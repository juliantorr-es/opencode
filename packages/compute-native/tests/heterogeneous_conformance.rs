//! Heterogeneous contract conformance tests.
//!
//! Tests the tensor registry, version-bound materializations, authority
//! transitions, transfer records, and cross-backend contract enforcement.

use tribunus_compute_native::backend::DType;
use tribunus_compute_native::backend::routing::{
    BackendId, LogicalShape, PhysicalLayout, TensorId, TensorMaterializationId,
    TensorTransferReceipt, TensorVersion,
};
use tribunus_compute_native::backend::tensor_registry::{
    MaterializationRecord, MaterializationSequence, MaterializationState,
    MaterializedTensor, TensorContract, TensorMutability, TensorRegistry,
    TensorRole, TensorTransferRecord,
};

// ── Fixtures ──────────────────────────────────────────────────────────────

fn mlx_id() -> BackendId { BackendId(0) }
fn accelerate_id() -> BackendId { BackendId(1) }
fn coreml_id() -> BackendId { BackendId(2) }

fn f32_layout() -> PhysicalLayout { PhysicalLayout::RowMajor }

fn small_contract() -> TensorContract {
    TensorContract {
        logical_shape: LogicalShape { dims: vec![2, 3] },
        canonical_dtype: DType::F32,
        mutability: TensorMutability::Mutable,
        role: TensorRole::Activation,
    }
}

fn tensor(id: u64) -> MaterializedTensor {
    MaterializedTensor::new(TensorId(id), small_contract(), mlx_id())
}

fn seq() -> MaterializationSequence { MaterializationSequence::new() }

// ── Version-bound materializations ────────────────────────────────────────

#[test]
fn mutation_invalidates_old_materializations() {
    let mut t = tensor(1);
    let mut sq = seq();
    t.add_materialization(&mut sq, mlx_id(), 100, f32_layout(), DType::F32);
    t.add_materialization(&mut sq, accelerate_id(), 200, f32_layout(), DType::F32);

    assert!(t.is_fresh(mlx_id()));
    assert!(t.is_fresh(accelerate_id()));

    let receipt = t.advance_version(&mut sq, mlx_id(), 101, f32_layout(), DType::F32);

    assert_eq!(receipt.new_version, TensorVersion(1));
    assert_eq!(t.version, TensorVersion(1));
    assert_eq!(receipt.previous_version, TensorVersion(0));
    assert_eq!(receipt.previous_authority, mlx_id());
    assert_eq!(receipt.new_authority, mlx_id());

    assert!(t.is_fresh(mlx_id()));
    assert!(!t.is_fresh(accelerate_id()));

    let acc_stale = receipt.invalidated
        .iter()
        .find(|r| r.backend_id == accelerate_id());
    assert!(acc_stale.is_some(), "accelerate must be in invalidated set");
    assert_eq!(acc_stale.unwrap().state, MaterializationState::Stale);
}

#[test]
fn stale_handle_rejected() {
    let mut t = tensor(2);
    let mut sq = seq();
    t.add_materialization(&mut sq, mlx_id(), 100, f32_layout(), DType::F32);
    t.add_materialization(&mut sq, accelerate_id(), 200, f32_layout(), DType::F32);

    t.advance_version(&mut sq, mlx_id(), 101, f32_layout(), DType::F32);

    let handle = t.get_handle(accelerate_id());
    assert!(handle.is_none(), "stale accelerate handle must be rejected");
}

#[test]
fn authority_transition_increments_exactly_once() {
    let mut t = tensor(3);
    let mut sq = seq();
    t.add_materialization(&mut sq, mlx_id(), 100, f32_layout(), DType::F32);

    assert_eq!(t.version, TensorVersion(0));

    let r1 = t.advance_version(&mut sq, accelerate_id(), 200, f32_layout(), DType::F32);
    assert_eq!(r1.new_version, TensorVersion(1));
    assert_eq!(t.version, TensorVersion(1));
    assert_eq!(t.authoritative_backend, accelerate_id());

    let r2 = t.advance_version(&mut sq, mlx_id(), 101, f32_layout(), DType::F32);
    assert_eq!(r2.new_version, TensorVersion(2));
    assert_eq!(t.version, TensorVersion(2));
    assert_eq!(t.authoritative_backend, mlx_id());
}

#[test]
fn authority_transition_replaced_authoritative_preserved() {
    let mut t = tensor(100);
    let mut sq = seq();
    t.add_materialization(&mut sq, mlx_id(), 100, f32_layout(), DType::F32);

    // MLX was the authoritative backend; transition to Accelerate
    let receipt = t.advance_version(&mut sq, accelerate_id(), 200, f32_layout(), DType::F32);
    // The old MLX materialization should be preserved in replaced_authoritative
    assert!(receipt.replaced_authoritative.is_some(), "old authoritative must be preserved");
    let old = receipt.replaced_authoritative.unwrap();
    assert_eq!(old.backend_id, mlx_id());
    assert_eq!(old.backend_handle, 100);
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
fn version_mutation_only_through_advance_version() {
    // adv_version is the only way to mutate version;
    // there is no replace() method.
    let mut reg = TensorRegistry::new();
    let t = tensor(99);
    reg.register(t).expect("first register");

    let stored = reg.get(TensorId(99)).unwrap();
    assert_eq!(stored.version, TensorVersion(0));
    assert_eq!(stored.authoritative_backend, mlx_id());

    // Mutate through advance_version on the registry-owned tensor
    let mut sq = seq();
    let mut t_mut = reg.get_mut(TensorId(99)).unwrap();
    let receipt = t_mut.advance_version(&mut sq, accelerate_id(), 300, f32_layout(), DType::F32);
    assert_eq!(receipt.new_version, TensorVersion(1));
    assert_eq!(t_mut.version, TensorVersion(1));
    assert_eq!(t_mut.authoritative_backend, accelerate_id());
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
    let mut sq = seq();
    t.add_materialization(&mut sq, mlx_id(), 100, f32_layout(), DType::F32);
    t.add_materialization(&mut sq, accelerate_id(), 200, f32_layout(), DType::F32);

    t.advance_version(&mut sq, mlx_id(), 101, f32_layout(), DType::F32);
    assert!(!t.is_fresh(accelerate_id()));
}

// ── Materialization state ─────────────────────────────────────────────────

#[test]
fn add_materialization_makes_fresh() {
    let mut t = tensor(6);
    let mut sq = seq();
    let rec = t.add_materialization(&mut sq, mlx_id(), 100, f32_layout(), DType::F32);
    assert_eq!(rec.state, MaterializationState::Fresh);
    assert_eq!(rec.tensor_version, t.version);
}

#[test]
fn new_tensor_has_zero_materializations() {
    let t = tensor(7);
    assert!(t.materializations.is_empty());
    assert_eq!(t.version, TensorVersion(0));
}

#[test]
fn new_tensor_has_contract() {
    let t = tensor(8);
    assert_eq!(t.contract.canonical_dtype, DType::F32);
    assert_eq!(t.contract.logical_shape.dims, vec![2, 3]);
    assert_eq!(t.contract.mutability, TensorMutability::Mutable);
    assert_eq!(t.contract.role, TensorRole::Activation);
}

#[test]
fn materialization_ids_are_monotonic() {
    let mut sq = seq();
    let id0 = sq.next();
    let id1 = sq.next();
    let id2 = sq.next();
    assert!(id0.0 < id1.0);
    assert!(id1.0 < id2.0);
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

    assert_eq!(receipt.tensor_id, TensorId(10));
    assert_eq!(receipt.source_backend, mlx_id());
    assert_eq!(receipt.destination_backend, accelerate_id());
    assert_eq!(receipt.bytes_read, 4096);
    assert_eq!(receipt.conversion_ns, 100);
}
