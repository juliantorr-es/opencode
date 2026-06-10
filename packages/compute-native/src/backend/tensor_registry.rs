//! Logical-tensor registry — version-bound materializations across backends.
//!
//! This is the CANONICAL registry.  Only one logical tensor type and one
//! backend materialization type exist across the entire backend module.
//! routing.rs re-exports `MaterializedTensor` as `LogicalTensor` for
//! backward compatibility of the routing schema.

use std::collections::HashMap;

use super::DType;
use super::routing::{
    BackendId, PhysicalLayout, TensorId, TensorMaterializationId,
    TensorVersion,
};

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
/// Every tensor has exactly one authoritative backend whose materialization
/// defines the current logical version.  Other backends may hold stale
/// materializations until re-materialised.
#[derive(Debug, Clone)]
pub struct MaterializedTensor {
    pub tensor_id: TensorId,
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
        authoritative_backend: BackendId,
    ) -> Self {
        Self {
            tensor_id,
            authoritative_backend,
            version: TensorVersion(0),
            materializations: HashMap::new(),
        }
    }

    /// Register a materialization at the current version (fresh).
    pub fn add_materialization(
        &mut self,
        backend_id: BackendId,
        backend_handle: u64,
        layout: PhysicalLayout,
        dtype: DType,
    ) -> MaterializationRecord {
        let id = TensorMaterializationId(self.materializations.len() as u64);
        let record = MaterializationRecord {
            materialization_id: id,
            backend_id,
            tensor_version: self.version,
            physical_layout: layout,
            dtype,
            state: MaterializationState::Fresh,
            backend_handle,
        };
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
    /// Returns the records that were invalidated.
    pub fn advance_version(
        &mut self,
        new_authoritative_backend: BackendId,
        new_handle: u64,
        layout: PhysicalLayout,
        dtype: DType,
    ) -> (TensorVersion, Vec<MaterializationRecord>) {
        self.version = TensorVersion(self.version.0 + 1);
        self.authoritative_backend = new_authoritative_backend;

        let mut invalidated = Vec::new();
        for record in self.materializations.values_mut() {
            if record.backend_id != new_authoritative_backend {
                record.state = MaterializationState::Stale;
                invalidated.push(record.clone());
            }
        }

        let new_record = self.add_materialization(
            new_authoritative_backend,
            new_handle,
            layout,
            dtype,
        );
        invalidated.push(new_record);

        (self.version, invalidated)
    }
}

// ── Registry ──────────────────────────────────────────────────────────

/// Central registry for all logical tensors in a model runtime.
#[derive(Debug, Default)]
pub struct TensorRegistry {
    tensors: HashMap<TensorId, MaterializedTensor>,
}

impl TensorRegistry {
    pub fn new() -> Self {
        Self { tensors: HashMap::new() }
    }

    /// Register a new tensor.  Fails if the ID already exists (no silent
    /// overwrite — use `replace` for explicit replacement).
    pub fn register(
        &mut self,
        tensor: MaterializedTensor,
    ) -> Result<(), String> {
        if self.tensors.contains_key(&tensor.tensor_id) {
            return Err(format!(
                "TensorRegistry: tensor {:?} already registered — use replace()",
                tensor.tensor_id,
            ));
        }
        self.tensors.insert(tensor.tensor_id, tensor);
        Ok(())
    }

    /// Explicitly replace a tensor registration (authority transition).
    pub fn replace(&mut self, tensor: MaterializedTensor) {
        self.tensors.insert(tensor.tensor_id, tensor);
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
