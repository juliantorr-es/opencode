//! Evaluation-plan authority conformance tests.
//!
//! Proves: plan validation (coverage, topology, ordering), boundary digest
//! computation, policy-support matrix, cardinality types, and malformed-plan
//! rejection.

use tribunus_compute_native::backend::routing::{
    BackendId, compute_boundary_digest, EvaluationGroupCardinality,
    EvaluationGroupId, EvaluationPolicy, EvaluationPolicySupport,
    ExecutionBoundaryPlan, OperationId, PlanValidationError,
    SynchronizationPolicy, TensorId, validate_boundary_plans, policy_support,
};

fn op(id: u64) -> OperationId {
    OperationId(id)
}
fn tid(id: u64) -> TensorId {
    TensorId(id)
}
fn gid(id: u64) -> EvaluationGroupId {
    EvaluationGroupId(id)
}

fn mlx() -> BackendId {
    BackendId(0)
}
fn accel() -> BackendId {
    BackendId(1)
}
fn coreml() -> BackendId {
    BackendId(2)
}

fn make_boundary(
    gid: u64,
    backend: BackendId,
    ops: &[u64],
    outputs: &[u64],
    policy: EvaluationPolicy,
    release: &[u64],
) -> ExecutionBoundaryPlan {
    ExecutionBoundaryPlan {
        group_id: EvaluationGroupId(gid),
        backend_id: backend,
        operations: ops.iter().map(|&i| OperationId(i)).collect(),
        materialized_outputs: outputs.iter().map(|&i| TensorId(i)).collect(),
        policy,
        synchronization: SynchronizationPolicy::None,
        release_after: release.iter().map(|&i| TensorId(i)).collect(),
        content_digest: None,
    }
}

// ── Policy support matrix ─────────────────────────────────────────────────

#[test]
fn mlx_supports_lazy_and_region() {
    assert_eq!(policy_support(mlx(), &EvaluationPolicy::BackendLazy), EvaluationPolicySupport::Native);
    assert_eq!(policy_support(mlx(), &EvaluationPolicy::ExplicitRegion), EvaluationPolicySupport::Native);
    assert_eq!(policy_support(mlx(), &EvaluationPolicy::ExplicitOperation { synchronize: true }), EvaluationPolicySupport::Native);
    assert_eq!(policy_support(mlx(), &EvaluationPolicy::Eager { synchronize: true, release_inputs_after_use: true, prohibit_deferred_nodes: true }), EvaluationPolicySupport::Emulated);
}

#[test]
fn accelerate_is_natively_eager() {
    assert_eq!(policy_support(accel(), &EvaluationPolicy::BackendLazy), EvaluationPolicySupport::Unsupported);
    assert_eq!(policy_support(accel(), &EvaluationPolicy::Eager { synchronize: true, release_inputs_after_use: false, prohibit_deferred_nodes: false }), EvaluationPolicySupport::Native);
}

#[test]
fn coreml_supports_only_region() {
    assert_eq!(policy_support(coreml(), &EvaluationPolicy::BackendLazy), EvaluationPolicySupport::Unsupported);
    assert_eq!(policy_support(coreml(), &EvaluationPolicy::ExplicitRegion), EvaluationPolicySupport::Native);
    assert_eq!(policy_support(coreml(), &EvaluationPolicy::ExplicitOperation { synchronize: true }), EvaluationPolicySupport::Unsupported);
}

// ── Plan validation ───────────────────────────────────────────────────────

#[test]
fn valid_plan_passes_validation() {
    let plans = vec![
        make_boundary(0, mlx(), &[1, 2, 3], &[10, 11], EvaluationPolicy::BackendLazy, &[]),
    ];
    assert!(validate_boundary_plans(&plans).is_ok());
}

#[test]
fn duplicate_operation_rejected() {
    let plans = vec![
        make_boundary(0, mlx(), &[1, 2], &[10], EvaluationPolicy::BackendLazy, &[]),
        make_boundary(1, mlx(), &[2, 3], &[11], EvaluationPolicy::BackendLazy, &[]),
    ];
    let err = validate_boundary_plans(&plans);
    assert!(err.is_err());
    let errs = err.unwrap_err();
    assert!(errs.iter().any(|e| matches!(e, PlanValidationError::DuplicateOperation(_))));
}

#[test]
fn empty_boundary_rejected() {
    let plans = vec![
        make_boundary(0, mlx(), &[], &[], EvaluationPolicy::BackendLazy, &[]),
    ];
    let err = validate_boundary_plans(&plans);
    assert!(err.is_err());
    let errs = err.unwrap_err();
    assert!(errs.iter().any(|e| matches!(e, PlanValidationError::EmptyBoundary(_))));
}

#[test]
fn backend_transition_without_transfer_rejected() {
    let plans = vec![
        make_boundary(0, mlx(), &[1], &[10], EvaluationPolicy::BackendLazy, &[]),
        make_boundary(1, accel(), &[2], &[11], EvaluationPolicy::BackendLazy, &[]),
    ];
    let err = validate_boundary_plans(&plans);
    assert!(err.is_err());
    let errs = err.unwrap_err();
    assert!(errs.iter().any(|e| matches!(e, PlanValidationError::BackendTransitionWithoutTransfer { .. })));
}

#[test]
fn unsupported_policy_rejected() {
    let plans = vec![
        make_boundary(0, accel(), &[1], &[10], EvaluationPolicy::BackendLazy, &[]),
    ];
    let err = validate_boundary_plans(&plans);
    assert!(err.is_err());
    assert!(err.unwrap_err().iter().any(|e| matches!(e, PlanValidationError::UnsupportedPolicy { .. })));
}

#[test]
fn eager_prohibit_deferred_rejected() {
    let plans = vec![
        make_boundary(0, mlx(), &[1, 2], &[10],
            EvaluationPolicy::Eager { synchronize: true, release_inputs_after_use: true, prohibit_deferred_nodes: true },
            &[]),
    ];
    let err = validate_boundary_plans(&plans);
    assert!(err.is_err());
    assert!(err.unwrap_err().iter().any(|e| matches!(e, PlanValidationError::EagerWithDeferredDependency(_))));
}

// ── Boundary digest ───────────────────────────────────────────────────────

#[test]
fn boundary_digest_is_deterministic() {
    let p = make_boundary(7, mlx(), &[1, 2], &[10], EvaluationPolicy::BackendLazy, &[]);
    let d1 = compute_boundary_digest(&p);
    let d2 = compute_boundary_digest(&p);
    assert_eq!(d1, d2, "digest must be deterministic");
}

#[test]
fn boundary_digest_changes_with_content() {
    let p1 = make_boundary(7, mlx(), &[1, 2], &[10], EvaluationPolicy::BackendLazy, &[]);
    let p2 = make_boundary(7, mlx(), &[1, 2, 3], &[10], EvaluationPolicy::BackendLazy, &[]);
    assert_ne!(compute_boundary_digest(&p1), compute_boundary_digest(&p2));
}

// ── Cardinality ───────────────────────────────────────────────────────────

#[test]
fn fixed_cardinality_matches() {
    let c = EvaluationGroupCardinality::Fixed(4);
    match c {
        EvaluationGroupCardinality::Fixed(n) => assert_eq!(n, 4),
        _ => panic!("expected Fixed"),
    }
}

#[test]
fn per_operation_cardinality_means_dynamic() {
    let c = EvaluationGroupCardinality::PerOperation;
    assert!(matches!(c, EvaluationGroupCardinality::PerOperation));
}

// ── Multiple valid boundaries ─────────────────────────────────────────────

#[test]
fn multiple_boundaries_same_backend_valid() {
    let plans = vec![
        make_boundary(0, mlx(), &[1, 2], &[10], EvaluationPolicy::ExplicitRegion, &[]),
        make_boundary(1, mlx(), &[3, 4], &[11], EvaluationPolicy::ExplicitRegion, &[]),
    ];
    assert!(validate_boundary_plans(&plans).is_ok());
}
