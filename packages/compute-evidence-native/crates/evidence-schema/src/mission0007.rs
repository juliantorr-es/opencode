//! Mission 0007 — typed policy, sidecar schema, and evidence event contracts.
//!
//! This module defines the frozen conditioning-policy types, execution
//! sidecar schema, and evidence-plane event payloads for Mission 0007
//! (Conditioning-Aware Pipeline Orchestration).
//!
//! ## Organization
//!
//! * **Policy types** — `ConditioningArm`, `ExecutionConditioningPolicy`,
//!   `ConditioningFallbackPolicy`, `MemoryPressureThreshold`, etc.
//! * **Sidecar schema** — `KernelSignature`, `ConditioningRecipe`,
//!   `ResidencyGroup`, `SyntheticInputContract`, `ScratchKvContract`, etc.
//! * **Evidence events** — `ConditioningRecipeEvent`,
//!   `PrefetchLifecycleEvent`, `ReadinessTransitionEvent`,
//!   `TreatmentSummaryEvent`.

use serde::{Deserialize, Serialize};

// ── Helper: newtype wrapper (local, since lib.rs `string_wrapper!` is not
//    `#[macro_export]`) ────────────────────────────────────────────────────

macro_rules! id_wrapper {
    ($name:ident, $doc:expr) => {
        #[doc = $doc]
        #[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
        #[serde(transparent)]
        pub struct $name(pub String);

        impl std::fmt::Display for $name {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                self.0.fmt(f)
            }
        }

        impl From<&str> for $name {
            fn from(s: &str) -> Self {
                $name(s.to_string())
            }
        }

        impl From<String> for $name {
            fn from(s: String) -> Self {
                $name(s)
            }
        }
    };
}

// ── ID newtype wrappers ───────────────────────────────────────────────────

id_wrapper!(
    KernelSignatureId,
    "Unique identifier for a kernel signature."
);
id_wrapper!(
    ConditioningRecipeId,
    "Unique identifier for a conditioning recipe."
);
id_wrapper!(ResidencyGroupId, "Unique identifier for a residency group.");
id_wrapper!(
    ExecutionStepId,
    "Unique identifier for an execution step (scoped to request)."
);
id_wrapper!(ResourceId, "Unique identifier for a tracked resource.");
id_wrapper!(
    PipelinePlanVersion,
    "Semantic version string for the pipeline plan."
);
id_wrapper!(
    ResidencyPlanVersion,
    "Semantic version string for the residency plan."
);

// ── ConditioningArm ────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConditioningArm {
    /// Full frozen-control path: no dynamic adaptation.
    FrozenControl,
    /// Pipeline-warmup only: prefill pipeline without rolling prefetch.
    PipelineWarmOnly,
    /// Rolling-prefetch only: no pipeline warmup.
    RollingPrefetchOnly,
    /// Both pipeline warmup and rolling prefetch.
    Combined,
    /// Sham arm — placeholder for A/B comparison baseline.
    Sham,
}

// ── ExecutionConditioningPolicy ────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExecutionConditioningPolicy {
    /// The active conditioning arm.
    pub arm: ConditioningArm,
    /// Number of tokens to prefetch ahead (rolling window).
    pub prefetch_window: Option<u32>,
    /// Number of warmup tokens for the pipeline.
    pub warmup_tokens: Option<u32>,
    /// Force synchronous pipeline execution (no interleaving).
    pub force_pipeline: bool,
    /// Preferred substrate for this policy.
    pub preferred_substrate: ExpectedSubstrate,
    /// Fallback strategy when primary arm is not viable.
    pub fallback: ConditioningFallbackPolicy,
}

// ── KernelSignature ────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KernelSignature {
    pub signature_id: KernelSignatureId,
    /// Name of the compiled kernel or op.
    pub kernel_name: String,
    /// Input/output dtypes recorded at signature-creation time.
    pub dtypes: Vec<DType>,
    /// Static shape dimensions (dynamic axes encoded as 0).
    pub shape: Vec<i32>,
    /// Whether this signature has been validated against a live kernel.
    pub validated: bool,
}

// ── ConditioningRecipe ─────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConditioningRecipe {
    pub recipe_id: ConditioningRecipeId,
    pub plan_version: PipelinePlanVersion,
    /// Which operation families are conditioned by this recipe.
    pub conditioned_families: Vec<OperationFamily>,
    /// Mapping from execution step to the input contract that step must
    /// prepare before dispatch.
    pub step_contracts: Vec<SyntheticInputContract>,
    /// Scratch-KV contract for this recipe (cache layout).
    pub scratch_kv: ScratchKvContract,
    /// Completion state (updated in evidence events).
    pub completion: ConditioningRecipeCompletionState,
}

// ── ConditioningRecipeCompletionState ──────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConditioningRecipeCompletionState {
    /// Recipe compiled but not yet dispatched.
    Pending,
    /// All conditioned steps completed successfully.
    Completed,
    /// One or more steps failed; partial results may be available.
    Failed,
    /// Recipe was superseded by a newer plan before completion.
    Superseded,
    /// Conditioning was skipped entirely (e.g. fallback arm).
    Skipped,
}

// ── ResidencyGroup ─────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResidencyGroup {
    pub group_id: ResidencyGroupId,
    pub plan_version: ResidencyPlanVersion,
    /// The artifact ranges that belong to this residency group.
    pub artifacts: Vec<ArtifactRange>,
    /// Priority of this group (higher = more urgent).
    pub priority: ResidencyPriority,
    /// Whether this group is eligible for eviction under pressure.
    pub evictable: bool,
}

// ── ArtifactRange ──────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ArtifactRange {
    pub resource_id: ResourceId,
    /// Byte offset in the resource (`None` for whole resource).
    pub offset: Option<u64>,
    /// Byte length (`None` for whole resource).
    pub length: Option<u64>,
}

// ── ResidencyPriority ──────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ResidencyPriority {
    Critical,
    High,
    Normal,
    Low,
    Background,
}

// ── ArtifactPreparationBackend (trait stub) ────────────────────────────────

/// Stub trait for artifact-preparation backends.
///
/// Concrete implementations (e.g. MLX file mapping, Metal buffer upload)
/// are provided by downstream crates.
pub trait ArtifactPreparationBackend {
    /// Prepare the artifact identified by `range`, returning a receipt or
    /// an error.
    fn prepare(&self, range: &ArtifactRange) -> Result<PreparationReceipt, PreparationError>;
}

// ── PreparationReceipt ─────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PreparationReceipt {
    pub resource_id: ResourceId,
    pub artifact_range: ArtifactRange,
    pub prepared_bytes: u64,
    pub mapping_address: Option<u64>,
    pub mapping_length: Option<u64>,
    pub preparation_ns: u64,
    pub backend_name: String,
}

// ── PreparationError ───────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PreparationError {
    pub resource_id: ResourceId,
    pub artifact_range: ArtifactRange,
    pub kind: String,
    pub message: String,
}

// ── ModelReadiness ─────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ModelReadiness {
    /// Model is fully resident and ready for inference.
    /// Model is valid and resident but has not completed the treatment plan.
    MappedReady,
    /// One or more conditioning recipes are in progress.
    Conditioning,
    /// Every required valid recipe completed and every treatment invariant passed.
    LatencyReady,
    /// A required recipe failed, selected the wrong substrate, exceeded time/memory policy, or contaminated runtime state.
    ConditioningFailed,
}

// ── ConditioningFallbackPolicy ─────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConditioningFallbackPolicy {
    /// Fall back to frozen control.
    FallbackToFrozen,
    /// Degrade gracefully (e.g. reduce prefetch window).
    Degrade,
    /// Abort the request.
    Abort,
    /// Log and continue with best-effort conditioning.
    LogAndContinue,
}

// ── MemoryPressureThreshold ────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MemoryPressureThreshold {
    /// No significant pressure.
    Normal,
    /// Elevated pressure — begin evicting low-priority groups.
    Elevated,
    /// High pressure — evict normal-priority groups.
    High,
    /// Critical pressure — evict everything non-essential.
    Critical,
}

// ── ExpectedSubstrate ──────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExpectedSubstrate {
    Cpu,
    Gpu,
}

// ── PhaseShape ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PhaseShape {
    Prefill,
    Decode,
}

// ── OperationFamily ────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OperationFamily {
    QProj,
    KProj,
    VProj,
    OProj,
    GateProj,
    UpProj,
    DownProj,
}

// ── SyntheticInputContract ─────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyntheticInputContract {
    pub step_id: ExecutionStepId,
    pub operation: OperationFamily,
    pub phase_shape: PhaseShape,
    pub expected_dtype: DType,
    pub logical_shape: Vec<i32>,
    pub seed: Option<u64>,
}

// ── ScratchKvContract ──────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScratchKvContract {
    pub max_seq_len: u32,
    pub num_layers: u32,
    pub num_heads: u32,
    pub head_dim: u32,
    pub dtype: DType,
    pub page_size: u32,
}

// ── DType ──────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DType {
    F32,
    Bf16,
    #[serde(rename = "u32_packed")]
    U32Packed,
}

// ── AttentionKind ──────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AttentionKind {
    Sliding,
    Full,
}

// ═══════════════════════════════════════════════════════════════════════════
// Evidence events
// ═══════════════════════════════════════════════════════════════════════════

// ── ConditioningRecipeEvent ────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConditioningRecipeEvent {
    pub recipe_id: ConditioningRecipeId,
    pub plan_version: PipelinePlanVersion,
    pub arm: ConditioningArm,
    pub completion: ConditioningRecipeCompletionState,
    pub total_conditioning_ns: u64,
    pub step_count: u32,
    pub completed_step_count: u32,
    pub error: Option<String>,
}

// ── PrefetchLifecycleEvent ─────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PrefetchLifecycleEvent {
    pub recipe_id: ConditioningRecipeId,
    pub resource_id: ResourceId,
    pub stage: PrefetchLifecycleStage,
    pub bytes_transferred: u64,
    pub duration_ns: u64,
    pub error: Option<String>,
}

// ── PrefetchLifecycleStage ─────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PrefetchLifecycleStage {
    Scheduled,
    InFlight,
    Completed,
    Failed,
    Cancelled,
}

// ── ReadinessTransitionEvent ───────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReadinessTransitionEvent {
    pub resource_id: ResourceId,
    pub previous: ModelReadiness,
    pub current: ModelReadiness,
    pub reason: String,
    pub transition_ns: u64,
}

// ── TreatmentSummaryEvent ──────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TreatmentSummaryEvent {
    pub recipe_id: ConditioningRecipeId,
    pub plan_version: PipelinePlanVersion,
    pub arm: ConditioningArm,
    pub total_prepare_ns: u64,
    pub total_execute_ns: u64,
    pub total_prefetch_bytes: u64,
    pub step_count: u32,
    pub eviction_count: u32,
    pub peak_memory_bytes: Option<u64>,
    pub final_readiness: ModelReadiness,
}
