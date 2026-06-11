//! Core ML backend adapter.
//!
//! F32 Vec<f32>-backed ArenaInfo predict. Materialize/compile/load phases real.

use std::path::Path;
use std::time::Instant;
use std::process::Command;

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
    let mil_start = Instant::now();
    let builder = MilBuilder::new("main")
        .input("x", mil_spec::DataType::Float32, &profile.input_shape_i64());
    let builder = (family.build)(builder, profile);
    let mut program = builder.build().map_err(|e| format!("MIL build: {e}"))?;
    let mil_build_ns = mil_start.elapsed().as_nanos() as u64;

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

    // ── Shape-contract verifier (before write_mlpackage consumes program) ──
    if let Err(shapes) = verify_shape_contract(&program, &output_names, ncols, &meta) {
        return Err(shapes);
    }

    // Write mlpackage.
    let pkg_write_start = Instant::now();
    let tmp = tempfile::tempdir().map_err(|e| format!("tempdir: {e}"))?;
    let pkg_path = mlpackage::write_mlpackage(program, tmp.path(), &meta)?;
    let package_write_ns = pkg_write_start.elapsed().as_nanos() as u64;

    // Compile.
    let compile_start = Instant::now();
    // Check if modelc already exists (cache hit detection at the directory level).
    let cmc_path = output_dir.join(format!("{}.modelc/{}.mlmodelc", island_id, island_id));
    let cache_hit = cmc_path.exists();

    let compile_result = coreml_pipeline::compile_mlpackage(
        &pkg_path, output_dir, &island_id, compute_units, "CoreML9",
    );
    let compile_ns = compile_start.elapsed().as_nanos() as u64;

    // Capture compiler stdout/stderr/exit_code.
    // The coreml_pipeline::compile_mlpackage may use xcrun coremlcompiler internally.
    // For now we record whether compilation succeeded and the duration.
    let (compiler_stdout, compiler_stderr, compiler_exit_code) = match &compile_result {
        Ok(_) => (None, None, None),
        Err(e) => (None, Some(format!("{:?}", e)), Some(1)),
    };

    // Save artifacts (before error propagation so compile failures are preserved).
    if let Ok(bc_path) = std::env::var("CML_BREADCRUMB_PATH") {
        save_coreml_artifacts(&pkg_path, &cmc_path, &island_id, &bc_path);
    }

    let cm_receipt = compile_result?;

    // Load.
    let cmc_path = output_dir.join(format!("{}.modelc/{}.mlmodelc", island_id, island_id));
    let load_start = Instant::now();
    let cu = match compute_units { "cpuAndGPU" => CoreMlComputeUnits::CpuAndGpu, _ => CoreMlComputeUnits::CpuOnly };
    let model = CoreMlModel::load_with_compute_units(&cmc_path.to_string_lossy(), cu)?;
    let load_ns = load_start.elapsed().as_nanos() as u64;

    let prepare_ns = mil_build_ns + package_write_ns + compile_ns + load_ns;
    let runtime_policy = match cu { CoreMlComputeUnits::CpuAndGpu => BackendRuntimePolicy::CoreMlCpuAndGpu, _ => BackendRuntimePolicy::CoreMlCpuOnly };

    // Save compiled artifacts to crash repro directory (if breadcrumbs enabled).
    Ok(PreparedBackendRun {
        backend: super::BackendKind::CoreMl,
        runtime_policy,
        prepare_duration_ns: prepare_ns as u64,
        mlx_device: String::new(),
        mlx_eval_forced: false,
        mlx_eval_method: String::new(),
        coreml_model: Some(model),
        coreml_mil_build_ns: mil_build_ns,
        coreml_package_write_ns: package_write_ns,
        coreml_compiler_ns: compile_ns,
        coreml_model_load_ns: load_ns,
        compile_cache_hit: cache_hit,
        source_package_sha256: cm_receipt.model_hash,
        compiled_artifact_sha256: cm_receipt.compiled_hash,
        compiler_stdout,
        compiler_stderr,
        compiler_exit_code,
    })
}

pub fn cold_predict(prepared: &PreparedBackendRun, input_name: &str, output_name: &str, input_data: &[f32], output_len: usize) -> Result<u64, String> {
    let model = prepared.coreml_model.as_ref().ok_or("no model loaded")?;
    
    // Breadcrumb 1: input feature construction
    crate::decode_attribution::breadcrumb::write_breadcrumb("input_feature_construction");
    
    let mut input_arena: ArenaInfo = unsafe { std::mem::zeroed() };
    input_arena.logical_dim0 = 1;
    input_arena.logical_dim1 = input_data.len() as i32;
    input_arena.byte_size = (input_data.len() * 4) as i32;
    input_arena.bytes_per_row = input_arena.byte_size;
    let mut input_buf = input_data.to_vec();
    input_arena.base_address = input_buf.as_mut_ptr() as *mut std::ffi::c_void;
    
    // Breadcrumb 2: output arena construction
    crate::decode_attribution::breadcrumb::write_breadcrumb("output_arena_construction");
    
    let mut output_buffer = vec![0.0f32; output_len];
    let mut output_arena: ArenaInfo = unsafe { std::mem::zeroed() };
    output_arena.logical_dim0 = 1;
    output_arena.logical_dim1 = output_len as i32;
    output_arena.byte_size = (output_len * 4) as i32;
    output_arena.bytes_per_row = output_arena.byte_size;
    output_arena.base_address = output_buffer.as_mut_ptr() as *mut std::ffi::c_void;
    
    // Breadcrumb 3: model predict call
    crate::decode_attribution::breadcrumb::write_breadcrumb("model_predict_call");
    
    let start = Instant::now();
    model.predict(input_name, &input_arena, output_name, &output_arena)?;
    
    // Breadcrumb 4: output extracted
    crate::decode_attribution::breadcrumb::write_breadcrumb("output_extracted");
    
    Ok(start.elapsed().as_nanos() as u64)
}

/// Recursive directory copy. Silently ignores errors (best-effort for artifact preservation).
fn copy_dir_recursive(src: &std::path::Path, dst: &std::path::Path) -> std::io::Result<()> {
    if !src.is_dir() { return Ok(()); }
    let _ = std::fs::create_dir_all(dst);
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let ft = entry.file_type()?;
        let src_path = entry.path();
        let dst_path = dst.join(entry.file_name());
        if ft.is_dir() {
            copy_dir_recursive(&src_path, &dst_path)?;
        } else if ft.is_file() {
            let _ = std::fs::copy(&src_path, &dst_path);
        }
    }
    Ok(())
}

/// Save .mlpackage and .mlmodelc artifacts to the crash repro directory.
/// Called before error propagation so artifacts survive both compile failures
/// and predict crashes.
fn save_coreml_artifacts(pkg_path: &std::path::Path, cmc_path: &std::path::Path, island_id: &str, breadcrumb_path: &str) {
    let repro_parent = std::path::Path::new(breadcrumb_path).parent();
    let Some(repro_dir) = repro_parent else { return };
    let art_dir = repro_dir.join("artifacts");
    let _ = std::fs::create_dir_all(&art_dir);
    let pkg_dst = art_dir.join(format!("{}.mlpackage", island_id));
    if !pkg_dst.exists() {
        let _ = copy_dir_recursive(pkg_path, &pkg_dst);
    }
    let modelc_dst = art_dir.join(format!("{}.modelc", island_id));
    if !modelc_dst.exists() {
        let _ = copy_dir_recursive(cmc_path.parent().unwrap_or(cmc_path), &modelc_dst);
    }
}

/// Verify that all output-shape-bearing locations agree before compiling.
/// Returns Ok(()) or Err with structured diagnostic naming the mismatched layers.
fn verify_shape_contract(
    program: &mil_spec::Program,
    output_names: &[String],
    ncols: u32,
    meta: &mlpackage::ModelMeta,
) -> Result<(), String> {
    let expected = vec![1i64, ncols as i64];
    let mut errors: Vec<String> = Vec::new();

    // Layer 1: Model description function output shape
    for (out_name, shape) in &meta.outputs {
        if *shape != expected {
            errors.push(format!(
                "model_desc_output: name={} shape={:?} expected={:?}",
                out_name, shape, expected
            ));
        }
    }

    // Layer 2: MIL program function output value types
    for (_, func) in &program.functions {
        for (_, block) in &func.block_specializations {
            for op in &block.operations {
                let op_name = op.outputs.first().map(|o| o.name.as_str()).unwrap_or("");
                if !output_names.iter().any(|n| n == op_name) { continue; }
                for (i, out) in op.outputs.iter().enumerate() {
                    if let Some(ref vt) = out.r#type {
                        if let Some(mil_spec::value_type::Type::TensorType(ref tt)) = vt.r#type {
                            let dims: Vec<i64> = tt.dimensions.iter().filter_map(|d| {
                                match d.dimension.as_ref()? {
                                    mil_spec::dimension::Dimension::Constant(c) => Some(c.size as i64),
                                    _ => None,
                                }
                            }).collect();
                            if dims != expected && !dims.is_empty() {
                                errors.push(format!(
                                    "mil_op_output: op={} output[{}] dims={:?} expected={:?}",
                                    op_name, i, dims, expected
                                ));
                            }
                        }
                    }
                }
            }
        }
    }

    // Layer 3: Check intermediate values for unknown dimensions
    for (_, func) in &program.functions {
        for (_, block) in &func.block_specializations {
            for op in &block.operations {
                for out in &op.outputs {
                    let op_name = op.outputs.first().map(|o| o.name.as_str()).unwrap_or("");
                    if output_names.iter().any(|n| n == op_name) { continue; }
                    if let Some(ref vt) = out.r#type {
                        if let Some(mil_spec::value_type::Type::TensorType(ref tt)) = vt.r#type {
                            let has_unknown = tt.dimensions.iter().any(|d| {
                                !matches!(d.dimension.as_ref(), Some(mil_spec::dimension::Dimension::Constant(_)))
                            });
                            if has_unknown {
                                errors.push(format!(
                                    "unknown_intermediate_shape: op={} output={} has unknown/ dynamic dimensions",
                                    op_name, out.name
                                ));
                            }
                        }
                    }
                }
            }
        }
    }

    if errors.is_empty() {
        Ok(())
    } else {
        Err(format!("shape_contract_failed: {}", errors.join("; ")))
    }
}
