/// TransformationRecipe — describes a GPU-borne tensor transform.
///
/// This module defines the transform kinds, backends, and recipe struct
/// that the GPU worker thread executes. All types carry Debug, Clone,
/// Serialize, Deserialize for cross-thread use and inspection.

use serde::{Deserialize, Serialize};

/// Kinds of tensor transformations the GPU worker can perform.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum TransformKind {
    /// Pass data through unchanged (identity / relocation).
    Noop,
    /// Transpose a tensor (axes reordering).
    Transpose,
    /// Reshape a tensor to new dimensions.
    Reshape,
    /// Quantize a tensor to a lower-precision representation.
    Quantize,
    /// Dequantize a tensor back to a higher-precision representation.
    Dequantize,
    /// Repack tensor data into an alternative in-memory layout.
    Repack,
    /// Convert between dtypes (e.g., float32 → float16).
    DtypeConvert,
    /// Pad a tensor along specified axes.
    Pad,
    /// Convert tensor representation for CoreML compatibility.
    CoreMlRepresentation,
}

/// Backend target for executing a transformation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum TransformBackend {
    /// Execute on CPU.
    Cpu,
    /// Execute on GPU via MLX Metal.
    Gpu,
    /// Convert to CoreML format.
    CoreMl,
}

/// A fully-specified tensor transform recipe.
///
/// Combines a transform kind, target backend, and optional JSON parameters
/// (e.g., target shape, dtype, or pad sizes).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TransformationRecipe {
    /// The kind of transformation to apply.
    pub kind: TransformKind,
    /// The backend target for execution.
    pub backend: TransformBackend,
    /// Arbitrary JSON-serializable parameters.
    #[serde(default)]
    pub params: serde_json::Value,
}

impl TransformationRecipe {
    /// Create a recipe that relocates a tensor from one backend to another
    /// without changing the data itself (Noop transform).
    pub fn relocate(backend: TransformBackend) -> Self {
        Self {
            kind: TransformKind::Noop,
            backend,
            params: serde_json::Value::Null,
        }
    }

    /// Create a recipe that repacks tensor data for GPU residency.
    pub fn gpu_repack() -> Self {
        Self {
            kind: TransformKind::Repack,
            backend: TransformBackend::Gpu,
            params: serde_json::Value::Null,
        }
    }
}
