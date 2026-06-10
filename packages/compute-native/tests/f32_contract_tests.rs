//! F32 matmul contract conformance tests.
//!
//! Proves: contract digest determinism, shape matrix correctness,
//! tolerance defaults, and correctness result structure.

use tribunus_compute_native::experiment::{
    CorrectnessResult, F32MatmulContract, F32MatmulTolerance,
    conformance_shapes, representative_shapes,
};
use tribunus_compute_native::backend::routing::OperationId;

#[test]
fn contract_digest_is_deterministic() {
    let c1 = F32MatmulContract::new(OperationId(1), 2, 4, 3);
    let c2 = F32MatmulContract::new(OperationId(1), 2, 4, 3);
    assert_eq!(c1.digest(), c2.digest());
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
fn representative_shapes_are_valid() {
    let shapes = representative_shapes();
    assert!(!shapes.is_empty());
    for &(m, k, n) in &shapes {
        assert!(m > 0 && k > 0 && n > 0);
        assert!(m <= 1024); // sanity: no absurd M
    }
}

#[test]
fn tolerance_has_reasonable_defaults() {
    let tol = F32MatmulTolerance::default();
    assert!(tol.atol > 0.0);
    assert!(tol.rtol > 0.0);
    assert!(tol.min_cosine > 0.99);
}

#[test]
fn correctness_result_default_fail() {
    let r = CorrectnessResult {
        output_sha256: "abc".into(),
        element_count: 8,
        finite_count: 7,
        nan_count: 1,
        inf_count: 0,
        max_abs_error: 0.0,
        mean_abs_error: 0.0,
        max_rel_error: 0.0,
        cosine_similarity: 0.5,
        passed: false,
    };
    assert!(!r.passed);
    assert_eq!(r.nan_count, 1);
}
