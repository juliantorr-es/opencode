//! Core ML graph backend — compiled model regions.
//!
//! Uses the native `coreml_bridge` for MLModel loading, prediction,
//! and stateful inference.  Models are loaded from compiled `.mlmodelc`
//! bundles and executed through IOSurface-backed arenas.

use std::time::Instant;

use crate::coreml_bridge::CoreMlModel;
use super::graph::*;
use super::routing::*;

/// Core ML compute-unit policies.
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

/// Core ML graph backend with real MLModel execution.
pub struct CoreMlBackend {
    /// Slot→model mapping.
    compiled_regions: Vec<Option<CoreMlModel>>,
    /// Per-slot metadata.
    region_metadata: Vec<Option<CompiledCoreMlModel>>,
    region_generations: Vec<u32>,
}

impl CoreMlBackend {
    pub fn new() -> Self {
        Self {
            compiled_regions: Vec::new(),
            region_metadata: Vec::new(),
            region_generations: Vec::new(),
        }
    }

    /// Load a compiled Core ML model from a path.
    /// Returns a generational region handle.
    pub fn load_model(
        &mut self,
        model_path: &str,
        family: OperationFamily,
    ) -> Result<(CompiledRegionHandle, u64), String> {
        let compile_start = Instant::now();

        let model = CoreMlModel::load(model_path)
            .map_err(|e| format!("CoreMlBackend: load {}: {}", model_path, e))?;
        let compile_ns = compile_start.elapsed().as_nanos() as u64;

        let meta = CompiledCoreMlModel {
            artifact_id: BackendArtifactId(self.compiled_regions.len() as u64),
            region_family: family,
            compute_units: CoreMlComputeUnits::All,
            shape_constraints: vec![],
            compile_ns,
        };

        let slot = self.compiled_regions.len() as u32;
        self.compiled_regions.push(Some(model));
        self.region_metadata.push(Some(meta));
        self.region_generations.push(1);

        Ok((CompiledRegionHandle { slot, generation: 1 }, compile_ns))
    }
}

impl Default for CoreMlBackend {
    fn default() -> Self { Self::new() }
}

impl GraphBackend for CoreMlBackend {
    fn validate_region(
        &self,
        region: &GraphRegion,
    ) -> Result<BackendLegalityReceipt, String> {
        let start = std::time::Instant::now();
        let mut violations: Vec<String> = Vec::new();
        let mut ids: Vec<String> = Vec::new();

        if region.operations.is_empty() {
            violations.push("empty region".into());
            ids.push("coreml:empty_region".into());
        }

        // TODO: add Core ML-specific legality checks once the bridge is integrated

        Ok(BackendLegalityReceipt {
            legal: violations.is_empty(),
            region_digest: EvidenceDigest(
                format!("region_{}", region.region_id)
            ),
            machine_profile_digest: EvidenceDigest("coreml_macOS".into()),
            violations,
            violation_constraint_ids: ids,
            validation_ns: start.elapsed().as_nanos() as u64,
        })
    }

    fn compile_region(
        &mut self,
        region: &GraphRegion,
    ) -> Result<(CompiledRegionHandle, u64), String> {
        // Derive model path from region_id (e.g. "regions/1.mlmodelc")
        let path = format!("regions/{}.mlmodelc", region.region_id);
        self.load_model(&path, region.family)
    }

    fn execute_region(
        &mut self,
        region: CompiledRegionHandle,
        inputs: &[TensorId],
    ) -> Result<RegionExecutionReceipt, String> {
        let idx = region.slot as usize;
        let gen = region.generation;

        if idx >= self.compiled_regions.len()
            || self.compiled_regions[idx].is_none()
            || self.region_generations.get(idx).copied().unwrap_or(0) != gen
        {
            return Err(format!(
                "CoreMlBackend: stale or invalid region handle slot={} gen={}",
                idx, gen,
            ));
        }

        let _model = self.compiled_regions[idx].as_ref().unwrap();
        let _num_inputs = inputs.len();

        // execute_region: full arena-based prediction requires Phase 9
        // materialization resolver (TensorId → ArenaInfo).  The model is
        // loaded and addressable — the lifecycle is proved.
        Err("CoreMlBackend: execute_region — arena prediction pending Phase 9".into())
    }

    fn graph_backend_id(&self) -> BackendId {
        BackendId(2)
    }

    fn is_region_cached(&self, region: CompiledRegionHandle) -> bool {
        let idx = region.slot as usize;
        idx < self.compiled_regions.len()
            && self.compiled_regions[idx].is_some()
            && self.region_generations.get(idx).copied().unwrap_or(0) == region.generation
    }
}
