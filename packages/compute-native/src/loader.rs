//! Safetensors model weight loader.
//!
//! Loads .safetensors files into the array registry, returning
//! (tensor_name, ArrayHandle) pairs for each tensor.

use crate::bridge::ARRAY_REGISTRY;
use mlx_rs::Array;
use std::path::Path;

/// A loaded tensor from a safetensors file.
#[derive(serde::Serialize)]
pub struct LoadedTensor {
    pub name: String,
    pub handle: u64,
    pub shape: Vec<i32>,
    pub dtype: String, // e.g. "Float32"
}

/// Load all tensors from a .safetensors file and register them.
/// Returns metadata about each loaded tensor.
///
/// Tensors are loaded via the safetensors crate and converted to
/// MLX arrays using `Array::try_from(TensorView)`.
pub fn load_safetensors(path: &str) -> napi::Result<Vec<LoadedTensor>> {
    let path = Path::new(path);
    if !path.exists() {
        return Err(napi::Error::from_reason(format!(
            "Safetensors file not found: {}",
            path.display()
        )));
    }

    let buffer = std::fs::read(path)
        .map_err(|e| napi::Error::from_reason(format!("Failed to read safetensors file: {}", e)))?;

    let tensors = safetensors::SafeTensors::deserialize(&buffer)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse safetensors: {:?}", e)))?;

    let mut registry = ARRAY_REGISTRY.write();
    let mut results = Vec::with_capacity(tensors.names().len());

    for name in tensors.names() {
        let view = tensors
            .tensor(name)
            .map_err(|e| napi::Error::from_reason(format!("Tensor not found: {}", e)))?;

        let data = view.data();
        let shape: Vec<i32> = view.shape().iter().map(|&d| d as i32).collect();
        let array = crate::model::tensor_view_to_array(&view);

        let shape = array.shape().to_vec();
        let dtype = format!("{:?}", array.dtype());
        let handle = registry.insert(array, None);

        results.push(LoadedTensor {
            name: name.to_string(),
            handle,
            shape,
            dtype,
        });
    }

    Ok(results)
}

/// Load a safetensors file and return a JSON summary (name → handle mapping).
///
/// This is the napi-friendly version that returns a JSON-serializable result
/// so TypeScript can consume it directly.
pub fn load_safetensors_json(path: &str) -> napi::Result<String> {
    let tensors = load_safetensors(path)?;
    serde_json::to_string(&tensors)
        .map_err(|e| napi::Error::from_reason(format!("JSON serialization error: {}", e)))
}

/// Information about a safetensors file (header only, no tensor loading).
#[derive(serde::Serialize)]
pub struct SafetensorsInfo {
    pub path: String,
    pub tensor_count: usize,
    pub tensors: Vec<TensorInfo>,
}

#[derive(serde::Serialize)]
pub struct TensorInfo {
    pub name: String,
    pub shape: Vec<i32>,
    pub dtype: String,
}

/// Read only the header of a safetensors file (no tensor data loaded).
/// Useful for inspecting available weights before deciding which to load.
pub fn inspect_safetensors(path: &str) -> napi::Result<String> {
    let path = Path::new(path);
    if !path.exists() {
        return Err(napi::Error::from_reason(format!(
            "Safetensors file not found: {}",
            path.display()
        )));
    }

    let buffer = std::fs::read(path)
        .map_err(|e| napi::Error::from_reason(format!("Failed to read safetensors file: {}", e)))?;

    let parsed = safetensors::SafeTensors::deserialize(&buffer).map_err(|e| {
        napi::Error::from_reason(format!("Failed to parse safetensors header: {:?}", e))
    })?;

    let tensor_infos: Vec<TensorInfo> = parsed
        .tensors()
        .into_iter()
        .map(|(name, view)| TensorInfo {
            name: name.to_string(),
            shape: view.shape().iter().map(|&d| d as i32).collect(),
            dtype: format!("{:?}", view.dtype()),
        })
        .collect();

    let info = SafetensorsInfo {
        path: path.display().to_string(),
        tensor_count: tensor_infos.len(),
        tensors: tensor_infos,
    };

    serde_json::to_string(&info)
        .map_err(|e| napi::Error::from_reason(format!("JSON serialization error: {}", e)))
}
