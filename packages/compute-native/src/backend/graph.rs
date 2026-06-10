//! GraphBackend trait — subgraph compilation and execution.
//!
//! Graph backends accept stable compiled regions (e.g. MLP block, attention
//! block, decoder layer) rather than individual primitives.  This separates
//! Core ML and similar backends from primitive backends like MLX or Accelerate.

use super::routing::{
    BackendArtifactId,
    BackendExecutionReceipt,
    BackendId,
    CompiledRegionHandle,
    EvidenceDigest,
    GraphRegion,
    RequestedSubstrate,
};


/// Receipt from a [`GraphBackend::validate_region`] call.
///
/// Binds the validation result to the machine profile that performed it
/// so a compiled artifact is qualified for a specific OS and hardware.
#[derive(Debug, Clone)]
pub struct BackendLegalityReceipt {
    /// Whether the region is legal for this backend.
    pub legal: bool,
    /// Content-addressed identity of the region that was validated.
    pub region_digest: EvidenceDigest,
    /// Machine profile (OS version, hardware, framework UUIDs).
    pub machine_profile_digest: EvidenceDigest,
    /// Violation descriptions — empty if legal.
    pub violations: Vec<String>,
    /// Backend-specific constraint identifiers for each violation.
    pub violation_constraint_ids: Vec<String>,
    /// Wall-clock duration of the validation (ns).
    pub validation_ns: u64,
}

/// Receipt for a compiled-region execution.
#[derive(Debug, Clone)]
pub struct RegionExecutionReceipt {
    pub region_id: CompiledRegionHandle,
    pub backend_id: BackendId,
    pub requested_substrate: Option<RequestedSubstrate>,
    pub execution: BackendExecutionReceipt,
    pub compile_cache_hit: bool,
    pub compile_ns: u64,
    /// Logical tensor IDs consumed by this region execution.
    pub input_tensors: Vec<crate::backend::routing::TensorId>,
    /// Logical tensor IDs produced.
    pub output_tensors: Vec<crate::backend::routing::TensorId>,
}

/// Backend that executes compiled graph regions rather than individual
/// primitives.
///
/// Core ML is the primary target.  A region is compiled once, cached by
/// content-addressed identity, and executed many times with different
/// input tensors.
pub trait GraphBackend {
    /// Validate a graph region against this backend's constraints
    /// before compilation.  Returns a receipt describing legality
    /// and any violations found.
    ///
    /// This is the pre-compilation gate — a region that fails
    /// validation should not be compiled.
    fn validate_region(
        &self,
        region: &GraphRegion,
    ) -> Result<BackendLegalityReceipt, String>;

    /// Compile a graph region into a backend-specific artifact.
    /// Returns a stable handle and the compile duration.
    fn compile_region(
        &mut self,
        region: &GraphRegion,
    ) -> Result<(CompiledRegionHandle, u64), String>;

    /// Execute a previously-compiled region.
    fn execute_region(
        &mut self,
        region: CompiledRegionHandle,
        inputs: &[crate::backend::routing::TensorId],
    ) -> Result<RegionExecutionReceipt, String>;

    /// Return the backend identity.
    fn graph_backend_id(&self) -> BackendId;

    /// Check whether a compiled region is still cached.
    fn is_region_cached(&self, region: CompiledRegionHandle) -> bool;
}
