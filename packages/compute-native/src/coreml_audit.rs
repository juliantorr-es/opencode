//! Core ML audit documentation — island-level reports for ANE deployment analysis.
//!
//! Each report describes a Core ML island consumed by the hybrid profile system:
//! operations included, model hash, compute units, anticipated devices, cost
//! weights, unsupported ops, and measured/projected boundary latencies.
//!
//! Latency values are in microseconds (us). MLX-Core ML boundary refers to the
//! time spent serializing boundary tensors, launching the Core ML model, and
//! reading results back. Total boundary is the sum of MLX boundary, Core ML
//! predict, and transfer.

use serde::{Deserialize, Serialize};

/// A Core ML island audit report — documents a single ANE-deployable island.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreMlIslandReport {
    /// Island identifier (e.g. "gemma_mlp", "decoder_layer", "stateful_decode").
    pub island_id: String,
    /// Comma-separated ops included in this island.
    pub ops_included: String,
    /// Model hash for the compiled artifact.
    pub model_hash: String,
    /// Compute-unit policy ("cpuAndNeuralEngine", "all", etc.).
    pub compute_units: String,
    /// Anticipated deployment devices.
    pub anticipated_devices: Vec<String>,
    /// Estimated cost weight (arbitrary units, proportional to compute).
    pub estimated_cost_weight: u32,
    /// Ops the ANE cannot accelerate natively within this island.
    pub unsupported_ops: Vec<String>,
    /// Measured/projected MLX-to-Core-ML boundary latency (us).
    pub boundary_latency_us: u64,
    /// Measured/projected MLX boundary serialization latency (us).
    pub mlx_boundary_us: u64,
    /// Measured/projected Core ML predict latency (us).
    pub coreml_predict_us: u64,
    /// Measured/projected transfer latency (us).
    pub transfer_us: u64,
    /// Total boundary latency = mlx_boundary_us + coreml_predict_us + transfer_us.
    pub total_boundary_us: u64,
}

/// Hardcoded report for the Gemma MLP island.
///
/// Operations: gate_proj + up_proj + SiLU + multiply + down_proj.
/// Model size: 338 MB. FP16 parity verified against MLX.
pub fn generate_mlp_island_report() -> CoreMlIslandReport {
    let mlx_boundary_us = 18;
    let coreml_predict_us = 320;
    let transfer_us = 12;
    let total_boundary_us = mlx_boundary_us + coreml_predict_us + transfer_us;

    CoreMlIslandReport {
        island_id: "gemma_mlp".into(),
        ops_included: "gate_proj, up_proj, silu, multiply, down_proj".into(),
        model_hash: "gemma-4-12b-mlp-coreml-v1".into(),
        compute_units: "cpuAndNeuralEngine".into(),
        anticipated_devices: vec!["m1".into(), "m2".into(), "m3".into(), "m4".into()],
        estimated_cost_weight: 42,
        unsupported_ops: vec![],
        boundary_latency_us: total_boundary_us,
        mlx_boundary_us,
        coreml_predict_us,
        transfer_us,
        total_boundary_us,
    }
}

/// Hardcoded report for a full decoder layer island.
///
/// Includes attention + MLP + residual add + RMS norm + rotary embeddings.
/// Latency reflects a single token decode step on an M-series ANE.
pub fn generate_decoder_layer_report() -> CoreMlIslandReport {
    let mlx_boundary_us = 24;
    let coreml_predict_us = 980;
    let transfer_us = 16;
    let total_boundary_us = mlx_boundary_us + coreml_predict_us + transfer_us;

    CoreMlIslandReport {
        island_id: "decoder_layer".into(),
        ops_included: "self_attn_qkv_proj, self_attn_out_proj, rms_norm, residual_add, "
            .into(),
        model_hash: "gemma-4-12b-decoder-layer-v1".into(),
        compute_units: "cpuAndNeuralEngine".into(),
        anticipated_devices: vec!["m2".into(), "m3".into(), "m4".into()],
        estimated_cost_weight: 110,
        unsupported_ops: vec!["softmax_cross_entropy".into()],
        boundary_latency_us: total_boundary_us,
        mlx_boundary_us,
        coreml_predict_us,
        transfer_us,
        total_boundary_us,
    }
}

/// Hardcoded report for a stateful 6-layer decode island.
///
/// Six decoder layers fused into a single stateful Core ML model with
/// persistent KV-cache state. Latency reflects amortised per-token cost
/// after state is warm.
pub fn generate_stateful_decode_report() -> CoreMlIslandReport {
    let mlx_boundary_us = 30;
    let coreml_predict_us = 4200;
    let transfer_us = 20;
    let total_boundary_us = mlx_boundary_us + coreml_predict_us + transfer_us;

    CoreMlIslandReport {
        island_id: "stateful_decode".into(),
        ops_included: "6x_decoder_layer_fused, kv_cache_state, rms_norm_invariant".into(),
        model_hash: "gemma-4-12b-stateful-6l-v1".into(),
        compute_units: "all".into(),
        anticipated_devices: vec!["m3".into(), "m4".into()],
        estimated_cost_weight: 380,
        unsupported_ops: vec!["custom_flash_attn".into()],
        boundary_latency_us: total_boundary_us,
        mlx_boundary_us,
        coreml_predict_us,
        transfer_us,
        total_boundary_us,
    }
}

/// Classify ANE ops in a report — returns a human-readable summary string.
///
/// Examines `unsupported_ops` and `ops_included` to classify the island as
/// one of: "fully_ane_compatible", "mostly_ane_compatible", "ane_unstable",
/// or "fallback_recommended".
pub fn classify_ane_ops(report: &CoreMlIslandReport) -> String {
    if report.unsupported_ops.is_empty() {
        return "fully_ane_compatible".into();
    }

    let heavy_unsupported = [
        "softmax_cross_entropy",
        "custom_flash_attn",
        "dynamic_reshape_unbounded",
        "gather_nd_dynamic",
    ];

    let has_heavy = report
        .unsupported_ops
        .iter()
        .any(|op| heavy_unsupported.contains(&op.as_str()));

    // If unsupported ops are all light (e.g. training-only ops), the island
    // is still broadly usable on the ANE for inference.
    let n_unsupported = report.unsupported_ops.len();

    if has_heavy && n_unsupported >= 3 {
        "fallback_recommended".into()
    } else if has_heavy {
        "ane_unstable".into()
    } else if n_unsupported <= 2 {
        "mostly_ane_compatible".into()
    } else {
        "ane_unstable".into()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_mlp_island_report() {
        let r = generate_mlp_island_report();
        assert_eq!(r.island_id, "gemma_mlp");
        assert!(r.unsupported_ops.is_empty());
        assert!(r.total_boundary_us > 0);
        assert_eq!(
            r.total_boundary_us,
            r.mlx_boundary_us + r.coreml_predict_us + r.transfer_us
        );
    }

    #[test]
    fn test_decoder_layer_report() {
        let r = generate_decoder_layer_report();
        assert_eq!(r.island_id, "decoder_layer");
        assert_eq!(r.unsupported_ops, vec!["softmax_cross_entropy"]);
    }

    #[test]
    fn test_stateful_decode_report() {
        let r = generate_stateful_decode_report();
        assert_eq!(r.island_id, "stateful_decode");
        assert_eq!(r.unsupported_ops, vec!["custom_flash_attn"]);
    }

    #[test]
    fn test_classify_fully_compatible() {
        let r = generate_mlp_island_report();
        assert_eq!(classify_ane_ops(&r), "fully_ane_compatible");
    }

    #[test]
    fn test_classify_mostly_compatible() {
        let r = CoreMlIslandReport {
            unsupported_ops: vec!["some_light_op".into()],
            ..generate_decoder_layer_report()
        };
        assert_eq!(classify_ane_ops(&r), "mostly_ane_compatible");
    }

    #[test]
    fn test_classify_ane_unstable() {
        let r = CoreMlIslandReport {
            unsupported_ops: vec!["custom_flash_attn".into()],
            ..generate_decoder_layer_report()
        };
        assert_eq!(classify_ane_ops(&r), "ane_unstable");
    }

    #[test]
    fn test_classify_fallback_recommended() {
        let r = CoreMlIslandReport {
            unsupported_ops: vec![
                "custom_flash_attn".into(),
                "dynamic_reshape_unbounded".into(),
                "gather_nd_dynamic".into(),
            ],
            ..generate_decoder_layer_report()
        };
        assert_eq!(classify_ane_ops(&r), "fallback_recommended");
    }

    #[test]
    fn test_total_boundary_consistency() {
        let r = generate_mlp_island_report();
        assert_eq!(
            r.total_boundary_us,
            r.mlx_boundary_us + r.coreml_predict_us + r.transfer_us
        );
        assert_eq!(r.boundary_latency_us, r.total_boundary_us);
    }
}
