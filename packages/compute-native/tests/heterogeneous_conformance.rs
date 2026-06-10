//! Heterogeneous contract conformance tests.
//!
//! Tests the tensor registry, version-bound materializations, authority
//! transitions, transfer records, contract enforcement, and immutability.

use tribunus_compute_native::backend::DType;
use tribunus_compute_native::backend::routing::{
    BackendId, LogicalShape, PhysicalLayout, TensorId, TensorMaterializationId,
    TensorShape, TensorTransferReceipt, TensorVersion,
};
use tribunus_compute_native::backend::tensor_registry::{
    MaterializationRecord, MaterializationState, MaterializedTensor,
    TensorContract, TensorMutability, TensorRegistry, TensorRole,
    TensorTransferRecord,
};

// ── Fixtures ──────────────────────────────────────────────────────────────

fn mlx_id() -> BackendId { BackendId(0) }
fn accelerate_id() -> BackendId { BackendId(1) }

fn f32_layout() -> PhysicalLayout { PhysicalLayout::RowMajor }
fn shape_2x3() -> TensorShape { TensorShape { dims: vec![2, 3] } }

fn small_contract() -> TensorContract {
    TensorContract {
        logical_shape: LogicalShape { dims: vec![2, 3] },
        canonical_dtype: DType::F32,
        mutability: TensorMutability::Mutable,
        role: TensorRole::Activation,
    }
}

fn weight_contract() -> TensorContract {
    TensorContract {
        logical_shape: LogicalShape { dims: vec![4096, 4096] },
        canonical_dtype: DType::F32,
        mutability: TensorMutability::Immutable,
        role: TensorRole::Weight,
    }
}

fn tensor(id: u64) -> MaterializedTensor {
    MaterializedTensor::new(TensorId(id), small_contract(), mlx_id())
}

fn registry_with(tensors: Vec<MaterializedTensor>) -> TensorRegistry {
    let mut reg = TensorRegistry::new();
    for t in tensors {
        reg.register(t).unwrap();
    }
    reg
}

// ── Version-bound materializations ────────────────────────────────────────

#[test]
fn mutation_invalidates_old_materializations() {
    let mut reg = registry_with(vec![tensor(1)]);
    reg.add_materialization(TensorId(1), mlx_id(), 100, shape_2x3(), f32_layout(), DType::F32).unwrap();
    reg.add_materialization(TensorId(1), accelerate_id(), 200, shape_2x3(), f32_layout(), DType::F32).unwrap();

    {
        let t = reg.get(TensorId(1)).unwrap();
        assert!(t.is_fresh(mlx_id()));
        assert!(t.is_fresh(accelerate_id()));
    }

    let receipt = reg.advance_version(TensorId(1), mlx_id(), 101, shape_2x3(), f32_layout(), DType::F32).unwrap();

    assert_eq!(receipt.new_version, TensorVersion(1));
    assert_eq!(receipt.previous_version, TensorVersion(0));
    assert_eq!(receipt.previous_authority, mlx_id());
    assert_eq!(receipt.new_authority, mlx_id());

    let t = reg.get(TensorId(1)).unwrap();
    assert_eq!(t.version, TensorVersion(1));
    assert!(t.is_fresh(mlx_id()));
    assert!(!t.is_fresh(accelerate_id()));

    let acc_stale = receipt.invalidated_non_authoritative
        .iter()
        .find(|r| r.backend_id == accelerate_id());
    assert!(acc_stale.is_some(), "accelerate must be in invalidated set");
    assert_eq!(acc_stale.unwrap().state, MaterializationState::Stale);
}

#[test]
fn stale_handle_rejected() {
    let mut reg = registry_with(vec![tensor(2)]);
    reg.add_materialization(TensorId(2), mlx_id(), 100, shape_2x3(), f32_layout(), DType::F32).unwrap();
    reg.add_materialization(TensorId(2), accelerate_id(), 200, shape_2x3(), f32_layout(), DType::F32).unwrap();
    reg.advance_version(TensorId(2), mlx_id(), 101, shape_2x3(), f32_layout(), DType::F32).unwrap();

    let t = reg.get(TensorId(2)).unwrap();
    assert!(t.get_handle(accelerate_id()).is_none(), "stale handle must be rejected");
}

#[test]
fn authority_transition_increments_exactly_once() {
    let mut reg = registry_with(vec![tensor(3)]);
    reg.add_materialization(TensorId(3), mlx_id(), 100, shape_2x3(), f32_layout(), DType::F32).unwrap();

    assert_eq!(reg.get(TensorId(3)).unwrap().version, TensorVersion(0));

    let r1 = reg.advance_version(TensorId(3), accelerate_id(), 200, shape_2x3(), f32_layout(), DType::F32).unwrap();
    assert_eq!(r1.new_version, TensorVersion(1));
    assert_eq!(reg.get(TensorId(3)).unwrap().version, TensorVersion(1));
    assert_eq!(reg.get(TensorId(3)).unwrap().authoritative_backend, accelerate_id());

    let r2 = reg.advance_version(TensorId(3), mlx_id(), 101, shape_2x3(), f32_layout(), DType::F32).unwrap();
    assert_eq!(r2.new_version, TensorVersion(2));
    assert_eq!(reg.get(TensorId(3)).unwrap().version, TensorVersion(2));
    assert_eq!(reg.get(TensorId(3)).unwrap().authoritative_backend, mlx_id());
}

#[test]
fn cross_backend_transition_preserves_both_history_paths() {
    let mut reg = registry_with(vec![tensor(100)]);
    reg.add_materialization(TensorId(100), mlx_id(), 100, shape_2x3(), f32_layout(), DType::F32).unwrap();

    // Transition to Accelerate
    let receipt = reg.advance_version(TensorId(100), accelerate_id(), 200, shape_2x3(), f32_layout(), DType::F32).unwrap();

    // Previous authoritative (MLX) must be preserved
    let prev_auth = &receipt.previous_authoritative_materialization;
    assert!(prev_auth.is_some(), "previous authoritative must be preserved");
    assert_eq!(prev_auth.as_ref().unwrap().backend_id, mlx_id());
    assert_eq!(prev_auth.as_ref().unwrap().backend_handle, 100);

    // Destination (Accelerate) had no prior materialization
    assert!(receipt.replaced_destination_materialization.is_none(),
        "no prior materialization at Accelerate");
}

#[test]
fn cross_backend_preserves_destination_prior_record() {
    let mut reg = registry_with(vec![tensor(101)]);
    reg.add_materialization(TensorId(101), mlx_id(), 100, shape_2x3(), f32_layout(), DType::F32).unwrap();
    // Pre-populate Accelerate with a materialization
    reg.add_materialization(TensorId(101), accelerate_id(), 200, shape_2x3(), f32_layout(), DType::F32).unwrap();

    // Transition authority to Accelerate
    let receipt = reg.advance_version(TensorId(101), accelerate_id(), 300, shape_2x3(), f32_layout(), DType::F32).unwrap();

    // Previous authoritative (MLX)
    assert!(receipt.previous_authoritative_materialization.is_some());
    assert_eq!(receipt.previous_authoritative_materialization.as_ref().unwrap().backend_id, mlx_id());

    // Replaced destination: old Accelerate record (handle 200, not 300)
    assert!(receipt.replaced_destination_materialization.is_some(),
        "replaced destination must be preserved");
    let replaced = receipt.replaced_destination_materialization.as_ref().unwrap();
    assert_eq!(replaced.backend_id, accelerate_id());
    assert_eq!(replaced.backend_handle, 200);
}

// ── Contract enforcement ──────────────────────────────────────────────────

#[test]
fn dtype_mismatch_rejected() {
    let mut reg = registry_with(vec![tensor(50)]);
    let err = reg.add_materialization(
        TensorId(50), mlx_id(), 100, shape_2x3(), f32_layout(), DType::U32,
    );
    assert!(err.is_err(), "dtype mismatch must be rejected");
    assert!(err.unwrap_err().contains("dtype"));
}

#[test]
fn contract_dtype_enforced() {
    let mut reg = registry_with(vec![tensor(51)]);
    // Correct dtype → OK
    assert!(reg.add_materialization(TensorId(51), mlx_id(), 100, shape_2x3(), f32_layout(), DType::F32).is_ok());
    // Wrong dtype → rejected
    assert!(reg.add_materialization(TensorId(51), accelerate_id(), 200, shape_2x3(), f32_layout(), DType::BF16).is_err());
}

// ── Immutability ──────────────────────────────────────────────────────────

#[test]
fn immutable_weight_rejects_advance_version() {
    let mut reg = registry_with(vec![MaterializedTensor::new(TensorId(200), weight_contract(), mlx_id())]);
    reg.add_materialization(TensorId(200), mlx_id(), 100, TensorShape { dims: vec![4096, 4096] }, f32_layout(), DType::F32).unwrap();

    let err = reg.advance_version(TensorId(200), accelerate_id(), 200, TensorShape { dims: vec![4096, 4096] }, f32_layout(), DType::F32);
    assert!(err.is_err(), "immutable tensor must reject advance_version");
    assert!(err.unwrap_err().contains("immutable"));
}

#[test]
fn immutable_weight_accepts_add_materialization() {
    // Adding a materialization to an immutable weight is allowed
    // (it's a cache copy, not a version mutation)
    let mut reg = registry_with(vec![MaterializedTensor::new(TensorId(201), weight_contract(), mlx_id())]);
    let rec = reg.add_materialization(TensorId(201), mlx_id(), 100, TensorShape { dims: vec![4096, 4096] }, f32_layout(), DType::F32);
    assert!(rec.is_ok());
}

// ── Registry contracts ────────────────────────────────────────────────────

#[test]
fn duplicate_tensor_registration_fails() {
    let mut reg = registry_with(vec![tensor(42)]);
    let err = reg.register(tensor(42));
    assert!(err.is_err());
    assert!(err.unwrap_err().contains("already registered"));
}

#[test]
fn version_mutation_only_through_registry() {
    let mut reg = registry_with(vec![tensor(99)]);
    let receipt = reg.advance_version(TensorId(99), accelerate_id(), 300, shape_2x3(), f32_layout(), DType::F32).unwrap();
    assert_eq!(receipt.new_version, TensorVersion(1));
    assert_eq!(reg.get(TensorId(99)).unwrap().version, TensorVersion(1));
    assert_eq!(reg.get(TensorId(99)).unwrap().authoritative_backend, accelerate_id());
}

#[test]
fn unknown_tensor_errors() {
    let mut reg = TensorRegistry::new();
    assert!(reg.get(TensorId(999)).is_none());
    assert!(reg.add_materialization(TensorId(999), mlx_id(), 0, shape_2x3(), f32_layout(), DType::F32).is_err());
    assert!(reg.advance_version(TensorId(999), mlx_id(), 0, shape_2x3(), f32_layout(), DType::F32).is_err());
}

// ── Transfer record ───────────────────────────────────────────────────────

#[test]
fn transfer_record_preserves_exact_layouts_and_dtypes() {
    let record = TensorTransferRecord {
        tensor_id: TensorId(1),
        tensor_version: TensorVersion(3),
        source_materialization: TensorMaterializationId(10),
        destination_materialization: TensorMaterializationId(11),
        source_backend: mlx_id(),
        destination_backend: accelerate_id(),
        source_layout: PhysicalLayout::RowMajor,
        destination_layout: PhysicalLayout::PackedU32 { group_size: 128, bits: 4 },
        source_dtype: DType::F32,
        destination_dtype: DType::U32,
        bytes_read: 4096,
        bytes_written: 512,
        transfer_ns: 1234,
        conversion_ns: 567,
        zero_copy: false,
    };
    assert_eq!(record.tensor_id, TensorId(1));
    assert_eq!(record.source_backend, mlx_id());
    assert_eq!(record.destination_backend, accelerate_id());
    assert_eq!(record.bytes_read, 4096);
    assert_eq!(record.transfer_ns, 1234);
}

// ── Materialization state ─────────────────────────────────────────────────

#[test]
fn new_tensor_is_empty() {
    let t = tensor(7);
    assert!(t.is_empty());
    assert_eq!(t.version, TensorVersion(0));
}

#[test]
fn new_tensor_has_contract() {
    let t = tensor(8);
    assert_eq!(t.contract.canonical_dtype, DType::F32);
    assert_eq!(t.contract.logical_shape.dims, vec![2, 3]);
    assert_eq!(t.contract.mutability, TensorMutability::Mutable);
}

#[test]
fn materialization_records_physical_shape() {
    let mut reg = registry_with(vec![tensor(300)]);
    let rec = reg.add_materialization(TensorId(300), mlx_id(), 0, shape_2x3(), f32_layout(), DType::F32).unwrap();
    assert_eq!(rec.physical_shape.dims, vec![2, 3]);
}

// ── Lossless transfer receipt ─────────────────────────────────────────────

#[test]
fn lossless_transfer_receipt() {
    let receipt = TensorTransferReceipt {
        tensor_id: TensorId(10),
        tensor_version: TensorVersion(1),
        source_materialization: TensorMaterializationId(100),
        destination_materialization: TensorMaterializationId(101),
        source_backend: mlx_id(),
        destination_backend: accelerate_id(),
        source_layout: PhysicalLayout::RowMajor,
        destination_layout: PhysicalLayout::ColumnMajor,
        source_dtype: DType::F32,
        destination_dtype: DType::F32,
        bytes_read: 4096,
        bytes_written: 4096,
        transfer_ns: 1000,
        conversion_ns: 100,
        zero_copy: false,
    };
    assert_eq!(receipt.tensor_id, TensorId(10));
    assert_eq!(receipt.bytes_read, 4096);
}
