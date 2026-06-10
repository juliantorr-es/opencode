//! Core ML backend adapter.
//!
//! Wraps Core ML stateless prediction using F32 [`Vec<f32>`]-backed [`ArenaInfo`]
//! buffers (no IOSurface/CVPixelBuffer).  The existing Arena allocator sizes for
//! FP16 (2 bytes/element), but `tribunus_coreml_predict` wraps the pointer as
//! MLMultiArrayDataTypeFloat32 (4 bytes/element).  This adapter works around that
//! by allocating `Vec<f32>` in Rust and constructing [`ArenaInfo`] on the stack.

use std::ffi::c_void;
use std::path::Path;
use std::time::Instant;

use crate::arena::ArenaInfo;
use crate::coreml_bridge::{CoreMlComputeUnits, CoreMlModel};
use crate::coreml_pipeline;
use crate::mil_builder::MilBuilder;
use crate::mlpackage::{self, ModelMeta};
use coreml_proto::proto::mil_spec;

use super::{BackendKind, BackendRuntimePolicy, PreparedBackendRun};
use super::super::graph_catalog::GraphFamily;
use super::super::shape_profiles::ShapeProfile;

// ── Public API ─────────────────────────────────────────────────────────────

/// Prepare a Core ML backend run.
///
/// 1. Build the MIL program via [`MilBuilder`] + graph family build function.
/// 2. Write the `.mlpackage` bundle.
/// 3. Compile via `xcrun coremlcompiler`.
/// 4. Load the compiled model via [`CoreMlModel::load_with_compute_units`].
///
/// Returns a [`PreparedBackendRun`] with the loaded model and total
/// prepare duration (materialize + compile + load).
pub fn prepare(
    family: &GraphFamily,
    profile: &ShapeProfile,
    compute_units: &str,
    output_dir: &Path,
) -> Result<PreparedBackendRun, String> {
    let overall_start = Instant::now();

    // ── 1. Build MIL program ──────────────────────────────────────────
    //
    // Register the "x" input before delegating to the graph family's
    // build function (the catalog references "x" but does not define it).
    let builder = MilBuilder::new("main")
        .input("x", mil_spec::DataType::Float32, &profile.input_shape_i64());
    let builder = (family.build)(builder, profile);
    let program = builder.build().map_err(|e| format!("MIL build: {e}"))?;

    let (output_names, output_shapes) = output_info(family, profile);
    let island_id = format!("da-{}-{}", family.name, profile.name);

    let meta = ModelMeta {
        model_name: island_id.clone(),
        function_name: "main".into(),
        inputs: vec![("x".to_string(), profile.input_shape_i64())],
        outputs: output_names
            .iter()
            .zip(output_shapes.iter())
            .map(|(n, s)| (n.clone(), s.clone()))
            .collect(),
        output_name: output_names[0].clone(),
        ..Default::default()
    };

    // ── 2. Write mlpackage ────────────────────────────────────────────
    let tmp = tempfile::tempdir().map_err(|e| format!("tempdir: {e}"))?;
    let pkg_path = mlpackage::write_mlpackage(program, tmp.path(), &meta)?;
    let materialize_ns = overall_start.elapsed().as_nanos() as u64;

    // ── 3. Compile via xcrun coremlcompiler ───────────────────────────
    let compile_start = Instant::now();
    let receipt = coreml_pipeline::compile_mlpackage(
        &pkg_path,
        output_dir,
        &island_id,
        compute_units,
        "CoreML9",
    )?;
    let compile_ns = compile_start.elapsed().as_nanos() as u64;

    // ── 4. Load compiled model ────────────────────────────────────────
    let load_start = Instant::now();
    let cu = match compute_units {
        "cpuOnly" => CoreMlComputeUnits::CpuOnly,
        _ => CoreMlComputeUnits::CpuAndGpu,
    };
    let model =
        CoreMlModel::load_with_compute_units(&receipt.compiled_modelc_path, cu)?;
    let load_ns = load_start.elapsed().as_nanos() as u64;

    let prepare_duration_ns = materialize_ns + compile_ns + load_ns;

    let runtime_policy = match compute_units {
        "cpuOnly" => BackendRuntimePolicy::CoreMlCpuOnly,
        _ => BackendRuntimePolicy::CoreMlCpuAndGpu,
    };

    Ok(PreparedBackendRun {
        backend: BackendKind::CoreMl,
        runtime_policy,
        prepare_duration_ns,
        mlx_device: String::new(),
        mlx_eval_forced: false,
        mlx_eval_method: String::new(),
        coreml_model: Some(model),
    })
}

/// Run one cold (first-ever) prediction and return the elapsed duration in ns.
///
/// Allocates F32 [`Vec`] buffers for input and output, constructs two
/// [`ArenaInfo`] structs on the stack with `base_address` pointing into
/// those vecs, and calls [`CoreMlModel::predict`].
///
/// # Arena layout (per tensor)
///
/// | Field           | Value                              |
/// |-----------------|------------------------------------|
/// | `logical_dim0`  | 1                                  |
/// | `logical_dim1`  | element count                      |
/// | `byte_size`     | element_count × 4                  |
/// | `bytes_per_row` | element_count × 4 (flat, no pad)   |
/// | `base_address`  | `Vec::as_mut_ptr()` as `*mut c_void` |
/// | `pixel_format`  | 0                                  |
/// | `width`/`height`| 0                                  |
/// | `cv_buffer`     | null                               |
/// | `io_surface`    | null                               |
///
/// # Output lifecycle
///
/// The output [`Vec<f32>`] lives on this function's stack for the duration
/// of `predict` and is dropped after the timing capture.  This function does
/// NOT hash or return the output values — callers extract that data through
/// the [`conformance`](super::conformance) module by re-issuing a predict
/// with caller-owned buffers, or by wiring their own output extraction.
pub fn cold_predict(
    prepared: &PreparedBackendRun,
    input_name: &str,
    output_name: &str,
    input_data: &[f32],
    output_len: usize,
) -> Result<u64, String> {
    let model = prepared
        .coreml_model
        .as_ref()
        .ok_or_else(|| "CoreML model not loaded — call prepare() first".to_string())?;

    let input_bytes = (input_data.len() * 4) as i32;
    let output_bytes = (output_len * 4) as i32;

    // Output buffer — Core ML writes through ArenaInfo.base_address.
    let mut output_buffer = vec![0.0f32; output_len];

    // ArenaInfo has private cv_buffer/io_surface fields, so we zero-initialise
    // with `std::mem::zeroed()` (same pattern as Arena::new) and then set
    // only the public fields that the bridge reads.
    let mut input_arena: ArenaInfo = unsafe { std::mem::zeroed() };
    input_arena.logical_dim0 = 1;
    input_arena.logical_dim1 = input_data.len() as i32;
    input_arena.byte_size = input_bytes;
    input_arena.bytes_per_row = input_bytes;
    input_arena.base_address = input_data.as_ptr() as *mut c_void;

    let mut output_arena: ArenaInfo = unsafe { std::mem::zeroed() };
    output_arena.logical_dim0 = 1;
    output_arena.logical_dim1 = output_len as i32;
    output_arena.byte_size = output_bytes;
    output_arena.bytes_per_row = output_bytes;
    output_arena.base_address = output_buffer.as_mut_ptr() as *mut c_void;

    let start = Instant::now();
    model.predict(input_name, &input_arena, output_name, &output_arena)?;
    let duration = start.elapsed().as_nanos() as u64;

    Ok(duration)
}

// ── Helpers ────────────────────────────────────────────────────────────────

/// Return the output SSA names and shapes for a given graph family.
///
/// These are the values passed to `.output(...)` in the graph catalog
/// build functions, paired with their expected tensor shapes.
fn output_info(family: &GraphFamily, profile: &ShapeProfile) -> (Vec<String>, Vec<Vec<i64>>) {
    // Most families produce a single [1, weight_cols] output.
    // Multi-output and identity-passthrough are the exceptions.
    match family.name {
        "multi_output" => (
            vec!["matmul_2".into(), "add_3".into()],
            vec![vec![1, -1], vec![1, -1]],
        ),
        "identity_passthrough" => (
            vec!["identity_0".into()],
            vec![vec![1, -1]],
        ),
        "matmul" => (
            vec!["matmul_1".into()],
            vec![vec![1, -1]],
        ),
        "chain_matmul_add_silu" => (
            vec!["silu_4".into()],
            vec![vec![1, -1]],
        ),
        "branch_rejoin" => (
            vec!["add_4".into()],
            vec![vec![1, -1]],
        ),
        "constant_heavy" => (
            vec!["matmul_6".into()],
            vec![vec![1, -1]],
        ),
        "reshape_transpose_matmul" => (
            vec!["matmul_1".into()],
            vec![vec![1, -1]],
        ),
        "softmax_tail" => (
            vec!["softmax_2".into()],
            vec![vec![1, -1]],
        ),
        other => panic!(
            "coreml_adapter: unexpected graph family '{other}' — \
             add an output_info entry for it"
        ),
    }
}
