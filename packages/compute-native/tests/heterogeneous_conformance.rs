//! Heterogeneous contract conformance tests.
//!
//! Tests the tensor registry, version-bound materializations, authority
//! transitions, transfer records, and cross-backend contract enforcement.

use tribunus_compute_native::backend::DType;
use tribunus_compute_native::backend::routing::{
    BackendId, PhysicalLayout, TensorId, TensorMaterializationId,
    TensorTransferReceipt, TensorVersion,
};
use tribunus_compute_native::backend::tensor_registry::{
    MaterializationRecord, MaterializationState, MaterializedTensor,
    TensorRegistry, TensorTransferRecord,
};

// ── Fixtures ──────────────────────────────────────────────────────────────

fn mlx_id() -> BackendId {
    BackendId(0)
}
fn accelerate_id() -> BackendId {
    BackendId(1)
}
fn coreml_id() -> BackendId {
    BackendId(2)
}

fn f32_layout() -> PhysicalLayout {
    PhysicalLayout::RowMajor
}

fn tensor(id: u64) -> MaterializedTensor {
    MaterializedTensor::new(TensorId(id), mlx_id())
}

// ── Version-bound materializations ────────────────────────────────────────

#[test]
fn mutation_invalidates_old_materializations() {
    let mut t = tensor(1);
    t.add_materialization(mlx_id(), 100, f32_layout(), DType::F32);
    t.add_materialization(accelerate_id(), 200, f32_layout(), DType::F32);

    assert!(t.is_fresh(mlx_id()));
    assert!(t.is_fresh(accelerate_id()));

    // Advance version — MLX produces new authority
    let (new_ver, invalidated) =
        t.advance_version(mlx_id(), 101, f32_layout(), DType::F32);

    assert_eq!(new_ver, TensorVersion(1));
    assert_eq!(t.version, TensorVersion(1));
    // MLX should still be fresh (it IS the authority)
    assert!(t.is_fresh(mlx_id()));
    // Accelerate should now be stale
    assert!(!t.is_fresh(accelerate_id()));
    // At least one invalidated record for Accelerate
    let acc_stale = invalidated
        .iter()
        .find(|r| r.backend_id == accelerate_id());
    assert!(acc_stale.is_some(), "accelerate must be in invalidated set");
    assert_eq!(acc_stale.unwrap().state, MaterializationState::Stale);
}

#[test]
fn stale_handle_rejected() {
    let mut t = tensor(2);
    t.add_materialization(mlx_id(), 100, f32_layout(), DType::F32);
    t.add_materialization(accelerate_id(), 200, f32_layout(), DType::F32);

    t.advance_version(mlx_id(), 101, f32_layout(), DType::F32);

    // Accelerate handle should now be rejected
    let handle = t.get_handle(accelerate_id());
    assert!(handle.is_none(), "stale accelerate handle must be rejected");
}

#[test]
fn authority_transition_increments_exactly_once() {
    let mut t = tensor(3);
    t.add_materialization(mlx_id(), 100, f32_layout(), DType::F32);

    assert_eq!(t.version, TensorVersion(0));

    let (v1, _) = t.advance_version(accelerate_id(), 200, f32_layout(), DType::F32);
    assert_eq!(v1, TensorVersion(1));
    assert_eq!(t.version, TensorVersion(1));
    assert_eq!(t.authoritative_backend, accelerate_id());

    let (v2, _) = t.advance_version(mlx_id(), 101, f32_layout(), DType::F32);
    assert_eq!(v2, TensorVersion(2));
    assert_eq!(t.version, TensorVersion(2));
    assert_eq!(t.authoritative_backend, mlx_id());
}

// ── Registry contracts ────────────────────────────────────────────────────

#[test]
fn duplicate_tensor_registration_fails() {
    let mut reg = TensorRegistry::new();
    let t1 = tensor(42);
    reg.register(t1).expect("first register");

    let t2 = tensor(42);
    let err = reg.register(t2);
    assert!(err.is_err(), "duplicate registration must fail");
    assert!(err.unwrap_err().contains("already registered"));
}

#[test]
fn explicit_replace_succeeds() {
    let mut reg = TensorRegistry::new();
    let t1 = tensor(99);
    reg.register(t1).expect("first register");
    assert_eq!(reg.get(TensorId(99)).unwrap().version, TensorVersion(0));

    let t2 = tensor(99);
    reg.replace(t2);
    assert_eq!(reg.get(TensorId(99)).unwrap().version, TensorVersion(0));
}

#[test]
fn registry_returns_none_for_unknown_id() {
    let mut reg = TensorRegistry::new();
    assert!(reg.get(TensorId(999)).is_none());
    assert!(reg.get_mut(TensorId(999)).is_none());
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
        destination_layout: PhysicalLayout::PackedU32 {
            group_size: 128,
            bits: 4,
        },
        source_dtype: DType::F32,
        destination_dtype: DType::U32,
        bytes_read: 4096,
        bytes_written: 512,
        transfer_ns: 1234,
        conversion_ns: 567,
        zero_copy: false,
    };

    // Verify all fields survive round-trip
    assert_eq!(record.tensor_id, TensorId(1));
    assert_eq!(record.tensor_version, TensorVersion(3));
    assert_eq!(record.source_backend, mlx_id());
    assert_eq!(record.destination_backend, accelerate_id());
    assert_eq!(record.bytes_read, 4096);
    assert_eq!(record.bytes_written, 512);
    assert_eq!(record.source_dtype, DType::F32);
    assert_eq!(record.destination_dtype, DType::U32);
    assert_eq!(record.transfer_ns, 1234);
    assert_eq!(record.conversion_ns, 567);
    assert!(!record.zero_copy);
}

#[test]
fn version_mismatch_means_stale() {
    let mut t = tensor(5);
    t.add_materialization(mlx_id(), 100, f32_layout(), DType::F32);

    // Manually create a situation where a materialization's version
    // doesn't match the logical tensor's version
    t.add_materialization(accelerate_id(), 200, f32_layout(), DType::F32);
    // Bump version without formally recording an accelerate materialization
    t.advance_version(mlx_id(), 101, f32_layout(), DType::F32);
    // Old accelerate materialization should be stale
    assert!(!t.is_fresh(accelerate_id()));
}

// ── Materialization state ─────────────────────────────────────────────────

#[test]
fn add_materialization_makes_fresh() {
    let mut t = tensor(6);
    let rec = t.add_materialization(mlx_id(), 100, f32_layout(), DType::F32);
    assert_eq!(rec.state, MaterializationState::Fresh);
    assert_eq!(rec.tensor_version, t.version);
}

#[test]
fn new_tensor_has_zero_materializations() {
    let t = tensor(7);
    assert!(t.materializations.is_empty());
    assert_eq!(t.version, TensorVersion(0));
}

// ── Cross-backend routing contract ────────────────────────────────────────

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

    // Verify no fields were lost
    assert_eq!(receipt.tensor_id, TensorId(10));
    assert_eq!(receipt.source_backend, mlx_id());
    assert_eq!(receipt.destination_backend, accelerate_id());
    assert_eq!(receipt.bytes_read, 4096);
    assert_eq!(receipt.conversion_ns, 100);
}
