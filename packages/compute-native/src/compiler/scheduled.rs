//! Scheduled module — physical regions with concrete layouts, placements,
//! materializations, fusion boundaries, residency, synchronization, and
//! backend assignment.
//!
//! This is where Orion's `shape[4]` convention, fp16 IOSurface format,
//! convolution-based linear lowering, and uniform-output constraints
//! would appear as backend-specific lowering decisions. The semantic
//! graph in [`super::semantic::SemanticModule`] remains untouched.

use std::collections::HashMap;

use crate::backend::DType;
use crate::backend::routing::{
    BackendId, EvidenceDigest, LogicalShape, OperationFamily, OperationId,
    PhysicalLayout, TensorId, TensorShape,
};

// ── Physical tensor ───────────────────────────────────────────────────────

/// A tensor with concrete physical layout, storage class, and placement.
/// This is the scheduled counterpart of [`super::semantic::SemanticTensor`].
#[derive(Debug, Clone)]
pub struct PhysicalTensor {
    /// Maps back to the semantic `TensorId`.
    pub semantic_id: TensorId,
    /// Name in the scheduled module (may differ from semantic name).
    pub name: String,
    /// Concrete physical shape including any padding or stride.
    pub shape: TensorShape,
    /// Element type (may differ from semantic if cast during lowering).
    pub dtype: DType,
    /// Physical memory layout.
    pub layout: PhysicalLayout,
    /// Where this tensor resides.
    pub storage_class: StorageClass,
    /// Which backend owns this tensor.
    pub backend: BackendId,
    /// Whether this tensor is materialized (allocated) or virtual.
    pub materialized: bool,
    /// Alignment requirement in bytes.
    pub alignment: u64,
}

/// Storage class for physical tensors.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StorageClass {
    /// IOSurface-backed shared memory (Apple-specific, zero-copy capable).
    IoSurface,
    /// Heap-allocated buffer.
    Heap,
    /// Memory-mapped file.
    Mapped,
    /// Metal buffer.
    Metal,
    /// Core ML multi-array.
    CoreMlArray,
    /// Virtual (not yet allocated — placeholder for planning).
    Virtual,
}

// ── Scheduled region ──────────────────────────────────────────────────────

/// A group of operations assigned to a single backend with explicit
/// physical tensor contracts, dependency edges, and evaluation boundary.
#[derive(Debug, Clone)]
pub struct ScheduledRegion {
    /// Stable region identifier.
    pub region_id: RegionId,
    /// Human-readable label.
    pub name: String,
    /// Operations in this region (references into semantic module).
    pub operations: Vec<OperationId>,
    /// Backend assigned to execute this region.
    pub selected_backend: BackendId,
    /// Physical tensors owned or accessed by this region.
    pub physical_tensors: Vec<PhysicalTensor>,
    /// Inputs consumed from outside this region.
    pub inputs: Vec<TensorId>,
    /// Outputs produced for outside this region.
    pub outputs: Vec<TensorId>,
    /// Regions this one depends on (must complete first).
    pub dependencies: Vec<RegionDependency>,
    /// Fusion candidates within this region.
    pub fusions: Vec<FusionBoundary>,
    /// State effects of this region.
    pub state_effects: Vec<StateEffect>,
    /// Estimated temporary memory needed for this region (bytes).
    pub temp_memory_bytes: u64,
    /// Whether this region is a synchronization fence point.
    pub is_fence: bool,
}

/// Stable region identifier.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct RegionId(pub u64);

/// A dependency between two scheduled regions.
#[derive(Debug, Clone)]
pub struct RegionDependency {
    /// Region that must complete first.
    pub predecessor: RegionId,
    /// Tensors flowing across the boundary.
    pub tensors: Vec<TensorId>,
    /// Classification of the dependency.
    pub kind: DependencyKind,
}

/// Classification of a region dependency.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DependencyKind {
    /// Data dependency — consumer needs producer's output.
    Data,
    /// State dependency — consumer needs producer's state mutation.
    StateTransition,
    /// Resource dependency — shared resource needs serialization.
    Resource,
    /// Ordering constraint (no data flow).
    Ordering,
}

/// A fusion boundary within a scheduled region.
#[derive(Debug, Clone)]
pub struct FusionBoundary {
    /// Operations inside this fusion.
    pub operations: Vec<OperationId>,
    /// The fused operation family.
    pub fused_family: OperationFamily,
    /// Whether this fusion has been qualified.
    pub qualified: bool,
    /// Which backend implements this fusion.
    pub backend: Option<BackendId>,
}

/// Side effect a region has on mutable state.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StateEffect {
    /// KV cache read (non-destructive).
    KvCacheRead,
    /// KV cache write (updates the cache).
    KvCacheWrite,
    /// KV cache clear (resets for new sequence).
    KvCacheClear,
}

// ── Transfer plan ─────────────────────────────────────────────────────────

/// Describes a data transfer between two backends or storage classes.
#[derive(Debug, Clone)]
pub struct TransferPlan {
    /// Source tensor.
    pub source: TensorId,
    /// Destination tensor (may be same ID with different storage class).
    pub destination: TensorId,
    /// Source backend.
    pub source_backend: BackendId,
    /// Destination backend.
    pub dest_backend: BackendId,
    /// Source storage class.
    pub source_storage: StorageClass,
    /// Destination storage class.
    pub dest_storage: StorageClass,
    /// Estimated transfer size in bytes.
    pub size_bytes: u64,
    /// Whether this transfer can be zero-copy (same physical memory).
    pub zero_copy_capable: bool,
    /// Whether the transfer was verified as zero-copy at runtime.
    pub zero_copy_verified: bool,
    /// Whether format conversion is needed (e.g. fp16 ↔ fp32).
    pub conversion_needed: bool,
}

// ── Memory plan ───────────────────────────────────────────────────────────

/// Physical memory allocation plan for the scheduled module.
#[derive(Debug, Clone)]
pub struct MemoryPlan {
    /// Total estimated memory across all backends (bytes).
    pub total_bytes: u64,
    /// Peak memory at any synchronization point (bytes).
    pub peak_bytes: u64,
    /// Memory per backend.
    pub per_backend: HashMap<BackendId, u64>,
    /// Tensors that share physical storage (aliased).
    pub aliases: Vec<(TensorId, TensorId)>,
    /// Buffer reuse plan.
    pub buffer_reuse: Vec<BufferReuse>,
}

/// A buffer reuse opportunity — two tensors that can share the same
/// allocation because their lifetimes don't overlap.
#[derive(Debug, Clone)]
pub struct BufferReuse {
    pub tensor_a: TensorId,
    pub tensor_b: TensorId,
    pub size_bytes: u64,
}

// ── Evaluation boundary ───────────────────────────────────────────────────

/// Sealed evaluation boundary — groups regions that must be evaluated
/// together within a single synchronization domain.
#[derive(Debug, Clone)]
pub struct SealedEvaluationBoundary {
    /// Regions in this boundary.
    pub regions: Vec<RegionId>,
    /// Whether this boundary requires a synchronization fence.
    pub requires_fence: bool,
    /// Whether all regions in this boundary share the same backend.
    pub same_backend: bool,
}

// ── Scheduled module ──────────────────────────────────────────────────────

/// Complete scheduled module — the physical counterpart of
/// [`super::semantic::SemanticModule`].
///
/// Carries concrete layouts, backend assignments, fusion decisions,
/// memory plans, transfer plans, and evaluation boundaries.
#[derive(Debug, Clone)]
pub struct ScheduledModule {
    /// Content-addressed digest of this schedule.
    pub digest: EvidenceDigest,
    /// Digest of the semantic module this was derived from.
    pub source_semantic_digest: EvidenceDigest,
    /// All scheduled regions in execution order.
    pub regions: Vec<ScheduledRegion>,
    /// Data transfers between regions/backends.
    pub transfers: Vec<TransferPlan>,
    /// Memory allocation plan.
    pub memory_plan: MemoryPlan,
    /// Evaluation boundaries (synchronization domains).
    pub evaluation_boundaries: Vec<SealedEvaluationBoundary>,
    /// Machine profile this schedule targets.
    pub machine_profile_digest: EvidenceDigest,
}

impl ScheduledModule {
    /// Create a new empty scheduled module.
    pub fn new(source_semantic_digest: EvidenceDigest) -> Self {
        Self {
            digest: EvidenceDigest(String::new()),
            source_semantic_digest,
            regions: Vec::new(),
            transfers: Vec::new(),
            memory_plan: MemoryPlan {
                total_bytes: 0,
                peak_bytes: 0,
                per_backend: HashMap::new(),
                aliases: Vec::new(),
                buffer_reuse: Vec::new(),
            },
            evaluation_boundaries: Vec::new(),
            machine_profile_digest: EvidenceDigest(String::new()),
        }
    }

    /// Compute the content-addressed digest of this schedule.
    pub fn seal(&mut self) -> EvidenceDigest {
        use sha2::{Digest, Sha256};
        let mut h = Sha256::new();
        h.update(self.source_semantic_digest.0.as_bytes());
        for region in &self.regions {
            h.update(format!("{:?}", region.region_id.0).as_bytes());
            h.update(format!("{:?}", region.selected_backend.0).as_bytes());
            h.update(format!("{}", region.operations.len()).as_bytes());
        }
        let digest = format!("{:x}", h.finalize());
        self.digest = EvidenceDigest(digest.clone());
        self.digest.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_schedule_seals() {
        let mut m = ScheduledModule::new(EvidenceDigest("semantic_001".into()));
        let d = m.seal();
        assert!(!d.0.is_empty());
    }

    #[test]
    fn schedule_with_region() {
        let mut m = ScheduledModule::new(EvidenceDigest("semantic_002".into()));
        m.regions.push(ScheduledRegion {
            region_id: RegionId(1),
            name: "matmul_region".into(),
            operations: vec![OperationId(1)],
            selected_backend: BackendId(1),
            physical_tensors: vec![],
            inputs: vec![TensorId(1), TensorId(2)],
            outputs: vec![TensorId(3)],
            dependencies: vec![],
            fusions: vec![],
            state_effects: vec![],
            temp_memory_bytes: 0,
            is_fence: false,
        });
        let d = m.seal();
        assert!(!d.0.is_empty());
        assert_eq!(m.regions.len(), 1);
    }
}
