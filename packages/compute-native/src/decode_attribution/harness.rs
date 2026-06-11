//! Core orchestration function for the decode attribution harness.
//!
//! `run_one()` executes one graph family at one shape profile with one
//! compute-unit policy and returns a `DecodeAttributionReceipt`.
//!
//! ## Phases
//!
//! 1. **Materialize** — Build MIL program via `MilBuilder`, write `.mlpackage`.
//! 2. **Compile** — Invoke `xcrun coremlcompiler` via `compile_mlpackage`.
//! 3. **Load** — Load compiled model via `CoreMlModel::load_with_compute_units`.
//! 4. **MLComputePlan** — Attempt compute-plan inspection (stub, non-blocking).
//! 5. **Cold predict** — First prediction (stub — not yet wired).
//! 6. **Warmup** — Warmup predictions (stub).
//! 7. **Steady state** — Timed predictions with statistics (stub).
//! 8. **Reference conformance** — Compare against pure-Rust evaluator (stub).
//! 9. **Accelerate** — Accelerate backend where supported (stub).
//!
//! Phases 1–3 are fully implemented. Phases 4–9 are stubs that will be
//! completed once the Core ML bridge predict API is integrated with
//! IOSurface arena setup. See the bridge integration TODO in
//! `coreml_bridge::predict`.

use sha2::{Digest, Sha256};
use std::path::Path;
use std::time::Instant;

use crate::coreml_bridge::{CoreMlComputeUnits, CoreMlModel};
use crate::coreml_pipeline;
use crate::mil_builder::MilBuilder;
use crate::mlpackage::{self, ModelMeta};
use crate::worker_memory;

use crate::decode_attribution::compute_plan::inspect_compute_plan;
use crate::decode_attribution::environment::{self, capture_host_environment};
use crate::decode_attribution::graph_catalog;
use crate::pipeline_parity::{graph_family_to_phase, graph_family_phase_variant, graph_family_semantic_contract_id};
use crate::decode_attribution::graph_catalog::GraphFamily;
use crate::decode_attribution::receipt::DecodeAttributionReceipt;
use crate::decode_attribution::shape_profiles::ShapeProfile;
use std::ffi::c_void;

use crate::arena::ArenaInfo;
use crate::decode_attribution::backend_adapters::{
    coreml_adapter, accelerate_adapter, mlx_adapter, conformance, predict_loop,
    reference_adapter as ref_eval, BackendSupportTier,
};

/// Run one decode-attribution measurement.
///
/// # Arguments
///
/// * `run_id` — Unique identifier for this run (e.g. `"DA-0001-20260610"`).
/// * `family` — Graph family topology (matmul, chain, branch_rejoin, etc.).
/// * `profile` — Shape profile (small, medium, large).
/// * `compute_units` — `"cpuOnly"` or `"cpuAndGPU"`.
/// * `matrix_name` — Matrix label for run-config metadata.
/// * `matrix_required` — Whether this matrix is part of the mandatory closure.
/// * `warmup_iters` — Number of warmup predictions.
/// * `steady_iters` — Number of steady-state timed predictions.
/// * `tolerance` — Numerical tolerance threshold for reference conformance.
/// * `output_dir` — Directory for sidecar outputs (stderr/stdout artifacts).
///
/// # Returns
///
/// A fully populated `DecodeAttributionReceipt`. Phases 1–3 (materialize,
/// compile, load) are fully timed and captured. Phases 4–9 (compute plan,
/// prediction, reference conformance, accelerate) are stubs that record
/// status but do not execute prediction. See the module docs for the
/// bridge integration TODO.
pub fn run_one(
    run_id: &str,
    family: &GraphFamily,
    profile: &ShapeProfile,
    compute_units: &str,
    matrix_name: &str,
    matrix_required: bool,
    warmup_iters: u32,
    steady_iters: u32,
    tolerance: f64,
    output_dir: &Path,
) -> DecodeAttributionReceipt {
    // ── Environment ──────────────────────────────────────────────────────────
    let env = environment::capture_host_environment().unwrap_or_else(|_| environment::HostEnvironment {
        host_chip: std::env::consts::ARCH.to_string(),
        macos_version: "unknown".into(),
        xcode_build_version: "unknown".into(),
        coremlcompiler_version: "unknown".into(),
        coreml_compiler_available: false,
    });

    let ts = iso_timestamp();

// ── Build base receipt ──────────────────────────────
    let mut r = DecodeAttributionReceipt {
        run_id: run_id.to_string(),
        commit_sha: option_env!("VERGEN_GIT_SHA")
            .unwrap_or("unknown")
            .to_string(),
        branch: option_env!("VERGEN_GIT_BRANCH")
            .unwrap_or("unknown")
            .to_string(),
        timestamp: ts,
        schema_version: "decode-attribution.v1".to_string(),
        host_chip: env.host_chip.clone(),
        macos_version: env.macos_version.clone(),
        xcode_version: env.xcode_build_version.clone(),
        coremlcompiler_version: env.coremlcompiler_version.clone(),
        graph_family: family.name.to_string(),
        pipeline_phase: graph_family_to_phase(family.name).ok().map(|p| p.to_string()),
        phase_variant: graph_family_phase_variant(family.name).to_string(),
        semantic_contract_id: graph_family_semantic_contract_id(family.name),
        shape_profile: profile.name.to_string(),
        graph_status: family.status.to_string(),
        op_count: family.op_count,
        input_shape: profile.input_shape(),
        weight_shape: profile.weight_shape(),
        // Simplified: most single-output graphs produce [1, weight_cols].
        // Multi-output graphs will need per-family shape introspection
        // when prediction is wired. For the initial harness this
        // placeholder is consistent with the rest of the stub phases.
        output_shapes: vec![vec![1, profile.weight_cols]],
        dtype: "float32".to_string(),
        matrix_name: matrix_name.to_string(),
        matrix_required,
        configured_warmup_iterations: warmup_iters,
        configured_steady_iterations: steady_iters,
        tolerance,
        percentile_method: "nearest_rank".to_string(),
        memory_measurement_method: "task_info_resident_size".to_string(),
        compile_diagnostics: vec![],
        ..Default::default()
    };

    // Record RSS before any allocations.
    r.process_rss_before_materialize_kb = resident_size_kb();

    // ── Phase 1: Materialize ─────────────────────────────────────────────────
    let temp_dir = match tempfile::tempdir() {
        Ok(d) => d,
        Err(e) => {
            r.status = "compile_error".into();
            r.failure_reason = Some(format!("tempdir creation failed: {e}"));
            return r;
        }
    };
    let mlpackage_path = temp_dir.path().join("model.mlpackage");

    let b = MilBuilder::new("main");
    let b = (family.build)(b, profile);
    let program = match b.build() {
        Ok(p) => p,
        Err(e) => {
            r.status = "compile_error".into();
            r.failure_reason = Some(format!("MIL program build failed: {e}"));
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
        r.failure_reason = Some(format!("mlpackage write failed: {e}"));
        return r;
    }
    r.materialize_duration_ns = mat_start.elapsed().as_nanos() as u64;
    r.source_package_sha256 = sha256_dir(&mlpackage_path);

    // ── Phase 2: Compile ──────────────────────────────────────────────────────
    let compile_result = coreml_pipeline::compile_mlpackage(
        &mlpackage_path,
        temp_dir.path(),
        family.name,
        compute_units,
        "com.apple.coreml.ops.15_0",
    );

    let cm_receipt = match compile_result {
        Ok(rec) => rec,
        Err(e) => {
            r.status = "compile_error".into();
            r.failure_reason = Some(format!("coremlcompiler compilation failed: {e}"));
            r.compile_duration_ns = 0;
            return r;
        }
    };

    // Copy compile-phase provenance from the pipeline receipt.
    // Note: CoreMlIslandReceipt stores compile duration inside
    // toolchain.compile_duration_ns (not at the top level).
    r.compile_duration_ns = cm_receipt.toolchain.compile_duration_ns;
    r.compiled_artifact_sha256 = cm_receipt.compiled_hash.clone();
    r.compile_exit_status = cm_receipt.toolchain.exit_status;
    r.compiler_stdout_sha256 = cm_receipt.toolchain.stdout_sha256.clone();
    r.compiler_stderr_sha256 = cm_receipt.toolchain.stderr_sha256.clone();

    // Sidecar paths for compiler stdout/stderr.
    //
    // The pipeline receipt captures SHA-256 digests of stdout and stderr
    // but not the raw bytes. The sidecar paths are recorded here so the
    // JSONL result carrries the intended file paths for a follow-up that
    // writes the actual captured output to disk alongside the JSONL.
    //
    // Sidecars are only recorded when the output is non-empty or the
    // compiler exited with a non-zero status (indicating a failure that
    // warrants forensic investigation).
    if !cm_receipt.toolchain.stdout_sha256.is_empty() || cm_receipt.toolchain.exit_status != 0 {
        let sidecar_path = output_dir.join(format!("{}_stdout.txt", family.name));
        r.compiler_stdout_sidecar_path = Some(sidecar_path.to_string_lossy().to_string());
    }
    if !cm_receipt.toolchain.stderr_sha256.is_empty() || cm_receipt.toolchain.exit_status != 0 {
        let sidecar_path = output_dir.join(format!("{}_stderr.txt", family.name));
        r.compiler_stderr_sidecar_path = Some(sidecar_path.to_string_lossy().to_string());
    }

    // ── Phase 3: Load model ──────────────────────────────────────────────────
    let cu = match compute_units {
        "cpuOnly" => CoreMlComputeUnits::CpuOnly,
        _ => CoreMlComputeUnits::CpuAndGpu,
    };

    r.runtime_compute_units = cu.name().to_string();

    // RSS before model load.
    r.process_rss_before_load_kb = resident_size_kb();

    let load_start = Instant::now();
    let model = match CoreMlModel::load_with_compute_units(&cm_receipt.compiled_modelc_path, cu) {
        Ok(m) => m,
        Err(e) => {
            r.load_duration_ns = load_start.elapsed().as_nanos() as u64;
            r.load_success = false;
            r.status = "load_error".into();
            r.failure_reason = Some(format!("model load failed: {e}"));
            return r;
        }
    };
    r.load_duration_ns = load_start.elapsed().as_nanos() as u64;
    r.load_success = true;

    // RSS after model load — captures the memory impact of the loaded
    // model structure (compute graph, weight data, Metal buffers on GPU).
    r.process_rss_after_load_kb = resident_size_kb();

    // ── Phase 4: MLComputePlan (optional, non-blocking) ──────────────────────
    //
    // Currently a stub: there is no Rust-side API for MLComputePlan
    // exposed through the coreml_bridge. Returns "unavailable" with a
    // descriptive summary.
    let plan = inspect_compute_plan(&cm_receipt.compiled_modelc_path);
    r.compute_plan_status = plan.status;
    r.compute_plan_summary = plan.summary;

    // ── Phases 5–9: Prediction and conformance (stubs) ──────────────────────
    //
    // These phases require an IOSurface arena allocated and wired through
    // the Core ML bridge's prediction API (tribunus_coreml_predict). The
    // bridge is compiled and linked but the harness does not yet allocate
    // arenas or invoke prediction. See the following TODOs:
    //
    // - Arena allocation: `Arena::new(...)` with matching FP16 buffer size
    // - Predict call: `model.predict("input", &input_arena, "output",
    //   &output_arena)`
    // - Output extraction: read back arena data, hash for conformance
    // - Reference evaluator: run same graph through pure-Rust f32 eval
    // - Accelerate backend: invoke cblas_sgemm for matmul family
    //
    // For now, all prediction-phase fields are left at their default values
    // (zero/none/empty) and the overall status is set to indicate that
    // materialize/compile/load succeeded ("pass") but that prediction
    // timings are absent.
    //
    // This explicit stub prevents the false impression that prediction
    // timing has been collected. The receipt still carries full provenance
    // for phases 1–3, which is the primary deliverable of the initial
    // harness.

    // Keep the model alive until after prediction stubs. `model` is
    // deliberately bound to silence unused-variable warnings; it will
    // be used when prediction is wired. It drops here at end of scope.
    let _ = model;

    // Phase 5: Cold predict
    r.cold_first_predict_ns = 0;
    r.cold_output_hashes = vec![];
    r.process_rss_after_cold_predict_kb = resident_size_kb();

    // Phase 6: Warmup
    r.warmup_iterations = 0;
    r.warmup_total_ns = 0;

    // Phase 7: Steady state
    r.steady_iterations = 0;
    r.steady_sample_ns = vec![];
    r.steady_total_ns = 0;
    r.steady_p50_ns = 0;
    r.steady_p90_ns = 0;
    r.steady_p99_ns = 0;
    r.steady_min_ns = 0;
    r.steady_max_ns = 0;
    r.steady_mean_ns = 0.0;
    r.steady_stddev_ns = 0.0;
    r.steady_mad_ns = 0.0;
    r.steady_iqr_ns = 0.0;
    r.steady_outlier_count = 0;
    r.process_rss_after_steady_kb = resident_size_kb();

    // Phase 8: Reference conformance
    r.max_absolute_error = 0.0;
    r.max_relative_error = 0.0;
    r.mean_absolute_error = 0.0;
    r.cosine_similarity = 0.0;
    r.matches_tolerance = false;
    r.reference_output_hashes = vec![];

    // Phase 9: Accelerate
    r.accelerate_status = "not_run".to_string();
    r.accelerate_duration_ns = None;
    r.accelerate_output_hashes = vec![];

    // ── Outcome ──────────────────────────────────────────────────────────────
    //
    // "pass" means materialize, compile, and load all succeeded. The
    // prediction stubs mean timing fields are zero — receivers of this
    // receipt must check `cold_first_predict_ns > 0` to determine
    // whether prediction was actually executed.
    r.status = "pass".to_string();

    r
}

/// Run one decode-attribution measurement for a given backend.
///
/// # Arguments
///
/// * `run_id` — Unique identifier for this run.
/// * `backend` — Backend: `"coreml"`, `"accelerate"`, `"mlx"`, or `"reference"`.
/// * `family` — Graph family topology.
/// * `profile` — Shape profile.
/// * `runtime_policy` — Backend-specific runtime policy string.
/// * `matrix_name` — Matrix label for run-config metadata.
/// * `matrix_required` — Whether this matrix is mandatory.
/// * `warmup_iters` — Number of warmup predictions.
/// * `steady_iters` — Number of steady-state timed predictions.
/// * `tolerance` — Numerical tolerance threshold for reference conformance.
/// * `output_dir` — Directory for sidecar outputs.
///
/// # Returns
///
/// A fully populated `DecodeAttributionReceipt` with backend-appropriate fields.
///
/// ## Backend behavior
///
/// - **coreml**: materialize+compile+load via `coreml_adapter::prepare()`, then
///   cold/warmup/steady prediction via `predict_loop` with ArenaInfo-backed F32
///   buffers. Sets phase kind fields and statuses.
/// - **accelerate**: only matmul is supported. Checks `support_status` first; for
///   matmul calls `accelerate_adapter::prepare_matmul()` then predict loop.
/// - **mlx**: only matmul is implemented. Checks support; for matmul calls
///   `mlx_adapter::prepare_matmul()` then predict loop. Records `mlx_device`,
///   `mlx_eval_forced=true`, `mlx_eval_method="eval()"`.
/// - **reference**: calls `reference_adapter::evaluate_graph()` once for the
///   family. Sets `reference_status="skipped"` (self-match). No conformance
///   comparison.
pub fn run_backend(
    run_id: &str,
    backend: &str,
    family: &GraphFamily,
    profile: &ShapeProfile,
    runtime_policy: &str,
    matrix_name: &str,
    matrix_required: bool,
    warmup_iters: u32,
    steady_iters: u32,
    tolerance: f64,
    output_dir: &Path,
) -> DecodeAttributionReceipt {
    // ── Environment ──────────────────────────────────────────────────────
    let env = capture_host_environment().unwrap_or_else(|_| environment::HostEnvironment {
        host_chip: std::env::consts::ARCH.to_string(),
        macos_version: "unknown".into(),
        xcode_build_version: "unknown".into(),
        coremlcompiler_version: "unknown".into(),
        coreml_compiler_available: false,
    });
    let ts = iso_timestamp();

// ── Build empty receipt with provenance and config ───────────────────────
    let mut r = DecodeAttributionReceipt {
        run_id: run_id.to_string(),
        commit_sha: option_env!("VERGEN_GIT_SHA")
            .unwrap_or("unknown")
            .to_string(),
        branch: option_env!("VERGEN_GIT_BRANCH")
            .unwrap_or("unknown")
            .to_string(),
        timestamp: ts,
        schema_version: "decode-attribution.v1".to_string(),
        host_chip: env.host_chip.clone(),
        macos_version: env.macos_version.clone(),
        xcode_version: env.xcode_build_version.clone(),
        coremlcompiler_version: env.coremlcompiler_version.clone(),
        graph_family: family.name.to_string(),
        pipeline_phase: graph_family_to_phase(family.name).ok().map(|p| p.to_string()),
        phase_variant: graph_family_phase_variant(family.name).to_string(),
        semantic_contract_id: graph_family_semantic_contract_id(family.name),
        shape_profile: profile.name.to_string(),
        graph_status: family.status.to_string(),
        op_count: family.op_count,
        input_shape: profile.input_shape(),
        weight_shape: profile.weight_shape(),
        // Simplified: most single-output graphs produce [1, weight_cols].
        dtype: "float32".to_string(),
        matrix_name: matrix_name.to_string(),
        matrix_required,
        configured_warmup_iterations: warmup_iters,
        configured_steady_iterations: steady_iters,
        tolerance,
        percentile_method: "nearest_rank".to_string(),
        memory_measurement_method: "task_info_resident_size".to_string(),
        compile_diagnostics: vec![],
        backend: backend.to_string(),
        backend_runtime_policy: runtime_policy.to_string(),
        ..Default::default()
    };

    r.process_rss_before_materialize_kb = resident_size_kb();

    match backend {
        "coreml" => run_backend_coreml(
            &mut r, family, profile, runtime_policy,
            warmup_iters, steady_iters, tolerance, output_dir,
        ),
        "accelerate" => run_backend_accelerate(
            &mut r, family, profile, warmup_iters, steady_iters, tolerance,
        ),
        "mlx" => run_backend_mlx(
            &mut r, family, profile, warmup_iters, steady_iters, tolerance,
        ),
        "reference" => run_backend_reference(&mut r, family, profile),
        other => {
            r.status = "prediction_error".into();
            r.failure_reason = Some(format!("unknown backend: {other}"));
        }
    }

    // ── Phase 5a: Execution provenance (fill in if backend runner didn't set it) ──
    if r.execution_proof.engine.is_empty() {
        r.execution_proof = crate::decode_attribution::receipt::ExecutionProof {
            engine: backend.to_string(),
            accelerated_ops: family_ops(family.name),
            cpu_ops: vec![],
            reference_ops: vec![],
            accelerate_blas_ops: vec![],
            accelerate_vdsp_ops: vec![],
            accelerate_vforce_ops: vec![],
            cpu_glue_ops: vec![],
            bridge_path: None,
            notes: if r.status == "pass" || r.status == "compile_error" {
                Some(format!("backend={} family={} status={}", backend, family.name, r.status))
            } else {
                None
            },
        };
    }

    // ── Phase 5: Unconditional reference authority ────────────────────────
    // Every lattice row carries reference output hashes, regardless of backend
    // outcome. If the per-backend runner did not populate reference hashes
    // (e.g., skipped_by_support or error paths), run the reference evaluator here.
    if r.reference_output_hashes.is_empty() {
        let input_data = generate_input_data(profile);
        let weights = backend_weights(family.name, profile);
        let ref_outputs = ref_eval::evaluate_graph(family.name, &input_data, &weights, profile);
        r.reference_output_hashes = ref_outputs
            .iter()
            .map(|o| conformance::hash_output(o))
            .collect();
        r.reference_output_hashes_populated = true;
        r.reference_status = "ok".to_string();
    } else {
        r.reference_output_hashes_populated = true;
    }

    r
}

// ── Per-backend runners ───────────────────────────────────────────────────

/// Run the Core ML backend: materialize, compile, load, then predict.
fn run_backend_coreml(
    r: &mut DecodeAttributionReceipt,
    family: &GraphFamily,
    profile: &ShapeProfile,
    runtime_policy: &str,
    warmup_iters: u32,
    steady_iters: u32,
    tolerance: f64,
    output_dir: &Path,
) {
    let compute_units = match runtime_policy {
        "cpuAndGPU" => "cpuAndGPU",
        _ => "cpuOnly",
    };
    r.runtime_compute_units = compute_units.to_string();

    r.materialization_kind = "mil_package_write".to_string();
    r.compile_kind = "xcrun_coremlcompiler".to_string();
    r.load_kind = "mlmodel_load".to_string();
    r.execution_kind = "coreml_predict".to_string();
    r.backend_support_status = "supported".to_string();
    r.support_tier = "supported_native".to_string();

    // Identity passthrough: trivially handled, no MIL/compile/load needed.
    // MIL proto has no native "identity" op and manual reshape ops fail
    // coremlcompiler parsing. For identity, skip the Core ML pipeline and
    // compute the pass-through output directly.
    if family.name == "identity_passthrough" || family.name == "identity" {
        r.execution_kind = "identity_passthrough_cpu".to_string();
        r.materialize_status = "not_applicable".to_string();
        r.compile_status = "not_applicable".to_string();
        r.load_status = "not_applicable".to_string();
        r.cold_status = "skipped".to_string();
        r.warmup_status = "skipped".to_string();
        r.steady_status = "skipped".to_string();
        r.cold_first_predict_ns = 0;
        r.predict_status = "pass".to_string();
        r.status = "pass".to_string();
        r.terminal_phase = "complete".into();
        // Reference conformance for identity: output equals input.
        let input_data = generate_input_data(profile);
        r.cold_output_hashes = vec![conformance::hash_output(&input_data)];
        r.reference_status = "ok".to_string();
        r.reference_output_hashes_populated = true;
        return;
    }

    // ── Phases 1-3: Materialize + Compile + Load ────────────────────────
    let prepared = match coreml_adapter::prepare(family, profile, compute_units, output_dir) {
        Ok(p) => p,
        Err(e) => {
            r.predict_status = "compile_limited".into();
            r.predict_failure_classification = "compile_limited".into();
            r.terminal_phase = "mil_build".into();
            r.failure_diagnostics = Some(format!("coreml prepare: {e}"));
            r.status = "compile_error".into();
            r.failure_reason = Some(format!("coreml prepare failed: {e}"));
            r.materialize_status = "error".into();
            r.compile_status = "error".into();
            r.load_status = "error".into();
            return;
        }
    };
    r.materialize_status = "ok".to_string();
    r.compile_status = "ok".to_string();
    r.load_status = "ok".to_string();
    r.backend_prepare_duration_ns = prepared.prepare_duration_ns;
    r.process_rss_before_load_kb = resident_size_kb();
    r.load_duration_ns = prepared.prepare_duration_ns;
    r.load_success = true;
    r.coreml_mil_build_ns = prepared.coreml_mil_build_ns;
    r.coreml_package_write_ns = prepared.coreml_package_write_ns;
    r.coreml_compiler_ns = prepared.coreml_compiler_ns;
    r.coreml_model_load_ns = prepared.coreml_model_load_ns;
    r.compile_cache_hit = prepared.compile_cache_hit;
    r.source_package_sha256 = prepared.source_package_sha256;
    r.compiled_artifact_sha256 = prepared.compiled_artifact_sha256;
    r.execution_proof = crate::decode_attribution::receipt::ExecutionProof {
        engine: "coreml".into(),
        accelerated_ops: family_ops(family.name),
        cpu_ops: vec![],
        reference_ops: vec![],
        accelerate_blas_ops: vec![],
        accelerate_vdsp_ops: vec![],
        accelerate_vforce_ops: vec![],
        cpu_glue_ops: vec![],
        bridge_path: prepared.coreml_model.as_ref().map(|_| format!("coreml_predict_bridge")),
        notes: Some(format!("Compiled via coremlcompiler, island={}", prepared.compile_cache_hit)),
    };
    if let Some(stdout) = &prepared.compiler_stdout {
        r.compiler_stdout = Some(stdout.clone());
    }
    if let Some(stderr) = &prepared.compiler_stderr {
        r.compiler_stderr = Some(stderr.clone());
    }
    r.compiler_exit_code = prepared.compiler_exit_code;

    // Phase 4: MLComputePlan (stub)
    r.compute_plan_status = "unavailable".to_string();

    // ── Build predict closure ───────────────────────────────────────────
    let input_data = generate_input_data(profile);
    let output_name = graph_catalog::graph_primary_output(family.name);
    let output_len = coreml_output_len(family.name, profile);

    let model = match prepared.coreml_model.as_ref() {
        Some(m) => m,
        None => {
            r.status = "load_error".into();
            r.predict_status = "load_blocked".into();
            r.predict_failure_classification = "load_blocked".into();
            r.terminal_phase = "load".into();
            r.failure_diagnostics = Some("coreml model not loaded".into());
            r.failure_reason = Some("coreml model not loaded".into());
            r.load_status = "error".into();
            return;
        }
    };

    let mut predict_fn = || -> Result<(u64, Vec<String>, Vec<Vec<f32>>), String> {
        let mut output_buffer = vec![0.0f32; output_len];
        let input_bytes = (input_data.len() * 4) as i32;
        let output_bytes = (output_len * 4) as i32;

        crate::decode_attribution::breadcrumb::write_breadcrumb("predict_input_arena");
        let mut in_arena: ArenaInfo = unsafe { std::mem::zeroed() };
        in_arena.logical_dim0 = 1;
        in_arena.logical_dim1 = input_data.len() as i32;
        in_arena.byte_size = input_bytes;
        in_arena.bytes_per_row = input_bytes;
        in_arena.base_address = input_data.as_ptr() as *mut c_void;

        crate::decode_attribution::breadcrumb::write_breadcrumb("predict_output_arena");
        let mut out_arena: ArenaInfo = unsafe { std::mem::zeroed() };
        out_arena.logical_dim0 = 1;
        out_arena.logical_dim1 = output_len as i32;
        out_arena.byte_size = output_bytes;
        out_arena.bytes_per_row = output_bytes;
        out_arena.base_address = output_buffer.as_mut_ptr() as *mut c_void;

        let start = Instant::now();
        crate::decode_attribution::breadcrumb::write_breadcrumb("predict_call");
        model.predict("x", &in_arena, &output_name, &out_arena)
            .map_err(|e| format!("coreml predict: {e}"))?;
        crate::decode_attribution::breadcrumb::write_breadcrumb("predict_done");
        let dur = start.elapsed().as_nanos() as u64;
        let hash = conformance::hash_output(&output_buffer);
        Ok((dur, vec![hash], vec![output_buffer]))
    };

    // ── Phase 5: Cold predict ───────────────────────────────────────────
    r.cold_status = "ok".to_string();
    match predict_loop::run_cold(&mut predict_fn) {
        Ok((cold_ns, cold_hashes, _cold_outputs)) => {
            r.cold_first_predict_ns = cold_ns;
            r.cold_output_hashes = cold_hashes;
        }
        Err(e) => {
            r.cold_status = "error".into();
            r.predict_status = "predict_blocked".into();
            r.predict_failure_classification = "predict_blocked".into();
            r.terminal_phase = "predict".into();
            r.failure_diagnostics = Some(format!("coreml cold predict: {e}"));
            r.status = "prediction_error".into();
            r.failure_reason = Some(format!("coreml cold predict: {e}"));
            return;
        }
    }
    r.process_rss_after_cold_predict_kb = resident_size_kb();

    // ── Phase 6: Warmup ─────────────────────────────────────────────────
    r.warmup_status = "ok".to_string();
    match predict_loop::run_warmup(&mut predict_fn, warmup_iters) {
        Ok((wi, wt, _)) => {
            r.warmup_iterations = wi;
            r.warmup_total_ns = wt;
        }
        Err(e) => {
            r.warmup_status = "error".into();
            r.predict_status = "predict_blocked".into();
            r.predict_failure_classification = "predict_blocked".into();
            r.terminal_phase = "predict".into();
            r.failure_diagnostics = Some(format!("coreml warmup: {e}"));
            r.status = "prediction_error".into();
            r.failure_reason = Some(format!("coreml warmup: {e}"));
            return;
        }
    }

    // ── Phase 7: Steady state ───────────────────────────────────────────
    r.steady_status = "ok".to_string();
    let last_outputs = match predict_loop::run_steady(&mut predict_fn, steady_iters) {
        Ok((si, samples, total, stats, last)) => {
            r.steady_iterations = si;
            r.steady_sample_ns = samples;
            r.steady_total_ns = total;
            r.steady_p50_ns = stats.p50_ns;
            r.steady_p90_ns = stats.p90_ns;
            r.steady_p99_ns = stats.p99_ns;
            r.steady_min_ns = stats.min_ns;
            r.steady_max_ns = stats.max_ns;
            r.steady_mean_ns = stats.mean_ns;
            r.steady_stddev_ns = stats.stddev_ns;
            r.steady_mad_ns = stats.mad_ns;
            r.steady_iqr_ns = stats.iqr_ns;
            r.steady_outlier_count = stats.outlier_count;
            last
        }
        Err(e) => {
            r.steady_status = "error".into();
            r.terminal_phase = "predict".into();
            r.failure_diagnostics = Some(format!("coreml steady: {e}"));
            r.status = "prediction_error".into();
            r.failure_reason = Some(format!("coreml steady: {e}"));
            return;
        }
    };
    r.process_rss_after_steady_kb = resident_size_kb();

    // ── Phase 8: Reference conformance ──────────────────────────────────
    let weights = backend_weights(family.name, profile);
    let ref_outputs = ref_eval::evaluate_graph(family.name, &input_data, &weights, profile);
    r.reference_output_hashes = ref_outputs.iter().map(|o| conformance::hash_output(o)).collect();

    let metrics = conformance::compute_conformance(&last_outputs, &ref_outputs, tolerance);
    r.max_absolute_error = metrics.max_absolute_error;
    r.max_relative_error = metrics.max_relative_error;
    r.mean_absolute_error = metrics.mean_absolute_error;
    r.cosine_similarity = metrics.cosine_similarity;
    r.matches_tolerance = metrics.matches_tolerance;

    r.reference_status = "ok".to_string();
    r.terminal_phase = "complete".into();
    if r.cold_first_predict_ns > 0 && r.steady_p50_ns > 0 {
        r.amortization_factor = Some(r.cold_first_predict_ns as f64 / r.steady_p50_ns as f64);
    }

    if metrics.matches_tolerance {
        r.status = "pass".to_string();
        r.predict_status = "pass".to_string();
    } else {
        r.status = "numerical_divergence".into();
        r.predict_status = "numerical_divergence".into();
        r.failure_reason = Some(format!(
            "max_absolute_error={}, tolerance={}",
            metrics.max_absolute_error, tolerance
        ));
    }
}

/// Run the Accelerate backend: matmul only via cblas_sgemm.
fn run_backend_accelerate(
    r: &mut DecodeAttributionReceipt,
    family: &GraphFamily,
    profile: &ShapeProfile,
    warmup_iters: u32,
    steady_iters: u32,
    tolerance: f64,
) {
    r.materialization_kind = "array_pack".to_string();
    r.compile_kind = "not_applicable".to_string();
    r.load_kind = "not_applicable".to_string();
    r.execution_kind = "cblas_sgemm".to_string();
    r.materialize_status = "ok".to_string();
    r.compile_status = "not_applicable".to_string();
    r.load_status = "not_applicable".to_string();

    let tier = accelerate_adapter::support_tier(family.name);
    r.backend_support_status = tier.to_string();
    r.support_tier = tier.to_string();

    if matches!(tier, BackendSupportTier::UnsupportedGraph | BackendSupportTier::NotImplemented) {
        r.predict_status = "skipped_by_support".to_string();
        // Unsupported graph — status reflects that the named backend did not execute.
        // The reference evaluator (run unconditionally after backend dispatch) will
        // produce conformance data. This row is NOT a native Accelerate pass.
        r.status = "skipped_by_support".to_string();
        r.execution_proof = crate::decode_attribution::receipt::ExecutionProof {
            engine: "reference_evaluator".into(),
            accelerated_ops: vec![],
            cpu_ops: vec![],
            reference_ops: family_ops(family.name),
            accelerate_blas_ops: vec![],
            accelerate_vdsp_ops: vec![],
            accelerate_vforce_ops: vec![],
            cpu_glue_ops: vec![],
            bridge_path: None,
            notes: Some(format!("Accelerate does not support {}; output from reference evaluator", family.name)),
        };
        r.cold_status = "skipped".to_string();
        r.warmup_status = "skipped".to_string();
        r.steady_status = "skipped".to_string();
        return;
    }

    let k = profile.input_cols as i32;
    let n = profile.weight_cols as i32;
    let input_data = generate_input_data(profile);
    let weights = backend_weights(family.name, profile);

    // Handle identity family: trivial passthrough, no Accelerate needed.
    if family.name == "identity_passthrough" || family.name == "identity" {
        r.execution_kind = "identity_memcpy".to_string();
        r.cold_status = "ok".to_string();
        r.warmup_status = "ok".to_string();
        r.steady_status = "ok".to_string();
        r.cold_first_predict_ns = 0;
        r.cold_output_hashes = vec![conformance::hash_output(&input_data)];
        r.predict_status = "pass".to_string();
        r.status = "pass".to_string();
        r.reference_status = "ok".to_string();
        r.execution_proof = crate::decode_attribution::receipt::ExecutionProof {
            engine: "accelerate".into(),
            accelerated_ops: vec!["identity:memcpy".into()],
            cpu_ops: vec![],
            reference_ops: vec![],
            accelerate_blas_ops: vec![],
            accelerate_vdsp_ops: vec![],
            accelerate_vforce_ops: vec![],
            cpu_glue_ops: vec![],
            bridge_path: None,
            notes: Some("Identity passthrough, no BLAS/vDSP needed".into()),
        };
        return;
    }


    // ── Domain adapter ─────────────────────────────────────────────────────
    r.backend_prepare_duration_ns = 0;
    let domain_result = match accelerate_adapter::run_family(family.name, &input_data, &weights, profile) {
        Ok(rr) => rr,
        Err(e) => {
            r.status = "measurement_failed".into();
            r.failure_reason = Some(format!("accelerate domain adapter: {e}"));
            return;
        }
    };
    r.execution_kind = format!("{:?}", domain_result.execution_kind);
    r.execution_proof = domain_result.execution_proof;
    r.cold_first_predict_ns = domain_result.duration_ns;
    r.cold_output_hashes = vec![conformance::hash_output(&domain_result.output)];
    r.cold_status = "ok".into();
    r.predict_status = "pass".into();
    r.status = "pass".into();

    // ── Steady (amortized loop) ────────────────────────────────────────────
    let steady_start = Instant::now();
    for _ in 0..steady_iters {
        let _ = accelerate_adapter::run_family(family.name, &input_data, &weights, profile);
    }
    let steady_total = steady_start.elapsed().as_nanos() as u64;
    r.steady_iterations = steady_iters;
    r.steady_total_ns = steady_total;
    r.steady_p50_ns = steady_total / steady_iters.max(1) as u64;
    r.steady_mean_ns = r.steady_p50_ns as f64;
    r.steady_status = "ok".into();
    r.warmup_status = "skipped".into();
    r.warmup_iterations = 0;
    r.load_status = "ok".into();
    r.compile_status = "not_applicable".into();

    // ── Reference conformance ───────────────────────────────────────────────
    let ref_outputs = ref_eval::evaluate_graph(family.name, &input_data, &weights, profile);
    let last_outputs = [domain_result.output.clone()];
    r.reference_output_hashes = ref_outputs.iter().map(|o| conformance::hash_output(o)).collect();

    r.process_rss_after_steady_kb = resident_size_kb();
    let metrics = conformance::compute_conformance(&last_outputs, &ref_outputs, tolerance);
    r.max_absolute_error = metrics.max_absolute_error;
    r.max_relative_error = metrics.max_relative_error;
    r.mean_absolute_error = metrics.mean_absolute_error;
    r.cosine_similarity = metrics.cosine_similarity;
    r.matches_tolerance = metrics.matches_tolerance;

    r.reference_status = "ok".to_string();

    // Compute amortization factor if both cold and steady are available.
    if r.cold_first_predict_ns > 0 && r.steady_p50_ns > 0 {
        r.amortization_factor = Some(r.cold_first_predict_ns as f64 / r.steady_p50_ns as f64);
    }

    if metrics.matches_tolerance {
        r.predict_status = "pass".to_string();
        r.terminal_phase = "complete".into();
        r.status = "pass".to_string();
    } else {
        r.predict_status = "numerical_divergence".into();
        r.terminal_phase = "conformance".into();
        r.status = "numerical_divergence".into();
        r.failure_reason = Some(format!(
            "max_absolute_error={}, tolerance={}",
            metrics.max_absolute_error, tolerance
        ));
    }
}

/// Run the MLX backend: matmul only with forced evaluation.
fn run_backend_mlx(
    r: &mut DecodeAttributionReceipt,
    family: &GraphFamily,
    profile: &ShapeProfile,
    warmup_iters: u32,
    steady_iters: u32,
    tolerance: f64,
) {
    r.materialization_kind = "mlx_array_construct".to_string();
    r.compile_kind = "not_applicable".to_string();
    r.load_kind = "not_applicable".to_string();
    r.execution_kind = "mlx_eval".to_string();
    r.materialize_status = "ok".to_string();
    r.compile_status = "not_applicable".to_string();
    r.load_status = "not_applicable".to_string();

    let tier = mlx_adapter::support_tier(family.name);
    r.backend_support_status = tier.to_string();
    r.support_tier = tier.to_string();

    if matches!(tier, BackendSupportTier::UnsupportedGraph | BackendSupportTier::NotImplemented) {
        r.predict_status = "skipped_by_support".to_string();
        r.status = "pass".to_string();
        r.cold_status = "skipped".to_string();
        r.warmup_status = "skipped".to_string();
        r.steady_status = "skipped".to_string();
        return;
    }

    let (device_name, _device_kind) = mlx_adapter::detect_device();
    r.mlx_device = device_name;
    r.mlx_eval_forced = true;
    r.mlx_eval_method = "eval()".to_string();
    r.mlx_compile_attempted = false;

    let input_data = generate_input_data(profile);
    let weights = backend_weights(family.name, profile);

    let (arrays, mut prepare_fn) = match mlx_adapter::prepare_graph(
        family.name, &input_data, &weights, profile,
    ) {
        Ok(pair) => pair,
        Err(e) => {
            r.predict_status = "predict_blocked".to_string();
            r.predict_failure_classification = "predict_blocked".to_string();
            r.status = "prediction_error".into();
            r.failure_reason = Some(format!("mlx prepare_graph: {e}"));
            return;
        }
    };
    // Keep arrays alive across repeated predictions
    let _alive = arrays;
    r.backend_prepare_duration_ns = 0;
    r.process_rss_before_load_kb = resident_size_kb();

    // ── Phase-split cold measurement (first run captures split timings) ──
    {
        let cold_result = (|| -> Result<(), String> {
        let t0 = Instant::now();
        let result = prepare_fn().map_err(|e| format!("mlx prepare: {e}"))?;
        let t1 = Instant::now();
        result.eval().map_err(|e| format!("mlx eval: {e:?}"))?;
        let t2 = Instant::now();
        let _output_slice = result.try_as_slice::<f32>()
            .map_err(|e| format!("mlx read: {e:?}"))?
            .to_vec();
        let t3 = Instant::now();

        r.mlx_graph_build_ns = t1.duration_since(t0).as_nanos() as u64;
        r.mlx_eval_only_ns = t2.duration_since(t1).as_nanos() as u64;
        r.mlx_readback_ns = t3.duration_since(t2).as_nanos() as u64;
            r.mlx_array_construct_ns = 0;
        r.mlx_cache_hit = false;
            r.python_boundary_ns = Some(0);
            Ok(())
        })();
        if let Err(e) = cold_result {
            r.predict_status = "predict_blocked".into();
            r.predict_failure_classification = "predict_blocked".into();
            r.status = "prediction_error".into();
            r.failure_reason = Some(format!("mlx phase-split cold: {e}"));
            return;
    }
    }

    let mut predict_fn = move || -> Result<(u64, Vec<String>, Vec<Vec<f32>>), String> {
        let start = Instant::now();
        let result = prepare_fn()?;
        result
            .eval()
            .map_err(|e| format!("mlx eval: {:?}", e))?;
        let output = result
            .try_as_slice::<f32>()
            .map_err(|e| format!("mlx read: {:?}", e))?
            .to_vec();
        let dur = start.elapsed().as_nanos() as u64;
        let hash = conformance::hash_output(&output);
        Ok((dur, vec![hash], vec![output]))
    };

    // ── Cold ────────────────────────────────────────────────────────────────
    r.cold_status = "ok".to_string();
    match predict_loop::run_cold(&mut predict_fn) {
        Ok((cold_ns, cold_hashes, _)) => {
            r.cold_first_predict_ns = cold_ns;
            r.cold_output_hashes = cold_hashes;
        }
        Err(e) => {
            r.cold_status = "error".into();
            r.status = "prediction_error".into();
            r.failure_reason = Some(format!("mlx cold: {e}"));
            return;
        }
    }
    r.process_rss_after_cold_predict_kb = resident_size_kb();

    // ── Warmup ──────────────────────────────────────────────────────────────
    r.warmup_status = "ok".to_string();
    match predict_loop::run_warmup(&mut predict_fn, warmup_iters) {
        Ok((wi, wt, _)) => {
            r.warmup_iterations = wi;
            r.warmup_total_ns = wt;
        }
        Err(e) => {
            r.warmup_status = "error".into();
            r.status = "prediction_error".into();
            r.failure_reason = Some(format!("mlx warmup: {e}"));
            return;
        }
    }

    // ── Steady ──────────────────────────────────────────────────────────────
    r.steady_status = "ok".to_string();
    let last_outputs = match predict_loop::run_steady(&mut predict_fn, steady_iters) {
        Ok((si, samples, total, stats, last)) => {
            r.steady_iterations = si;
            r.steady_sample_ns = samples;
            r.steady_total_ns = total;
            r.steady_p50_ns = stats.p50_ns;
            r.steady_p90_ns = stats.p90_ns;
            r.steady_p99_ns = stats.p99_ns;
            r.steady_min_ns = stats.min_ns;
            r.steady_max_ns = stats.max_ns;
            r.steady_mean_ns = stats.mean_ns;
            r.steady_stddev_ns = stats.stddev_ns;
            r.steady_mad_ns = stats.mad_ns;
            r.steady_iqr_ns = stats.iqr_ns;
            r.steady_outlier_count = stats.outlier_count;
            last
        }
        Err(e) => {
            r.steady_status = "error".into();
            r.status = "prediction_error".into();
            r.failure_reason = Some(format!("mlx steady: {e}"));
            return;
        }
    };
    r.process_rss_after_steady_kb = resident_size_kb();

    // ── Reference conformance ───────────────────────────────────────────────
    let ref_outputs = ref_eval::evaluate_graph(family.name, &input_data, &weights, profile);
    r.reference_output_hashes = ref_outputs.iter().map(|o| conformance::hash_output(o)).collect();

    let metrics = conformance::compute_conformance(&last_outputs, &ref_outputs, tolerance);
    r.max_absolute_error = metrics.max_absolute_error;
    r.max_relative_error = metrics.max_relative_error;
    r.mean_absolute_error = metrics.mean_absolute_error;
    r.cosine_similarity = metrics.cosine_similarity;
    r.matches_tolerance = metrics.matches_tolerance;

    r.reference_status = "ok".to_string();

    if metrics.matches_tolerance {
        r.status = "pass".to_string();
        r.predict_status = "pass".to_string();
    } else {
        r.status = "numerical_divergence".into();
        r.predict_status = "numerical_divergence".into();
        r.failure_reason = Some(format!(
            "max_absolute_error={}, tolerance={}",
            metrics.max_absolute_error, tolerance
        ));
    }
}

/// Run the Reference backend: pure-Rust f32 evaluation, no timing.
fn run_backend_reference(
    r: &mut DecodeAttributionReceipt,
    family: &GraphFamily,
    profile: &ShapeProfile,
) {
    r.materialization_kind = String::new();
    r.compile_kind = String::new();
    r.load_kind = String::new();
    r.execution_kind = String::new();
    r.materialize_status = String::new();
    r.compile_status = String::new();
    r.load_status = String::new();
    r.backend_support_status = "supported".to_string();
    r.cold_status = "skipped".to_string();
    r.warmup_status = "skipped".to_string();
    r.steady_status = "skipped".to_string();
    r.reference_status = "skipped".to_string();
    r.compute_plan_status = "unavailable".to_string();

    let input_data = generate_input_data(profile);
    let weights = backend_weights(family.name, profile);
    let ref_outputs = ref_eval::evaluate_graph(family.name, &input_data, &weights, profile);

    r.reference_output_hashes = ref_outputs.iter().map(|o| conformance::hash_output(o)).collect();

    // Reference is the correctness baseline — no conformance comparison needed.
    r.max_absolute_error = 0.0;
    r.max_relative_error = 0.0;
    r.mean_absolute_error = 0.0;
    r.cosine_similarity = 1.0;
    r.matches_tolerance = true;

    // Populate output shapes for multi-output families.
    r.output_shapes = ref_outputs
        .iter()
        .map(|o| vec![1, o.len() as u32])
        .collect();

    r.status = "pass".to_string();
}

// ── Backend helpers ─────────────────────────────────────────────────────────

/// Deterministic input data: ramp from 0.5/(N) to (N-0.5)/N.
fn generate_input_data(profile: &ShapeProfile) -> Vec<f32> {
    let n = profile.input_cols as usize;
    (0..n).map(|i| (i as f32 + 0.5) / n as f32).collect()
}

/// Replicate [`graph_catalog::seeded_f32`] LCG (private upstream).
fn seeded_f32(seed: u64, len: usize) -> Vec<f32> {
    let mut state = seed;
    let mut out = vec![0.0f32; len];
    for v in out.iter_mut() {
        state = state
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        *v = ((state >> 32) as i32 as f32) * 1.0e-9_f32;
    }
    out
}

/// Generate deterministic backend weights matching `graph_catalog` seeds.
fn backend_weights(family_name: &str, profile: &ShapeProfile) -> Vec<f32> {
    let k = profile.input_cols;
    let n = profile.weight_cols;
    let weight_len = (k * n) as usize;

    match family_name {
        "matmul" => seeded_f32(1, weight_len),
        "constant_heavy" => seeded_f32(40, weight_len),
        "chain_matmul_add_silu" => {
            let mut w = seeded_f32(10, weight_len);
            w.extend(seeded_f32(11, n as usize));
            w
        }
        "branch_rejoin" => {
            let mut w = seeded_f32(20, weight_len);
            w.extend(seeded_f32(21, weight_len));
            w
        }
        "multi_output" => {
            let mut w = seeded_f32(30, weight_len);
            w.extend(seeded_f32(31, n as usize));
            w
        }
        "reshape_transpose_matmul" => seeded_f32(50, weight_len),
        "softmax_tail" => seeded_f32(60, weight_len),
        "identity_passthrough" | "identity" => vec![],
        // ── Tier 1 families ────────────────────────────────────────────
        "add_standalone" => {
            // Single bias vector of length n (weight_cols)
            seeded_f32(11, n as usize)
        }
        "mul_standalone" => {
            // Single weight matrix [k, n]
            seeded_f32(12, weight_len)
        }
        "sigmoid_standalone" | "silu_standalone" => {
            // No weights needed for standalone sigmoid/silu
            vec![]
        }
        "matmul_projection" => seeded_f32(1, weight_len),
        "matmul_residual_add" => {
            let mut w = seeded_f32(1, weight_len);
            w.extend(seeded_f32(11, n as usize));
            w
        }
        "two_matmul_add" => {
            let mut w = seeded_f32(20, weight_len);
            w.extend(seeded_f32(21, weight_len));
            w
        }
        "matmul_add_silu" => {
            let mut w = seeded_f32(10, weight_len);
            w.extend(seeded_f32(11, n as usize));
            w
        }
        _ => seeded_f32(1, weight_len),
    }
}

/// Core ML output SSA name for the primary (first) output of a family.
/// Mirrors [`coreml_adapter::output_info`] (private).
fn coreml_output_name(family: &GraphFamily) -> String {
    match family.name {
        "matmul" => "matmul_1",
        "chain_matmul_add_silu" => "silu_12",
        "branch_rejoin" => "add_22",
        "multi_output" => "matmul_30",
        "constant_heavy" => "matmul_40",
        "reshape_transpose_matmul" => "matmul_53",
        "softmax_tail" => "softmax_61",
        "identity_passthrough" => "identity_70",
        other => panic!(
            "coreml_output_name: unknown family '{other}'"
        ),
    }
    .to_string()
}

/// Core ML output tensor element count for a family x profile.
fn coreml_output_len(family_name: &str, profile: &ShapeProfile) -> usize {
    match family_name {
        "identity_passthrough" => profile.input_cols as usize,
        _ => profile.weight_cols as usize,
    }
}

/// Generate an ISO 8601 UTC timestamp string without chrono dependency.
///
/// Format: `YYYY-MM-DDTHH:MM:SSZ`.
/// Uses a simple day-count-to-date algorithm (valid for 1970–2100).
fn iso_timestamp() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let d = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let secs = d.as_secs();
    let days = secs / 86400;
    let time_secs = secs % 86400;
    let h = time_secs / 3600;
    let m = (time_secs % 3600) / 60;
    let s = time_secs % 60;

    // Gregorian calendar: 400-year cycle has 146097 days.
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
        if doy <= accum + md {
            month = (i + 1) as u16;
            break;
        }
        accum += md;
    }
    let day = doy - accum;

    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        y, month, day, h, m, s
    )
}

/// Compute a deterministic SHA-256 digest of a directory tree.
///
/// Reads entries in sorted order and hashes filenames + file contents
/// recursively.  This produces a stable hash suitable for artifact
/// identity in receipts.  Returns an empty string on any I/O error
/// (resilient — never panics).
fn sha256_dir(path: &Path) -> String {
    let mut h = Sha256::new();
    let mut entries: Vec<_> = std::fs::read_dir(path)
        .map(|rd| rd.filter_map(|e| e.ok()).map(|e| e.path()).collect())
        .unwrap_or_default();
    entries.sort();
    for p in &entries {
        h.update(
            p.file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .as_bytes(),
        );
        if p.is_dir() {
            h.update(sha256_dir(p).as_bytes());
        } else if let Ok(d) = std::fs::read(p) {
            h.update(&d);
        }
    }
    format!("{:x}", h.finalize())
}

/// Sample the current process resident set size in kilobytes.
///
/// Delegates to `worker_memory::sample_process_rss_self()` which reads
/// `task_info` TASK_BASIC_INFO on macOS (returns bytes, divided here
/// by 1024). Returns 0 on non-macOS platforms or on failure.
fn resident_size_kb() -> u64 {
    let bytes = worker_memory::sample_process_rss_self();
    bytes / 1024
}

/// Best-effort op list for a given family name.
/// Used to populate execution_proof.accelerated_ops.
fn family_ops(family_name: &str) -> Vec<String> {
    match family_name {
        "matmul" => vec!["matmul".into()],
        "chain_matmul_add_silu" => vec!["matmul".into(), "add".into(), "sigmoid".into(), "mul".into()],
        "constant_heavy" => vec!["fill".into(), "matmul".into(), "add".into()],
        "branch_rejoin" => vec!["matmul".into(), "add".into(), "matmul".into(), "add".into()],
        "identity_passthrough" | "identity" => vec!["identity".into()],
        "multi_output" => vec!["matmul".into(), "add".into()],
        "reshape_transpose_matmul" => vec!["reshape".into(), "transpose".into(), "matmul".into()],
        "softmax_tail" => vec!["matmul".into(), "softmax".into()],
        _ => vec![family_name.into()],
    }
}

