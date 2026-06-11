//! Decode Attribution Measurement Harness — Narrow Catalog.
//!
//! Runs 4 families × 2 shapes × 3 backends = ≤24 rows.
//! Each row writes a receipt to `{output_dir}/{run_id}/{backend}/{family}/{shape}/receipt.json`.
//! A run-level `summary.json` aggregates all rows.
//!
//! Core ML rows are run in a subprocess for crash isolation. If the child
//! predict crashes (SIGBUS etc.), the parent classifies it as `predict_crashed`
//! and continues to the next row.
//!
//! Usage:
//!   cargo run --bin tribunus-decode-attribution-measure --output-dir decode_attribution_runs
//!   cargo run --bin tribunus-decode-attribution-measure --single-row coreml matmul small cpuOnly 2>&1
//!
//! Single-row mode writes the receipt JSON to stdout and exits.
//! Used by the parent loop for crash isolation of Core ML rows.

use std::fs;
use std::io::Write;
use std::os::unix::process::ExitStatusExt;
use std::path::Path;
use std::process::{Command, ExitStatus};
use std::time::{SystemTime, UNIX_EPOCH};

use tribunus_compute_native::decode_attribution::environment::{self, HostEnvironment};
use tribunus_compute_native::decode_attribution::harness::run_backend;
use tribunus_compute_native::decode_attribution::graph_catalog::GraphFamily;
use tribunus_compute_native::decode_attribution::receipt::DecodeAttributionReceipt;
use tribunus_compute_native::decode_attribution::shape_profiles::ShapeProfile;
use tribunus_compute_native::decode_attribution::timer_calibration::calibrate_timer_overhead;

// ── Measurement shape profiles ───────────────────────────────────────────

/// Small: k=4, n=1 — [1,4] × [4,1] = [1,1]
const MEASUREMENT_SMALL: ShapeProfile = ShapeProfile {
    name: "small",
    input_rows: 1,
    input_cols: 4,
    weight_rows: 4,
    weight_cols: 1,
};

/// Medium: k=16, n=8 — [1,16] × [16,8] = [1,8] (harness-validation scale)
const MEASUREMENT_MEDIUM: ShapeProfile = ShapeProfile {
    name: "medium",
    input_rows: 1,
    input_cols: 16,
    weight_rows: 16,
    weight_cols: 8,
};

const MEASUREMENT_SHAPES: &[ShapeProfile] = &[MEASUREMENT_SMALL, MEASUREMENT_MEDIUM];

// ── Narrow catalog families ──────────────────────────────────────────────

const MEASUREMENT_FAMILIES: &[&GraphFamily] = &[
    &tribunus_compute_native::decode_attribution::graph_catalog::NORMAL_FAMILIES[0], // matmul
    &tribunus_compute_native::decode_attribution::graph_catalog::NORMAL_FAMILIES[1], // chain_matmul_add_silu
    &tribunus_compute_native::decode_attribution::graph_catalog::NORMAL_FAMILIES[4], // constant_heavy (index 4)
    &tribunus_compute_native::decode_attribution::graph_catalog::NORMAL_FAMILIES[2], // branch_rejoin
];

// ── Tier 1 families (static-op expansion) ──────────────────────────────

const TIER1_FAMILIES: &[&GraphFamily] = &[
    &tribunus_compute_native::decode_attribution::graph_catalog::TIER1_FAMILIES[0], // add_standalone
    &tribunus_compute_native::decode_attribution::graph_catalog::TIER1_FAMILIES[1], // mul_standalone
    &tribunus_compute_native::decode_attribution::graph_catalog::TIER1_FAMILIES[2], // sigmoid_standalone
    &tribunus_compute_native::decode_attribution::graph_catalog::TIER1_FAMILIES[3], // silu_standalone
    &tribunus_compute_native::decode_attribution::graph_catalog::TIER1_FAMILIES[4], // matmul_projection
    &tribunus_compute_native::decode_attribution::graph_catalog::TIER1_FAMILIES[5], // matmul_residual_add
    &tribunus_compute_native::decode_attribution::graph_catalog::TIER1_FAMILIES[6], // two_matmul_add
    &tribunus_compute_native::decode_attribution::graph_catalog::TIER1_FAMILIES[7], // matmul_add_silu
];


// ── Backend/policy pairs ─────────────────────────────────────────────────

const MEASUREMENT_BACKENDS: &[(&str, &str)] = &[
    ("coreml", "cpuOnly"),
    ("mlx", "mlx_default"),
    ("accelerate", "accelerate_cpu"),
];

// ── Constants ────────────────────────────────────────────────────────────

const WARMUP: u32 = 10;
const STEADY: u32 = 100;
const TOLERANCE: f64 = 1e-4;

// ── Helpers for finding bin path ─────────────────────────────────────────

fn self_exe() -> String {
    std::env::current_exe()
        .unwrap_or_else(|_| "tribunus-decode-attribution-measure".into())
        .to_string_lossy()
        .to_string()
}

// ── Main ─────────────────────────────────────────────────────────────────

fn main() {
    let args: Vec<String> = std::env::args().collect();

    // ── Single-row mode? ────────────────────────────────────────────────
    // --single-row <backend> <family> <shape> <policy>
    let single_row: bool = args.iter().any(|a| a == "--single-row");
    if single_row {
        // Expect 4 positional args after --single-row: backend, family, shape, policy
        let pos = args.iter().position(|a| a == "--single-row").unwrap();
        let backend = args.get(pos + 1).map(|s| s.as_str()).unwrap_or("coreml");
        let family_name = args.get(pos + 2).map(|s| s.as_str()).unwrap_or("matmul");
        let shape_name = args.get(pos + 3).map(|s| s.as_str()).unwrap_or("small");
        let policy = args.get(pos + 4).map(|s| s.as_str()).unwrap_or("cpuOnly");

        let family = MEASUREMENT_FAMILIES.iter().chain(TIER1_FAMILIES.iter())
            .find(|f| f.name == family_name)
            .expect("unknown family");
        let shape = MEASUREMENT_SHAPES
            .iter()
            .find(|s| s.name == shape_name)
            .expect("unknown shape");

        let run_id = format!("child-{}", {
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        });
        let tmp_dir = std::env::temp_dir().join(&run_id);
        fs::create_dir_all(&tmp_dir).expect("create child tmp dir");
        
        // Breadcrumb path is set by parent via CML_BREADCRUMB_PATH env var.
        // If not set by parent, use a default in the temp dir.
        if std::env::var("CML_BREADCRUMB_PATH").is_err() {
            let default_crumb = tmp_dir.join("predict_breadcrumbs.txt");
            std::env::set_var("CML_BREADCRUMB_PATH", &default_crumb);
        }

        let receipt = run_backend(
            &run_id,
            backend,
            family,
            shape,
            policy,
            "measurement_single_row",
            true,
            WARMUP,
            STEADY,
            TOLERANCE,
            &tmp_dir,
        );
        
        // Read breadcrumbs and include in receipt.
        let crumb_path_for_read = std::env::var("CML_BREADCRUMB_PATH")
            .ok()
            .filter(|p| !p.is_empty())
            .unwrap_or_else(|| tmp_dir.join("predict_breadcrumbs.txt").to_string_lossy().to_string());
        let crumb_path_for_read = std::path::Path::new(&crumb_path_for_read);
        eprintln!("DEBUG breadcrumb path: {}", crumb_path_for_read.display());
        eprintln!("DEBUG breadcrumb file exists: {}", crumb_path_for_read.exists());
        let last_crumb = tribunus_compute_native::decode_attribution::breadcrumb::last_breadcrumb(crumb_path_for_read)
            .unwrap_or_default();
        let cal = calibrate_timer_overhead(10000);
        let mut receipt = receipt;
        receipt.last_completed_predict_breadcrumb = last_crumb;
        receipt.timer_overhead_ns = Some(cal.timer_overhead_ns);
    receipt.timer_overhead_method = Some(cal.timer_overhead_method.to_owned());
    receipt.raw_timing_adjusted = cal.raw_timing_adjusted;

        // Write receipt JSON to stdout on a special marker line.
        let json = serde_json::to_string(&receipt).expect("serialize");
        println!("__RECEIPT_BEGIN__");
        println!("{}", json);
        println!("__RECEIPT_END__");
        
        // Preserve .mlpackage, .mlmodelc, and breadcrumbs for crash repro.
        // Copy to a deterministic path derivable from run_id or base_dir.
        // If CML_BREADCRUMB_PATH points to a crash_repro directory, use that.
        // Otherwise, save to tmp_dir itself (persisted for this run).
        if let Ok(crumb_path_str) = std::env::var("CML_BREADCRUMB_PATH") {
            let crumb_dir = std::path::Path::new(&crumb_path_str).parent();
            if let Some(repro_parent) = crumb_dir {
                let _ = copy_dir(&tmp_dir, &repro_parent.join("artifacts"));
            }
        }
        
        // Clean up temp dir
        // Clean up temp dir
        let _ = fs::remove_dir_all(&tmp_dir);
        return;
    }

    // ── Normal (parent) mode ────────────────────────────────────────────
    let output_dir = args
        .iter()
        .position(|a| a == "--output-dir")
        .and_then(|i| args.get(i + 1))
        .cloned()
        .unwrap_or_else(|| "decode_attribution_runs".to_string());

    let custom_run_id = args
        .iter()
        .position(|a| a == "--run-id")
        .and_then(|i| args.get(i + 1))
        .cloned();

    let run_id = custom_run_id.unwrap_or_else(|| {
        format!("DA-{:04}-{:06}", 1, {
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs() % 1_000_000
        })
    });

    let base_dir = Path::new(&output_dir).join(&run_id);
    fs::create_dir_all(&base_dir).expect("create output dir");

    // Probe environment.
    let env: HostEnvironment = environment::capture_host_environment().unwrap_or_else(|_| HostEnvironment {
        host_chip: std::env::consts::ARCH.to_string(),
        macos_version: "unknown".into(),
        xcode_build_version: "unknown".into(),
        coremlcompiler_version: "unknown".into(),
        coreml_compiler_available: false,
    });

    eprintln!("=== Decode Attribution Measurement Harness ===");
    eprintln!("Run ID: {}", run_id);
    eprintln!("Output: {}", base_dir.display());
    eprintln!("Core ML compiler available: {}", env.coreml_compiler_available);
    eprintln!("Host: {} / macOS {} / Xcode {}", env.host_chip, env.macos_version, env.xcode_build_version);
    eprintln!("");

    let parent_cal = calibrate_timer_overhead(10000);
    eprintln!("Timer overhead: {} ns ({} iterations, method={})",
        parent_cal.timer_overhead_ns, parent_cal.calibration_iterations, parent_cal.timer_overhead_method);

    let self_path = self_exe();
    let include_tier1 = args.iter().any(|a| a == "--tier1");
    let active_families: Vec<&GraphFamily> = if include_tier1 {
        MEASUREMENT_FAMILIES.iter().chain(TIER1_FAMILIES.iter()).copied().collect()
    } else {
        MEASUREMENT_FAMILIES.to_vec()
    };
    let mut receipts: Vec<RowEntry> = Vec::new();
    let mut seq: u32 = 0;

    for backend_pair in MEASUREMENT_BACKENDS {
        let (backend_name, policy) = *backend_pair;

        for family in &active_families {
            for shape in MEASUREMENT_SHAPES {
                seq += 1;
                let row_id = format!("{}-N-{:04}", run_id, seq);

                let r = if backend_name == "coreml" && !env.coreml_compiler_available {
                    synthetic_env_unavailable_receipt(&row_id, &env, family, shape, backend_name)
                } else if backend_name == "coreml" {
                    // Core ML row: run in subprocess for crash isolation.
                    run_coreml_row_in_child(&self_path, &row_id, backend_name, family, shape, policy, &base_dir)
                } else {
                    run_backend(
                        &row_id,
                        backend_name,
                        family,
                        shape,
                        policy,
                        "measurement_narrow_catalog",
                        true,
                        WARMUP,
                        STEADY,
                        TOLERANCE,
                        &base_dir,
                    )
                };

                // Apply parent calibration for rows that don't have their own.
                let mut r = r;
                if r.timer_overhead_ns.is_none() {
                    r.timer_overhead_ns = Some(parent_cal.timer_overhead_ns);
                }
                if r.timer_overhead_method.is_none() {
                    r.timer_overhead_method = Some(parent_cal.timer_overhead_method.to_owned());
                }
                r.raw_timing_adjusted = r.raw_timing_adjusted || parent_cal.raw_timing_adjusted;

                // Write per-row receipt.
                let row_dir = base_dir.join(backend_name).join(family.name).join(shape.name);
                fs::create_dir_all(&row_dir).expect("create row dir");
                let receipt_path = row_dir.join("receipt.json");
                let receipt_json = serde_json::to_string_pretty(&r).expect("serialize");
                let mut f = fs::File::create(&receipt_path).expect("create receipt file");
                f.write_all(receipt_json.as_bytes()).expect("write receipt");

                let cache_hit = if backend_name == "coreml" {
                    r.compile_cache_hit
                } else {
                    r.mlx_cache_hit
                };

                eprintln!(
                    "  [{:4}] {} / {} / {} → status={}, cache_hit={}",
                    seq, backend_name, family.name, shape.name,
                    r.status, cache_hit
                );

                receipts.push(RowEntry {
                    sequence: seq,
                    backend: backend_name.to_string(),
                    family: family.name.to_string(),
                    shape: shape.name.to_string(),
                    row_id: row_id.clone(),
                    status: r.status.clone(),
                    predict_status: r.predict_status.clone(),
                    receipt_path: receipt_path.to_string_lossy().to_string(),
                    compile_cache_hit: cache_hit,
                });
            }
        }
    }

    // ── Write summary ──────────────────────────────────────────────────
    let summary = MeasurementSummary {
        run_id: run_id.clone(),
        total_rows: seq,
        rows: receipts,
        timestamp: epoch_secs(),
    };

    let summary_path = base_dir.join("summary.json");
    let summary_json = serde_json::to_string_pretty(&summary).expect("serialize");
    let mut sf = fs::File::create(&summary_path).expect("create summary file");
    sf.write_all(summary_json.as_bytes()).expect("write summary");

    eprintln!("");
    eprintln!("=== Narrow Catalog Complete ===");
    eprintln!("Rows: {}", seq);
    eprintln!("Summary: {}", summary_path.display());
}

// ── Core ML subprocess execution ─────────────────────────────────────────

/// Runs a single Core ML row in a child process. If the child crashes (SIGBUS
/// etc.), returns a synthetic receipt with status=predict_crashed.
fn run_coreml_row_in_child(
    self_path: &str,
    row_id: &str,
    backend: &str,
    family: &GraphFamily,
    shape: &ShapeProfile,
    policy: &str,
    base_dir: &Path,
) -> DecodeAttributionReceipt {
    let abort_info_path = base_dir.join(format!(
        "crash_repro/{}/{}/{}/row_desc.json",
        backend, family.name, shape.name
    ));
    let abort_dir = abort_info_path.parent().unwrap();
    let _ = fs::create_dir_all(abort_dir);

    // Save row descriptor for crash reproducibility.
    let row_desc = serde_json::json!({
        "row_id": row_id,
        "backend": backend,
        "family": family.name,
        "shape": shape.name,
        "policy": policy,
        "output_dir": base_dir.to_string_lossy(),
    });
    {
        let mut f = fs::File::create(&abort_info_path).expect("create crash repro file");
        f.write_all(row_desc.to_string().as_bytes()).expect("write crash repro");
    }

    // Set breadcrumb path so child writes to a known location the parent can read after crash.
    let crumb_path = abort_dir.join("predict_breadcrumbs.txt");
    let crumb_str = crumb_path.to_string_lossy().to_string();

    let child_output = Command::new(self_path)
        .args([
            "--single-row",
            backend,
            family.name,
            shape.name,
            policy,
        ])
        .env("CML_BREADCRUMB_PATH", &crumb_str)
        .output();

    match child_output {
        Ok(output) => {
            let status = output.status;
            if status.success() {
                // Parse receipt from stdout.
                let stdout = String::from_utf8_lossy(&output.stdout);
                if let Some(receipt_json) = extract_receipt(&stdout) {
                    serde_json::from_str(&receipt_json).unwrap_or_else(|e| {
                        synthetic_child_failure(row_id, "parse_failed", &format!("receipt parse: {e}"), status)
                    })
                } else {
                    synthetic_child_failure(row_id, "measurement_failed", "no receipt marker in child stdout", status)
                }
            } else {
                // Child exited with error or signal.
                classify_child_exit(row_id, status, &abort_info_path)
            }
        }
        Err(e) => {
            synthetic_child_failure(row_id, "measurement_failed", &format!("child spawn: {e}"), std::process::ExitStatus::default())
        }
    }
}

/// Extract receipt JSON from child stdout between __RECEIPT_BEGIN__ markers.
fn extract_receipt(stdout: &str) -> Option<String> {
    let lines = stdout.lines();
    let mut collecting = false;
    let mut parts = Vec::new();
    for line in lines {
        if line == "__RECEIPT_BEGIN__" {
            collecting = true;
            continue;
        }
        if line == "__RECEIPT_END__" {
            break;
        }
        if collecting {
            parts.push(line);
        }
    }
    if parts.is_empty() { None } else { Some(parts.join("\n")) }
}

/// Classify a non-success child exit into a typed receipt.
fn classify_child_exit(
    row_id: &str,
    status: ExitStatus,
    repro_path: &Path,
) -> DecodeAttributionReceipt {
    let (signal_desc, exit_code) = if let Some(sig) = status.signal() {
        let sig_name = match sig {
            10 => "SIGBUS",
            11 => "SIGSEGV",
            6 => "SIGABRT",
            4 => "SIGILL",
            8 => "SIGFPE",
            _ => "UNKNOWN_SIGNAL",
        };
        (format!("{sig_name}({sig})"), sig)
    } else if let Some(code) = status.code() {
        (format!("exit_code({code})"), 0)
    } else {
        ("unknown".into(), 0)
    };

    let terminal_status = if matches!(exit_code, 4 | 6 | 8 | 10 | 11) {
        "predict_crashed"
    } else if status.code().map_or(false, |c| c != 0) {
        "measurement_failed"
    } else {
        "measurement_failed"
    };

    let diag = format!(
        "child terminated by {}; repro at {}",
        signal_desc,
        repro_path.display()
    );

    // Read breadcrumbs from the repro directory.
    let repro_dir = repro_path.parent().unwrap_or(Path::new("/"));
    let crumb_path = repro_dir.join("predict_breadcrumbs.txt");
    let last_crumb = tribunus_compute_native::decode_attribution::breadcrumb::last_breadcrumb(&crumb_path)
        .unwrap_or_default();

    let mut r = DecodeAttributionReceipt {
        run_id: row_id.to_string(),
        status: terminal_status.into(),
        terminal_phase: "coreml_predict_child".into(),
        failure_diagnostics: Some(diag),
        execution_proof: tribunus_compute_native::decode_attribution::receipt::ExecutionProof {
            engine: "coreml".into(),
            accelerated_ops: vec![],
            cpu_ops: vec![],
            reference_ops: vec![],
            accelerate_blas_ops: vec![],
            accelerate_vdsp_ops: vec![],
            accelerate_vforce_ops: vec![],
            cpu_glue_ops: vec![],
            bridge_path: Some(repro_path.to_string_lossy().to_string()),
            notes: Some(format!("child terminated by {}", signal_desc)),
        },
        last_completed_predict_breadcrumb: last_crumb,
        ..DecodeAttributionReceipt::default()
    };
    // Fill minimum identity fields from defaults so the receipt is valid.
    r.commit_sha = option_env!("VERGEN_GIT_SHA").unwrap_or("unknown").to_string();
    r.branch = option_env!("VERGEN_GIT_BRANCH").unwrap_or("unknown").to_string();
    r.timestamp = iso_timestamp_v2();
    r.schema_version = "decode-attribution.v1".to_string();
    r.predict_status = terminal_status.into();
    r.predict_failure_classification = signal_desc;
    r
}

/// Fallback: generic child failure receipt.
fn synthetic_child_failure(
    row_id: &str,
    status: &str,
    diag: &str,
    _exit_status: ExitStatus,
) -> DecodeAttributionReceipt {
    let mut r = DecodeAttributionReceipt {
        run_id: row_id.to_string(),
        status: status.into(),
        failure_diagnostics: Some(diag.into()),
        ..DecodeAttributionReceipt::default()
    };
    r.commit_sha = option_env!("VERGEN_GIT_SHA").unwrap_or("unknown").to_string();
    r.branch = option_env!("VERGEN_GIT_BRANCH").unwrap_or("unknown").to_string();
    r.timestamp = iso_timestamp_v2();
    r.schema_version = "decode-attribution.v1".to_string();
    r
}

// ── Environment unavailable receipt ──────────────────────────────────────

fn synthetic_env_unavailable_receipt(
    row_id: &str,
    env: &HostEnvironment,
    family: &GraphFamily,
    shape: &ShapeProfile,
    backend: &str,
) -> DecodeAttributionReceipt {
    let ts = iso_timestamp_v2();
    DecodeAttributionReceipt {
        run_id: row_id.to_string(),
        commit_sha: option_env!("VERGEN_GIT_SHA").unwrap_or("unknown").to_string(),
        branch: option_env!("VERGEN_GIT_BRANCH").unwrap_or("unknown").to_string(),
        timestamp: ts,
        schema_version: "decode-attribution.v1".to_string(),
        host_chip: env.host_chip.clone(),
        macos_version: env.macos_version.clone(),
        xcode_version: env.xcode_build_version.clone(),
        coremlcompiler_version: env.coremlcompiler_version.clone(),
        graph_family: family.name.to_string(),
        shape_profile: shape.name.to_string(),
        graph_status: family.status.to_string(),
        op_count: family.op_count,
        backend: backend.to_string(),
        status: "compile_environment_unavailable".into(),
        materialize_status: "skipped_unavailable_environment".into(),
        compile_status: "skipped_unavailable_environment".into(),
        load_status: "skipped_unavailable_environment".into(),
        failure_diagnostics: Some(format!("coremlcompiler unavailable: {}", env.coremlcompiler_version)),
        backend_support_status: "environment_unavailable".into(),
        execution_proof: tribunus_compute_native::decode_attribution::receipt::ExecutionProof {
            engine: backend.to_string(),
            accelerated_ops: vec![],
            cpu_ops: vec![],
            reference_ops: vec![],
            accelerate_blas_ops: vec![],
            accelerate_vdsp_ops: vec![],
            accelerate_vforce_ops: vec![],
            cpu_glue_ops: vec![],
            bridge_path: None,
            notes: Some(format!("coremlcompiler unavailable: {}", env.coremlcompiler_version)),
        },
        ..DecodeAttributionReceipt::default()
    }
}

// ── Utilities ────────────────────────────────────────────────────────────

fn epoch_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn iso_timestamp_v2() -> String {
    let dur = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let secs = dur.as_secs();
    let days = secs / 86400;
    let time_secs = secs % 86400;
    let hours = time_secs / 3600;
    let minutes = (time_secs % 3600) / 60;
    let seconds = time_secs % 60;
    let y = 1970 + (days as u64) / 365;
    format!("{}-{:02}-{:02}T{:02}:{:02}:{:02}Z", y, 1, 1, hours, minutes, seconds)
}

// ── Summary types ────────────────────────────────────────────────────────

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct RowEntry {
    pub sequence: u32,
    pub backend: String,
    pub family: String,
    pub shape: String,
    pub row_id: String,
    pub status: String,
    pub predict_status: String,
    pub receipt_path: String,
    pub compile_cache_hit: bool,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct MeasurementSummary {
    pub run_id: String,
    pub total_rows: u32,
    pub rows: Vec<RowEntry>,
    pub timestamp: u64,
}

/// Recursive directory copy. Creates target if needed.
fn copy_dir(src: &std::path::Path, dst: &std::path::Path) -> std::io::Result<()> {
    if !src.is_dir() { return Ok(()); }
    let _ = std::fs::create_dir_all(dst);
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let ft = entry.file_type()?;
        let src_path = entry.path();
        let dst_path = dst.join(entry.file_name());
        if ft.is_dir() {
            copy_dir(&src_path, &dst_path)?;
        } else if ft.is_file() {
            let _ = std::fs::copy(&src_path, &dst_path);
        }
    }
    Ok(())
}
