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
    GraphRegion,
    RequestedSubstrate,
};

use super::TensorHandle;

/// Receipt for a compiled-region execution.
#[derive(Debug, Clone)]
pub struct RegionExecutionReceipt {
    pub region_id: CompiledRegionHandle,
    pub backend_id: BackendId,
    pub requested_substrate: Option<RequestedSubstrate>,
    pub execution: BackendExecutionReceipt,
    pub compile_cache_hit: bool,
    pub compile_ns: u64,
}

/// Backend that executes compiled graph regions rather than individual
/// primitives.
///
/// Core ML is the primary target.  A region is compiled once, cached by
/// content-addressed identity, and executed many times with different
/// input tensors.
pub trait GraphBackend {
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
        inputs: &[TensorHandle],
    ) -> Result<RegionExecutionReceipt, String>;

    /// Return the backend identity.
    fn graph_backend_id(&self) -> BackendId;

    /// Check whether a compiled region is still cached.
    fn is_region_cached(&self, region: CompiledRegionHandle) -> bool;
}
