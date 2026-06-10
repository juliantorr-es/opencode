//! Deterministic heterogeneous routing types.
//!
//! Every operation carries a stable `OperationId` and complete descriptor.
//! The router selects a backend from a sealed `ComputeRouteProfile`; it does
//! not make opportunistic decisions.  All routing events emit typed receipts
//! into the evidence plane so future profiles are derived from measured data,
//! not hand-written assumptions.

use std::collections::HashMap;

use super::DType;

// ── Identity types ────────────────────────────────────────────────────────

/// Identifies a logical tensor across backend boundaries.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct TensorId(pub u64);

/// Identifies a logical operation in the Tribunus-owned execution graph.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct OperationId(pub u64);

/// Identifies a specific backend implementation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct BackendId(pub u32);

/// Identifies a sealed route profile (deterministic backend assignment).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct RouteProfileId(pub u64);

/// Identifies a compiled backend artifact (e.g. Core ML model, packed layout).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct BackendArtifactId(pub u64);

/// Identifies a specific materialization of a tensor on a particular backend.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct TensorMaterializationId(pub u64);

/// Identifies a compiled graph region.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct CompiledRegionHandle(pub u64);

/// Identifies an evaluation group (synchronization fence).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct EvaluationGroupId(pub u64);

/// Machine profile identity (model + hardware + thermal state).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct MachineProfileId(pub u64);

/// Evidence digest — content-addressed proof of a measurement.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct EvidenceDigest(pub String);

// ── Substrate ─────────────────────────────────────────────────────────────

/// Requested compute substrate.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RequestedSubstrate {
    Cpu,
    Gpu,
    NeuralEngine,
    CpuAndGpu,
    CpuAndNeuralEngine,
    All,
}

/// Observed compute substrate — `Unknown` until native instrumentation
/// provides defensible placement evidence.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Substrate {
    Cpu,
    Gpu,
    NeuralEngine,
    Unknown,
}

// ── Operation descriptor ──────────────────────────────────────────────────

/// Logical shape before any physical layout is applied.
#[derive(Debug, Clone)]
pub struct LogicalShape {
    pub dims: Vec<u32>,
}

/// Physical layout (row-major, column-major, packed, etc.).
#[derive(Debug, Clone)]
pub enum PhysicalLayout {
    RowMajor,
    ColumnMajor,
    PackedU32 { group_size: u32, bits: u8 },
    Custom(String),
}

/// Quantization contract carried through the operation.
#[derive(Debug, Clone)]
pub struct QuantizationContract {
    pub bits: u8,
    pub group_size: u32,
    pub symmetric: bool,
}

/// Tensor shape descriptor.
#[derive(Debug, Clone)]
pub struct TensorShape {
    pub dims: Vec<u32>,
}

/// Execution phase.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Phase {
    Prefill,
    Decode,
    Conditioning,
    Qualification,
}

/// Operation family for classification.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OperationFamily {
    QuantizedMatmul,
    Matmul,
    RmsNorm,
    RoPE,
    Silu,
    Add,
    Multiply,
    Softmax,
    Transpose,
    Reshape,
    IndexSelect,
    Sampling,
    Reduction,
    LayoutTransform,
    Checksum,
    MlpBlock,
    AttentionBlock,
    DecoderLayer,
    PrefillFragment,
}

pub type OperationContractDigest = EvidenceDigest;

/// Policy for correctness checkpointing.
#[derive(Debug, Clone)]
pub enum CorrectnessCheckpointPolicy {
    None,
    CompareAgainstAuthority { tolerance: f64 },
    Checksum { digest: EvidenceDigest },
}

/// Complete descriptor for a single logical operation.
#[derive(Debug, Clone)]
pub struct OperationDescriptor {
    pub operation_id: OperationId,
    pub family: OperationFamily,
    pub layer_index: Option<u32>,
    pub phase: Phase,
    pub logical_shape: LogicalShape,
    pub physical_layout: PhysicalLayout,
    pub input_dtypes: Vec<DType>,
    pub output_dtype: DType,
    pub quantization: Option<QuantizationContract>,
    pub expected_output_shape: TensorShape,
    pub correctness_checkpoint: CorrectnessCheckpointPolicy,
}

// ── Routing ────────────────────────────────────────────────────────────────

/// How the router selects a backend.
#[derive(Debug, Clone)]
pub enum RoutingMode {
    /// Execute only on the specified backend; fail if unavailable.
    Forced(BackendId),
    /// Execute on the control/authority backend.
    Baseline,
    /// Authority produces result; candidate executes for measurement only.
    ShadowCompare {
        authority: BackendId,
        candidate: BackendId,
    },
    /// Use a measured, evidence-authorized selection.
    MeasuredSelection,
    /// Production policy (sealed profile).
    ProductionPolicy,
}

/// A routing request for one operation.
#[derive(Debug, Clone)]
pub struct RouteRequest {
    pub operation: OperationDescriptor,
    pub candidate_backends: Vec<BackendId>,
    pub routing_mode: RoutingMode,
    pub session_id: u64, // SessionId from compute_lane
    pub evaluation_group_id: EvaluationGroupId,
}

/// Reason the router selected a specific backend.
#[derive(Debug, Clone)]
pub enum RouteSelectionReason {
    Forced,
    BaselineAuthority,
    OnlyCandidate,
    PolicyMatch { evidence: Option<EvidenceDigest> },
    Fallback { original_error: String },
}

/// Information about a candidate backend considered during routing.
#[derive(Debug, Clone)]
pub struct BackendCandidate {
    pub backend_id: BackendId,
    pub eligible: bool,
    pub reason: String,
}

/// Receipt emitted before execution — the router's decision.
#[derive(Debug, Clone)]
pub struct RouteDecisionReceipt {
    pub operation_id: OperationId,
    pub requested_backend: BackendId,
    pub selected_backend: BackendId,
    pub selection_reason: RouteSelectionReason,
    pub candidate_backends: Vec<BackendCandidate>,
    pub forced: bool,
    pub fallback_allowed: bool,
    pub decision_duration_ns: u64,
}

// ── Execution receipts ─────────────────────────────────────────────────────

/// Backend version identity.
#[derive(Debug, Clone)]
pub struct BackendVersion {
    pub backend_name: String,
    pub version: String,
    pub git_commit: Option<String>,
}

/// Physical execution receipt — what the backend actually did.
#[derive(Debug, Clone)]
pub struct BackendExecutionReceipt {
    pub operation_id: OperationId,
    pub backend_id: BackendId,
    pub backend_version: BackendVersion,
    pub requested_substrate: Option<RequestedSubstrate>,
    pub observed_substrate: Option<Substrate>,
    pub graph_build_ns: Option<u64>,
    pub compile_ns: Option<u64>,
    pub queue_wait_ns: Option<u64>,
    pub submit_ns: Option<u64>,
    pub execution_ns: Option<u64>,
    pub synchronization_ns: Option<u64>,
    pub total_wall_ns: u64,
    pub bytes_read: Option<u64>,
    pub bytes_written: Option<u64>,
    pub temporary_bytes: Option<u64>,
    pub active_memory_before: Option<u64>,
    pub active_memory_after: Option<u64>,
    pub cache_memory_before: Option<u64>,
    pub cache_memory_after: Option<u64>,
    pub transfer_in_ns: Option<u64>,
    pub transfer_out_ns: Option<u64>,
    pub fallback_occurred: bool,
}

// ── Tensor transfer ────────────────────────────────────────────────────────

/// Conversion required when moving a tensor between backends.
#[derive(Debug, Clone)]
pub enum LayoutConversion {
    None,
    Transpose,
    Cast { from: DType, to: DType },
    Pack { group_size: u32, bits: u8 },
    Unpack { group_size: u32, bits: u8 },
    Contiguous,
}

/// Receipt for explicit cross-backend tensor movement.
///
/// Preserves exact source and destination layouts, dtypes, and timings.
/// No invented detail — every field is observed or absent.
#[derive(Debug, Clone)]
pub struct TensorTransferReceipt {
    pub tensor_id: TensorId,
    pub tensor_version: TensorVersion,
    pub source_materialization: TensorMaterializationId,
    pub destination_materialization: TensorMaterializationId,
    pub source_backend: BackendId,
    pub destination_backend: BackendId,
    pub source_layout: PhysicalLayout,
    pub destination_layout: PhysicalLayout,
    pub source_dtype: DType,
    pub destination_dtype: DType,
    pub bytes_read: u64,
    pub bytes_written: u64,
    pub transfer_ns: u64,
    pub conversion_ns: u64,
    pub zero_copy: bool,
}

// ── Tensor version ────────────────────────────────────────────────────────

/// Version counter for a logical tensor (incremented on mutation).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TensorVersion(pub u64);

// ── Transfer plan ──────────────────────────────────────────────────────────

/// Kind of conversion in a compile-time transfer plan.
#[derive(Debug, Clone)]
pub enum ConversionKind {
    None,
    LayoutConversion,
    DtypeCast,
    OwnedCopy,
    SharedReference,
}

/// Compile-time plan for moving a tensor between backends.
#[derive(Debug, Clone)]
pub struct TensorTransferPlan {
    pub tensor_id: TensorId,
    pub source_backend: BackendId,
    pub destination_backend: BackendId,
    pub source_layout: PhysicalLayout,
    pub destination_layout: PhysicalLayout,
    pub conversion: ConversionKind,
    pub expected_bytes: u64,
    pub synchronization_before: bool,
    pub synchronization_after: bool,
}

// ── Route profile ──────────────────────────────────────────────────────────

/// One routed operation in a deterministic profile.
#[derive(Debug, Clone)]
pub struct RoutedOperation {
    pub operation_id: OperationId,
    pub operation_contract: OperationContractDigest,
    pub backend: BackendId,
    pub requested_substrate: RequestedSubstrate,
    pub backend_artifact: Option<BackendArtifactId>,
    pub input_materializations: Vec<TensorMaterializationId>,
    pub output_materialization: TensorMaterializationId,
    pub evaluation_group: EvaluationGroupId,
    pub fallback_policy: FallbackPolicy,
}

/// What to do when the routed backend cannot execute.
#[derive(Debug, Clone)]
pub enum FallbackPolicy {
    FailClosed,
    FallbackTo(BackendId),
    RetryOnce(BackendId),
}

/// Manifest of backend-specific artifacts referenced by a route profile.
#[derive(Debug, Clone)]
pub struct BackendArtifactManifest {
    pub coreml: Vec<BackendArtifactId>,
    pub accelerate: Vec<BackendArtifactId>,
    pub mlx: Vec<BackendArtifactId>,
}

// ── Route profile ──────────────────────────────────────────────────────────

/// A sealed, deterministic route profile — compiled, not improvised.
#[derive(Debug, Clone)]
pub struct ComputeRouteProfile {
    pub profile_id: RouteProfileId,
    pub logical_image_hash: EvidenceDigest,
    pub artifact_root_hash: EvidenceDigest,
    pub machine_profile: MachineProfileId,
    pub operations: Vec<RoutedOperation>,
    pub transfers: Vec<TensorTransferPlan>,
    pub backend_artifacts: BackendArtifactManifest,
    /// Single source of truth for evaluation boundaries — supersedes
    /// both SynchronizationGroup and EvaluationGroupPlan.
    pub execution_boundaries: Vec<ExecutionBoundaryPlan>,
    pub evidence_basis: Vec<EvidenceDigest>,
}

// ── Evaluation policy ────────────────────────────────────────────────────

/// Cardinality of evaluation groups in a plan.
#[derive(Debug, Clone)]
pub enum EvaluationGroupCardinality {
    /// Exact number of groups known at compile time.
    Fixed(u32),
    /// One group per materialized operation (determined at plan generation).
    PerOperation,
}

/// Who controls when tensors are materialised and at what granularity.
#[derive(Debug, Clone)]
pub enum EvaluationPolicy {
    /// Preserve the backend's normal lazy behaviour.  MLX builds the full
    /// layer graph; materialisation happens at the backend's discretion.
    BackendLazy,

    /// Tribunus defines one or more explicit fusion regions.  MLX may
    /// still fuse operations inside each region, but must materialise
    /// every `materialized_output` at the region boundary.
    ExplicitRegion,

    /// Insert a materialization request after each operation.  The backend
    /// may retain asynchronous execution across the boundary.
    ExplicitOperation {
        synchronize: bool,
    },

    /// Require completion before the next operation begins, prohibit
    /// deferred dependencies crossing the boundary, and enforce
    /// deterministic lifetime release.
    Eager {
        synchronize: bool,
        release_inputs_after_use: bool,
        prohibit_deferred_nodes: bool,
    },
}

/// Whether a backend natively supports a given evaluation policy.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EvaluationPolicySupport {
    Native,
    Emulated,
    Unsupported,
}

/// Qualifies which backends support which policies.
pub fn policy_support(backend: BackendId, policy: &EvaluationPolicy) -> EvaluationPolicySupport {
    match backend.0 {
        0 => match policy {
            // MLX: all lazy variants native
            EvaluationPolicy::BackendLazy => EvaluationPolicySupport::Native,
            EvaluationPolicy::ExplicitRegion => EvaluationPolicySupport::Native,
            EvaluationPolicy::ExplicitOperation { .. } => EvaluationPolicySupport::Native,
            EvaluationPolicy::Eager { .. } => EvaluationPolicySupport::Emulated,
        },
        1 => match policy {
            // Accelerate: naturally eager, lazy is unsupported
            EvaluationPolicy::BackendLazy => EvaluationPolicySupport::Unsupported,
            EvaluationPolicy::ExplicitRegion => EvaluationPolicySupport::Emulated,
            EvaluationPolicy::ExplicitOperation { .. } => EvaluationPolicySupport::Native,
            EvaluationPolicy::Eager { .. } => EvaluationPolicySupport::Native,
        },
        2 => match policy {
            // Core ML: region execution native, per-operation unsupported
            EvaluationPolicy::BackendLazy => EvaluationPolicySupport::Unsupported,
            EvaluationPolicy::ExplicitRegion => EvaluationPolicySupport::Native,
            EvaluationPolicy::ExplicitOperation { .. } => EvaluationPolicySupport::Unsupported,
            EvaluationPolicy::Eager { .. } => EvaluationPolicySupport::Unsupported,
        },
        _ => EvaluationPolicySupport::Unsupported,
    }
}

/// Synchronization requirement for a boundary.
#[derive(Debug, Clone)]
pub enum SynchronizationPolicy {
    None,
    Barrier,
    Stream,
    Device,
}

/// One authoritative execution boundary — the single source of truth
/// for evaluation groups, superseding both the older SynchronizationGroup
/// and EvaluationGroupPlan types.
///
/// The compiler guarantees every operation is assigned exactly once,
/// operations are topologically ordered, all materialized tensors are
/// outputs of operations within or before the group, no consumer executes
/// before its producer, and backends transitions have explicit transfer
/// plans.
#[derive(Debug, Clone)]
pub struct ExecutionBoundaryPlan {
    pub group_id: EvaluationGroupId,
    pub backend_id: BackendId,
    pub operations: Vec<OperationId>,
    pub materialized_outputs: Vec<TensorId>,
    pub policy: EvaluationPolicy,
    pub synchronization: SynchronizationPolicy,
    pub release_after: Vec<TensorId>,
    /// Canonical content digest — proves which boundary plan was executed.
    pub content_digest: Option<EvidenceDigest>,
}

/// Deprecated: use ExecutionBoundaryPlan.
#[derive(Debug, Clone)]
pub struct EvaluationGroupPlan {
    pub group_id: EvaluationGroupId,
    pub operation_ids: Vec<OperationId>,
    pub materialized_outputs: Vec<TensorId>,
    pub backend: BackendId,
    pub evaluation_policy: EvaluationPolicy,
}

/// Directed edge in the operation dependency graph.
#[derive(Debug, Clone)]
pub struct DependencyEdge {
    pub from: OperationId,
    pub to: OperationId,
    pub via_tensor: TensorId,
}

/// Complete context for boundary-plan validation.
#[derive(Debug, Clone)]
pub struct BoundaryValidationContext<'a> {
    pub expected_operations: &'a [OperationId],
    pub dependency_edges: &'a [DependencyEdge],
    pub transfer_plans: &'a [TensorTransferPlan],
}

// ── Plan validation ───────────────────────────────────────────────────────

/// Errors detected during boundary-plan validation.
#[derive(Debug, Clone)]
pub enum PlanValidationError {
    DuplicateOperation(OperationId),
    MissingOperation(OperationId),
    TopologicalViolation { before: OperationId, after: OperationId },
    UnreferencedMaterializedOutput(TensorId),
    ConsumerBeforeProducer { tensor: TensorId, consumer: OperationId },
    BackendTransitionWithoutTransfer { from: BackendId, to: BackendId },
    EagerWithDeferredDependency { op: OperationId, via: TensorId, crosses_boundary_to: EvaluationGroupId },
    UnsupportedPolicy { backend: BackendId, policy: EvaluationPolicy },
    EmptyBoundary(EvaluationGroupId),
}

/// Validate boundary plans against the full operation graph, dependency
/// edges, and transfer plans.  Every operation in `ctx.expected_operations`
/// must be assigned exactly once.  Backend transitions must have matching
/// transfer plans.  Eager boundaries fail only when a dependency edge
/// proves a deferred node crosses the boundary.
pub fn validate_boundary_plans(
    plans: &[ExecutionBoundaryPlan],
    ctx: &BoundaryValidationContext,
) -> Result<(), Vec<PlanValidationError>> {
    let mut errors = Vec::new();
    let mut seen_ops = std::collections::HashMap::new();

    // Build operation→boundary index
    let mut op_to_boundary = std::collections::HashMap::new();
    for plan in plans {
        for &op in &plan.operations {
            if let Some(&prev) = op_to_boundary.get(&op) {
                errors.push(PlanValidationError::DuplicateOperation(op));
                let _ = prev;
            }
            op_to_boundary.insert(op, plan.group_id);
            if let Some(&prev_group) = seen_ops.get(&op) {
                errors.push(PlanValidationError::DuplicateOperation(op));
                let _ = prev_group;
            }
            seen_ops.insert(op, plan.group_id);
        }
    }

    // Check every expected operation is covered
    for &op in ctx.expected_operations {
        if !seen_ops.contains_key(&op) {
            errors.push(PlanValidationError::MissingOperation(op));
        }
    }

    // Backend transitions: must have matching transfer plan
    for w in plans.windows(2) {
        let prev = &w[0];
        let next = &w[1];
        if prev.backend_id != next.backend_id {
            let has_transfer = ctx.transfer_plans.iter().any(|tp| {
                tp.source_backend == prev.backend_id
                    && tp.destination_backend == next.backend_id
            });
            if !has_transfer {
                errors.push(PlanValidationError::BackendTransitionWithoutTransfer {
                    from: prev.backend_id,
                    to: next.backend_id,
                });
            }
        }
    }

    for plan in plans {
        // Empty boundary?
        if plan.operations.is_empty() {
            errors.push(PlanValidationError::EmptyBoundary(plan.group_id));
        }

        // Policy supported?
        match policy_support(plan.backend_id, &plan.policy) {
            EvaluationPolicySupport::Unsupported => {
                errors.push(PlanValidationError::UnsupportedPolicy {
                    backend: plan.backend_id,
                    policy: plan.policy.clone(),
                });
            }
            _ => {}
        }

        // Eager: check actual deferred dependencies crossing the boundary
        if let EvaluationPolicy::Eager { prohibit_deferred_nodes: true, .. } = &plan.policy {
            for edge in ctx.dependency_edges {
                let from_boundary = op_to_boundary.get(&edge.from);
                let to_boundary = op_to_boundary.get(&edge.to);
                // Dependency crosses from this boundary to another
                if from_boundary == Some(&plan.group_id)
                    && to_boundary.is_some()
                    && to_boundary != from_boundary
                {
                    errors.push(PlanValidationError::EagerWithDeferredDependency {
                        op: edge.from,
                        via: edge.via_tensor,
                        crosses_boundary_to: *to_boundary.unwrap(),
                    });
                }
            }
        }
    }

    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors)
    }
}

/// Canonical SHA-256 content digest for an execution boundary plan.
/// Covers every execution-relevant field so materially different plans
/// produce different digests.
pub fn compute_boundary_digest(plan: &ExecutionBoundaryPlan) -> EvidenceDigest {
    use std::fmt::Write;
    let mut s = String::new();
    let _ = write!(s, "g{}b{}o", plan.group_id.0, plan.backend_id.0);
    for op in &plan.operations { let _ = write!(s, "{}", op.0); }
    let _ = write!(s, "m");
    for t in &plan.materialized_outputs { let _ = write!(s, "{}", t.0); }
    let _ = write!(s, "p{:?}", plan.policy);
    let _ = write!(s, "s{:?}", plan.synchronization);
    let _ = write!(s, "r");
    for t in &plan.release_after { let _ = write!(s, "{}", t.0); }
    // SHA-256 digest
    use sha2::{Sha256, Digest};
    let hash = Sha256::digest(s.as_bytes());
    EvidenceDigest(format!("{:x}", hash))
}

// ── Boundary executor ─────────────────────────────────────────────────────

/// Executor that consumes a sealed ExecutionBoundaryPlan and enforces
/// evaluation boundaries at runtime.
pub trait BoundaryExecutor {
    /// Execute all boundaries in a plan, emitting observed receipts.
    fn execute_boundaries(
        &mut self,
        plans: &[ExecutionBoundaryPlan],
    ) -> Result<Vec<BoundaryExecutionReceipt>, String>;
}

/// Observed receipt from executing one evaluation boundary.
#[derive(Debug, Clone)]
pub struct BoundaryExecutionReceipt {
    pub group_id: EvaluationGroupId,
    pub planned_policy: EvaluationPolicy,
    pub backend: BackendId,
    pub operation_count: usize,
    pub planned_materialized_outputs: usize,
    pub actual_eval_calls: usize,
    pub actual_sync_count: usize,
    pub graph_build_ns: u64,
    pub submit_ns: u64,
    pub execution_ns: u64,
    pub wait_ns: u64,
    pub temporary_bytes: u64,
    pub released_tensor_count: usize,
    pub unaccounted_ns: u64,
    pub policy_support: EvaluationPolicySupport,
}

// ── Research routing policy ───────────────────────────────────────────────

/// Static research policy — no learned heuristic.
#[derive(Debug, Clone)]
pub enum ResearchRoutingPolicy {
    MlxControl,
    AccelerateCandidate,
    CoreMlCandidate,
    Shadow {
        authority: BackendId,
        candidate: BackendId,
    },
}

/// Evidence-derived route policy entry.
#[derive(Debug, Clone)]
pub struct RoutePolicyEntry {
    pub predicate: RoutePredicate,
    pub selected_backend: BackendId,
    pub expected_latency_ns: Box<(u64, u64)>, // (median, p99)
    pub expected_memory_bytes: Box<(u64, u64)>,
    pub confidence: f64,
    pub evidence_digest: EvidenceDigest,
    pub fallback_backend: BackendId,
}

/// Condition that must be satisfied for a policy to apply.
#[derive(Debug, Clone)]
pub struct RoutePredicate {
    pub family: OperationFamily,
    pub m_min: Option<u32>,
    pub m_max: Option<u32>,
    pub k_min: Option<u32>,
    pub k_max: Option<u32>,
    pub n_min: Option<u32>,
    pub n_max: Option<u32>,
    pub phase: Option<Phase>,
    pub cold_state: Option<bool>,
    pub integrated: Option<bool>,
}

// ── Deterministic router ──────────────────────────────────────────────────

/// Lookup-only router — does not make decisions, only resolves profiles.
pub trait DeterministicRouter {
    fn route(
        &self,
        profile: &ComputeRouteProfile,
        operation_id: OperationId,
    ) -> Result<RoutedOperation, String>;
}

// ── Graph region descriptor ───────────────────────────────────────────────

/// A stable subgraph region (e.g. MLP block, attention block, decoder layer).
#[derive(Debug, Clone)]
pub struct GraphRegion {
    pub region_id: u64,
    pub family: OperationFamily,
    pub operations: Vec<OperationId>,
    pub input_tensors: Vec<TensorId>,
    pub output_tensors: Vec<TensorId>,
    pub shape_constraints: Vec<TensorShape>,
}
