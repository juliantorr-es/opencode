//! Experiment artifact authority tests — recursive sealing, layout payloads,
//! tensor data verification, per-contract datasets, build attestation.

use tribunus_compute_native::backend::routing::{OperationId, PhysicalLayout};
use tribunus_compute_native::experiment::{
    CorrectnessResult, ExperimentManifest, F32MatmulContract,
    F32MatmulTolerance, InputDataset, MachineProfile, SealedExperimentProfile,
    conformance_shapes, representative_shapes,
};

// ── Contract digest ──────────────────────────────────────────────────

#[test]
fn contract_digest_deterministic() {
    let c = F32MatmulContract::new(OperationId(1), 2, 4, 3);
    assert_eq!(c.digest(), c.digest());
}

#[test]
fn contract_digest_changes_with_shape() {
    assert_ne!(F32MatmulContract::new(OperationId(1), 2, 4, 3).digest(), F32MatmulContract::new(OperationId(1), 2, 4, 5).digest());
}

#[test]
fn contract_digest_changes_with_op_id() {
    assert_ne!(F32MatmulContract::new(OperationId(1), 2, 4, 3).digest(), F32MatmulContract::new(OperationId(2), 2, 4, 3).digest());
}

#[test]
fn contract_digest_changes_with_transpose() {
    let mut c = F32MatmulContract::new(OperationId(1), 2, 4, 3);
    let d = c.digest();
    c.transpose_a = true;
    assert_ne!(c.digest(), d);
}

#[test]
fn contract_digest_changes_with_layout_payload() {
    let c1 = F32MatmulContract::new(OperationId(1), 2, 4, 3);
    let mut c2 = c1.clone();
    c2.output_layout = PhysicalLayout::PackedU32 { group_size: 128, bits: 4 };
    assert_ne!(c1.digest(), c2.digest(), "PackedU32 fields must affect digest");
}

// ── Shape matrices ──────────────────────────────────────────────────

#[test]
fn conformance_shapes_valid() { for &(m,k,n) in &conformance_shapes() { assert!(m>0&&k>0&&n>0); } }

#[test]
fn representative_shapes_three_m_classes() {
    let s = representative_shapes();
    assert_eq!(s.len(), 3);
    assert_eq!(s[0].0, 1); assert_eq!(s[1].0, 4); assert_eq!(s[2].0, 16);
}

// ── Input dataset ────────────────────────────────────────────────────

#[test]
fn dataset_reproducible() {
    let c = F32MatmulContract::new(OperationId(0), 2, 4, 3);
    let d1 = InputDataset::generate(1, &c).unwrap();
    let d2 = InputDataset::generate(1, &c).unwrap();
    assert_eq!(d1.tensors[0].sha256, d2.tensors[0].sha256);
    assert_eq!(d1.sha256, d2.sha256);
}

#[test]
fn dataset_ids_unique_per_contract() {
    assert_ne!(InputDataset::generate(1, &F32MatmulContract::new(OperationId(10), 2, 4, 3)).unwrap().dataset_id,
               InputDataset::generate(1, &F32MatmulContract::new(OperationId(11), 2, 4, 3)).unwrap().dataset_id);
}

#[test]
fn tensor_verify_passes() {
    let c = F32MatmulContract::new(OperationId(0), 2, 4, 3);
    let ds = InputDataset::generate(1, &c).unwrap();
    for t in &ds.tensors { assert!(t.verify()); }
}

#[test]
fn tensor_verify_detects_tampering() {
    let c = F32MatmulContract::new(OperationId(0), 2, 4, 3);
    let mut ds = InputDataset::generate(1, &c).unwrap();
    ds.tensors[0].data[0] ^= 0xFF;
    assert!(!ds.tensors[0].verify(), "tampered bytes must fail verify");
}

#[test]
fn golden_vector_stable() {
    let ds = InputDataset::generate(1, &F32MatmulContract::new(OperationId(0), 2, 4, 3)).unwrap();
    assert_eq!(ds.generator_algorithm, "tribunus-e0008-input-v1");
    assert_eq!(ds.tensors.len(), 2);
    assert!(!ds.tensors[0].sha256.0.is_empty());
}

// ── Machine profile ──────────────────────────────────────────────────

#[test]
fn machine_fixture_rejected_by_claim_grade() {
    assert!(MachineProfile::m1_fixture().validate_claim_grade().is_err());
}

#[test]
fn machine_seal_and_verify() {
    let mut mp = MachineProfile::m1_fixture();
    mp.seal();
    assert!(mp.verify());
}

// ── Sealed profiles ─────────────────────────────────────────────────

#[test]
fn sealed_profiles_verify() {
    let c = F32MatmulContract::new(OperationId(0), 2, 4, 3);
    assert!(SealedExperimentProfile::mlx_control(&c).verify());
    assert!(SealedExperimentProfile::accelerate_cpu(&c).verify());
    assert!(SealedExperimentProfile::coreml_ane(&c).verify());
}

#[test]
fn sealed_profile_tamper_detected() {
    let c = F32MatmulContract::new(OperationId(0), 2, 4, 3);
    let mut p = SealedExperimentProfile::mlx_control(&c);
    p.backend = tribunus_compute_native::backend::routing::BackendId(99);
    assert!(!p.verify());
}

// ── Manifest ─────────────────────────────────────────────────────────

#[test]
fn manifest_fixture_has_12_profiles() {
    assert_eq!(ExperimentManifest::fixture().profiles.len(), 12);
}

#[test]
fn manifest_seal_and_verify() {
    let mut m = ExperimentManifest::fixture();
    m.seal();
    assert!(m.verify());
}

#[test]
fn manifest_verify_fails_with_empty_digest() {
    let m = ExperimentManifest::fixture();
    assert!(!m.verify(), "unsealed manifest must fail verify");
}

#[test]
fn manifest_with_datasets_seals_and_verifies() {
    let mut m = ExperimentManifest::fixture();
    let mut datasets = Vec::new();
    for c in &m.contracts {
        datasets.push(InputDataset::generate(1, c).unwrap());
    }
    m.datasets = datasets;
    m.seal();
    assert!(m.verify(), "manifest with per-contract datasets must verify");
}

#[test]
fn manifest_detect_tampered_dataset() {
    let mut m = ExperimentManifest::fixture();
    let ds = InputDataset::generate(1, &m.contracts[0]).unwrap();
    m.datasets = vec![ds];
    m.seal();

    let mut tampered = m.clone();
    tampered.datasets[0].tensors[0].data[0] ^= 0xFF;
    assert!(!tampered.verify(), "tampered dataset bytes must fail manifest verify");
}
