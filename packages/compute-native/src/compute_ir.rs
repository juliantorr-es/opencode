//! ComputeExecutionIR — structured intermediate representation for compute graph
//! analysis, alias resolution, layer partitioning, and region-based scheduling.
//!
//! The IR captures every tensor with logical (model-level) and physical
//! (runtime-level) type/shape annotations, tracks aliasing relationships,
//! groups tensors into layers, and decomposes the execution graph into
//! scheduling regions with dependency edges, fusion candidates, and
//! state-effect annotations.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

// ── QuantMode ──────────────────────────────────────────────────────────────

/// Quantization mode applied to a tensor.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum QuantMode {
    None,
    Int4,
    Int8,
    Float8,
    BlockFloat8,
    BlockInt4,
    BlockInt8,
    MixedPrecision,
}

// ── TensorDisposition ──────────────────────────────────────────────────────

/// Placement disposition of a tensor within the memory hierarchy.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum TensorDisposition {
    /// Stays resident in GPU/accelerator memory for the full region lifetime.
    Resident,
    /// Evicted to host memory; fetched on demand.
    Swapped,
    /// Page-locked host memory for fast DMA transfers.
    Pinned,
    /// Temporary intermediate; discarded after last consumer.
    Transient,
    /// Host-device unified memory (Apple Unified Memory or CUDA Managed).
    Unified,
    /// Paged/swappable virtual address space.
    Paged,
    /// Memory-mapped file-backed storage.
    Mapped,
}

// ── IrTensor ───────────────────────────────────────────────────────────────

/// A single tensor in the execution graph with full type/shape/placement
/// metadata for both its logical (model-level) and physical (runtime) views.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IrTensor {
    /// Globally unique identifier for this tensor instance.
    pub id: String,
    /// Human-readable name (e.g. `"model.layers.0.input_layernorm.weight"`).
    pub name: String,
    /// Data type in the source model graph (e.g. `"bfloat16"`, `"float32"`).
    pub logical_dtype: String,
    /// Shape in the source model graph.
    pub logical_shape: Vec<u32>,
    /// Data type as stored/computed at runtime.
    pub physical_dtype: String,
    /// Shape as stored/computed at runtime (may differ from logical after
    /// padding, transposition, or quantization).
    pub physical_shape: Vec<u32>,
    /// Strides for each dimension (logical order). Empty for contiguous
    /// default-layout tensors.
    pub strides: Vec<usize>,
    /// Quantization mode, if any.
    pub quant_mode: QuantMode,
    /// Memory disposition.
    pub disposition: TensorDisposition,
}

// ── IrAlias ────────────────────────────────────────────────────────────────

/// A directed alias edge: `source_id` is an alias (view, shared storage, or
/// in-place transformation) of `target_id`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IrAlias {
    pub source_id: String,
    pub target_id: String,
}

// ── IrLayer ────────────────────────────────────────────────────────────────

/// A logical layer grouping tensors by model layer or execution stage.
///
/// The `tensor_ids` map provides name-keyed lookup into the layer's tensor
/// set; the actual `IrTensor` instances live in `ComputeExecutionIR::tensors`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IrLayer {
    pub tensor_ids: HashMap<String, String>,
}

// ── IROp ───────────────────────────────────────────────────────────────────

/// A single kernel operation dispatched within a region.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IROp {
    /// Operation kind identifier (e.g. `"matmul"`, `"rms_norm"`, `"rope"`).
    pub kind: String,
    /// Tensor IDs consumed by this operation.
    pub input_tensors: Vec<String>,
    /// Tensor IDs produced by this operation.
    pub output_tensors: Vec<String>,
    /// Arbitrary key-value metadata (e.g. `{"head_dim": "256"}`).
    pub metadata: HashMap<String, String>,
}

// ── DependencyKind ─────────────────────────────────────────────────────────

/// Classification of a dependency between two operations.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum DependencyKind {
    /// Producer–consumer data flow.
    Data,
    /// Explicit control ordering (barrier, sync point).
    Control,
    /// Memory alias / reuse ordering constraint.
    Memory,
    /// Implicit program-order constraint.
    Ordering,
}

// ── RegionDependency ───────────────────────────────────────────────────────

/// A dependency edge between two operations within a scheduling region.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RegionDependency {
    /// ID of the predecessor operation.
    pub from: String,
    /// ID of the successor operation.
    pub to: String,
    /// Classification of the edge.
    pub kind: DependencyKind,
}

// ── RegionCandidate ────────────────────────────────────────────────────────

/// A candidate region-level operation or fusion opportunity identified
/// during profiling or scheduling analysis.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RegionCandidate {
    /// Short label/name for this candidate (e.g. `"fuse_qk_norm"`).
    pub label: String,
    /// IDs of the operations that would be grouped or fused.
    pub ops: Vec<String>,
    /// Estimated benefit score (higher is better); scale is
    /// context-dependent (latency reduction, memory savings, etc.).
    pub benefit: f64,
}

// ── StateEffect ────────────────────────────────────────────────────────────

/// Side effect a region has on the execution state machine.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum StateEffect {
    /// Pure compute; no persistent side effect.
    NoEffect,
    /// Allocates new storage.
    Allocates,
    /// Frees previously allocated storage.
    Frees,
    /// Mutates a tensor in place.
    ModifiesInPlace,
    /// Reads persisted state (e.g. KV cache).
    ReadsState,
    /// Writes persisted state (e.g. KV cache update).
    WritesState,
}

// ── IrRegion ───────────────────────────────────────────────────────────────

/// A scheduling region that groups related operations together with their
/// dependency graph, fusion candidates, and aggregate state effects.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IrRegion {
    /// Operations belonging to this region.
    pub ops: Vec<IROp>,
    /// Dependency edges between operations in this region.
    pub dependencies: Vec<RegionDependency>,
    /// Fusion or grouping candidates for this region.
    pub candidates: Vec<RegionCandidate>,
    /// Aggregate state effects across all ops in this region.
    pub state_effects: Vec<StateEffect>,
}

// ── ComputeExecutionIR ─────────────────────────────────────────────────────

/// Top-level execution IR describing the complete compute graph in a
/// fully serializable form suitable for profiling, scheduling analysis,
/// and cross-backend code generation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ComputeExecutionIR {
    /// All tensors in the execution graph, keyed by `IrTensor::id`.
    pub tensors: Vec<IrTensor>,
    /// Directed alias edges between tensors.
    pub aliases: Vec<IrAlias>,
    /// Layer groupings that partition the tensor set.
    pub layers: Vec<IrLayer>,
    /// Scheduling regions that decompose the execution graph.
    pub regions: Vec<IrRegion>,
    /// Arbitrary key-value metadata (e.g. `{"model": "gemma4-12b"}`).
    pub metadata: HashMap<String, String>,
}

// ── Constructors ───────────────────────────────────────────────────────────

impl ComputeExecutionIR {
    /// Create an empty IR.
    pub fn new() -> Self {
        Self {
            tensors: Vec::new(),
            aliases: Vec::new(),
            layers: Vec::new(),
            regions: Vec::new(),
            metadata: HashMap::new(),
        }
    }

    /// Return the number of distinct tensors, aliases, layers, and regions.
    pub fn len(&self) -> (usize, usize, usize, usize) {
        (
            self.tensors.len(),
            self.aliases.len(),
            self.layers.len(),
            self.regions.len(),
        )
    }

    /// Look up a tensor by its id.
    pub fn tensor_by_id(&self, id: &str) -> Option<&IrTensor> {
        self.tensors.iter().find(|t| t.id == id)
    }

    /// Look up a tensor by its name.
    pub fn tensor_by_name(&self, name: &str) -> Option<&IrTensor> {
        self.tensors.iter().find(|t| t.name == name)
    }
}

impl Default for ComputeExecutionIR {
    fn default() -> Self {
        Self::new()
    }
}
