//! Logical-tensor registry — version-bound materializations across backends.
//!
//! The `TensorRegistry` is the sole authority for materialization identity
//! allocation and version transitions.  All mutations are transactional:
//! validation happens before any tensor state is modified.

use std::collections::HashMap;

use super::DType;
use super::routing::{
    BackendId, LogicalShape, PhysicalLayout, TensorId, TensorMaterializationId,
    TensorShape, TensorVersion,
};

// ── Materialization identity ──────────────────────────────────────────

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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TensorMutability {
    Immutable,
    Mutable,
    Ephemeral,
}

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

#[derive(Debug, Clone)]
pub struct TensorContract {
    pub logical_shape: LogicalShape,
    pub canonical_dtype: DType,
    pub mutability: TensorMutability,
    pub role: TensorRole,
}

// ── Materialization ───────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MaterializationState {
    Fresh,
    Stale,
    Pending,
}

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

// ── Logical tensor (fields private, read-only accessors) ──────────────

#[derive(Debug, Clone)]
pub struct MaterializedTensor {
    pub tensor_id: TensorId,
    contract: TensorContract,
    authoritative_backend: BackendId,
    version: TensorVersion,
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

    // ── Read-only accessors ────────────────────────────────────────

    pub fn contract(&self) -> &TensorContract { &self.contract }
    pub fn authoritative_backend(&self) -> BackendId { self.authoritative_backend }
    pub fn version(&self) -> TensorVersion { self.version }

    pub fn is_fresh(&self, backend_id: BackendId) -> bool {
        self.materializations
            .get(&backend_id)
            .map(|r| r.state == MaterializationState::Fresh
                && r.tensor_version == self.version)
            .unwrap_or(false)
    }

    pub fn get_handle(&self, backend_id: BackendId) -> Option<u64> {
        if self.is_fresh(backend_id) {
            self.materializations.get(&backend_id).map(|r| r.backend_handle)
        } else {
            None
        }
    }

    pub fn materialization_count(&self) -> usize { self.materializations.len() }
    pub fn is_empty(&self) -> bool { self.materializations.is_empty() }

    // ── Private mutations ──────────────────────────────────────────

    fn validate_materialization(
        &self,
        dtype: DType,
        shape: &TensorShape,
    ) -> Result<(), String> {
        if dtype != self.contract.canonical_dtype {
            return Err(format!(
                "dtype {:?} != contract canonical {:?} for tensor {:?}",
                dtype, self.contract.canonical_dtype, self.tensor_id,
            ));
        }
        // Shape compatibility: physical dims must match logical dims
        // count (backend-specific packing may change individual dims,
        // but for now require exact match).
        if shape.dims.len() != self.contract.logical_shape.dims.len() {
            return Err(format!(
                "physical shape has {} dims, logical contract has {}",
                shape.dims.len(), self.contract.logical_shape.dims.len(),
            ));
        }
        Ok(())
    }

    fn add_materialization(
        &mut self,
        seq: &mut MaterializationSequence,
        backend_id: BackendId,
        backend_handle: u64,
        shape: TensorShape,
        layout: PhysicalLayout,
        dtype: DType,
    ) -> Result<MaterializationRecord, String> {
        self.validate_materialization(dtype, &shape)?;
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

    /// Prepare a transition receipt WITHOUT mutating tensor state.
    /// Used by the registry for transactional validation.
    fn prepare_transition(
        &self,
        new_authoritative_backend: BackendId,
        dtype: DType,
        shape: &TensorShape,
    ) -> Result<(), String> {
        if self.contract.mutability == TensorMutability::Immutable {
            return Err(format!(
                "tensor {:?} is immutable (role {:?})",
                self.tensor_id, self.contract.role,
            ));
        }
        self.validate_materialization(dtype, shape)?;
        let _ = new_authoritative_backend;
        Ok(())
    }

    /// Commit a previously-validated transition.  All validation
    /// must pass before calling this method — it never returns Err.
    fn commit_transition(
        &mut self,
        new_authoritative_backend: BackendId,
        new_handle: u64,
        shape: TensorShape,
        layout: PhysicalLayout,
        dtype: DType,
        seq: &mut MaterializationSequence,
    ) -> AuthorityTransitionReceipt {
        let previous_version = self.version;
        let previous_authority = self.authoritative_backend;

        let previous_authoritative_materialization =
            self.materializations.get(&self.authoritative_backend).cloned();

        let replaced_destination_materialization =
            self.materializations.get(&new_authoritative_backend).cloned();

        // Commit mutations
        self.version = TensorVersion(self.version.0 + 1);
        self.authoritative_backend = new_authoritative_backend;

        // The previous authoritative backend is now non-authoritative
        // and marked stale.  It also appears in
        // previous_authoritative_materialization for clarity.
        let mut invalidated_non_authoritative = Vec::new();
        for record in self.materializations.values_mut() {
            if record.backend_id != new_authoritative_backend {
                record.state = MaterializationState::Stale;
                invalidated_non_authoritative.push(record.clone());
            }
        }

        // add_materialization can't fail here because dtype/shape were
        // validated in prepare_transition.
        let new_authoritative = self.add_materialization(
            seq, new_authoritative_backend, new_handle, shape, layout, dtype,
        ).expect("add_materialization after validated prepare must succeed");

        AuthorityTransitionReceipt {
            tensor_id: self.tensor_id,
            previous_version,
            new_version: self.version,
            previous_authority,
            new_authority: new_authoritative_backend,
            previous_authoritative_materialization,
            replaced_destination_materialization,
            invalidated_non_authoritative,
            new_authoritative_materialization: new_authoritative,
        }
    }
}

/// Structured receipt from an authority transition.
///
/// `previous_authoritative_materialization` may also appear in
/// `invalidated_non_authoritative` if the previous authority is
/// not the new authority (cross-backend transition).  Consumers
/// should treat `previous_authoritative_materialization` as the
/// canonical location of the replaced authority record.
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

// ── Registry ──────────────────────────────────────────────────────────

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

    pub fn register(&mut self, tensor: MaterializedTensor) -> Result<(), String> {
        if self.tensors.contains_key(&tensor.tensor_id) {
            return Err(format!("TensorRegistry: tensor {:?} already registered", tensor.tensor_id));
        }
        self.tensors.insert(tensor.tensor_id, tensor);
        Ok(())
    }

    /// Read-only access to a registered tensor.
    pub fn get(&self, id: TensorId) -> Option<&MaterializedTensor> {
        self.tensors.get(&id)
    }

    pub fn remove(&mut self, id: TensorId) -> Option<MaterializedTensor> {
        self.tensors.remove(&id)
    }

    pub fn len(&self) -> usize { self.tensors.len() }
    pub fn is_empty(&self) -> bool { self.tensors.is_empty() }

    /// Add a materialization through the registry.
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
            &mut self.materialization_seq, backend_id, backend_handle, shape, layout, dtype,
        )
    }

    /// Execute an authority transition transactionally.
    ///
    /// All validation (immutability, dtype, shape) happens before any
    /// tensor state is mutated.  On error, the tensor is unchanged.
    pub fn advance_version(
        &mut self,
        tensor_id: TensorId,
        new_authoritative_backend: BackendId,
        new_handle: u64,
        shape: TensorShape,
        layout: PhysicalLayout,
        dtype: DType,
    ) -> Result<AuthorityTransitionReceipt, String> {
        // Phase 1: validate without mutation
        {
            let tensor = self.tensors.get(&tensor_id).ok_or_else(|| {
                format!("TensorRegistry: tensor {:?} not found", tensor_id)
            })?;
            tensor.prepare_transition(new_authoritative_backend, dtype, &shape)?;
        }

        // Phase 2: commit (cannot fail)
        let tensor = self.tensors.get_mut(&tensor_id).unwrap();
        Ok(tensor.commit_transition(
            new_authoritative_backend, new_handle, shape, layout, dtype,
            &mut self.materialization_seq,
        ))
    }
}

// ── Transfer record ───────────────────────────────────────────────────

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
