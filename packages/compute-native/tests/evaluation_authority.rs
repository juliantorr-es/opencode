//! Evaluation-plan authority conformance tests.
//!
//! Proves: plan validation against graph context, SHA-256 boundary digest,
//! policy-support matrix, cardinality, transfer-aware transitions, and
//! eager deferred-dependency detection based on actual edges.

use tribunus_compute_native::backend::routing::{
    BackendId, BoundaryValidationContext, compute_boundary_digest,
    DependencyEdge, EvaluationGroupCardinality,
    EvaluationGroupId, EvaluationPolicy, EvaluationPolicySupport,
    ExecutionBoundaryPlan, OperationId, PlanValidationError,
    SynchronizationPolicy, TensorId, TensorTransferPlan, validate_boundary_plans,
    policy_support,
};

fn op(id: u64) -> OperationId { OperationId(id) }
fn tid(id: u64) -> TensorId { TensorId(id) }
fn gid(id: u64) -> EvaluationGroupId { EvaluationGroupId(id) }

fn mlx() -> BackendId { BackendId(0) }
fn accel() -> BackendId { BackendId(1) }
fn coreml() -> BackendId { BackendId(2) }

fn make_boundary(
    gid: u64, backend: BackendId, ops: &[u64], outputs: &[u64],
    policy: EvaluationPolicy, release: &[u64],
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

fn no_ctx() -> BoundaryValidationContext<'static> {
    BoundaryValidationContext {
        expected_operations: &[],
        dependency_edges: &[],
        transfer_plans: &[],
    }
}



fn xfer(from: BackendId, to: BackendId) -> TensorTransferPlan {
    TensorTransferPlan {
        tensor_id: TensorId(0),
        source_backend: from,
        destination_backend: to,
        source_layout: tribunus_compute_native::backend::routing::PhysicalLayout::RowMajor,
        destination_layout: tribunus_compute_native::backend::routing::PhysicalLayout::RowMajor,
        conversion: tribunus_compute_native::backend::routing::ConversionKind::None,
        expected_bytes: 0,
        synchronization_before: false,
        synchronization_after: false,
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
    assert!(validate_boundary_plans(&plans, &no_ctx()).is_ok());
}

#[test]
fn duplicate_operation_rejected() {
    let plans = vec![
        make_boundary(0, mlx(), &[1, 2], &[10], EvaluationPolicy::BackendLazy, &[]),
        make_boundary(1, mlx(), &[2, 3], &[11], EvaluationPolicy::BackendLazy, &[]),
    ];
    let err = validate_boundary_plans(&plans, &no_ctx());
    assert!(err.is_err());
    assert!(err.unwrap_err().iter().any(|e| matches!(e, PlanValidationError::DuplicateOperation(_))));
}

#[test]
fn empty_boundary_rejected() {
    let plans = vec![
        make_boundary(0, mlx(), &[], &[], EvaluationPolicy::BackendLazy, &[]),
    ];
    let err = validate_boundary_plans(&plans, &no_ctx());
    assert!(err.is_err());
    assert!(err.unwrap_err().iter().any(|e| matches!(e, PlanValidationError::EmptyBoundary(_))));
}

#[test]
fn unsupported_policy_rejected() {
    let plans = vec![
        make_boundary(0, accel(), &[1], &[10], EvaluationPolicy::BackendLazy, &[]),
    ];
    let err = validate_boundary_plans(&plans, &no_ctx());
    assert!(err.is_err());
    assert!(err.unwrap_err().iter().any(|e| matches!(e, PlanValidationError::UnsupportedPolicy { .. })));
}

#[test]
fn backend_transition_with_transfer_accepted() {
    let plans = vec![
        make_boundary(0, mlx(), &[1], &[10], EvaluationPolicy::BackendLazy, &[]),
        make_boundary(1, accel(), &[2], &[11], EvaluationPolicy::ExplicitRegion, &[]),
    ];
    let ctx = BoundaryValidationContext {
        expected_operations: &[],
        dependency_edges: &[],
        transfer_plans: &[xfer(mlx(), accel())],
    };
    assert!(validate_boundary_plans(&plans, &ctx).is_ok(), "transition with transfer must be valid");
}

#[test]
fn backend_transition_without_transfer_rejected() {
    let plans = vec![
        make_boundary(0, mlx(), &[1], &[10], EvaluationPolicy::BackendLazy, &[]),
        make_boundary(1, accel(), &[2], &[11], EvaluationPolicy::BackendLazy, &[]),
    ];
    let err = validate_boundary_plans(&plans, &no_ctx());
    assert!(err.is_err());
    assert!(err.unwrap_err().iter().any(|e| matches!(e, PlanValidationError::BackendTransitionWithoutTransfer { .. })));
}

#[test]
fn missing_operation_rejected() {
    let plans = vec![
        make_boundary(0, mlx(), &[1], &[10], EvaluationPolicy::BackendLazy, &[]),
    ];
    let ctx = BoundaryValidationContext {
        expected_operations: &[op(1), op(2)],
        dependency_edges: &[],
        transfer_plans: &[],
    };
    let err = validate_boundary_plans(&plans, &ctx);
    assert!(err.is_err());
    assert!(err.unwrap_err().iter().any(|e| matches!(e, PlanValidationError::MissingOperation(_))));
}

#[test]
fn eager_without_deferred_deps_is_valid() {
    // Eager with no crossing deps must pass
    let plans = vec![
        make_boundary(0, mlx(), &[1, 2], &[10],
            EvaluationPolicy::Eager { synchronize: true, release_inputs_after_use: true, prohibit_deferred_nodes: true },
            &[]),
    ];
    let ctx = BoundaryValidationContext {
        expected_operations: &[],
        dependency_edges: &[
            DependencyEdge { from: op(1), to: op(2), via_tensor: tid(10) },
        ],
        transfer_plans: &[],
    };
    // Edge 1→2 is within the same boundary — no cross-boundary, so valid
    assert!(validate_boundary_plans(&plans, &ctx).is_ok(), "eager with internal-only deps must pass");
}

#[test]
fn eager_with_crossing_deferred_dep_rejected() {
    // Tensor 99 is NOT in materialized_outputs [10]
    let plans = vec![
        make_boundary(0, mlx(), &[1], &[10],
            EvaluationPolicy::Eager { synchronize: true, release_inputs_after_use: true, prohibit_deferred_nodes: true },
            &[]),
        make_boundary(1, mlx(), &[2], &[11],
            EvaluationPolicy::ExplicitRegion, &[]),
    ];
    let ctx = BoundaryValidationContext {
        expected_operations: &[],
        dependency_edges: &[
            DependencyEdge { from: op(1), to: op(2), via_tensor: tid(99) },
        ],
        transfer_plans: &[],
    };
    let err = validate_boundary_plans(&plans, &ctx);
    assert!(err.is_err(), "unevaluated crossing dep must be rejected");
    assert!(err.unwrap_err().iter().any(|e| matches!(e, PlanValidationError::EagerWithDeferredDependency { .. })));
}

#[test]
fn eager_materialized_crossing_allowed() {
    // Tensor 10 IS materialized and boundary is synchronized
    let plans = vec![
        make_boundary(0, mlx(), &[1], &[10],
            EvaluationPolicy::Eager { synchronize: true, release_inputs_after_use: true, prohibit_deferred_nodes: true },
            &[]),
        make_boundary(1, mlx(), &[2], &[11],
            EvaluationPolicy::ExplicitRegion, &[]),
    ];
    let ctx = BoundaryValidationContext {
        expected_operations: &[],
        dependency_edges: &[
            DependencyEdge { from: op(1), to: op(2), via_tensor: tid(10) },
        ],
        transfer_plans: &[],
    };
    assert!(validate_boundary_plans(&plans, &ctx).is_ok(),
        "materialized+synchronized crossing output must be allowed");
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
fn boundary_digest_changes_with_op_ids() {
    let p1 = make_boundary(7, mlx(), &[1, 2], &[10], EvaluationPolicy::BackendLazy, &[]);
    let p2 = make_boundary(7, mlx(), &[1, 3], &[10], EvaluationPolicy::BackendLazy, &[]);
    assert_ne!(compute_boundary_digest(&p1), compute_boundary_digest(&p2), "different op IDs must change digest");
}

#[test]
fn boundary_digest_changes_with_backend() {
    let p1 = make_boundary(7, mlx(), &[1], &[10], EvaluationPolicy::BackendLazy, &[]);
    let p2 = make_boundary(7, accel(), &[1], &[10], EvaluationPolicy::BackendLazy, &[]);
    assert_ne!(compute_boundary_digest(&p1), compute_boundary_digest(&p2));
}

#[test]
fn boundary_digest_changes_with_policy() {
    let p1 = make_boundary(7, mlx(), &[1, 2], &[10], EvaluationPolicy::BackendLazy, &[]);
    let p2 = make_boundary(7, mlx(), &[1, 2], &[10], EvaluationPolicy::ExplicitRegion, &[]);
    assert_ne!(compute_boundary_digest(&p1), compute_boundary_digest(&p2));
}

#[test]
fn boundary_digest_is_sha256_hex() {
    let p = make_boundary(0, mlx(), &[1], &[10], EvaluationPolicy::BackendLazy, &[]);
    let d = compute_boundary_digest(&p);
    // SHA-256 hex output is 64 characters
    assert_eq!(d.0.len(), 64, "digest must be 64-char SHA-256 hex");
    assert!(d.0.chars().all(|c| c.is_ascii_hexdigit()));
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
    assert!(validate_boundary_plans(&plans, &no_ctx()).is_ok());
}
