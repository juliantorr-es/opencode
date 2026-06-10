//! Logical-tensor registry — version-bound materializations across backends.
//!
//! The `TensorRegistry` is the sole authority for materialization identity
//! allocation and version transitions.  Mutable tensor access is private;
//! all mutations go through the registry.

use std::collections::HashMap;

use super::DType;
use super::routing::{
    BackendId, LogicalShape, PhysicalLayout, TensorId, TensorMaterializationId,
    TensorShape, TensorVersion,
};

// ── Materialization identity ──────────────────────────────────────────

/// Monotonic allocator for materialization IDs (registry-private).
#[derive(Debug)]
struct MaterializationSequence(u64);

impl MaterializationSequence {
    fn new() -> Self { Self(0) }
    fn next(&mut self) -> TensorMaterializationId {
        let id = self.0;
        self.0 += 1;
        TensorMaterializationId(id)
    }
}

// ── Tensor contract ───────────────────────────────────────────────────

/// Mutability class for a logical tensor.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TensorMutability {
    Immutable,
    Mutable,
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
    Fresh,
    Stale,
    Pending,
}

/// One backend-specific physical materialization of a logical tensor.
#[derive(Debug, Clone)]
pub struct MaterializationRecord {
    pub materialization_id: TensorMaterializationId,
    pub backend_id: BackendId,
    pub tensor_version: TensorVersion,
    pub physical_shape: TensorShape,
    pub physical_layout: PhysicalLayout,
    pub dtype: DType,
    pub state: MaterializationState,
    pub backend_handle: u64,
}

// ── Logical tensor (registry-private mutable access) ──────────────────

/// The canonical logical-tensor type.  Mutable access is private to the
/// registry; all mutations go through `TensorRegistry` methods.
#[derive(Debug, Clone)]
pub struct MaterializedTensor {
    pub tensor_id: TensorId,
    pub contract: TensorContract,
    pub authoritative_backend: BackendId,
    pub version: TensorVersion,
    materializations: HashMap<BackendId, MaterializationRecord>,
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

    /// Read-only access to materializations.
    pub fn materialization_count(&self) -> usize {
        self.materializations.len()
    }

    pub fn is_empty(&self) -> bool {
        self.materializations.is_empty()
    }

    // ── Private mutations (called only by TensorRegistry) ────────────

    fn add_materialization(
        &mut self,
        seq: &mut MaterializationSequence,
        backend_id: BackendId,
        backend_handle: u64,
        shape: TensorShape,
        layout: PhysicalLayout,
        dtype: DType,
    ) -> Result<MaterializationRecord, String> {
        // Contract compatibility: dtype must match or be explicitly converted
        if dtype != self.contract.canonical_dtype {
            return Err(format!(
                "add_materialization: dtype {:?} != contract canonical {:?} for tensor {:?}",
                dtype, self.contract.canonical_dtype, self.tensor_id,
            ));
        }
        let id = seq.next();
        let record = MaterializationRecord {
            materialization_id: id,
            backend_id,
            tensor_version: self.version,
            physical_shape: shape,
            physical_layout: layout,
            dtype,
            state: MaterializationState::Fresh,
            backend_handle,
        };
        self.materializations.insert(backend_id, record.clone());
        Ok(record)
    }

    fn advance_version(
        &mut self,
        seq: &mut MaterializationSequence,
        new_authoritative_backend: BackendId,
        new_handle: u64,
        shape: TensorShape,
        layout: PhysicalLayout,
        dtype: DType,
    ) -> Result<AuthorityTransitionReceipt, String> {
        // Immutable weights cannot be version-incremented.
        if self.contract.mutability == TensorMutability::Immutable {
            return Err(format!(
                "advance_version: tensor {:?} is immutable (role {:?})",
                self.tensor_id, self.contract.role,
            ));
        }

        let previous_version = self.version;
        let previous_authority = self.authoritative_backend;

        // Preserve the previous authoritative record.
        let previous_authoritative_materialization =
            self.materializations.get(&self.authoritative_backend).cloned();

        // Preserve any existing record at the destination backend.
        let replaced_destination_materialization =
            self.materializations.get(&new_authoritative_backend).cloned();

        self.version = TensorVersion(self.version.0 + 1);
        self.authoritative_backend = new_authoritative_backend;

        let mut invalidated_non_authoritative = Vec::new();
        for record in self.materializations.values_mut() {
            if record.backend_id != new_authoritative_backend {
                record.state = MaterializationState::Stale;
                invalidated_non_authoritative.push(record.clone());
            }
        }

        let new_authoritative = self.add_materialization(
            seq,
            new_authoritative_backend,
            new_handle,
            shape,
            layout,
            dtype,
        )?;

        Ok(AuthorityTransitionReceipt {
            tensor_id: self.tensor_id,
            previous_version,
            new_version: self.version,
            previous_authority,
            new_authority: new_authoritative_backend,
            previous_authoritative_materialization,
            replaced_destination_materialization,
            invalidated_non_authoritative,
            new_authoritative_materialization: new_authoritative,
        })
    }
}

/// Structured receipt from an authority transition.
#[derive(Debug, Clone)]
pub struct AuthorityTransitionReceipt {
    pub tensor_id: TensorId,
    pub previous_version: TensorVersion,
    pub new_version: TensorVersion,
    pub previous_authority: BackendId,
    pub new_authority: BackendId,
    pub previous_authoritative_materialization: Option<MaterializationRecord>,
    pub replaced_destination_materialization: Option<MaterializationRecord>,
    pub invalidated_non_authoritative: Vec<MaterializationRecord>,
    pub new_authoritative_materialization: MaterializationRecord,
}

// ── Registry (sole mutation authority) ────────────────────────────────

/// Central registry for all logical tensors.  Owns materialization identity
/// allocation and version transitions exclusively.
#[derive(Debug)]
pub struct TensorRegistry {
    tensors: HashMap<TensorId, MaterializedTensor>,
    materialization_seq: MaterializationSequence,
}

impl Default for TensorRegistry {
    fn default() -> Self { Self::new() }
}

impl TensorRegistry {
    pub fn new() -> Self {
        Self {
            tensors: HashMap::new(),
            materialization_seq: MaterializationSequence::new(),
        }
    }

    /// Register a new tensor.  Fails if the ID already exists.
    pub fn register(&mut self, tensor: MaterializedTensor) -> Result<(), String> {
        if self.tensors.contains_key(&tensor.tensor_id) {
            return Err(format!(
                "TensorRegistry: tensor {:?} already registered",
                tensor.tensor_id,
            ));
        }
        self.tensors.insert(tensor.tensor_id, tensor);
        Ok(())
    }

    /// Add a materialization to a registered tensor through the registry.
    pub fn add_materialization(
        &mut self,
        tensor_id: TensorId,
        backend_id: BackendId,
        backend_handle: u64,
        shape: TensorShape,
        layout: PhysicalLayout,
        dtype: DType,
    ) -> Result<MaterializationRecord, String> {
        let tensor = self.tensors.get_mut(&tensor_id).ok_or_else(|| {
            format!("TensorRegistry: tensor {:?} not found", tensor_id)
        })?;
        tensor.add_materialization(
            &mut self.materialization_seq,
            backend_id, backend_handle, shape, layout, dtype,
        )
    }

    /// Execute an authority transition through the registry.
    pub fn advance_version(
        &mut self,
        tensor_id: TensorId,
        new_authoritative_backend: BackendId,
        new_handle: u64,
        shape: TensorShape,
        layout: PhysicalLayout,
        dtype: DType,
    ) -> Result<AuthorityTransitionReceipt, String> {
        let tensor = self.tensors.get_mut(&tensor_id).ok_or_else(|| {
            format!("TensorRegistry: tensor {:?} not found", tensor_id)
        })?;
        tensor.advance_version(
            &mut self.materialization_seq,
            new_authoritative_backend, new_handle, shape, layout, dtype,
        )
    }

    pub fn get(&self, id: TensorId) -> Option<&MaterializedTensor> {
        self.tensors.get(&id)
    }

    pub fn remove(&mut self, id: TensorId) -> Option<MaterializedTensor> {
        self.tensors.remove(&id)
    }

    pub fn len(&self) -> usize { self.tensors.len() }
    pub fn is_empty(&self) -> bool { self.tensors.is_empty() }
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
