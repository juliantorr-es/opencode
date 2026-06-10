//! Logical-tensor registry — tracks tensor identity and per-backend
//! materializations independently of any single backend's handle space.

use std::collections::{HashMap, HashSet};

use super::DType;
use super::routing::{
    BackendId, ConversionKind, LayoutConversion, LogicalShape, PhysicalLayout,
    Substrate, TensorContract, TensorId, TensorTransferPlan, TensorTransferReceipt,
    TensorVersion,
};

/// Handle to a backend-specific tensor materialization.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct BackendTensorHandle {
    pub backend_id: BackendId,
    pub handle: u64,
}

/// A tensor that may have multiple physical materializations.
#[derive(Debug, Clone)]
pub struct MaterializedTensor {
    pub tensor_id: TensorId,
    pub contract: TensorContract,
    pub materializations: HashMap<BackendId, BackendTensorHandle>,
    pub authoritative_backend: BackendId,
    pub version: TensorVersion,
    pub stale_materializations: HashSet<BackendId>,
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
            materializations: HashMap::new(),
            authoritative_backend,
            version: TensorVersion(0),
            stale_materializations: HashSet::new(),
        }
    }

    /// Register a backend materialization.
    pub fn add_materialization(&mut self, backend: BackendId, handle: u64) {
        self.materializations
            .insert(backend, BackendTensorHandle { backend_id: backend, handle });
        self.stale_materializations.remove(&backend);
    }

    /// Mark all non-authoritative materializations as stale.
    pub fn invalidate_non_authoritative(&mut self) {
        for &backend in self.materializations.keys() {
            if backend != self.authoritative_backend {
                self.stale_materializations.insert(backend);
            }
        }
        self.version = TensorVersion(self.version.0 + 1);
    }

    /// Check whether a backend's materialization is fresh.
    pub fn is_fresh(&self, backend: BackendId) -> bool {
        self.materializations.contains_key(&backend)
            && !self.stale_materializations.contains(&backend)
    }

    /// Get a backend's materialization handle.
    pub fn get_handle(&self, backend: BackendId) -> Option<BackendTensorHandle> {
        if self.is_fresh(backend) {
            self.materializations.get(&backend).copied()
        } else {
            None
        }
    }
}

/// Central registry for all logical tensors.
#[derive(Debug, Default)]
pub struct TensorRegistry {
    tensors: HashMap<TensorId, MaterializedTensor>,
}

impl TensorRegistry {
    pub fn new() -> Self {
        Self { tensors: HashMap::new() }
    }

    pub fn register(&mut self, tensor: MaterializedTensor) {
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

/// Records the transfer of a tensor between two backends.
#[derive(Debug, Clone)]
pub struct TensorTransferRecord {
    pub tensor_id: TensorId,
    pub source_backend: BackendId,
    pub destination_backend: BackendId,
    pub bytes: u64,
    pub conversion: Option<ConversionKind>,
    pub transfer_ns: u64,
    pub zero_copy: bool,
}

impl TensorTransferRecord {
    pub fn to_receipt(&self) -> TensorTransferReceipt {
        TensorTransferReceipt {
            tensor_id: self.tensor_id,
            source_backend: self.source_backend,
            destination_backend: self.destination_backend,
            bytes: self.bytes,
            conversion: self.conversion.as_ref().map(|c| match c {
                ConversionKind::LayoutConversion => LayoutConversion::Contiguous,
                ConversionKind::DtypeCast => LayoutConversion::Cast {
                    from: DType::F32,
                    to: DType::F32,
                },
                _ => LayoutConversion::None,
            }),
            transfer_ns: self.transfer_ns,
            zero_copy: self.zero_copy,
        }
    }

    pub fn from_plan(plan: &TensorTransferPlan, actual_ns: u64, zero_copy: bool) -> Self {
        Self {
            tensor_id: plan.tensor_id,
            source_backend: plan.source_backend,
            destination_backend: plan.destination_backend,
            bytes: plan.expected_bytes,
            conversion: Some(plan.conversion.clone()),
            transfer_ns: actual_ns,
            zero_copy,
        }
    }
}
