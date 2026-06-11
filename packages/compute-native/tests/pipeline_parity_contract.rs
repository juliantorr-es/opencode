//! Integration tests for INFERENCE-PIPELINE-PARITY-CONTRACT-0001.
//!
//! These tests verify that pipeline phase identity propagates correctly
//! through suite manifest rows and decode attribution receipts.

use tribunus_compute_native::decode_attribution::suite_manifest::{tier0_manifest, tier1_manifest};
use tribunus_compute_native::pipeline_parity::PipelinePhase;

// ── Suite manifest phase propagation ──────────────────────────────────────

/// Every tier 0 manifest row that maps to a valid pipeline phase must have
/// a non-empty `pipeline_phase`. Harness control families (identity_passthrough)
/// may have `None`.
#[test]
fn tier0_rows_carry_phase() {
    let m = tier0_manifest();
    for row in &m.rows {
        // Every row must have a non-empty pipeline_phase or be explicitly None
        // for harness control families.
        let has_phase = row.pipeline_phase.is_some()
            && !row.pipeline_phase.as_ref().unwrap().is_empty();
        if !has_phase {
            // Only identity_passthrough is allowed to have no phase.
            assert_eq!(
                row.family, "identity_passthrough",
                "non-control family '{}' has empty pipeline_phase",
                row.family,
            );
        }
        // All rows must have a phase_variant.
        assert!(!row.phase_variant.is_empty(), "row {} has empty phase_variant", row.row_id);
        // All rows must have a semantic_contract_id.
        assert!(!row.semantic_contract_id.is_empty(), "row {} has empty semantic_contract_id", row.row_id);
    }
}

/// Every tier 1 manifest row must have a non-empty pipeline_phase, phase_variant,
/// and semantic_contract_id. Tier 1 families do not include identity_passthrough,
/// so no rows should be None.
#[test]
fn tier1_rows_carry_phase() {
    let m = tier1_manifest();
    for row in &m.rows {
        assert!(
            row.pipeline_phase.is_some() && !row.pipeline_phase.as_ref().unwrap().is_empty(),
            "Tier 1 row {} has missing pipeline_phase",
            row.row_id,
        );
        assert!(!row.phase_variant.is_empty(), "Tier 1 row {} has empty phase_variant", row.row_id);
        assert!(!row.semantic_contract_id.is_empty(), "Tier 1 row {} has empty semantic_contract_id", row.row_id);
    }
}

/// Every pipeline_phase in the manifest should parse back to a valid PipelinePhase variant.
#[test]
fn manifest_phases_are_valid_pipeline_phases() {
    let m = tier0_manifest();
    for row in &m.rows {
        if let Some(phase) = &row.pipeline_phase {
            if !phase.is_empty() {
                let parsed: Result<PipelinePhase, _> = phase.parse();
                assert!(
                    parsed.is_ok(),
                    "row '{}' has unrecognized pipeline_phase: '{phase}'",
                    row.row_id,
                );
            }
        }
    }
}

/// Phase strings must match the canonical snake_case format from PipelinePhase::Display.
#[test]
fn manifest_phase_variants_match_expected() {
    use tribunus_compute_native::pipeline_parity::graph_family_phase_variant;
    let m = tier0_manifest();
    for row in &m.rows {
        let expected_variant = graph_family_phase_variant(&row.family);
        assert_eq!(
            row.phase_variant, expected_variant,
            "row '{}': expected phase_variant '{expected_variant}', got '{}'",
            row.row_id, row.phase_variant,
        );
    }
}

/// Every manifest family maps to a distinct semantic contract ID.
#[test]
fn manifest_semantic_contract_ids_are_deterministic() {
    use tribunus_compute_native::pipeline_parity::graph_family_semantic_contract_id;
    let m = tier0_manifest();
    for row in &m.rows {
        let expected_id = graph_family_semantic_contract_id(&row.family);
        assert_eq!(
            row.semantic_contract_id, expected_id,
            "row '{}': expected semantic_contract_id '{expected_id}', got '{}'",
            row.row_id, row.semantic_contract_id,
        );
    }
}

/// Default decode attribution receipt must have None pipeline_phase for backward compat.
#[test]
fn receipt_default_has_empty_phase() {
    use tribunus_compute_native::decode_attribution::receipt::DecodeAttributionReceipt;
    let r = DecodeAttributionReceipt::default();
    // Legacy default: pipeline_phase is None.
    assert!(
        r.pipeline_phase.is_none() || r.pipeline_phase.as_ref().unwrap().is_empty(),
        "default receipt should have empty/missing pipeline_phase",
    );
}
