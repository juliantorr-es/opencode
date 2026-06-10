//! Core ML backend adapter.
//!
//! F32 Vec<f32>-backed ArenaInfo predict. Materialize/compile/load phases real.

use std::path::Path;
use std::time::Instant;

use crate::arena::ArenaInfo;
use crate::coreml_bridge::{CoreMlComputeUnits, CoreMlModel};
use crate::coreml_pipeline;
use crate::decode_attribution::graph_catalog;
use crate::mil_builder::MilBuilder;
use crate::mlpackage::{self, ModelMeta};
use coreml_proto::proto::mil_spec;
use mil_spec::dimension;

use super::{BackendRuntimePolicy, PreparedBackendRun};
use super::super::graph_catalog::GraphFamily;
use super::super::shape_profiles::ShapeProfile;

pub fn prepare(
    family: &GraphFamily,
    profile: &ShapeProfile,
    compute_units: &str,
    output_dir: &Path,
) -> Result<PreparedBackendRun, String> {
    let overall_start = Instant::now();

    // Build MIL program.
    let builder = MilBuilder::new("main")
        .input("x", mil_spec::DataType::Float32, &profile.input_shape_i64());
    let builder = (family.build)(builder, profile);
    let mut program = builder.build().map_err(|e| format!("MIL build: {e}"))?;

    let ncols = if family.name == "identity_passthrough" { profile.input_cols } else { profile.weight_cols };
    let output_names: Vec<String> = graph_catalog::graph_output_names(family.name)
        .iter().map(|s| s.to_string()).collect();
    let island_id = format!("da-{}-{}", family.name, profile.name);

    // Patch MLProgram block outputs to explicit constant shapes.
    // Core ML's validator requires the MLProgram block output dimensions to
    // match the model description's function output features. The MilBuilder
    // produces unknown dimensions; we set them to explicit [1, ncols] here.
    for (_, func) in program.functions.iter_mut() {
        for (_, block) in func.block_specializations.iter_mut() {
            for op in block.operations.iter_mut() {
                for out in op.outputs.iter_mut() {
                    if !output_names.iter().any(|n| n == &out.name) { continue; }
                    if let Some(ref mut vt) = out.r#type {
                        if let Some(ref mut tt) = vt.r#type.as_mut() {
                            if let mil_spec::value_type::Type::TensorType(ref mut tensor) = tt {
                                tensor.dimensions = vec![
                                    mil_spec::Dimension {
                                        dimension: Some(dimension::Dimension::Constant(
                                            dimension::ConstantDimension { size: 1 },
                                        )),
                                    },
                                    mil_spec::Dimension {
                                        dimension: Some(dimension::Dimension::Constant(
                                            dimension::ConstantDimension { size: ncols as u64 },
                                        )),
                                    },
                                ];
                            }
                        }
                    }
                }
            }
        }
    }

    let meta = ModelMeta {
        model_name: island_id.clone(),
        function_name: "main".into(),
        inputs: vec![("x".to_string(), profile.input_shape_i64())],
        outputs: output_names.iter().map(|n| (n.clone(), vec![1, ncols as i64])).collect(),
        output_name: output_names[0].clone(),
        ..Default::default()
    };

    // Write mlpackage.
    let tmp = tempfile::tempdir().map_err(|e| format!("tempdir: {e}"))?;
    let pkg_path = mlpackage::write_mlpackage(program, tmp.path(), &meta)?;
    let materialize_ns = overall_start.elapsed().as_nanos() as u64;

    // Compile.
    let compile_start = Instant::now();
    let receipt = coreml_pipeline::compile_mlpackage(
        &pkg_path, output_dir, &island_id, compute_units, "CoreML9",
    )?;
    let compile_ns = compile_start.elapsed().as_nanos() as u64;

    // Load.
    let cmc_path = output_dir.join(format!("{}.modelc/{}.mlmodelc", island_id, island_id));
    let load_start = Instant::now();
    let cu = match compute_units { "cpuAndGPU" => CoreMlComputeUnits::CpuAndGpu, _ => CoreMlComputeUnits::CpuOnly };
    let model = CoreMlModel::load_with_compute_units(&cmc_path.to_string_lossy(), cu)?;
    let load_ns = load_start.elapsed().as_nanos() as u64;

    let prepare_ns = materialize_ns + compile_ns + load_ns;
    let runtime_policy = match cu { CoreMlComputeUnits::CpuAndGpu => BackendRuntimePolicy::CoreMlCpuAndGpu, _ => BackendRuntimePolicy::CoreMlCpuOnly };

    Ok(PreparedBackendRun {
        backend: super::BackendKind::CoreMl,
        runtime_policy,
        prepare_duration_ns: prepare_ns as u64,
        mlx_device: String::new(),
        mlx_eval_forced: false,
        mlx_eval_method: String::new(),
        coreml_model: Some(model),
    })
}

pub fn cold_predict(prepared: &PreparedBackendRun, input_name: &str, output_name: &str, input_data: &[f32], output_len: usize) -> Result<u64, String> {
    let model = prepared.coreml_model.as_ref().ok_or("no model loaded")?;
    let mut input_arena: ArenaInfo = unsafe { std::mem::zeroed() };
    input_arena.logical_dim0 = 1;
    input_arena.logical_dim1 = input_data.len() as i32;
    input_arena.byte_size = (input_data.len() * 4) as i32;
    input_arena.bytes_per_row = input_arena.byte_size;
    let mut input_buf = input_data.to_vec();
    input_arena.base_address = input_buf.as_mut_ptr() as *mut std::ffi::c_void;

    let mut output_buffer = vec![0.0f32; output_len];
    let mut output_arena: ArenaInfo = unsafe { std::mem::zeroed() };
    output_arena.logical_dim0 = 1;
    output_arena.logical_dim1 = output_len as i32;
    output_arena.byte_size = (output_len * 4) as i32;
    output_arena.bytes_per_row = output_arena.byte_size;
    output_arena.base_address = output_buffer.as_mut_ptr() as *mut std::ffi::c_void;

    let start = Instant::now();
    model.predict(input_name, &input_arena, output_name, &output_arena)?;
    Ok(start.elapsed().as_nanos() as u64)
}
