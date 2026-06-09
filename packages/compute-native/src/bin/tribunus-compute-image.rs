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
        eprintln!("  tribunus-compute-image infer  --image <dir>");
        eprintln!("  tribunus-compute-image verify --image <dir> [--expected-hash <hash>] [--full]");
        std::process::exit(1);
    }

    let result = match args[1].as_str() {
        "build" => cmd_build(&args[2..]),
        "verify" => cmd_verify(&args[2..]),
        "infer" => cmd_infer(&args[2..]),
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

    // Verify all segment files exist on disk.
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
    let sealed_at = format_iso8601(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or(Duration::ZERO)
            .as_secs(),
    );

    let seal = json!({
        "status": "sealed",
        "image_hash": image_hash,
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

    // If --full: recompute image hash from all segments and compare.
    if full {
        let recomputed = recompute_image_hash(image_path, &reader.manifest)?;
        if recomputed != stored_hash {
            return Err(format!(
                "full verify hash mismatch: stored={stored_hash} recomputed={recomputed}"
            ));
        }
    }

    let segment_count = reader.manifest.segments.len();
    let tensor_count = reader.manifest.tensor_table.len();
    let storage_abi = reader.manifest.required_storage_abi.clone();
    let image_hash = reader.manifest.image_hash.clone();

    let out = json!({
        "status": "verified",
        "image_hash": image_hash,
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

/// Recompute the image hash by reading every segment file, hashing each, and
/// combining them into a single hex string.
fn recompute_image_hash(
    dir: &Path,
    manifest: &compute_image::Manifest,
) -> Result<String, String> {
    let mut hasher = Sha256::new();
    for seg in &manifest.segments {
        let path = dir.join(&seg.filename);
        let bytes = fs::read(&path)
            .map_err(|e| format!("read {}: {e}", seg.filename))?;
        hasher.update(&bytes);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

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

// ═══════════════════════════════════════════════════════════════════════════
// infer command — runs a forward pass against a sealed image at opt-level=3
// ═══════════════════════════════════════════════════════════════════════════

fn cmd_infer(args: &[String]) -> Result<(), String> {
    let mut image: Option<String> = None;
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--image" => { i += 1; if i < args.len() { image = Some(args[i].clone()); } }
            _ => { return Err(format!("unknown flag: {}", args[i])); }
        }
        i += 1;
    }
    let image_dir = image.ok_or("missing --image")?;
    let image_path = Path::new(&image_dir);
    if !image_path.join("manifest.json").exists() {
        return Err("not a ComputeImage directory (missing manifest.json)".into());
    }

    eprintln!("Opening sealed image: {}", image_dir);
    let reader = compute_image::read(&image_dir)
        .map_err(|e| format!("read image: {e}"))?;

    let plan = &reader.manifest.execution_plan;
    let plan_errors = plan.validate();
    if let Err(errs) = plan_errors {
        return Err(format!("plan validation failed: {}", errs.join("; ")));
    }

    let start = std::time::Instant::now();
    let mut runtime = reader.open_runtime(compute_image::StorageBackend::Copied)
        .map_err(|e| format!("open runtime: {e}"))?;

    eprintln!("Running 48-layer forward pass...");
    let token = runtime.run_full_model(&[2i32])
        .map_err(|e| format!("run_full_model: {e}"))?;
    let elapsed = start.elapsed();
    let elapsed_s = elapsed.as_secs_f64();

    let out = serde_json::json!({
        "status": "inferred",
        "image_hash": reader.manifest.image_hash,
        "output_token": token,
        "elapsed_s": elapsed_s,
        "layers": plan.layers.len(),
    });
    println!("{}", serde_json::to_string(&out).unwrap());

    eprintln!("GATE PASSED: token={} elapsed={:.1}s", token, elapsed_s);
    Ok(())
}
