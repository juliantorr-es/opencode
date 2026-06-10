//! Optional MLComputePlan inspection wrapper.
//!
//! Apple's MLComputePlan provides a way to estimate model cost and
//! resources before prediction and to inspect ML Program structure.
//! This module attempts to load a compute plan from a compiled .mlmodelc
//! path and captures a compact summary. Failure is non-blocking.

/// Result of optional MLComputePlan inspection.
#[derive(Debug, Clone)]
pub struct ComputePlanResult {
    /// "available" if a plan was loaded, "unavailable" on any failure.
    pub status: String,
    /// Compact structural summary when available.
    pub summary: Option<String>,
}

/// Attempt to inspect the compute plan of a compiled Core ML model.
///
/// Currently this is a stub: there is no Rust-side API for MLComputePlan
/// exposed through the coreml_bridge. The bridge would need a new FFI
/// binding for `MLModel.computePlanWithError:` and `MLComputePlan` to
/// inspect program structure and cost estimates.
///
/// Returns `Unavailable` with a descriptive summary today. Once the
/// bridge is extended, this function can call into ObjC to get real
/// compute-plan data.
pub fn inspect_compute_plan(_mlmodelc_path: &str) -> ComputePlanResult {
    // TODO: Add FFI binding for MLComputePlan inspection.
    // Requires: ObjC bridge exposes tribunus_coreml_inspect_compute_plan()
    // which calls MLModel.computePlanWithError: and reads MLComputePlan
    // properties (program structure, model cost estimate, etc.).
    ComputePlanResult {
        status: "unavailable".to_string(),
        summary: Some("compute plan inspection not yet wired through bridge; needs FFI binding for MLModel.computePlanWithError: and MLComputePlan".into()),
    }
}
