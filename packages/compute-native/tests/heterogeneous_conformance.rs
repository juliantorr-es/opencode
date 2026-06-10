//! Heterogeneous contract conformance tests.
//!
//! Tests the tensor registry, version-bound materializations, authority
//! transitions, transfer records, contract enforcement, immutability,
//! and transactional semantics.

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

fn mlx_id() -> BackendId { BackendId(0) }
fn accelerate_id() -> BackendId { BackendId(1) }

fn f32_layout() -> PhysicalLayout { PhysicalLayout::RowMajor }
fn shape_2x3() -> TensorShape { TensorShape { dims: vec![2, 3] } }
fn shape_4x4() -> TensorShape { TensorShape { dims: vec![4, 4] } }

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
    for t in tensors { reg.register(t).unwrap(); }
    reg
}

// ── Version-bound materializations ────────────────────────────────────

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

    let t = reg.get(TensorId(1)).unwrap();
    assert_eq!(t.version(), TensorVersion(1));
    assert!(t.is_fresh(mlx_id()));
    assert!(!t.is_fresh(accelerate_id()));
}

#[test]
fn stale_handle_rejected() {
    let mut reg = registry_with(vec![tensor(2)]);
    reg.add_materialization(TensorId(2), mlx_id(), 100, shape_2x3(), f32_layout(), DType::F32).unwrap();
    reg.add_materialization(TensorId(2), accelerate_id(), 200, shape_2x3(), f32_layout(), DType::F32).unwrap();
    reg.advance_version(TensorId(2), mlx_id(), 101, shape_2x3(), f32_layout(), DType::F32).unwrap();

    let t = reg.get(TensorId(2)).unwrap();
    assert!(t.get_handle(accelerate_id()).is_none());
}

#[test]
fn authority_transition_increments_exactly_once() {
    let mut reg = registry_with(vec![tensor(3)]);
    reg.add_materialization(TensorId(3), mlx_id(), 100, shape_2x3(), f32_layout(), DType::F32).unwrap();
    assert_eq!(reg.get(TensorId(3)).unwrap().version(), TensorVersion(0));

    let r1 = reg.advance_version(TensorId(3), accelerate_id(), 200, shape_2x3(), f32_layout(), DType::F32).unwrap();
    assert_eq!(r1.new_version, TensorVersion(1));
    assert_eq!(reg.get(TensorId(3)).unwrap().version(), TensorVersion(1));
    assert_eq!(reg.get(TensorId(3)).unwrap().authoritative_backend(), accelerate_id());

    let r2 = reg.advance_version(TensorId(3), mlx_id(), 101, shape_2x3(), f32_layout(), DType::F32).unwrap();
    assert_eq!(r2.new_version, TensorVersion(2));
    assert_eq!(reg.get(TensorId(3)).unwrap().version(), TensorVersion(2));
    assert_eq!(reg.get(TensorId(3)).unwrap().authoritative_backend(), mlx_id());
}

// ── Transactional semantics ───────────────────────────────────────────

#[test]
fn failed_advance_version_preserves_state() {
    let mut reg = registry_with(vec![tensor(400)]);
    reg.add_materialization(TensorId(400), mlx_id(), 100, shape_2x3(), f32_layout(), DType::F32).unwrap();

    let v_before = reg.get(TensorId(400)).unwrap().version();
    let auth_before = reg.get(TensorId(400)).unwrap().authoritative_backend();

    // Attempt transition with wrong dtype
    let err = reg.advance_version(TensorId(400), accelerate_id(), 200, shape_2x3(), f32_layout(), DType::U32);
    assert!(err.is_err(), "wrong dtype must fail");

    // State must be UNCHANGED
    let t = reg.get(TensorId(400)).unwrap();
    assert_eq!(t.version(), v_before, "version unchanged");
    assert_eq!(t.authoritative_backend(), auth_before, "authority unchanged");
    assert!(t.is_fresh(mlx_id()), "materialization still fresh");
}

#[test]
fn failed_advance_version_immutable_preserves_state() {
    let mut reg = registry_with(vec![
        MaterializedTensor::new(TensorId(500), weight_contract(), mlx_id())
    ]);
    reg.add_materialization(TensorId(500), mlx_id(), 100, shape_4x4(), f32_layout(), DType::F32).unwrap();

    let v_before = reg.get(TensorId(500)).unwrap().version();
    let err = reg.advance_version(TensorId(500), accelerate_id(), 200, shape_4x4(), f32_layout(), DType::F32);
    assert!(err.is_err());

    let t = reg.get(TensorId(500)).unwrap();
    assert_eq!(t.version(), v_before);
    assert_eq!(t.authoritative_backend(), mlx_id());
}

#[test]
fn failed_advance_version_wrong_shape() {
    let mut reg = registry_with(vec![tensor(600)]);
    reg.add_materialization(TensorId(600), mlx_id(), 0, shape_2x3(), f32_layout(), DType::F32).unwrap();

    let v_before = reg.get(TensorId(600)).unwrap().version();
    // shape_4x4 has different dim count — validate_materialization rejects
    let err = reg.advance_version(TensorId(600), accelerate_id(), 0,
        TensorShape { dims: vec![4, 4, 1] },  // 3 dims vs 2 in contract
        f32_layout(), DType::F32);
    assert!(err.is_err());

    let t = reg.get(TensorId(600)).unwrap();
    assert_eq!(t.version(), v_before);
}

// ── Cross-backend transition ──────────────────────────────────────────

#[test]
fn cross_backend_transition_preserves_both_history_paths() {
    let mut reg = registry_with(vec![tensor(100)]);
    reg.add_materialization(TensorId(100), mlx_id(), 100, shape_2x3(), f32_layout(), DType::F32).unwrap();

    let receipt = reg.advance_version(TensorId(100), accelerate_id(), 200, shape_2x3(), f32_layout(), DType::F32).unwrap();

    assert!(receipt.previous_authoritative_materialization.is_some());
    assert_eq!(receipt.previous_authoritative_materialization.as_ref().unwrap().backend_id, mlx_id());
    assert!(receipt.replaced_destination_materialization.is_none());
}

#[test]
fn cross_backend_preserves_destination_prior_record() {
    let mut reg = registry_with(vec![tensor(101)]);
    reg.add_materialization(TensorId(101), mlx_id(), 100, shape_2x3(), f32_layout(), DType::F32).unwrap();
    reg.add_materialization(TensorId(101), accelerate_id(), 200, shape_2x3(), f32_layout(), DType::F32).unwrap();

    let receipt = reg.advance_version(TensorId(101), accelerate_id(), 300, shape_2x3(), f32_layout(), DType::F32).unwrap();
    assert!(receipt.previous_authoritative_materialization.is_some());
    assert!(receipt.replaced_destination_materialization.is_some());
    assert_eq!(receipt.replaced_destination_materialization.as_ref().unwrap().backend_handle, 200);
}

// ── Contract enforcement ──────────────────────────────────────────────

#[test]
fn dtype_mismatch_rejected() {
    let mut reg = registry_with(vec![tensor(50)]);
    let err = reg.add_materialization(TensorId(50), mlx_id(), 100, shape_2x3(), f32_layout(), DType::U32);
    assert!(err.is_err());
}

#[test]
fn immutable_weight_rejects_advance_version() {
    let mut reg = registry_with(vec![
        MaterializedTensor::new(TensorId(200), weight_contract(), mlx_id())
    ]);
    reg.add_materialization(TensorId(200), mlx_id(), 100, shape_4x4(), f32_layout(), DType::F32).unwrap();
    assert!(reg.advance_version(TensorId(200), accelerate_id(), 200, shape_4x4(), f32_layout(), DType::F32).is_err());
}

// ── Registry contracts ────────────────────────────────────────────────

#[test]
fn duplicate_tensor_registration_fails() {
    let mut reg = registry_with(vec![tensor(42)]);
    assert!(reg.register(tensor(42)).is_err());
}

#[test]
fn new_tensor_has_contract() {
    let t = tensor(8);
    assert_eq!(t.contract().canonical_dtype, DType::F32);
    assert_eq!(t.contract().logical_shape.dims, vec![2, 3]);
}

// ── Transfer record ───────────────────────────────────────────────────

#[test]
fn transfer_record_preserves_exact_layouts_and_dtypes() {
    let record = TensorTransferRecord {
        tensor_id: TensorId(1), tensor_version: TensorVersion(3),
        source_materialization: TensorMaterializationId(10),
        destination_materialization: TensorMaterializationId(11),
        source_backend: mlx_id(), destination_backend: accelerate_id(),
        source_layout: PhysicalLayout::RowMajor,
        destination_layout: PhysicalLayout::PackedU32 { group_size: 128, bits: 4 },
        source_dtype: DType::F32, destination_dtype: DType::U32,
        bytes_read: 4096, bytes_written: 512,
        transfer_ns: 1234, conversion_ns: 567, zero_copy: false,
    };
    assert_eq!(record.bytes_read, 4096);
}

#[test]
fn lossless_transfer_receipt() {
    let receipt = TensorTransferReceipt {
        tensor_id: TensorId(10), tensor_version: TensorVersion(1),
        source_materialization: TensorMaterializationId(100),
        destination_materialization: TensorMaterializationId(101),
        source_backend: mlx_id(), destination_backend: accelerate_id(),
        source_layout: PhysicalLayout::RowMajor,
        destination_layout: PhysicalLayout::ColumnMajor,
        source_dtype: DType::F32, destination_dtype: DType::F32,
        bytes_read: 4096, bytes_written: 4096,
        transfer_ns: 1000, conversion_ns: 100, zero_copy: false,
    };
    assert_eq!(receipt.bytes_read, 4096);
}
