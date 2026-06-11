//! Suite manifest for FULL-INFERENCE-SUITE-QUALIFICATION-0001.
//!
//! The manifest is the authority for what the suite intends to run.
//! Every row ID is deterministic from: tier, group, family, variant, shape_profile,
//! dtype, backend, and backend_policy.

use serde::{Deserialize, Serialize};

// ── Tier ──────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum SuiteTier {
    Tier0, // Narrow control (existing 24-row catalog)
    Tier1, // Full static-op suite
    Tier2, // Decode microphase
    Tier3, // Model-block fragments
    Tier4, // Full-model or near-full-model
}

impl SuiteTier {
    pub fn as_str(&self) -> &'static str {
        match self {
            SuiteTier::Tier0 => "tier0",
            SuiteTier::Tier1 => "tier1",
            SuiteTier::Tier2 => "tier2",
            SuiteTier::Tier3 => "tier3",
            SuiteTier::Tier4 => "tier4",
        }
    }
}

// ── Row identity ──────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SuiteRow {
    /// Deterministic row ID: `{tier}/{family}/{variant}/{shape}/{backend}/{policy}`.
    pub row_id: String,
    pub tier: SuiteTier,
    pub group: String,
    pub family: String,
    pub variant: String,
    pub shape_profile: String,
    /// Semantic shape profile for Tier 2+ decode microphases.
    /// Distinguishes decode_small_v1 (hidden_dim=16) from Tier 1 small (1x4).
    /// Empty for Tier 0/1 rows where shape_profile is sufficient.
    #[serde(default)]
    pub semantic_shape_profile: String,
    pub dtype: String,
    pub backend: String,
    pub backend_policy: String,
    /// Canonical inference pipeline phase, or None for harness control families.
    pub pipeline_phase: Option<String>,
    /// Phase variant disambiguating different operations within a phase.
    pub phase_variant: String,
    /// Full semantic contract ID encoding (phase/variant).
    pub semantic_contract_id: String,
}

impl SuiteRow {
    pub fn new(
        tier: SuiteTier,
        group: &str,
        family: &str,
        variant: &str,
        shape_profile: &str,
        dtype: &str,
        backend: &str,
        backend_policy: &str,
    ) -> Self {
        let row_id = format!(
            "{}/{}/{}/{}/{}/{}",
            tier.as_str(), family, variant, shape_profile, backend, backend_policy
        );
        let (pipeline_phase, phase_variant, semantic_contract_id) = {
            use crate::pipeline_parity::{graph_family_to_phase, graph_family_phase_variant, graph_family_semantic_contract_id};
            (
                graph_family_to_phase(family).ok().map(|p| p.to_string()),
                graph_family_phase_variant(family).to_string(),
                graph_family_semantic_contract_id(family),
            )
        };
        SuiteRow {
            row_id, tier, group: group.into(), family: family.into(), variant: variant.into(),
            shape_profile: shape_profile.into(), semantic_shape_profile: String::new(), dtype: dtype.into(),
            backend: backend.into(), backend_policy: backend_policy.into(),
            pipeline_phase, phase_variant, semantic_contract_id,
        }
    }

    /// Create a row with explicit pipeline phase metadata (bypasses graph_family_to_phase lookup).
    /// Used for Tier 2+ decode microphases that don't map through the graph catalog.
    pub fn with_phase(
        tier: SuiteTier,
        group: &str,
        family: &str,
        variant: &str,
        shape_profile: &str,
        semantic_shape_profile: &str,
        dtype: &str,
        backend: &str,
        backend_policy: &str,
        pipeline_phase: Option<&str>,
        phase_variant: &str,
        semantic_contract_id: &str,
    ) -> Self {
        let row_id = format!(
            "{}/{}/{}/{}/{}/{}",
            tier.as_str(), family, variant, shape_profile, backend, backend_policy
        );
        SuiteRow {
            row_id,
            tier,
            group: group.into(),
            family: family.into(),
            variant: variant.into(),
            shape_profile: shape_profile.into(),
            semantic_shape_profile: semantic_shape_profile.into(),
            dtype: dtype.into(),
            backend: backend.into(),
            backend_policy: backend_policy.into(),
            pipeline_phase: pipeline_phase.map(String::from),
            phase_variant: phase_variant.into(),
            semantic_contract_id: semantic_contract_id.into(),
        }
    }
}

// ── Backend support status ────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum SupportStatus {
    SupportedNative,
    SupportedDomainAdapter,
    UnsupportedOp,
    UnsupportedShape,
    UnsupportedDtype,
    UnsupportedPolicy,
    EnvironmentUnavailable,
    NotAttempted,
}

impl SupportStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            SupportStatus::SupportedNative => "supported_native",
            SupportStatus::SupportedDomainAdapter => "supported_domain_adapter",
            SupportStatus::UnsupportedOp => "unsupported_op",
            SupportStatus::UnsupportedShape => "unsupported_shape",
            SupportStatus::UnsupportedDtype => "unsupported_dtype",
            SupportStatus::UnsupportedPolicy => "unsupported_policy",
            SupportStatus::EnvironmentUnavailable => "environment_unavailable",
            SupportStatus::NotAttempted => "not_attempted",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackendSupport {
    pub row_id: String,
    pub backend: String,
    pub backend_policy: String,
    pub support_status: SupportStatus,
    pub execution_kind_if_supported: Option<String>,
    pub reason: Option<String>,
}

// ── Fence requirements ────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FenceRequirement {
    pub row_id: String,
    pub backend: String,
    pub required_fence: String,
    pub fence_semantics: String,
}

// ── Manifest ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SuiteManifest {
    pub version: &'static str,
    pub description: &'static str,
    pub rows: Vec<SuiteRow>,
    pub shape_profiles: Vec<ShapeProfileEntry>,
    pub backends: Vec<BackendEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ShapeProfileEntry {
    pub name: String,
    pub rows: i64,
    pub cols: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackendEntry {
    pub name: String,
    pub policies: Vec<String>,
}

/// Build the Tier 0 manifest (narrow control).
pub fn tier0_manifest() -> SuiteManifest {
    let families = ["matmul", "constant_heavy", "chain_matmul_add_silu", "branch_rejoin"];
    let shapes = ["small", "medium"];
    let backends = [("coreml", "cpuOnly"), ("mlx", "mlx_default"), ("accelerate", "accelerate_cpu")];

    let mut rows = Vec::new();
    for (backend, policy) in &backends {
        for family in &families {
            for shape in &shapes {
                rows.push(SuiteRow::new(
                    SuiteTier::Tier0, "narrow", family, "default", shape, "f32", backend, policy,
                ));
            }
        }
    }

    let expected_count = families.len() * shapes.len() * backends.len();
    assert_eq!(rows.len(), expected_count, "Tier 0 expected {expected_count} rows");

    SuiteManifest {
        version: "full-suite.v1",
        description: "Full Inference Suite Qualification — Tier 0 (narrow control)",
        rows,
        shape_profiles: vec![
            ShapeProfileEntry { name: "small".into(), rows: 1, cols: 4 },
            ShapeProfileEntry { name: "medium".into(), rows: 1, cols: 16 },
        ],
        backends: vec![
            BackendEntry { name: "coreml".into(), policies: vec!["cpuOnly".into()] },
            BackendEntry { name: "mlx".into(), policies: vec!["mlx_default".into()] },
            BackendEntry { name: "accelerate".into(), policies: vec!["accelerate_cpu".into()] },
        ],
    }
}

/// Build the Tier 1 manifest (static-op expansion).
pub fn tier1_manifest() -> SuiteManifest {
    let families_batch1 = ["add_standalone", "mul_standalone", "sigmoid_standalone", "silu_standalone"];
    let families_batch2 = ["matmul_projection", "matmul_residual_add", "two_matmul_add", "matmul_add_silu"];
    let all_families: Vec<&str> = families_batch1.iter().chain(families_batch2.iter()).copied().collect();
    let shapes = ["small", "medium"];
    let backends = [("coreml", "cpuOnly"), ("mlx", "mlx_default"), ("accelerate", "accelerate_cpu")];

    let mut rows = Vec::new();
    for (backend, policy) in &backends {
        for family in &all_families {
            for shape in &shapes {
                rows.push(SuiteRow::new(
                    SuiteTier::Tier1, "static_op", family, "default", shape, "f32", backend, policy,
                ));
            }
        }
    }

    let expected_count = all_families.len() * shapes.len() * backends.len();
    assert_eq!(rows.len(), expected_count, "Tier 1 expected {expected_count} rows");

    SuiteManifest {
        version: "full-suite.v1",
        description: "Full Inference Suite Qualification — Tier 1 (static-op expansion)",
        rows,
        shape_profiles: vec![
            ShapeProfileEntry { name: "small".into(), rows: 1, cols: 4 },
            ShapeProfileEntry { name: "medium".into(), rows: 1, cols: 16 },
        ],
        backends: vec![
            BackendEntry { name: "coreml".into(), policies: vec!["cpuOnly".into()] },
            BackendEntry { name: "mlx".into(), policies: vec!["mlx_default".into()] },
            BackendEntry { name: "accelerate".into(), policies: vec!["accelerate_cpu".into()] },
        ],
    }
}

/// Build the Tier 2 Batch 1 manifest (decode microphase projection/residual/MLP heads).
///
/// 7 semantic contracts × 2 shape profiles × 3 backends = 42 rows.
/// Uses `SuiteRow::with_phase()` to set explicit pipeline phase metadata.
pub fn tier2_batch1_manifest() -> SuiteManifest {
    // (family, pipeline_phase_str, phase_variant, semantic_contract_id)
    const BATCH1_FAMILIES: &[(&str, &str, &str, &str)] = &[
        ("decode_qkv_projection", "qkv_projection", "combined_projection", "decode.qkv_projection.f32.v1"),
        ("decode_attention_output_projection", "attention_output_projection", "default", "decode.attention_output_projection.f32.v1"),
        ("decode_residual_add_1", "residual_add_1", "default", "decode.residual_add_1.f32.v1"),
        ("decode_mlp_gate_up_silu", "mlp_gate_up", "gated_silu", "decode.mlp_gate_up.silu.f32.v1"),
        ("decode_mlp_down", "mlp_down", "default", "decode.mlp_down.f32.v1"),
        ("decode_residual_add_2", "residual_add_2", "default", "decode.residual_add_2.f32.v1"),
        ("decode_lm_head", "lm_head", "default", "decode.lm_head.f32.v1"),
    ];
    // Semantic shape profiles for decode microphases
    const SHAPE_DEFS: &[(&str, &str)] = &[
        ("small", "decode_small_v1"),
        ("medium", "decode_medium_v1"),
    ];
    let backends = [("coreml", "cpuOnly"), ("mlx", "mlx_default"), ("accelerate", "accelerate_cpu")];

    let mut rows = Vec::new();
    for (backend, policy) in &backends {
        for (family, phase, variant, contract_id) in BATCH1_FAMILIES {
            for (shape, semantic_shape) in SHAPE_DEFS {
                rows.push(SuiteRow::with_phase(
                    SuiteTier::Tier2,
                    "decode_batch1",
                    family,
                    "default",
                    shape,
                    semantic_shape,
                    "f32",
                    backend,
                    policy,
                    Some(phase),
                    variant,
                    contract_id,
                ));
            }
        }
    }

    let expected = BATCH1_FAMILIES.len() * SHAPE_DEFS.len() * backends.len();
    assert_eq!(rows.len(), expected, "Tier 2 Batch 1 expected {expected} rows");

    SuiteManifest {
        version: "full-suite.v1",
        description: "Full Inference Suite Qualification — Tier 2 Batch 1 (decode microphase projection/residual/MLP)",
        rows,
        shape_profiles: vec![
            ShapeProfileEntry { name: "small".into(), rows: 1, cols: 16 },
            ShapeProfileEntry { name: "medium".into(), rows: 1, cols: 64 },
        ],
        backends: vec![
            BackendEntry { name: "coreml".into(), policies: vec!["cpuOnly".into()] },
            BackendEntry { name: "mlx".into(), policies: vec!["mlx_default".into()] },
            BackendEntry { name: "accelerate".into(), policies: vec!["accelerate_cpu".into()] },
        ],
    }
}

impl SuiteManifest {
    /// Serialize the manifest to a JSON file.
    pub fn write_to_file(&self, path: &std::path::Path) -> Result<(), String> {
        let json = serde_json::to_string_pretty(self).map_err(|e| format!("serialize manifest: {e}"))?;
        std::fs::write(path, &json).map_err(|e| format!("write {:?}: {e}", path))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tier0_has_24_rows() {
        let m = tier0_manifest();
        assert_eq!(m.rows.len(), 24, "Tier 0 must have exactly 24 rows");
    }

    #[test]
    fn row_ids_are_deterministic() {
        let m = tier0_manifest();
        let ids: Vec<&str> = m.rows.iter().map(|r| r.row_id.as_str()).collect();
        // Run twice — same result
        let m2 = tier0_manifest();
        let ids2: Vec<&str> = m2.rows.iter().map(|r| r.row_id.as_str()).collect();
        assert_eq!(ids, ids2, "row IDs must be deterministic across invocations");
    }

    #[test]
    fn row_ids_are_unique() {
        let m = tier0_manifest();
        let mut ids: Vec<&str> = m.rows.iter().map(|r| r.row_id.as_str()).collect();
        ids.sort();
        ids.dedup();
        assert_eq!(ids.len(), 24, "all 24 row IDs must be unique");
    }

    #[test]
    fn row_id_format() {
        let m = tier0_manifest();
        for row in &m.rows {
            assert!(row.row_id.starts_with("tier0/"), "row_id must start with tier: {}", row.row_id);
            assert_eq!(row.dtype, "f32", "default dtype must be f32");
        }
    }

    #[test]
    fn tier1_has_48_rows() {
        let m = tier1_manifest();
        assert_eq!(m.rows.len(), 48, "Tier 1 must have 48 rows (8 families × 2 shapes × 3 backends)");
    }

    #[test]
    fn tier2_batch1_has_42_rows() {
        let m = tier2_batch1_manifest();
        assert_eq!(m.rows.len(), 42, "Tier 2 Batch 1 must have 42 rows (7 families × 2 shapes × 3 backends)");
    }

    #[test]
    fn tier2_batch1_rows_have_phase_metadata() {
        let m = tier2_batch1_manifest();
        for row in &m.rows {
            assert!(row.pipeline_phase.is_some(), "row {} must have pipeline_phase", row.row_id);
            assert!(!row.phase_variant.is_empty(), "row {} must have phase_variant", row.row_id);
            assert!(!row.semantic_contract_id.is_empty(), "row {} must have semantic_contract_id", row.row_id);
            assert!(!row.semantic_shape_profile.is_empty(), "row {} must have semantic_shape_profile", row.row_id);
            assert_eq!(row.tier, SuiteTier::Tier2, "row {} must be Tier 2", row.row_id);
            assert_eq!(row.dtype, "f32", "row {} dtype", row.row_id);
        }
    }

    #[test]
    fn tier2_batch1_row_ids_are_deterministic() {
        let m1 = tier2_batch1_manifest();
        let m2 = tier2_batch1_manifest();
        for (r1, r2) in m1.rows.iter().zip(m2.rows.iter()) {
            assert_eq!(r1.row_id, r2.row_id, "row IDs must be deterministic");
        }
    }

    #[test]
    fn tier2_batch1_row_ids_are_unique() {
        let m = tier2_batch1_manifest();
        let mut ids: Vec<&str> = m.rows.iter().map(|r| r.row_id.as_str()).collect();
        ids.sort();
        ids.dedup();
        assert_eq!(ids.len(), 42, "all 42 row IDs must be unique");
    }
}
