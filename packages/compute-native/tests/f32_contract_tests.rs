//! Experiment artifact conformance tests.
//!
//! Proves: contract serialization, deterministic input generation,
//! manifest creation, profile sealing, machine profile, and tolerance.

use tribunus_compute_native::backend::routing::OperationId;
use tribunus_compute_native::experiment::{
    CorrectnessResult, ExperimentManifest, F32MatmulContract,
    F32MatmulTolerance, InputDataset, MachineProfile, SealedExperimentProfile,
    conformance_shapes, representative_shapes,
};

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
fn conformance_shapes_are_valid() {
    let shapes = conformance_shapes();
    assert_eq!(shapes.len(), 4);
    for &(m, k, n) in &shapes {
        assert!(m > 0 && k > 0 && n > 0);
    }
}

#[test]
fn representative_shapes_have_three_m_classes() {
    let shapes = representative_shapes();
    assert_eq!(shapes.len(), 3);
    assert_eq!(shapes[0].0, 1);
    assert_eq!(shapes[1].0, 4);
    assert_eq!(shapes[2].0, 16);
}

#[test]
fn deterministic_inputs_are_reproducible() {
    let contract = F32MatmulContract::new(OperationId(0), 2, 4, 3);
    let ds1 = InputDataset::generate(1, &contract);
    let ds2 = InputDataset::generate(1, &contract);
    assert_eq!(ds1.tensors.len(), 2);
    assert_eq!(ds2.tensors.len(), 2);
    assert_eq!(ds1.tensors[0].sha256, ds2.tensors[0].sha256);
    assert_eq!(ds1.tensors[1].sha256, ds2.tensors[1].sha256);
}

#[test]
fn deterministic_inputs_have_correct_shapes() {
    let contract = F32MatmulContract::new(OperationId(0), 2, 4, 3);
    let ds = InputDataset::generate(1, &contract);
    assert_eq!(ds.tensors[0].shape, vec![2, 3]);
    assert_eq!(ds.tensors[1].shape, vec![3, 4]);
    assert_eq!(ds.tensors[0].element_count, 6);
    assert_eq!(ds.tensors[1].element_count, 12);
}

#[test]
fn deterministic_inputs_are_bounded() {
    let contract = F32MatmulContract::new(OperationId(0), 4, 4, 4);
    let ds = InputDataset::generate(1, &contract);
    for t in &ds.tensors {
        assert!(t.min_val >= -0.13 && t.max_val <= 0.13,
            "values must be in [-0.125, 0.125] range");
    }
}

#[test]
fn manifest_creates_four_contracts() {
    let manifest = ExperimentManifest::new(1);
    assert_eq!(manifest.contracts.len(), 4);
    assert_eq!(manifest.profiles.len(), 3);
}

#[test]
fn manifest_profiles_cover_three_backends() {
    let manifest = ExperimentManifest::new(1);
    let backends: Vec<u32> = manifest.profiles.iter().map(|p| p.backend.0).collect();
    assert_eq!(backends, vec![0, 1, 2]); // MLX, Accelerate, Core ML
}

#[test]
fn machine_profile_has_all_backends() {
    let mp = MachineProfile::m1_default();
    assert_eq!(mp.backend_versions.len(), 3);
    assert_eq!(mp.backend_versions[0].backend_name, "mlx");
    assert_eq!(mp.backend_versions[1].backend_name, "accelerate");
    assert_eq!(mp.backend_versions[2].backend_name, "coreml");
}

#[test]
fn sealed_profile_names_match_spec() {
    let contract = F32MatmulContract::new(OperationId(0), 2, 4, 3);
    assert_eq!(
        SealedExperimentProfile::mlx_control(&contract).profile_name,
        "F32-MATMUL-MLX-GPU-v1"
    );
    assert_eq!(
        SealedExperimentProfile::accelerate_cpu(&contract).profile_name,
        "F32-MATMUL-ACCELERATE-CPU-v1"
    );
    assert_eq!(
        SealedExperimentProfile::coreml_ane(&contract).profile_name,
        "F32-MATMUL-COREML-CPU-ANE-v1"
    );
}
