//! Negative-evidence fixture — deliberate load-error capture.
//!
//! Runs a valid compilation (same as normal graphs) but then attempts
//! to load from a non-existent model path. The receipt captures the
//! error as a datapoint, proving the error-capture pipeline works
//! without polluting the primary matrices.

use std::path::Path;
use std::time::Instant;
use sha2::{Digest, Sha256};

use crate::decode_attribution::receipt::DecodeAttributionReceipt;
use crate::decode_attribution::environment::capture_host_environment;
use crate::decode_attribution::graph_catalog;
use crate::decode_attribution::shape_profiles;
use crate::mil_builder::MilBuilder;
use crate::mlpackage::{self, ModelMeta};
use crate::coreml_pipeline;
use crate::coreml_bridge::{CoreMlModel, CoreMlComputeUnits};

/// Run the negative-evidence fixture.
///
/// 1. Build and compile a simple matmul graph (valid).
/// 2. Attempt to load from a deliberately non-existent path.
/// 3. Return a receipt with status="load_error" and the error captured.
pub fn run_negative_evidence(run_id: &str, _output_dir: &Path) -> DecodeAttributionReceipt {
    let env = capture_host_environment().unwrap_or_else(|_| {
        crate::decode_attribution::environment::HostEnvironment {
            host_chip: std::env::consts::ARCH.to_string(),
            macos_version: "unknown".into(),
            xcode_build_version: "unknown".into(),
            coremlcompiler_version: "unknown".into(),
        coreml_compiler_available: false,
        }
    });

    let profile = &shape_profiles::MEDIUM;
    let family = &graph_catalog::NORMAL_FAMILIES[0]; // matmul
    let compute_units = "cpuAndGPU";

    let ts = iso_timestamp();

    let mut r = DecodeAttributionReceipt {
        run_id: run_id.to_string(),
        commit_sha: option_env!("VERGEN_GIT_SHA").unwrap_or("unknown").to_string(),
        branch: option_env!("VERGEN_GIT_BRANCH").unwrap_or("unknown").to_string(),
        timestamp: ts,
        schema_version: "decode-attribution.v1".to_string(),
        host_chip: env.host_chip.clone(),
        macos_version: env.macos_version.clone(),
        xcode_version: env.xcode_build_version.clone(),
        coremlcompiler_version: env.coremlcompiler_version.clone(),
        graph_family: "negative_evidence_matmul".to_string(),
        shape_profile: "medium".to_string(),
        graph_status: "negative_evidence".to_string(),
        op_count: 1,
        input_shape: vec![1, 128],
        weight_shape: vec![128, 128],
        output_shapes: vec![vec![1, 1]],
        dtype: "float32".to_string(),
        matrix_name: "negative_evidence".to_string(),
        matrix_required: true,
        configured_warmup_iterations: 0,
        configured_steady_iterations: 0,
        tolerance: 1e-4,
        percentile_method: "nearest_rank".to_string(),
        memory_measurement_method: "task_info_resident_size".to_string(),
        ..Default::default()
    };

    // Phase 1: Materialize
    let temp_dir = match tempfile::tempdir() {
        Ok(d) => d,
        Err(e) => {
            r.status = "compile_error".into();
            r.failure_reason = Some(format!("tempdir: {e}"));
            return r;
        }
    };
    let mlpackage_path = temp_dir.path().join("neg.mlpackage");

    let b = MilBuilder::new("main");
    let b = (family.build)(b, profile);
    let program = match b.build() {
        Ok(p) => p,
        Err(e) => {
            r.status = "compile_error".into();
            r.failure_reason = Some(format!("MIL build: {e}"));
            return r;
        }
    };

    let meta = ModelMeta {
        function_name: "main".into(),
        ..Default::default()
    };

    let mat_start = Instant::now();
    if let Err(e) = mlpackage::write_mlpackage(program, &mlpackage_path, &meta) {
        r.status = "compile_error".into();
        r.failure_reason = Some(format!("mlpackage write: {e}"));
        return r;
    }
    r.materialize_duration_ns = mat_start.elapsed().as_nanos() as u64;
    r.source_package_sha256 = sha256_dir(&mlpackage_path);

    // Phase 2: Compile
    let compile_result = coreml_pipeline::compile_mlpackage(
        &mlpackage_path,
        temp_dir.path(),
        "neg",
        compute_units,
        "com.apple.coreml.ops.15_0",
    );

    let receipt = match compile_result {
        Ok(rec) => rec,
        Err(e) => {
            r.status = "compile_error".into();
            r.failure_reason = Some(format!("compilation: {e}"));
            return r;
        }
    };

    r.compile_duration_ns = receipt.toolchain.compile_duration_ns;
    r.compiled_artifact_sha256 = receipt.compiled_hash.clone();
    r.compile_exit_status = receipt.toolchain.exit_status;
    r.compiler_stdout_sha256 = receipt.toolchain.stdout_sha256;
    r.compiler_stderr_sha256 = receipt.toolchain.stderr_sha256;

    // Phase 3: Load from deliberately broken path
    r.runtime_compute_units = CoreMlComputeUnits::CpuAndGpu.name().to_string();

    let load_start = Instant::now();
    let fake_path = "/tmp/nonexistent/deadbeef.mlmodelc";
    let load_result = CoreMlModel::load_with_compute_units(
        fake_path,
        CoreMlComputeUnits::CpuAndGpu,
    );

    r.load_duration_ns = load_start.elapsed().as_nanos() as u64;
    r.load_success = false;
    r.status = "load_error".into();
    r.failure_reason = Some(format!(
        "deliberate negative evidence: attempted load from nonexistent path '{}'; error: {:?}",
        fake_path,
        load_result.err()
    ));

    r
}

fn iso_timestamp() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let d = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
    let secs = d.as_secs();
    let days = secs / 86400;
    let time_secs = secs % 86400;
    let h = time_secs / 3600;
    let m = (time_secs % 3600) / 60;
    let s = time_secs % 60;
    let y400 = days / 146097;
    let d400 = days % 146097;
    let y100 = d400 / 36524;
    let d100 = d400 % 36524;
    let y4 = d100 / 1461;
    let d4 = d100 % 1461;
    let y1 = d4 / 365;
    let d1 = d4 % 365;
    let y = 1970 + (y400 * 400 + y100 * 100 + y4 * 4 + y1) as u16;
    let leap = if y1 > 0 && (y1 % 4 == 0) { 1 } else { 0 };
    let doy = (d1 + 1) as u16;
    let months_days: [u16; 12] = [31, 28 + leap, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    let mut accum = 0u16;
    let mut month = 1u16;
    for (i, &md) in months_days.iter().enumerate() {
        if doy <= accum + md { month = (i + 1) as u16; break; }
        accum += md;
    }
    let day = doy - accum;
    format!("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z", y, month, day, h, m, s)
}

fn sha256_dir(path: &Path) -> String {
    let mut h = Sha256::new();
    let mut entries: Vec<_> = std::fs::read_dir(path)
        .map(|rd| rd.filter_map(|e| e.ok()).map(|e| e.path()).collect())
        .unwrap_or_default();
    entries.sort();
    for p in &entries {
        h.update(p.file_name().unwrap_or_default().to_string_lossy().as_bytes());
        if p.is_dir() { h.update(sha256_dir(p).as_bytes()); }
        else if let Ok(d) = std::fs::read(p) { h.update(&d); }
    }
    format!("{:x}", h.finalize())
}
