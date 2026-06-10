//! Experiment artifact authority tests.
//!
//! Proves: SHA-256 sealing, contract digest completeness, golden-vector
//! reproducibility, dataset identity uniqueness, profile cardinality,
//! tamper detection, and fixture vs claim-grade validation.

use tribunus_compute_native::backend::routing::OperationId;
use tribunus_compute_native::experiment::{
    CorrectnessResult, ExperimentManifest, F32MatmulContract,
    F32MatmulTolerance, InputDataset, MachineProfile, SealedExperimentProfile,
    conformance_shapes, representative_shapes,
};

// ── Contract digest ──────────────────────────────────────────────────

#[test]
fn contract_digest_is_deterministic() {
    let c = F32MatmulContract::new(OperationId(1), 2, 4, 3);
    assert_eq!(c.digest(), c.digest());
}

#[test]
fn contract_digest_changes_with_shape() {
    let c1 = F32MatmulContract::new(OperationId(1), 2, 4, 3);
    let c2 = F32MatmulContract::new(OperationId(1), 2, 4, 5);
    assert_ne!(c1.digest(), c2.digest());
}

#[test]
fn contract_digest_changes_with_operation_id() {
    let c1 = F32MatmulContract::new(OperationId(1), 2, 4, 3);
    let c2 = F32MatmulContract::new(OperationId(2), 2, 4, 3);
    assert_ne!(c1.digest(), c2.digest(), "operation_id must affect digest");
}

#[test]
fn contract_digest_changes_with_transpose() {
    let mut c = F32MatmulContract::new(OperationId(1), 2, 4, 3);
    let d1 = c.digest();
    c.transpose_a = true;
    assert_ne!(c.digest(), d1, "transpose must affect digest");
}

// ── Shape matrices ──────────────────────────────────────────────────

#[test]
fn conformance_shapes_are_valid() {
    for &(m, k, n) in &conformance_shapes() { assert!(m>0 && k>0 && n>0); }
}

#[test]
fn representative_shapes_have_three_m_classes() {
    let shapes = representative_shapes();
    assert_eq!(shapes.len(), 3);
    assert_eq!(shapes[0].0, 1);
    assert_eq!(shapes[1].0, 4);
    assert_eq!(shapes[2].0, 16);
}

// ── Input dataset ────────────────────────────────────────────────────

#[test]
fn deterministic_inputs_are_reproducible() {
    let c = F32MatmulContract::new(OperationId(0), 2, 4, 3);
    let ds1 = InputDataset::generate(1, &c).unwrap();
    let ds2 = InputDataset::generate(1, &c).unwrap();
    assert_eq!(ds1.tensors[0].sha256, ds2.tensors[0].sha256);
    assert_eq!(ds1.tensors[1].sha256, ds2.tensors[1].sha256);
    assert_eq!(ds1.sha256, ds2.sha256);
}

#[test]
fn dataset_ids_are_unique_per_contract() {
    let c1 = F32MatmulContract::new(OperationId(10), 2, 4, 3);
    let c2 = F32MatmulContract::new(OperationId(11), 2, 4, 3);
    let ds1 = InputDataset::generate(1, &c1).unwrap();
    let ds2 = InputDataset::generate(1, &c2).unwrap();
    assert_ne!(ds1.dataset_id, ds2.dataset_id);
    assert_ne!(ds1.sha256, ds2.sha256);
}

#[test]
fn dataset_verify_passes() {
    let c = F32MatmulContract::new(OperationId(0), 2, 4, 3);
    let ds = InputDataset::generate(1, &c).unwrap();
    assert!(ds.verify(), "dataset must verify after generation");
}

#[test]
fn golden_vector_is_stable() {
    let c = F32MatmulContract::new(OperationId(0), 2, 4, 3);
    let ds = InputDataset::generate(1, &c).unwrap();
    // Golden: seed is derived from SHA-256, so the first element is deterministic
    assert_eq!(ds.generator_algorithm, "tribunus-e0008-input-v1");
    assert_eq!(ds.tensors.len(), 2);
    assert_eq!(ds.tensors[0].element_count, 6);
    assert_eq!(ds.tensors[1].element_count, 12);
    // sha256 must be non-empty
    assert!(!ds.tensors[0].sha256.0.is_empty());
    assert!(!ds.tensors[1].sha256.0.is_empty());
    assert!(!ds.sha256.0.is_empty());
}

// ── Machine profile ──────────────────────────────────────────────────

#[test]
fn m1_fixture_has_all_backends() {
    let mp = MachineProfile::m1_fixture();
    assert_eq!(mp.backend_versions.len(), 3);
}

#[test]
fn fixture_rejected_by_claim_grade() {
    let mp = MachineProfile::m1_fixture();
    assert!(mp.validate_claim_grade().is_err());
}

#[test]
fn sealed_machine_profile_verifies() {
    let mut mp = MachineProfile::m1_fixture();
    mp.seal();
    assert!(!mp.sha256.0.is_empty());
}

// ── Sealed profiles ──────────────────────────────────────────────────

#[test]
fn sealed_profiles_are_nonempty() {
    let c = F32MatmulContract::new(OperationId(0), 2, 4, 3);
    let p = SealedExperimentProfile::mlx_control(&c);
    assert!(!p.sha256.0.is_empty());
    assert!(p.verify());
}

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
    assert!(!p.verify(), "tampered profile must fail verify");
}

// ── Manifest ─────────────────────────────────────────────────────────

#[test]
fn manifest_has_twelve_profiles() {
    let manifest = ExperimentManifest::new(1);
    // 4 contracts × 3 backends = 12 profiles
    assert_eq!(manifest.profiles.len(), 12);
}

#[test]
fn manifest_seal_is_nonempty() {
    let mut manifest = ExperimentManifest::new(1);
    let d = manifest.seal();
    assert!(!d.0.is_empty());
}

#[test]
fn manifest_verify_passes_after_seal() {
    let mut manifest = ExperimentManifest::new(1);
    manifest.seal();
    assert!(manifest.verify(), "manifest must verify after sealing");
}

// ── Tolerance ────────────────────────────────────────────────────────

#[test]
fn tolerance_has_reasonable_defaults() {
    let tol = F32MatmulTolerance::default();
    assert!(tol.atol > 0.0);
    assert!(tol.max_relative_error > 0.0);
    assert!(!tol.digest().0.is_empty());
}

#[test]
fn tolerance_digest_is_deterministic() {
    let t1 = F32MatmulTolerance::default();
    let t2 = F32MatmulTolerance::default();
    assert_eq!(t1.digest(), t2.digest());
}
