//! tribunus-compute-image — CLI for building and verifying ComputeImage directories.
//!
//! Commands:
//!   build  --source <dir> --output <dir>
//!   verify --image <dir> [--expected-hash <hash>] [--full]

use std::fs;
use std::fs::File;
use std::path::Path;
use std::io::Read;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::json;
use sha2::{Digest, Sha256};
use rayon::prelude::*;
use uuid::Uuid;

use tribunus_compute_native::compute_image;

// ═══════════════════════════════════════════════════════════════════════════
// Entry point
// ═══════════════════════════════════════════════════════════════════════════

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 2 {
        eprintln!("Usage:");
        eprintln!("  tribunus-compute-image build --source <dir> --output <dir>");
        eprintln!("  tribunus-compute-image verify --image <dir> [--expected-hash <hash>] [--full]");
        std::process::exit(1);
    }

    let result = match args[1].as_str() {
        "build" => cmd_build(&args[2..]),
        "verify" => cmd_verify(&args[2..]),
        other => {
            eprintln!("unknown command: {other}");
            std::process::exit(1);
        }
    };

    if let Err(e) = result {
        eprintln!("error: {e}");
        std::process::exit(1);
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Argument helpers
// ═══════════════════════════════════════════════════════════════════════════

/// Look up `--key` in `args` and return the following value, or `None`.
fn get_opt<'a>(args: &'a [String], key: &str) -> Option<&'a str> {
    args.windows(2).find_map(|w| {
        if w[0] == key {
            Some(w[1].as_str())
        } else {
            None
        }
    })
}

/// Return `true` if `--flag` appears anywhere in `args`.
fn has_flag(args: &[String], flag: &str) -> bool {
    args.iter().any(|a| a == flag)
}

// ═══════════════════════════════════════════════════════════════════════════
// build command
// ═══════════════════════════════════════════════════════════════════════════

fn cmd_build(args: &[String]) -> Result<(), String> {
    let source = get_opt(args, "--source")
        .ok_or_else(|| "--source is required".to_string())?;
    let output = get_opt(args, "--output")
        .ok_or_else(|| "--output is required".to_string())?;

    let output_path = Path::new(output);

    // Refuse to overwrite an existing output directory.
    if output_path.exists() {
        return Err(format!(
            "output directory already exists. Refusing to overwrite sealed image."
        ));
    }

    // Profile attestation — print before compiling
    let attestation = compute_image::image_build_attestation();
    println!("{}", serde_json::to_string(&attestation).unwrap());

    // Create staging directory.
    let uuid = Uuid::new_v4();
    let staging = format!("{output}.build-{uuid}");
    let staging_path = Path::new(&staging);

    fs::create_dir_all(staging_path)
        .map_err(|e| format!("create staging dir {staging}: {e}"))?;

    // Compile into staging.
    let compile_start = Instant::now();
    let compiled = compute_image::compile_with_authority(
        source, &staging, compute_image::CompilationAuthority::SealedComputeImage
    )
        .map_err(|e| format!("compilation failed: {e}"))?;
    let compile_ns = compile_start.elapsed().as_nanos() as u64;
    let compile_duration_s = compile_ns as f64 / 1_000_000_000.0;

    // Extract fields from the compiled output.
    let image_hash = compiled.manifest.image_hash.clone();
    let segment_count = compiled.manifest.segments.len();
    let tensor_count = compiled.manifest.tensor_table.len();
    let storage_abi = compiled.manifest.required_storage_abi.clone();
    let runtime_abi = compiled.manifest.runtime_abi.clone();

    // Reopen and validate with CompiledImageReader.
    let reader = compute_image::read(&staging)
        .map_err(|e| format!("reopen staging image failed: {e}"))?;

    // Validate execution plan.
    let plan_errors = reader.manifest.execution_plan.validate();
    if let Err(errs) = plan_errors {
        let joined = errs.join("; ");
        return Err(format!("execution plan validation failed: {joined}"));
    }

    // Verify all segment files exist on disk. Full hash verification is a
    // separate concern handled by the verify command.
    for seg in &reader.manifest.segments {
        let seg_path = staging_path.join(&seg.filename);
        if !seg_path.exists() {
            return Err(format!("missing segment file: {}", seg.filename));
        }
    }

    // Write seal.json.
    let compiler_commit = env!("CARGO_PKG_VERSION");
    let builder_sha256 = {
        let exe_path = std::env::current_exe()
            .map_err(|e| format!("current_exe: {e}"))?;
        let mut file = File::open(&exe_path)
            .map_err(|e| format!("open {:?}: {e}", exe_path))?;
        let mut hasher = Sha256::new();
        let mut buf = [0u8; 65536];
        loop {
            let n = file.read(&mut buf)
                .map_err(|e| format!("read {:?}: {e}", exe_path))?;
            if n == 0 { break; }
            hasher.update(&buf[..n]);
        }
        format!("{:x}", hasher.finalize())
    };
    // Compute artifact root hash from all segment files (parallel with rayon)
    eprintln!("[build] computing artifact root hash (parallel, {} segments)...", compiled.manifest.segments.len());
    let seg_data: Vec<Vec<u8>> = compiled.manifest.segments
        .par_iter()
        .map(|seg| {
            let sp = staging_path.join(&seg.filename);
            std::fs::read(&sp).unwrap_or_else(|e| panic!("read {}: {}", seg.filename, e))
        })
        .collect();
    let mut root_hasher = Sha256::new();
    for bytes in &seg_data {
        root_hasher.update(bytes);
    }
    let artifact_root_hash = format!("{:x}", root_hasher.finalize());
    eprintln!("[build] artifact_root_hash: {}...", &artifact_root_hash[..16]);

    let sealed_at = format_iso8601(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or(Duration::ZERO)
            .as_secs(),
    );

    let seal = json!({
        "status": "sealed",
        "image_hash": image_hash,
        "artifact_root_hash": artifact_root_hash,
        "manifest_image_hash": image_hash,
        "builder_sha256": builder_sha256,
        "segment_count": segment_count,
        "tensor_count": tensor_count,
        "compile_duration_s": compile_duration_s,
        "storage_abi": storage_abi,
        "runtime_abi": runtime_abi,
        "source_dir": source,
        "compiler_commit": compiler_commit,
        "sealed_at": sealed_at,
    });

    let seal_path = staging_path.join("seal.json");
    let seal_json = serde_json::to_string_pretty(&seal)
        .map_err(|e| format!("serialize seal.json: {e}"))?;
    fs::write(&seal_path, &seal_json)
        .map_err(|e| format!("write seal.json: {e}"))?;

    // Flush all files.
    sync_dir(staging_path)?;

    // Atomic rename: staging -> output.
    fs::rename(staging_path, output_path)
        .map_err(|e| format!("rename {staging} -> {output}: {e}"))?;

    // Print success JSON.
    let out = json!({
        "status": "sealed",
        "image_dir": output,
        "image_hash": image_hash,
        "segment_count": segment_count,
        "tensor_count": tensor_count,
        "compile_ns": compile_ns,
        "storage_abi": storage_abi,
        "runtime_abi": runtime_abi,
    });
    println!("{}", serde_json::to_string(&out).unwrap());

    Ok(())
}

// ═══════════════════════════════════════════════════════════════════════════
// verify command
// ═══════════════════════════════════════════════════════════════════════════

fn cmd_verify(args: &[String]) -> Result<(), String> {
    let image = get_opt(args, "--image")
        .ok_or_else(|| "--image is required".to_string())?;
    let expected_hash = get_opt(args, "--expected-hash");
    let full = has_flag(args, "--full");

    let image_path = Path::new(image);

    // Image dir must exist with seal.json.
    let seal_path = image_path.join("seal.json");
    if !image_path.exists() || !seal_path.exists() {
        return Err(format!(
            "image directory '{image}' does not exist or seal.json is missing"
        ));
    }

    // Read seal.json.
    let seal_text = fs::read_to_string(&seal_path)
        .map_err(|e| format!("read seal.json: {e}"))?;
    let seal: serde_json::Value = serde_json::from_str(&seal_text)
        .map_err(|e| format!("parse seal.json: {e}"))?;
    let stored_hash = seal["image_hash"]
        .as_str()
        .ok_or_else(|| "seal.json missing image_hash".to_string())?
        .to_string();

    // If --expected-hash provided, compare.
    if let Some(expected) = expected_hash {
        if expected != stored_hash {
            eprintln!("hash mismatch: expected={expected} stored={stored_hash}");
            return Err("image hash mismatch".to_string());
        }
    }

    // Open image (triggers full verification internally).
    let reader = compute_image::read(image)
        .map_err(|e| format!("image verification failed: {e}"))?;

    // Validate execution plan.
    let plan_errors = reader.manifest.execution_plan.validate();
    if let Err(errs) = plan_errors {
        let joined = errs.join("; ");
        return Err(format!("execution plan validation failed: {joined}"));
    }

    // Verify all segment files exist.
    for seg in &reader.manifest.segments {
        let seg_path = image_path.join(&seg.filename);
        if !seg_path.exists() {
            return Err(format!("missing segment file: {}", seg.filename));
        }
    }

    // If --full: verify every segment SHA-256 against manifest (parallel),
    // then verify artifact root hash against seal.json.
    if full {
        eprintln!("[verify] full: hashing {} segments in parallel...", reader.manifest.segments.len());
        let results: Vec<(String, bool, Vec<u8>)> = reader.manifest.segments
            .par_iter()
            .map(|seg| {
                let sp = image_path.join(&seg.filename);
                let bytes = std::fs::read(&sp)
                    .unwrap_or_else(|e| panic!("read {}: {}", seg.filename, e));
                let computed = format!("{:x}", Sha256::digest(&bytes));
                let ok = computed == seg.sha256;
                (seg.filename.clone(), ok, bytes)
            })
            .collect();

        let mut mismatches: Vec<String> = Vec::new();
        let mut verified = 0usize;
        let mut root_hasher = Sha256::new();
        for (filename, ok, bytes) in &results {
            if *ok { verified += 1; }
            else { mismatches.push(format!("{}: hash mismatch", filename)); }
            root_hasher.update(bytes);
        }
        if !mismatches.is_empty() {
            return Err(format!(
                "segment hash mismatches ({}/{} verified):\n{}",
                verified, reader.manifest.segments.len(), mismatches.join("\n")
            ));
        }
        eprintln!("[verify] segments: {}/{} verified", verified, reader.manifest.segments.len());

        let recomputed_root = format!("{:x}", root_hasher.finalize());
        // Compare against seal.json artifact_root_hash
        let expected_root = seal.get("artifact_root_hash")
            .and_then(|v| v.as_str().map(|s| s.to_string()))
            .unwrap_or_else(|| stored_hash.clone());
        if recomputed_root != expected_root {
            return Err(format!(
                "artifact root hash mismatch: seal={} recomputed={}",
                &expected_root[..16], &recomputed_root[..16]
            ));
        }
        eprintln!("[verify] artifact root hash: match");
    }

    let segment_count = reader.manifest.segments.len();
    let tensor_count = reader.manifest.tensor_table.len();
    let storage_abi = reader.manifest.required_storage_abi.clone();
    let image_hash = reader.manifest.image_hash.clone();

    let out = json!({
        "status": "verified",
        "segments_verified": segment_count,
        "image_hash": image_hash,
        "artifact_root_hash": seal["artifact_root_hash"].as_str().unwrap_or(&image_hash).to_string(),
        "segment_count": segment_count,
        "tensor_count": tensor_count,
        "storage_abi": storage_abi,
    });
    println!("{}", serde_json::to_string(&out).unwrap());

    Ok(())
}

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════

/// Sync (fsync) an open directory. Falls back to a no-op on platforms where
/// File::open on a directory is unsupported.
fn sync_dir(path: &Path) -> Result<(), String> {
    match fs::File::open(path) {
        Ok(file) => file.sync_all().map_err(|e| format!("sync dir failed: {e}")),
        Err(_) => Ok(()),
    }
}

/// Format a Unix timestamp (whole seconds since epoch) as an ISO 8601 UTC
/// string.
fn format_iso8601(secs: u64) -> String {
    // Days since epoch.
    let days = secs / 86400;
    let day_secs = secs % 86400;
    let hour = day_secs / 3600;
    let min = (day_secs % 3600) / 60;
    let sec = day_secs % 60;

    let (year, month, day) = civil_from_days(days as i64);
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        year, month as u32, day as u32, hour, min, sec,
    )
}

/// Convert a days-from-epoch value to (year, month, day) in the Gregorian
/// civil calendar.
fn civil_from_days(days: i64) -> (i64, i64, i64) {
    // Shamelessly adapted from Howard Hinnant's public-domain algorithm.
    let z = days + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = z - era * 146097; // day-of-era
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    (y, m, d)
}
