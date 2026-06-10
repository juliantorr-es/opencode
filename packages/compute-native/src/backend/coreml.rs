//! Core ML graph backend — compiled model regions.
//!
//! Core ML is modeled as a subgraph backend, not a primitive backend.
//! Its useful unit of execution is a stable compiled region (attention
//! block, MLP block, decoder layer, prefill fragment).
//!
//! This is a scaffolding backend.  Every method returns "not yet
//! implemented" until native Core ML bindings are added.

use super::graph::*;
use super::routing::*;
use super::*;

/// Core ML compute-unit policies.
///
/// These constrain which compute units Core ML may use, but do NOT
/// prove that a specific execution ran on that unit.  Observed
/// placement remains `Substrate::Unknown` until native instrumentation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CoreMlComputeUnits {
    CpuOnly,
    CpuAndGpu,
    CpuAndNeuralEngine,
    All,
}

impl CoreMlComputeUnits {
    pub fn to_requested_substrate(&self) -> RequestedSubstrate {
        match self {
            CoreMlComputeUnits::CpuOnly => RequestedSubstrate::Cpu,
            CoreMlComputeUnits::CpuAndGpu => RequestedSubstrate::CpuAndGpu,
            CoreMlComputeUnits::CpuAndNeuralEngine => RequestedSubstrate::CpuAndNeuralEngine,
            CoreMlComputeUnits::All => RequestedSubstrate::All,
        }
    }
}

/// Shape constraint for a compiled Core ML region.
#[derive(Debug, Clone)]
pub struct CoreMlShapeConstraint {
    pub name: String,
    pub min_dims: Vec<u32>,
    pub max_dims: Vec<u32>,
}

/// Compiled Core ML model identity.
#[derive(Debug, Clone)]
pub struct CompiledCoreMlModel {
    pub artifact_id: BackendArtifactId,
    pub region_family: OperationFamily,
    pub compute_units: CoreMlComputeUnits,
    pub shape_constraints: Vec<CoreMlShapeConstraint>,
    pub compile_ns: u64,
}

/// Core ML graph backend.
pub struct CoreMlBackend {
    name: String,
    compiled_regions: Vec<Option<CompiledCoreMlModel>>,
}

impl CoreMlBackend {
    pub fn new() -> Self {
        Self {
            name: "coreml".into(),
            compiled_regions: Vec::new(),
        }
    }

    pub fn with_name(name: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            compiled_regions: Vec::new(),
        }
    }
}

impl Default for CoreMlBackend {
    fn default() -> Self {
        Self::new()
    }
}

impl GraphBackend for CoreMlBackend {
    fn compile_region(
        &mut self,
        _region: &GraphRegion,
    ) -> Result<(CompiledRegionHandle, u64), String> {
        Err("CoreMlBackend: compile_region not yet implemented".into())
    }

    fn execute_region(
        &mut self,
        _region: CompiledRegionHandle,
        _inputs: &[TensorHandle],
    ) -> Result<RegionExecutionReceipt, String> {
        Err("CoreMlBackend: execute_region not yet implemented".into())
    }

    fn graph_backend_id(&self) -> BackendId {
        BackendId(2)
    }

    fn is_region_cached(&self, region: CompiledRegionHandle) -> bool {
        let idx = region.0 as usize;
        idx < self.compiled_regions.len() && self.compiled_regions[idx].is_some()
    }
}
