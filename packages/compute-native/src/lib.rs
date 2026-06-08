//! Tribunus Compute Kernel — native MLX backend via napi-rs.

mod attention;
pub mod arena;
pub mod arena_lifecycle;
mod bridge;
pub mod capability;
pub mod compute_image;
pub mod config;
pub mod coreml_bridge;
pub mod coreml_state;
pub mod external_array;
mod gemma;
pub mod kv_cache;
mod loader;
mod model;
pub mod primitives;
pub mod quantized;
mod session;
pub mod supervisor;
pub mod validator;

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
