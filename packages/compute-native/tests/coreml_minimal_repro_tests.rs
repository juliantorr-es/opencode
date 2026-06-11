//! Integration tests for Core ML Minimal Reproducer.
//!
//! Tests the structural verifier on negative fixtures to confirm it catches
//! the exact class of bugs it is designed to prevent.

use coreml_proto::proto::mil_spec;
use tribunus_compute_native::decode_attribution::coreml_minimal_repro::{
    DiagnosticGraphContract, VerificationErrorCode, verify_graph_contract, all_diagnostic_graphs,
};
use tribunus_compute_native::mil_builder::MilBuilder;

/// Helper: build a valid matmul program.
fn build_valid_matmul() -> mil_spec::Program {
    MilBuilder::new("main")
        .input("x", mil_spec::DataType::Float32, &[1, 4])
        .const_f32("w", &[1.0, 2.0, 3.0, 4.0], &[4, 1])
        .matmul("x", "w_0")
        .output("matmul_1")
        .build()
        .expect("valid matmul build")
}

/// Helper contract for a valid matmul.
fn matmul_contract() -> DiagnosticGraphContract {
    DiagnosticGraphContract {
        name: "integration_matmul",
        description: "known-valid matmul",
        track: "output_width",
        shape_k: 4,
        shape_n: 1,
        input_names: &["x"],
        output_names: &["matmul_1"],
        output_shapes: &[&[1, 1]],
        dtype: mil_spec::DataType::Float32,
        op_list: &["const", "matmul"],
        producer_map: &[("matmul_1", 1, "matmul", "matmul_1")],
        op_inputs: &[(1, "x", "x"), (1, "y", "w_0")],
        expected_fate: "expected_pass",
        build: |b| Ok(b),
    }
}

#[test]
fn verifier_rejects_missing_output() {
    let program = build_valid_matmul();
    let contract = DiagnosticGraphContract {
        output_names: &["nonexistent_output"],
        producer_map: &[("nonexistent_output", 1, "matmul", "nonexistent_output")],
        ..matmul_contract()
    };

    let result = verify_graph_contract(&program, &contract);
    assert!(result.is_err(), "should reject missing output");

    let errors = result.unwrap_err();
    assert!(
        errors.iter().any(|e| e.code == VerificationErrorCode::MissingOutput),
        "should contain MissingOutput error: {:?}",
        errors
    );
}

#[test]
fn verifier_rejects_wrong_output_shape() {
    let program = build_valid_matmul();
    let contract = DiagnosticGraphContract {
        output_shapes: &[&[1, 99]],
        ..matmul_contract()
    };

    let result = verify_graph_contract(&program, &contract);
    assert!(result.is_err(), "should reject wrong output shape");

    let errors = result.unwrap_err();
    assert!(
        errors.iter().any(|e| e.code == VerificationErrorCode::WrongOutputShape),
        "should contain WrongOutputShape error: {:?}",
        errors
    );
}

#[test]
fn verifier_rejects_wrong_input_binding() {
    let program = build_valid_matmul();
    let contract = DiagnosticGraphContract {
        op_inputs: &[(1, "x", "nonexistent_value")],
        ..matmul_contract()
    };

    let result = verify_graph_contract(&program, &contract);
    assert!(result.is_err(), "should reject wrong input binding");

    let errors = result.unwrap_err();
    assert!(
        errors.iter().any(|e| e.code == VerificationErrorCode::InputValueMismatch),
        "should contain InputValueMismatch error: {:?}",
        errors
    );
}

#[test]
fn verifier_rejects_wrong_op_index() {
    let program = build_valid_matmul();
    let contract = DiagnosticGraphContract {
        producer_map: &[("matmul_1", 0, "matmul", "matmul_1")],
        ..matmul_contract()
    };

    let result = verify_graph_contract(&program, &contract);
    assert!(result.is_err(), "should reject wrong producer op index");

    let errors = result.unwrap_err();
    assert!(
        errors.iter().any(|e| e.code == VerificationErrorCode::WrongOutputProducer),
        "should contain WrongOutputProducer error: {:?}",
        errors
    );
}

#[test]
fn verifier_rejects_wrong_op_count() {
    let program = build_valid_matmul();
    let contract = DiagnosticGraphContract {
        op_list: &["const", "matmul", "add"],
        op_inputs: &[(1, "x", "x"), (1, "y", "w_0")],
        ..matmul_contract()
    };

    let result = verify_graph_contract(&program, &contract);
    assert!(result.is_err(), "should reject wrong op count");

    let errors = result.unwrap_err();
    assert!(
        errors.iter().any(|e| e.code == VerificationErrorCode::OpIndexOutOfRange),
        "should contain OpIndexOutOfRange error: {:?}",
        errors
    );
}

#[test]
fn all_diagnostic_graphs_pass_structural_verification() {
    for contract in all_diagnostic_graphs() {
        let input_shape = &[1, contract.shape_k as i64];
        let builder = MilBuilder::new("main")
            .input("x", contract.dtype, input_shape);
        let builder = (contract.build)(builder);
        let builder = builder.unwrap();
        let program = match builder.build() {
            Ok(p) => p,
            Err(e) => {
                panic!("graph '{}' failed MIL build: {:?}", contract.name, e);
            }
        };
        let result = verify_graph_contract(&program, contract);
        assert!(
            result.is_ok(),
            "graph '{}' should pass structural verification: {:?}",
            contract.name,
            result
        );
    }
}
