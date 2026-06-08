//! Tribunus Compute Kernel — native MLX backend via napi-rs.

mod attention;
pub mod arena;
pub mod arena_lifecycle;
pub mod arena_pool;
mod bridge;
pub mod capability;
pub mod compute_image;
pub mod compile_pipeline;
pub mod copy_ledger;
pub mod compile_progress;
pub mod compute_ir;
pub mod compile_state;
pub mod config;
pub mod coreml_audit;
pub mod coreml_pipeline;
pub mod coreml_bridge;
pub mod coreml_state;
pub mod cpu_benchmarks;
pub mod errors;
pub mod engine;
pub mod engine_error;
pub mod engine_policy;
pub mod engine_receipts;
pub mod executor;
pub mod external_array;
pub mod fusion_region;
mod gemma;
pub mod gpu_worker;
pub mod mlx_executor;
pub mod hybrid_profile;
pub mod transform_recipe;
pub mod kv_cache;
pub mod layout_compiler;
pub mod mapped_image;
pub mod model_store;
pub mod model_runtime;
pub mod placement_profile;
pub mod profile_compiler;
pub mod profiled_executor;
mod loader;
mod model;
pub mod operation_catalog;
pub mod primitives;
pub mod quantized;
pub mod requalification;
pub mod mlx_inventory;
pub mod mlx_patch_register;
pub mod residency;
pub mod runtime_trace;
pub mod streaming;
pub mod receipts;
mod session;
pub mod validator;
pub mod worker_memory;
pub mod worker_protocol;
pub mod worker_supervisor;
pub mod cli;

use mlx_rs::Array;
use napi_derive::napi;

#[napi]
pub fn detect_default_device() -> napi::Result<serde_json::Value> {
    let info = bridge::detect_default_device();
    Ok(serde_json::to_value(info).unwrap())
}

#[napi]
pub fn create_array_f32(
    data: napi::bindgen_prelude::Float32Array,
    shape: Vec<i32>,
) -> napi::Result<i64> {
    Ok(bridge::create_array_f32(&data, &shape) as i64)
}

#[napi]
pub fn create_array_raw(
    data: napi::bindgen_prelude::Buffer,
    shape: Vec<i32>,
    dtype_id: u32,
) -> napi::Result<i64> {
    bridge::create_array_raw(&data, &shape, dtype_id).map(|h| h as i64)
}

#[napi]
pub fn create_scalar_f32(value: f64) -> napi::Result<i64> {
    Ok(bridge::create_scalar_f32(value as f32) as i64)
}

#[napi]
pub fn array_eval(handle: i64) -> napi::Result<()> {
    bridge::array_eval(handle as u64)
}
#[napi]
pub fn array_shape(handle: i64) -> napi::Result<Vec<i32>> {
    bridge::array_shape(handle as u64)
}
#[napi]
pub fn array_size(handle: i64) -> napi::Result<u32> {
    bridge::array_size(handle as u64).map(|s| s as u32)
}
#[napi]
pub fn array_nbytes(handle: i64) -> napi::Result<u32> {
    bridge::array_nbytes(handle as u64).map(|s| s as u32)
}

#[napi]
pub fn array_data_f32(
    handle: i64,
    #[napi(ts_arg_type = "Float32Array")] mut out: napi::bindgen_prelude::Buffer,
) -> napi::Result<u32> {
    bridge::array_data_f32(handle as u64, out.as_mut()).map(|n| n as u32)
}

#[napi]
pub fn free_array(handle: i64) -> napi::Result<()> {
    bridge::free_array(handle as u64)
}
#[napi]
pub fn drain_arrays() -> napi::Result<()> {
    bridge::drain_arrays();
    Ok(())
}
#[napi]
pub fn handle_count() -> napi::Result<u32> {
    Ok(bridge::handle_count() as u32)
}

#[napi]
pub fn matmul(a: i64, b: i64) -> napi::Result<i64> {
    bridge::matmul(a as u64, b as u64).map(|h| h as i64)
}
#[napi]
pub fn add(a: i64, b: i64) -> napi::Result<i64> {
    bridge::add(a as u64, b as u64).map(|h| h as i64)
}
#[napi]
pub fn multiply(a: i64, b: i64) -> napi::Result<i64> {
    bridge::multiply(a as u64, b as u64).map(|h| h as i64)
}

#[napi]
pub fn load_safetensors(path: String) -> napi::Result<String> {
    loader::load_safetensors_json(&path)
}
#[napi]
pub fn inspect_safetensors(path: String) -> napi::Result<String> {
    loader::inspect_safetensors(&path)
}

#[napi]
pub fn gemma4_12b_config() -> napi::Result<String> {
    let c = gemma::GemmaConfig::gemma4_12b();
    serde_json::to_string(&c).map_err(|e| napi::Error::from_reason(format!("json: {}", e)))
}

#[napi]
pub fn gemma_forward(
    input_ids: napi::bindgen_prelude::Buffer,
    wh: String,
    kv: u32,
) -> napi::Result<i64> {
    let wm: std::collections::HashMap<String, u64> =
        serde_json::from_str(&wh).map_err(|e| napi::Error::from_reason(format!("json: {}", e)))?;
    let wv: Vec<(String, u64)> = wm.into_iter().collect();
    let ids = unsafe {
        std::slice::from_raw_parts(input_ids.as_ptr() as *const i32, input_ids.len() / 4)
    };
    let ia = Array::from_slice(ids, &[1, ids.len() as i32]);
    let m = gemma::GemmaModel::new(gemma::GemmaConfig::gemma4_12b(), wv)?;
    let logits = m
        .forward(&ia, kv)
        .map_err(|e| napi::Error::from_reason(format!("fwd: {:?}", e)))?;
    Ok(bridge::ARRAY_REGISTRY.write().insert(logits, None) as i64)
}

#[napi]
pub fn gemma_sample_greedy(
    input_ids: napi::bindgen_prelude::Buffer,
    wh: String,
    kv: u32,
) -> napi::Result<u32> {
    let wm: std::collections::HashMap<String, u64> =
        serde_json::from_str(&wh).map_err(|e| napi::Error::from_reason(format!("json: {}", e)))?;
    let wv: Vec<(String, u64)> = wm.into_iter().collect();
    let ids = unsafe {
        std::slice::from_raw_parts(input_ids.as_ptr() as *const i32, input_ids.len() / 4)
    };
    let ia = Array::from_slice(ids, &[1, ids.len() as i32]);
    let m = gemma::GemmaModel::new(gemma::GemmaConfig::gemma4_12b(), wv)?;
    m.sample_token(&ia, kv)
}

/// Execute the full 48-layer model from a compiled ComputeImage.
/// Returns the next token ID directly — no logits cross the FFI boundary.
#[napi]
pub fn run_full_model_from_image(
    image_dir: String,
    input_ids: napi::bindgen_prelude::Buffer,
) -> napi::Result<u32> {
    let reader = compute_image::CompiledImageReader::open(std::path::Path::new(&image_dir))?;
    let mut runtime = reader.open_runtime(compute_image::StorageBackend::Copied)?;
    let ids: Vec<i32> = input_ids
        .chunks(4)
        .map(|chunk| i32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]))
        .collect();
    runtime.run_full_model(&ids)
}

#[napi]
pub fn parse_config_only(config_path: String) -> napi::Result<String> {
    let (arch, quant, manifest) = config::parse_config(&config_path)?;
    let r = serde_json::json!({"architecture":arch,"quantization":quant,"manifest":manifest});
    serde_json::to_string_pretty(&r).map_err(|e| napi::Error::from_reason(format!("json: {}", e)))
}

#[napi]
pub fn validate_from_metadata(config_path: String, shard_jsons: String) -> napi::Result<String> {
    #[derive(serde::Deserialize)]
    struct SI {
        #[serde(rename = "filename")]
        _filename: String,
        #[serde(rename = "sha256")]
        _sha256: String,
        tensors: Vec<TI>,
    }
    #[derive(serde::Deserialize)]
    struct TI {
        name: String,
        shape: Vec<u32>,
        dtype: String,
    }
    let shards: Vec<SI> = serde_json::from_str(&shard_jsons)
        .map_err(|e| napi::Error::from_reason(format!("json: {}", e)))?;
    let (arch, quant, _) = config::parse_config(&config_path)?;
    let mut nm = std::collections::HashMap::new();
    let mut an = Vec::new();
    for s in &shards {
        for t in &s.tensors {
            an.push(t.name.clone());
            nm.insert(
                t.name.clone(),
                validator::TensorMeta {
                    name: t.name.clone(),
                    shape: t.shape.clone(),
                    dtype: t.dtype.clone(),
                },
            );
        }
    }
    let ns = config::resolve_namespace(&an).ok_or_else(|| napi::Error::from_reason("ns"))?;
    let spec = config::compile(&arch, &ns, quant.as_ref());
    serde_json::to_string_pretty(&validator::validate_bindings_from_map(&nm, &spec)?)
        .map_err(|e| napi::Error::from_reason(format!("json: {}", e)))
}

/// Compile a precompiled ComputeImage runtime artifact from a source model directory.
/// Outputs manifest.json, receipt.json, and execution-ordered segment files.
#[napi]
pub fn compile_image(source_dir: String, output_dir: String) -> napi::Result<String> {
    let image = compute_image::compile(&source_dir, &output_dir)?;
    serde_json::to_string_pretty(&image)
        .map_err(|e| napi::Error::from_reason(format!("json: {}", e)))
}

#[napi]
pub fn read_compiled_image(image_dir: String) -> napi::Result<String> {
    let reader = compute_image::read(&image_dir)?;
    let verification = reader
        .verify()
        .map_err(|e| napi::Error::from_reason(format!("verify: {}", e)))?;
    let payload = serde_json::json!({
        "manifest": reader.manifest,
        "receipt": reader.receipt,
        "verification": verification,
    });
    serde_json::to_string_pretty(&payload)
        .map_err(|e| napi::Error::from_reason(format!("json: {}", e)))
}

#[napi]
pub fn verify_compiled_image(image_dir: String) -> napi::Result<String> {
    let verification = compute_image::verify(&image_dir)?;
    serde_json::to_string_pretty(&verification)
        .map_err(|e| napi::Error::from_reason(format!("json: {}", e)))
}

/// Return the native dependency identity and capability report.
#[napi]
pub fn native_capability_report() -> napi::Result<String> {
    let report = compute_image::NativeCapabilityReport::probe();
    serde_json::to_string_pretty(&report)
        .map_err(|e| napi::Error::from_reason(format!("json: {}", e)))
}

/// Returns MLX Metal active memory in bytes, or 0 if unavailable.
#[napi]
pub fn mlx_active_memory() -> napi::Result<u32> {
    Ok(compute_image::mlx_active_memory_bytes() as u32)
}

/// Clear the MLX Metal allocator cache. Returns bytes freed.
#[napi]
pub fn mlx_clear_cache() -> napi::Result<u32> {
    Ok(compute_image::clear_mlx_cache() as u32)
}

/// Install a model for the compute engine.
#[napi]
pub fn engine_install_model(
    image_dir: String,
    profile: String,
) -> napi::Result<String> {
    Ok(format!(
        "engine_install_model: image_dir={}, profile={}",
        image_dir, profile
    ))
}

/// Generate tokens from a compiled compute image using pre-tokenized input IDs.
///
/// This is a bridge function for the napi layer.  The `input_ids` buffer
/// contains a sequence of little-endian `u32` token IDs (4 bytes each).
///
/// Returns a JSON string with the generation job ID, e.g.:
/// ```json
/// {"jobId": "a1b2c3d4-...", "streamHandle": "<napi external placeholder>"}
/// ```
///
/// The real streaming API goes through napi external — this bridge
/// demonstrates the interface shape and provides the job_id for polling.
#[napi]
pub fn engine_generate(
    image_hash: String,
    input_ids: napi::bindgen_prelude::Buffer,
    max_tokens: i32,
) -> napi::Result<String> {
    // Convert Buffer (4 bytes per u32) to Vec<u32>
    if input_ids.len() % 4 != 0 {
        return Err(napi::Error::from_reason(format!(
            "input_ids buffer length ({}) must be a multiple of 4 (u32)",
            input_ids.len(),
        )));
    }
    let ids: Vec<u32> = input_ids
        .chunks(4)
        .map(|chunk| u32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]))
        .collect();

    let mut engine = engine::ComputeEngine::new()?;

    // Set worker binary path from environment if available.
    if let Ok(path) = std::env::var("TRIBUNUS_WORKER_BINARY") {
        engine.set_worker_binary_path(path);
    }

    // Load the model.
    engine.load_model(image_hash)?;

    // Generate — returns a GenerationHandle with job_id and stream.
    let handle = engine
        .generate(&ids, max_tokens.max(0) as u32)
        .map_err(|e| napi::Error::from_reason(format!("Generation failed: {}", e)))?;

    // Return job_id as JSON; stream handle placeholder for napi external.
    let result = serde_json::json!({
        "jobId": handle.job_id,
        "streamHandle": null,
    });
    serde_json::to_string(&result)
        .map_err(|e| napi::Error::from_reason(format!("json serialize: {}", e)))
}

/// Cancel an active generation by job ID.
///
/// Bridge function — delegates to [`ComputeEngine::cancel_generation`].
/// Returns `{"cancelled": true}` on success or throws an napi error on
/// failure.  The real cancellation path requires a persistent engine
/// instance exposed as a napi external.
#[napi]
pub fn engine_cancel_generation(
    image_hash: String,
    job_id: String,
) -> napi::Result<String> {
    let mut engine = engine::ComputeEngine::new()?;

    if let Ok(path) = std::env::var("TRIBUNUS_WORKER_BINARY") {
        engine.set_worker_binary_path(path);
    }

    // Load model so the supervisor exists to forward cancellation.
    let _ = engine.load_model(image_hash);

    engine
        .cancel_generation(job_id.clone())
        .map_err(|e| napi::Error::from_reason(format!("Cancel failed: {}", e)))?;

    let result = serde_json::json!({
        "cancelled": true,
        "jobId": job_id,
    });
    serde_json::to_string(&result)
        .map_err(|e| napi::Error::from_reason(format!("json serialize: {}", e)))
}
