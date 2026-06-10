//! Integration tests for the real-backend lowering preservation gate.

use crate::backend::routing::{
    EvidenceDigest, LogicalShape, OperationFamily, OperationId, Phase, TensorId,
};
use crate::backend::DType;
use crate::compiler::semantic::{SemanticModule, SemanticOp, ToleranceClass};

use super::dataset::F32MatmulDataset;
use super::mlx::lower_matmul_mlx;
use super::accelerate::lower_matmul_accelerate;
use super::coreml::lower_matmul_coreml;

fn build_semantic_matmul() -> (SemanticModule, F32MatmulDataset) {
    let mut sem = SemanticModule::new("matmul-contract", "1.0.0");
    let dataset = F32MatmulDataset::default();

    let a = TensorId(1);
    let w = TensorId(2);
    let c = TensorId(3);

    sem.declare_input(a, "a", LogicalShape { dims: vec![1, 4] }, DType::F32);
    sem.add_weight(w, "weight", LogicalShape { dims: vec![4, 1] }, DType::F32, None);
    sem.add_activation(c, "out", LogicalShape { dims: vec![1, 1] }, DType::F32, OperationId(1));

    sem.push_op(SemanticOp {
        id: OperationId(1),
        name: "matmul".into(),
        family: OperationFamily::Matmul,
        layer_index: None,
        phase: Phase::Qualification,
        inputs: vec![a, w],
        outputs: vec![c],
        stateful: false,
        state_reads: vec![],
        state_writes: vec![],
        quantization: None,
        tolerance_class: ToleranceClass::Fp16,
    });

    sem.declare_output(c);
    sem.seal();

    (sem, dataset)
}

#[test]
fn mlx_preserves_matmul_route() {
    let (sem, dataset) = build_semantic_matmul();
    let digest = sem.digest.clone();

    let receipt = lower_matmul_mlx(&dataset, digest)
        .expect("MLX lowering must succeed");

    assert!(receipt.output_verified,
        "MLX output must match known answer");
    assert_eq!(receipt.output_data.len(), 1);

    let got = receipt.output_data[0];
    let want = 30.0;
    assert!((got - want).abs() < 1e-4,
        "MLX matmul [1,4]x[4,1] = 30.0, got {got}");

    assert!(receipt.lowering.compile_duration_ns > 0);
    assert!(receipt.readback_ns > 0);
}

#[test]
fn accelerate_preserves_matmul_route() {
    let (sem, dataset) = build_semantic_matmul();
    let digest = sem.digest.clone();

    let receipt = lower_matmul_accelerate(&dataset, digest)
        .expect("Accelerate lowering must succeed");

    assert!(receipt.output_verified,
        "Accelerate output must match known answer");
    assert_eq!(receipt.output_data.len(), 1);

    let got = receipt.output_data[0];
    let want = 30.0;
    assert!((got - want).abs() < 1e-4,
        "Accelerate matmul [1,4]x[4,1] = 30.0, got {got}");

    assert!(receipt.lowering.compile_duration_ns > 0);
    assert!(receipt.readback_ns > 0);
}

#[test]
fn coreml_preserves_compile_route() {
    let (_sem, dataset) = build_semantic_matmul();
    let digest = _sem.digest.clone();

    let receipt = lower_matmul_coreml(&dataset, digest)
        .expect("Core ML lowering must succeed (xcrun required)");

    assert!(receipt.artifact_exists,
        "Core ML .mlmodelc artifact must exist on disk");
    assert!(receipt.lowering.compile_duration_ns > 0);
    assert!(!receipt.island_receipt.compiled_hash.is_empty());
    assert!(!receipt.island_receipt.model_hash.is_empty());
}
