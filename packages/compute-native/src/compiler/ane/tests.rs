//! Integration tests for Mission 0010: ANE Legality and Artifact Modeling.
//!
//! Tests:
//! 1. F32 matmul legality evaluation — matmul + conv lowering candidate,
//!    IOSurface contract, weight plan, compile plan.
//! 2. Differential legality — mutate one property, expect one rule violation.

use crate::backend::DType;
use crate::backend::routing::{
    BackendId, EvidenceDigest, LogicalShape, OperationFamily, OperationId,
    Phase, TensorId, TensorShape, PhysicalLayout,
};
use crate::compiler::semantic::{SemanticModule, SemanticOp, ToleranceClass};
use crate::compiler::scheduled::{
    RegionId, ScheduledModule, ScheduledRegion, PhysicalTensor, StorageClass,
    FusionBoundary,
};
use crate::compiler::ane::legality::{AneLegality, AneRule, LegalityStatus, RuleEvaluation};
use crate::compiler::ane::rules::register_orion_rules;
use crate::compiler::ane::artifacts::{
    AneCompilePlan, AneIoContract, AneIoSurfaceSpec, AneWeightBlobPlan,
    AneBlobEntry, AneProgramArtifactIdentity, AneProgramGeneration,
};

/// Build a known-answer F32 matmul scheduled region with ANE-compatible
/// physical tensors (fp16, IOSurface, [1,C,1,S] layout).
fn build_ane_matmul_region() -> (SemanticModule, ScheduledRegion) {
    let mut sem = SemanticModule::new("ane-matmul", "1.0.0");
    let a = TensorId(1);
    let w = TensorId(2);
    let c = TensorId(3);

    // ANE-compatible shapes: 768 * 32 = 24576 elements * 2 = 49152 bytes = min
    sem.declare_input(a, "a", LogicalShape { dims: vec![1, 768, 1, 32] }, DType::F32);
    sem.add_weight(w, "weight", LogicalShape { dims: vec![768, 32] }, DType::F32, None);
    sem.add_activation(c, "out", LogicalShape { dims: vec![1, 32, 1, 1] }, DType::F32, OperationId(1));

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

    let region = ScheduledRegion {
        region_id: RegionId(1),
        name: "ane-matmul-v1".into(),
        operations: vec![OperationId(1)],
        selected_backend: BackendId(4),
        physical_tensors: vec![
            PhysicalTensor {
                semantic_id: a,
                name: "a".into(),
                shape: TensorShape { dims: vec![1, 768, 1, 32] },
                dtype: DType::F16,
                layout: PhysicalLayout::RowMajor,
                storage_class: StorageClass::IoSurface,
                backend: BackendId(4),
                materialized: true,
                alignment: 16384,
            },
            PhysicalTensor {
                semantic_id: w,
                name: "w".into(),
                shape: TensorShape { dims: vec![768, 32] },
                dtype: DType::F16,
                layout: PhysicalLayout::RowMajor,
                storage_class: StorageClass::IoSurface,
                backend: BackendId(4),
                materialized: true,
                alignment: 16384,
            },
            PhysicalTensor {
                semantic_id: c,
                name: "c".into(),
                shape: TensorShape { dims: vec![1, 768, 1, 32] }, // padded for ANE min
                dtype: DType::F16,
                layout: PhysicalLayout::RowMajor,
                storage_class: StorageClass::IoSurface,
                backend: BackendId(4),
                materialized: true,
                alignment: 16384,
            },
        ],
        inputs: vec![a, w],
        outputs: vec![c],
        dependencies: vec![],
        fusions: vec![
            FusionBoundary {
                operations: vec![OperationId(1)],
                fused_family: OperationFamily::Matmul,
                qualified: false,
                backend: Some(BackendId(4)),
            },
        ],
        state_effects: vec![],
        temp_memory_bytes: 0,
        is_fence: false,
    };

    (sem, region)
}

#[test]
fn f32_matmul_is_ane_legal() {
    let (_sem, region) = build_ane_matmul_region();
    let mut legality = AneLegality::new(EvidenceDigest("m1-max-profile".into()));
    register_orion_rules(&mut legality);

    let receipt = legality.evaluate_region(&region);

    // The matmul region should be legal: fp16, IOSurface, >=49KB, no concat/GELU
    assert_eq!(receipt.status, LegalityStatus::Legal,
        "F32 matmul with fp16 IOSurface tensors must be legal; violations: {:?}",
        receipt.violations.iter().map(|v| &v.message).collect::<Vec<_>>());

    assert_eq!(receipt.satisfied_rules.len(), 13);
    assert!(receipt.violations.is_empty());
    assert!(!receipt.receipt_digest.0.is_empty());

    // The matmul-to-conv1x1 rule should report the candidate available
    let conv_rule = receipt.satisfied_rules.iter()
        .find(|r| r.rule.id == "ANE-OP-001")
        .expect("ANE-OP-001 matmul-conv rule must be present");
    assert!(conv_rule.satisfied);
}

#[test]
fn matmul_produces_compile_plan() {
    let (_sem, region) = build_ane_matmul_region();
    let mut legality = AneLegality::new(EvidenceDigest("m1-max-profile".into()));
    register_orion_rules(&mut legality);
    let receipt = legality.evaluate_region(&region);
    assert_eq!(receipt.status, LegalityStatus::Legal);

    // Build the derived artifact plans
    let io_contract = AneIoContract {
        digest: EvidenceDigest("io-c1".into()),
        surfaces: region.physical_tensors.iter().map(|pt| AneIoSurfaceSpec {
            tensor_id: pt.semantic_id,
            shape: [pt.shape.dims.get(0).copied().unwrap_or(1) as u64,
                    pt.shape.dims.get(1).copied().unwrap_or(4) as u64,
                    pt.shape.dims.get(2).copied().unwrap_or(1) as u64,
                    pt.shape.dims.get(3).copied().unwrap_or(4) as u64],
            dtype: pt.dtype,
            byte_size: pt.shape.dims.iter().fold(2u64, |a, &d| a * d as u64), // fp16
            alignment: pt.alignment,
            is_input: region.inputs.contains(&pt.semantic_id),
        }).collect(),
    };

    let weight_plan = AneWeightBlobPlan {
        digest: EvidenceDigest("wb-c1".into()),
        entries: vec![AneBlobEntry {
            tensor_id: TensorId(2),
            relative_path: "weights/weight.bin".into(),
            offset: 64,
            length: 49152, // 768*32*2 bytes fp16
            source_dtype: DType::F32,
            target_dtype: DType::F16,
        }],
        total_bytes: 128 + 49152, // header + payload
    };

    let compile_plan = AneCompilePlan {
        digest: EvidenceDigest("cp-c1".into()),
        mil_text_digest: EvidenceDigest("mil-c1".into()),
        io_contract_digest: io_contract.digest.clone(),
        weight_blob_digest: weight_plan.digest.clone(),
        opset: "ios18".into(),
        machine_profile_digest: receipt.machine_profile_digest.clone(),
        compile_budget_units: 1,
    };

    let prog_id = AneProgramArtifactIdentity {
        artifact_id: crate::backend::routing::BackendArtifactId(100),
        compile_plan_digest: compile_plan.digest.clone(),
        program_digest: EvidenceDigest("prog-c1".into()),
    };

    let _gen = AneProgramGeneration {
        code_identity: prog_id,
        generation: 1,
        weight_digest: weight_plan.digest,
        compiled: false,
    };

    // Verify the chain: receipt → IO → weights → compile plan → program
    assert_eq!(io_contract.surfaces.len(), 3);
    assert_eq!(weight_plan.entries.len(), 1);
    assert_eq!(compile_plan.compile_budget_units, 1);
}

// ═══════════════════════════════════════════════════════════════════════════
// Differential legality tests
// ═══════════════════════════════════════════════════════════════════════════

#[test]
fn diff_unsupported_dtype_violates_tensor002() {
    let (_sem, mut region) = build_ane_matmul_region();
    // Corrupt: change one tensor to Int8
    region.physical_tensors[0].dtype = DType::I8;

    let mut legality = AneLegality::new(EvidenceDigest("m1-max".into()));
    register_orion_rules(&mut legality);
    let receipt = legality.evaluate_region(&region);

    assert_eq!(receipt.status, LegalityStatus::Illegal,
        "Int8 dtype must be illegal on ANE");
    let v = receipt.violations.iter()
        .find(|v| v.rule.id == "ANE-TENSOR-002")
        .expect("ANE-TENSOR-002 must fire for unsupported dtype");
    assert!(v.fatal);
    assert!(!v.tensors.is_empty(), "must identify affected tensor");
}

#[test]
fn diff_undersized_tensor_violates_tensor001() {
    let (_sem, mut region) = build_ane_matmul_region();
    // Corrupt: make the output tensor tiny (1 byte — below 49KB)
    region.physical_tensors[2].shape = TensorShape { dims: vec![1] };
    region.physical_tensors[2].dtype = DType::F16;

    let mut legality = AneLegality::new(EvidenceDigest("m1-max".into()));
    register_orion_rules(&mut legality);
    let receipt = legality.evaluate_region(&region);

    let v = receipt.violations.iter()
        .find(|v| v.rule.id == "ANE-TENSOR-001")
        .expect("ANE-TENSOR-001 must fire for undersized tensor");
    assert!(v.fatal);
    assert!(!v.tensors.is_empty());
}

#[test]
fn diff_non_alphabetical_outputs_violates_io003() {
    let (_sem, mut region) = build_ane_matmul_region();
    // Add a second output with a name that sorts before the first
    region.outputs.push(TensorId(4));
    // region.outputs is now [TensorId(3), TensorId(4)] — names are "tensor_3", "tensor_4"
    // which ARE alphabetical. Let's make them non-alphabetical by using names
    // that sort differently. The alphabetical check uses "tensor_{id.0}",
    // so 4 before 3 would be: [TensorId(4), TensorId(3)] → "tensor_4", "tensor_3"
    region.outputs = vec![TensorId(4), TensorId(3)];

    let mut legality = AneLegality::new(EvidenceDigest("m1-max".into()));
    register_orion_rules(&mut legality);
    let receipt = legality.evaluate_region(&region);

    let v = receipt.violations.iter()
        .find(|v| v.rule.id == "ANE-IO-003")
        .expect("ANE-IO-003 must fire for non-alphabetical outputs");
    assert!(v.fatal);
    assert!(!v.tensors.is_empty());
    assert_eq!(receipt.status, LegalityStatus::Illegal);
}

#[test]
fn diff_no_fusion_matmul_passes_but_op001_says_no_matmul() {
    let (_sem, mut region) = build_ane_matmul_region();
    region.fusions.clear(); // remove matmul fusion annotation

    let mut legality = AneLegality::new(EvidenceDigest("m1-max".into()));
    register_orion_rules(&mut legality);
    let receipt = legality.evaluate_region(&region);

    // Still legal (no fatal violations), but OP-001 should say "no matmul"
    assert_eq!(receipt.status, LegalityStatus::Legal);
    let op001 = receipt.satisfied_rules.iter()
        .find(|r| r.rule.id == "ANE-OP-001").unwrap();
    assert!(op001.description.contains("no matmul"));
}
