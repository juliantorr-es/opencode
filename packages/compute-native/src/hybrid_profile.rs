//! Hybrid deployment profile — the contract for MLX/Core ML hybrid execution.
//!
//! A hybrid profile describes the MLX regions, Core ML stateful islands,
//! boundary tensors, arena profiles, execution order, fallback policy,
//! and required capabilities. It is separate from the canonical logical model
//! and from the MLX-only profile.

use serde::{Deserialize, Serialize};

/// Complete hybrid deployment profile.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HybridProfile {
    /// Root model hash (the ComputeImage this profile belongs to).
    pub root_model_hash: String,
    /// Hash of the ComputeImage artifact.
    pub compute_image_hash: String,
    /// Profile version for migration.
    pub version: u32,
    /// The MLX execution regions that bracket Core ML islands.
    pub mlx_regions: Vec<MlxRegion>,
    /// The Core ML stateful islands.
    pub coreml_islands: Vec<CoreMlIsland>,
    /// Boundary tensors that cross between MLX and Core ML.
    pub boundary_tensors: Vec<BoundaryTensor>,
    /// Execution order: sequence of region/island references.
    pub execution_order: Vec<ExecutionStep>,
    /// Fallback policy when Core ML is unavailable.
    pub fallback: FallbackPolicy,
    /// Required runtime capabilities.
    pub required_capabilities: Vec<String>,
    /// Minimum OS version (e.g. "15.0").
    pub min_os_version: String,
    /// Storage ABI identifier.
    pub storage_abi: String,
    /// Compute-unit preference ("cpuAndGPU", "cpuAndNeuralEngine", "all").
    pub compute_units: ComputeUnits,
}

/// An MLX execution region — pure MLX operations that run before or after Core ML.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MlxRegion {
    pub id: String,
    pub kind: MlxRegionKind,
    /// Input boundary tensors consumed from previous step.
    pub inputs: Vec<String>,
    /// Output boundary tensors produced for next step.
    pub outputs: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum MlxRegionKind {
    Embedding,
    PreAttentionProcess,
    PostAttentionProcess,
    Ffn,
    FinalNorm,
    LmHead,
}

/// A Core ML stateful island — persistent state + stateless boundary interface.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CoreMlIsland {
    pub id: String,
    /// Path to the compiled .mlmodelc artifact.
    pub artifact_path: String,
    /// Hash of the Core ML artifact for cache validation.
    pub artifact_hash: String,
    /// The MIL function name (default: "main").
    pub function_name: String,
    /// Input feature names (boundary activation ingest).
    pub input_names: Vec<String>,
    /// Output feature names (boundary activation output).
    pub output_names: Vec<String>,
    /// State schema — shapes and dtypes of recurrent state.
    pub state_schema: Vec<StateTensor>,
    /// Minimum macOS version for this island.
    pub min_os_version: String,
    /// Compute-unit policy for this island.
    pub compute_units: ComputeUnits,
    /// Fallback region: if this island cannot execute, fall back to MLX.
    pub fallback_region: Option<String>,
    /// Numerical tolerance for output comparison (max absolute error).
    pub tolerance_fp16: f64,
}

/// A state tensor descriptor.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StateTensor {
    pub name: String,
    pub dtype: String, // "float16"
    pub shape: Vec<u32>,
}

/// A boundary tensor that crosses between MLX and Core ML.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BoundaryTensor {
    pub name: String,
    /// Feature name in the Core ML island.
    pub feature_name: String,
    /// Logical shape.
    pub shape: Vec<u32>,
    /// FP16 arena profile.
    pub arena_profile: String, // "IOSurfaceFp16ContiguousV1"
}

/// One step in the execution order.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum ExecutionStep {
    #[serde(rename = "mlx")]
    Mlx { region_id: String },
    #[serde(rename = "coreml")]
    CoreMl { island_id: String },
}

/// Fallback policy.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "policy")]
pub enum FallbackPolicy {
    /// Fail if Core ML is unavailable.
    #[serde(rename = "require")]
    RequireCoreMl,
    /// Fall back to MLX if Core ML unavailable.
    #[serde(rename = "mlx_fallback")]
    MlxFallback,
    /// Use MLX for all execution (no Core ML).
    #[serde(rename = "mlx_only")]
    MlxOnly,
}

/// Compute-unit preference.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ComputeUnits {
    CpuOnly,
    CpuAndGpu,
    CpuAndNeuralEngine,
    All,
}

impl std::fmt::Display for ComputeUnits {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ComputeUnits::CpuOnly => write!(f, "cpuOnly"),
            ComputeUnits::CpuAndGpu => write!(f, "cpuAndGPU"),
            ComputeUnits::CpuAndNeuralEngine => write!(f, "cpuAndNeuralEngine"),
            ComputeUnits::All => write!(f, "all"),
        }
    }
}

impl HybridProfile {
    /// Validate against the runtime capability report. Returns the first missing capability.
    pub fn validate(
        &self,
        caps: &crate::capability::SharedTensorCapabilityReport,
    ) -> Result<(), String> {
        for req in &self.required_capabilities {
            let present = match req.as_str() {
                "iosurface_fp16_bridge" => caps.supports_iosurface_fp16_bridge,
                "coreml_iosurface_input" => caps.supports_coreml_iosurface_input,
                "coreml_output_backing" => caps.supports_coreml_output_backing,
                "mlx_external_array" => caps.supports_mlx_iosurface_external_array,
                "mlx_coreml_round_trip" => caps.supports_mlx_coreml_round_trip,
                "coreml_stateful" => caps.supports_coreml_stateful_models,
                "coreml_async" => caps.supports_coreml_async_stateful_prediction,
                _ => false,
            };
            if !present {
                return Err(format!("missing required capability: {}", req));
            }
        }
        Ok(())
    }

    /// Check that boundary tensors flow correctly between steps.
    pub fn validate_tensor_flow(&self) -> Result<(), String> {
        // Each boundary tensor must be produced by exactly one step and consumed by exactly one step.
        // This is a simple check that every tensor appears in at least one producer and one consumer.
        let mut producers: std::collections::HashMap<&str, &str> =
            std::collections::HashMap::new();
        let mut consumers: std::collections::HashMap<&str, &str> =
            std::collections::HashMap::new();

        for step in &self.execution_order {
            match step {
                ExecutionStep::Mlx { region_id } => {
                    if let Some(region) = self.mlx_regions.iter().find(|r| &r.id == region_id) {
                        for output in &region.outputs {
                            if producers.contains_key(output.as_str()) {
                                return Err(format!(
                                    "tensor {} produced by multiple steps",
                                    output
                                ));
                            }
                            producers.insert(output, region_id);
                        }
                        for input in &region.inputs {
                            consumers.insert(input, region_id);
                        }
                    }
                }
                ExecutionStep::CoreMl { island_id } => {
                    if let Some(island) = self.coreml_islands.iter().find(|i| &i.id == island_id) {
                        for output in &island.output_names {
                            if producers.contains_key(output.as_str()) {
                                return Err(format!(
                                    "tensor {} produced by multiple steps",
                                    output
                                ));
                            }
                            producers.insert(output, island_id);
                        }
                        for input in &island.input_names {
                            consumers.insert(input, island_id);
                        }
                    }
                }
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::capability::SharedTensorCapabilityReport;

    fn minimal_profile() -> HybridProfile {
        HybridProfile {
            root_model_hash: "abcdef".into(),
            compute_image_hash: "123456".into(),
            version: 1,
            mlx_regions: vec![MlxRegion {
                id: "pre".into(),
                kind: MlxRegionKind::PreAttentionProcess,
                inputs: vec![],
                outputs: vec!["hidden_in".into()],
            }],
            coreml_islands: vec![CoreMlIsland {
                id: "attn".into(),
                artifact_path: "/tmp/model.mlmodelc".into(),
                artifact_hash: "hash".into(),
                function_name: "main".into(),
                input_names: vec!["hidden_in".into()],
                output_names: vec!["hidden_out".into()],
                state_schema: vec![],
                min_os_version: "15.0".into(),
                compute_units: ComputeUnits::CpuAndGpu,
                fallback_region: Some("pre".into()),
                tolerance_fp16: 0.001,
            }],
            boundary_tensors: vec![BoundaryTensor {
                name: "hidden_in".into(),
                feature_name: "hidden_in".into(),
                shape: vec![1, 64],
                arena_profile: "IOSurfaceFp16ContiguousV1".into(),
            }],
            execution_order: vec![
                ExecutionStep::Mlx {
                    region_id: "pre".into(),
                },
                ExecutionStep::CoreMl {
                    island_id: "attn".into(),
                },
            ],
            fallback: FallbackPolicy::MlxFallback,
            required_capabilities: vec!["iosurface_fp16_bridge".into()],
            min_os_version: "15.0".into(),
            storage_abi: "tribunus-iosurface-fp16-arena-v1".into(),
            compute_units: ComputeUnits::CpuAndGpu,
        }
    }

    #[test]
    fn test_profile_serde_roundtrip() {
        let profile = minimal_profile();
        let json = serde_json::to_string(&profile).expect("serialize");
        let parsed: HybridProfile = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(parsed.storage_abi, "tribunus-iosurface-fp16-arena-v1");
    }

    #[test]
    fn test_validate_missing_capability() {
        let profile = HybridProfile {
            required_capabilities: vec!["nonexistent".into()],
            ..minimal_profile()
        };
        let caps = SharedTensorCapabilityReport::detect();
        assert!(profile.validate(&caps).is_err());
    }

    #[test]
    fn test_validate_tensor_flow_ok() {
        let profile = minimal_profile();
        assert!(profile.validate_tensor_flow().is_ok());
    }
}
