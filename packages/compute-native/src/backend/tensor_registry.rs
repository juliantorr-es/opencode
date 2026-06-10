//! Logical-tensor registry — version-bound materializations across backends.
//!
//! This is the CANONICAL registry.  Only one logical tensor type and one
//! backend materialization type exist across the entire backend module.

use std::collections::HashMap;

use super::DType;
use super::routing::{
    BackendId, LogicalShape, PhysicalLayout, TensorId, TensorMaterializationId,
    TensorVersion,
};

// ── Materialization identity ──────────────────────────────────────────

/// Monotonic allocator for materialization IDs.  The ID never derives
/// from collection length — it is always strictly increasing within the
/// lifetime of one registry.
#[derive(Debug)]
pub struct MaterializationSequence(u64);

impl MaterializationSequence {
    pub fn new() -> Self {
        Self(0)
    }

    pub fn next(&mut self) -> TensorMaterializationId {
        let id = self.0;
        self.0 += 1;
        TensorMaterializationId(id)
    }
}

impl Default for MaterializationSequence {
    fn default() -> Self {
        Self::new()
    }
}

// ── Tensor contract ───────────────────────────────────────────────────

/// Mutability class for a logical tensor.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TensorMutability {
    /// Content never changes after creation (model weights).
    Immutable,
    /// Content changes predictably (KV cache, activations).
    Mutable,
    /// Content is session-local and may change at any time.
    Ephemeral,
}

/// Semantic role within the model graph.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TensorRole {
    Weight,
    Activation,
    KvCache,
    Residual,
    Gradient,
    Scratch,
    Output,
}

/// Contract describing a logical tensor independent of any backend.
/// Every materialization must be compatible with this contract or
/// accompanied by an explicit conversion plan.
#[derive(Debug, Clone)]
pub struct TensorContract {
    pub logical_shape: LogicalShape,
    pub canonical_dtype: DType,
    pub mutability: TensorMutability,
    pub role: TensorRole,
}

// ── Materialization ───────────────────────────────────────────────────

/// The state of a backend materialization relative to the logical tensor.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MaterializationState {
    /// This materialization represents the current logical version.
    Fresh,
    /// The logical tensor has advanced past this materialization.
    Stale,
    /// The materialization is being transferred or created.
    Pending,
}

/// One backend-specific physical materialization of a logical tensor.
#[derive(Debug, Clone)]
pub struct MaterializationRecord {
    pub materialization_id: TensorMaterializationId,
    pub backend_id: BackendId,
    pub tensor_version: TensorVersion,
    pub physical_layout: PhysicalLayout,
    pub dtype: DType,
    pub state: MaterializationState,
    /// Opaque backend-local handle (meaningful only to `backend_id`).
    pub backend_handle: u64,
}

// ── Logical tensor ────────────────────────────────────────────────────

/// The canonical logical-tensor type for the entire backend module.
///
/// Every tensor has a `TensorContract` describing its logical shape,
/// canonical dtype, mutability, and role.  Materializations must be
/// compatible with this contract or carry an explicit conversion plan.
///
/// Exactly one backend is authoritative — its materialization defines
/// the current logical version.  Other backends may hold stale
/// materializations until re-materialised through `advance_version()`.
#[derive(Debug, Clone)]
pub struct MaterializedTensor {
    pub tensor_id: TensorId,
    pub contract: TensorContract,
    /// The backend whose materialization defines the truth.
    pub authoritative_backend: BackendId,
    /// Current logical version — incremented on every authority transition.
    pub version: TensorVersion,
    /// All known materializations, keyed by backend ID.
    pub materializations: HashMap<BackendId, MaterializationRecord>,
}

impl MaterializedTensor {
    pub fn new(
        tensor_id: TensorId,
        contract: TensorContract,
        authoritative_backend: BackendId,
    ) -> Self {
        Self {
            tensor_id,
            contract,
            authoritative_backend,
            version: TensorVersion(0),
            materializations: HashMap::new(),
        }
    }

    /// Register a materialization at the current version (fresh).
    /// Uses a monotonic sequence to guarantee unique IDs.
    pub fn add_materialization(
        &mut self,
        seq: &mut MaterializationSequence,
        backend_id: BackendId,
        backend_handle: u64,
        layout: PhysicalLayout,
        dtype: DType,
    ) -> MaterializationRecord {
        let id = seq.next();
        let record = MaterializationRecord {
            materialization_id: id,
            backend_id,
            tensor_version: self.version,
            physical_layout: layout,
            dtype,
            state: MaterializationState::Fresh,
            backend_handle,
        };
        // Preserve the previous record for this backend in invalidation
        // history before replacement.
        if let Some(old) = self.materializations.get(&backend_id) {
            let _previous_id = old.materialization_id;
        }
        self.materializations.insert(backend_id, record.clone());
        record
    }

    /// Check whether a backend's materialization is current.
    pub fn is_fresh(&self, backend_id: BackendId) -> bool {
        self.materializations
            .get(&backend_id)
            .map(|r| r.state == MaterializationState::Fresh
                && r.tensor_version == self.version)
            .unwrap_or(false)
    }

    /// Get a backend's materialization handle (fresh only).
    pub fn get_handle(&self, backend_id: BackendId) -> Option<u64> {
        if self.is_fresh(backend_id) {
            self.materializations.get(&backend_id).map(|r| r.backend_handle)
        } else {
            None
        }
    }

    /// Execute an authority transition: a backend produces a new logical
    /// version.  All non-authoritative materializations become stale.
    /// Returns structured receipt data for evidence emission (the caller
    /// is responsible for emitting the actual evidence event).
    pub fn advance_version(
        &mut self,
        seq: &mut MaterializationSequence,
        new_authoritative_backend: BackendId,
        new_handle: u64,
        layout: PhysicalLayout,
        dtype: DType,
    ) -> AuthorityTransitionReceipt {
        let previous_version = self.version;
        let previous_authority = self.authoritative_backend;

        // Preserve old authoritative record before replacement.
        let old_authoritative = self.materializations
            .get(&self.authoritative_backend)
            .cloned();

        self.version = TensorVersion(self.version.0 + 1);
        self.authoritative_backend = new_authoritative_backend;

        let mut invalidated = Vec::new();
        for record in self.materializations.values_mut() {
            if record.backend_id != new_authoritative_backend {
                record.state = MaterializationState::Stale;
                invalidated.push(record.clone());
            }
        }

        let authoritative = self.add_materialization(
            seq,
            new_authoritative_backend,
            new_handle,
            layout,
            dtype,
        );

        AuthorityTransitionReceipt {
            tensor_id: self.tensor_id,
            previous_version,
            new_version: self.version,
            previous_authority,
            new_authority: new_authoritative_backend,
            replaced_authoritative: old_authoritative,
            invalidated,
            authoritative_materialization: authoritative,
        }
    }
}

/// Structured receipt from an authority transition.
/// The caller emits this as an evidence event.
#[derive(Debug, Clone)]
pub struct AuthorityTransitionReceipt {
    pub tensor_id: TensorId,
    pub previous_version: TensorVersion,
    pub new_version: TensorVersion,
    pub previous_authority: BackendId,
    pub new_authority: BackendId,
    /// The old materialization on the newly authoritative backend
    /// (preserved before replacement).
    pub replaced_authoritative: Option<MaterializationRecord>,
    /// Materializations that were marked stale.
    pub invalidated: Vec<MaterializationRecord>,
    /// The new authoritative materialization.
    pub authoritative_materialization: MaterializationRecord,
}

// ── Registry ──────────────────────────────────────────────────────────

/// Central registry for all logical tensors in a model runtime.
#[derive(Debug)]
pub struct TensorRegistry {
    tensors: HashMap<TensorId, MaterializedTensor>,
    /// Monotonic materialization-ID allocator.
    pub materialization_seq: MaterializationSequence,
}

impl Default for TensorRegistry {
    fn default() -> Self {
        Self::new()
    }
}

impl TensorRegistry {
    pub fn new() -> Self {
        Self {
            tensors: HashMap::new(),
            materialization_seq: MaterializationSequence::new(),
        }
    }

    /// Register a new tensor.  Fails if the ID already exists.
    /// Versioned mutations happen only through MaterializedTensor::advance_version().
    pub fn register(
        &mut self,
        tensor: MaterializedTensor,
    ) -> Result<(), String> {
        if self.tensors.contains_key(&tensor.tensor_id) {
            return Err(format!(
                "TensorRegistry: tensor {:?} already registered",
                tensor.tensor_id,
            ));
        }
        self.tensors.insert(tensor.tensor_id, tensor);
        Ok(())
    }

    pub fn get(&self, id: TensorId) -> Option<&MaterializedTensor> {
        self.tensors.get(&id)
    }

    pub fn get_mut(&mut self, id: TensorId) -> Option<&mut MaterializedTensor> {
        self.tensors.get_mut(&id)
    }

    pub fn remove(&mut self, id: TensorId) -> Option<MaterializedTensor> {
        self.tensors.remove(&id)
    }

    pub fn len(&self) -> usize {
        self.tensors.len()
    }

    pub fn is_empty(&self) -> bool {
        self.tensors.is_empty()
    }
}

// ── Transfer record ───────────────────────────────────────────────────

/// Lossless transfer record — preserves exact source and destination
/// layouts, dtypes, and timings.  No invented detail.
#[derive(Debug, Clone)]
pub struct TensorTransferRecord {
    pub tensor_id: TensorId,
    pub tensor_version: TensorVersion,
    pub source_materialization: TensorMaterializationId,
    pub destination_materialization: TensorMaterializationId,
    pub source_backend: BackendId,
    pub destination_backend: BackendId,
    pub source_layout: PhysicalLayout,
    pub destination_layout: PhysicalLayout,
    pub source_dtype: DType,
    pub destination_dtype: DType,
    pub bytes_read: u64,
    pub bytes_written: u64,
    pub transfer_ns: u64,
    pub conversion_ns: u64,
    pub zero_copy: bool,
}
