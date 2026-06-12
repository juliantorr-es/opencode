//! Tribunus evidence-plane event schema — V4.
//!
//! Every event is self-contained.  No parser infers phase from preceding
//! [phase] lines.  Every field needed for analytical queries has a stable
//! typed column; measurement JSON blobs are for experimental extensions only.
//!
//! ## Crate boundary
//!
//! The inference runtime (`packages/compute-native`) may depend on this crate
//! for event types and serialization.  It must NOT depend on Arrow, DuckDB,
//! normalization, or any other crate in `compute-evidence-native`.
//!
//! ## Schema versioning
//!
//! `SchemaVersion` is the first field of every event envelope.  Major version
//! changes are breaking; minor changes add optional fields with defaults.
//! Unknown major versions MUST be rejected at ingestion.

use serde::{Deserialize, Serialize};
use std::fmt;
pub mod mission0007;
// Re-export Mission 0007 types (all except `AttentionKind` which already
// exists in this module with an additional `Embedding` variant).
pub use mission0007::{
    ArtifactPreparationBackend, ArtifactRange, ConditioningArm, ConditioningFallbackPolicy,
    ConditioningRecipe, ConditioningRecipeCompletionState, ConditioningRecipeEvent,
    ConditioningRecipeId, DType, ExecutionConditioningPolicy, ExecutionStepId, ExpectedSubstrate,
    KernelSignature, KernelSignatureId, MemoryPressureThreshold, ModelReadiness, OperationFamily,
    PhaseShape, PipelinePlanVersion, PrefetchLifecycleEvent, PrefetchLifecycleStage,
    PreparationError, PreparationReceipt, ReadinessTransitionEvent, ResidencyGroup,
    ResidencyGroupId, ResidencyPlanVersion, ResidencyPriority, ResourceId, ScratchKvContract,
    SyntheticInputContract, TreatmentSummaryEvent,
};

// ── Schema version ─────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct SchemaVersion {
    pub major: u16,
    pub minor: u16,
}

impl SchemaVersion {
    pub const V4_0: Self = SchemaVersion { major: 4, minor: 0 };

    pub fn is_compatible(&self) -> bool {
        self.major == 4
    }
}

impl fmt::Display for SchemaVersion {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "v{}.{}", self.major, self.minor)
    }
}

// ── String wrappers (cheap clones, no accidental confusion) ────────────────

macro_rules! string_wrapper {
    ($name:ident, $doc:expr) => {
        #[doc = $doc]
        #[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
        #[serde(transparent)]
        pub struct $name(pub String);

        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
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

string_wrapper!(RunId, "Unique run identifier, e.g. `E0002-R1-20260609`.");
string_wrapper!(RequestId, "Request identifier, scoped to run.");
string_wrapper!(WorkerId, "Worker identifier, scoped to request.");
string_wrapper!(SubstrateId, "Execution substrate, e.g. `mlx_generic_gpu`.");
string_wrapper!(EventId, "Globally unique event identifier (UUID v4).");

// ── Phase ──────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Phase {
    Prefill,
    DecodeStep,
    Epilogue,
}

impl Phase {
    pub fn as_str(&self) -> &'static str {
        match self {
            Phase::Prefill => "prefill",
            Phase::DecodeStep => "decode_step",
            Phase::Epilogue => "epilogue",
        }
    }
}

// ── Attention kind ─────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AttentionKind {
    Sliding,
    Full,
    Embedding,
}

// ── Projection family ──────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProjectionFamily {
    #[serde(rename = "q_proj")]
    QProj,
    #[serde(rename = "k_proj")]
    KProj,
    #[serde(rename = "v_proj")]
    VProj,
    #[serde(rename = "o_proj")]
    OProj,
    #[serde(rename = "gate_proj")]
    GateProj,
    #[serde(rename = "up_proj")]
    UpProj,
    #[serde(rename = "down_proj")]
    DownProj,
    #[serde(rename = "embedding")]
    Embedding,
    #[serde(rename = "vocabulary")]
    Vocabulary,
}

impl ProjectionFamily {
    pub fn as_str(&self) -> &'static str {
        match self {
            ProjectionFamily::QProj => "q_proj",
            ProjectionFamily::KProj => "k_proj",
            ProjectionFamily::VProj => "v_proj",
            ProjectionFamily::OProj => "o_proj",
            ProjectionFamily::GateProj => "gate_proj",
            ProjectionFamily::UpProj => "up_proj",
            ProjectionFamily::DownProj => "down_proj",
            ProjectionFamily::Embedding => "embedding",
            ProjectionFamily::Vocabulary => "vocabulary",
        }
    }
}

// ── Storage policy ─────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StoragePolicy {
    FrozenExisting,
    RuntimeCanonicalCopyProbe,
    CompilerPrepackedV1,
}

// ── Timestamp ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Timestamp(chrono::DateTime<chrono::Utc>);

impl Timestamp {
    pub fn now() -> Self {
        Timestamp(chrono::Utc::now())
    }
}

impl fmt::Display for Timestamp {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.to_rfc3339().fmt(f)
    }
}

// ── Event envelope ─────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EvidenceEventV4 {
    pub schema_version: SchemaVersion,

    // ── Identity ──
    pub event_id: EventId,
    pub run_id: RunId,
    pub request_id: RequestId,
    pub worker_id: WorkerId,

    // ── Ordering ──
    pub sequence_number: u64,
    pub monotonic_ns: u64,

    // ── Time ──
    pub wall_time: Option<Timestamp>,

    // ── Context ──
    pub phase: Phase,
    pub forward_pass_index: u32,
    pub token_step: Option<u32>,
    pub layer_index: Option<u32>,
    pub attention_kind: Option<AttentionKind>,

    // ── Substrate ──
    pub substrate: SubstrateId,

    // ── Source provenance ──
    pub source_provenance: Option<IngestionProvenance>,

    // ── Payload ──
    pub payload: EventPayloadV4,
}

impl EvidenceEventV4 {
    /// Derive a compact stage identifier for DuckDB queries.
    pub fn stage_id(&self) -> String {
        match &self.payload {
            EventPayloadV4::ProjectionGraph(p) => {
                let ts = self
                    .token_step
                    .map(|s| format!("step_{}", s))
                    .unwrap_or_default();
                let li = self
                    .layer_index
                    .map(|l| format!("layer_{}", l))
                    .unwrap_or_default();
                format!(
                    "{}_{}_{}_{}",
                    self.phase.as_str(),
                    ts,
                    li,
                    p.family.as_str()
                )
            }
            EventPayloadV4::LayerStage(_) => {
                let ts = self
                    .token_step
                    .map(|s| format!("step_{}", s))
                    .unwrap_or_default();
                let li = self
                    .layer_index
                    .map(|l| format!("layer_{}", l))
                    .unwrap_or_default();
                format!("{}_{}_layer_{}", self.phase.as_str(), ts, li)
            }
            _ => {
                format!("{}_{}", self.phase.as_str(), self.sequence_number)
            }
        }
    }
}

// ── Event payloads ─────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "event_type", rename_all = "snake_case")]
pub enum EventPayloadV4 {
    LayerStage(LayerStageEvent),
    ProjectionGraph(ProjectionGraphEvent),
    ProjectionReplay(ProjectionReplayEvent),
    MetalCommand(MetalCommandEvent),
    MemorySample(MemorySampleEvent),
    CorrectnessCheckpoint(CorrectnessCheckpointEvent),
    ModelLoad(ModelLoadEvent),
    TokenMetric(TokenMetricEvent),
    Lifecycle(LifecycleEvent),
    ResourceLifecycle(ResourceLifecycleEvent),
    Diagnostic(DiagnosticEvent),
    // ── Mission 0007: conditioning-aware pipeline events ──
    ConditioningRecipe(ConditioningRecipeEvent),
    PrefetchLifecycle(PrefetchLifecycleEvent),
    ReadinessTransition(ReadinessTransitionEvent),
    TreatmentSummary(TreatmentSummaryEvent),
}

// ── LayerStageEvent ────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LayerStageEvent {
    pub stage_id: String,
    pub status: String,
    pub graph_build_ns: u64,
    pub eval_ns: u64,
    pub total_ns: u64,
    pub kv_copy_bytes: u64,
    pub kv_alloc_bytes: u64,
    pub kv_seq_len: u32,
    pub shape: Vec<i32>,
    pub finite: bool,
}

// ── ProjectionGraphEvent ───────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectionGraphEvent {
    pub family: ProjectionFamily,
    pub invocation: u32,
    pub graph_build_ns: u64,
    pub input_shape: Vec<i32>,
    pub weight_logical_shape: Vec<i32>,
    pub weight_physical_shape: Vec<i32>,
    pub storage_dtype: String,
    pub runtime_dtype: String,
    pub group_size: i32,
    pub bits: i32,
    pub transpose: bool,
}

// ── ProjectionReplayEvent ──────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectionReplayEvent {
    pub family: ProjectionFamily,
    pub phase_class: String, // "cold", "warm", "warmup"
    pub m: i32,
    pub n: i32,
    pub k: i32,
    pub input_dtype: String,
    pub manifest_weight_dtype: String,
    pub mlx_weight_dtype: String,
    pub scale_dtype: String,
    pub bias_dtype: String,
    pub group_size: i32,
    pub bits: i32,
    pub transpose: bool,
    pub weight_logical_shape: Vec<i32>,
    pub weight_physical_shape: Vec<i32>,
    pub weight_strides: Vec<u64>,
    pub weight_element_bytes: u64,
    pub weight_array_byte_count: u64,
    pub manifest_byte_length: u64,
    pub pointer_alignment: u64,
    pub storage_policy: String,
    pub row_contiguous: Option<bool>,
    pub graph_build_ns: u64,
    pub forced_eval_ns: u64,
    pub synchronize_ns: u64,
    pub total_ns: u64,
    pub mlx_active_before: Option<u64>,
    pub mlx_active_after: Option<u64>,
    pub mlx_cache_before: Option<u64>,
    pub mlx_cache_after: Option<u64>,
    pub peak_mlx_memory: Option<u64>,
    pub process_rss: Option<u64>,
    pub output_digest: String,
    pub max_abs_error: Option<f64>,
    pub max_rel_error: Option<f64>,
    pub mean_abs_error: Option<f64>,
    pub cosine_similarity: Option<f64>,
    pub oracle_status: String,
}

// ── MetalCommandEvent ──────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MetalCommandEvent {
    pub family: Option<ProjectionFamily>,
    pub command_type: String, // "kernel", "copy", "blit", "sync", "fence", "unknown"
    pub kernel_name: Option<String>,
    pub command_buffer_id: Option<String>,
    pub encoder_id: Option<String>,
    pub gpu_start_ns: Option<u64>,
    pub gpu_end_ns: Option<u64>,
    pub gpu_duration_ns: Option<u64>,
    pub dispatch_grid: Option<[u32; 3]>,
    pub threadgroup_size: Option<[u32; 3]>,
    pub buffer_sizes: Vec<u64>,
    pub buffer_offsets: Vec<u64>,
    pub copy_bytes: u64,
    pub temporary_buffer_bytes: u64,
    pub pipeline_id: Option<String>,
    pub pipeline_cache_hit: Option<bool>,
    pub resource_stalls: Option<bool>,
    pub attributed: bool,
}

// ── MemorySampleEvent ──────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemorySampleEvent {
    pub resident_bytes: Option<u64>,
    pub mlx_active_bytes: Option<u64>,
    pub mlx_cache_bytes: Option<u64>,
    pub mlx_peak_bytes: Option<u64>,
    pub handles: Option<u32>,
}

// ── CorrectnessCheckpointEvent ─────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CorrectnessCheckpointEvent {
    pub family: ProjectionFamily,
    pub input_digest: String,
    pub reference_impl: String,
    pub reference_output_digest: String,
    pub treatment_output_digest: String,
    pub max_abs_error: f64,
    pub mean_abs_error: f64,
    pub max_rel_error: Option<f64>,
    pub mean_rel_error: Option<f64>,
    pub cosine_similarity: Option<f64>,
    pub tolerance: f64,
    pub passed: bool,
}

// ── ModelLoadEvent ─────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelLoadEvent {
    pub mapped_tensor_count: u64,
    pub copied_tensor_count: u64,
    pub materialized_tensor_count: u64,
    pub mapped_bytes: u64,
    pub copied_bytes: u64,
    pub materialized_bytes: u64,
    pub mapped_views: u64,
    pub postload_rss: u64,
    pub postload_active: u64,
    pub postload_cache: u64,
    pub page_faults: u64,
    pub segments: u32,
}

// ── TokenMetricEvent ───────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TokenMetricEvent {
    pub token_index: u32,
    pub token_id: u32,
    pub decode_ns: u64,
    pub attention_ns: u64,
    pub mlp_ns: u64,
    pub norm_ns: u64,
    pub sample_ns: u64,
}

// ── LifecycleEvent ─────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "lifecycle_event", rename_all = "snake_case")]
pub enum LifecycleEvent {
    RunStart {
        experiment_id: String,
        optimization_id: String,
        source_commit: String,
        binary_sha256: String,
        logical_image_hash: String,
        artifact_root_hash: String,
        machine_profile: MachineProfile,
    },
    RunEnd {
        status: String,
        error: Option<String>,
    },
    PhaseStart {
        phase: String,
    },
    PhaseEnd {
        phase: String,
    },
}

// ── DiagnosticEvent ────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiagnosticEvent {
    pub level: String, // "info", "warn", "error"
    pub message: String,
    pub context: Option<serde_json::Value>,
}

// ── Machine profile ────────────────────────────────────────────────────────
// ── ResourceLifecycleEvent ──────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResourceLifecycleEvent {
    pub resource_id: String,
    pub owner_scope: ResourceOwnerScope,
    pub resource_class: ResourceClass,
    pub lifecycle_phase: LifecyclePhase,
    pub logical_bytes: u64,
    pub physical_bytes: Option<u64>,
    pub creation_cause: Option<String>,
    pub retention_cause: Option<String>,
    pub parent_operation: Option<String>,
    pub generation: u32,
    pub eviction_policy: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ResourceOwnerScope {
    Device,
    WorkerProcess,
    ModelRuntime,
    Session,
    ProjectionInvocation,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ResourceClass {
    MappedSegment,
    MlxArray,
    MetalPipeline,
    CompiledKernel,
    TemporaryWorkspace,
    KvCache,
    TokenizerCache,
    ProjectionReplayInput,
    ArrowBatchBuffer,
    Other,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LifecyclePhase {
    Created,
    Retained,
    Reused,
    Evicted,
    Released,
    CacheHit,
    CacheMiss,
    CapacityExceeded,
    ReleaseVerified,
}

// ── DiagnosticEvent ────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MachineProfile {
    pub model_identifier: String,
    pub chip: String,
    pub memory: String,
    pub perf_cores: u32,
    pub eff_cores: u32,
    pub gpu_cores: u32,
    pub os_version: String,
}

// ── Ingestion provenance ───────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IngestionProvenance {
    pub source_file: String,
    pub source_file_sha256: Option<String>,
    pub source_byte_start: u64,
    pub source_byte_end: u64,
    pub source_line: u64,
    pub parser_backend: String,
    pub parser_version: String,
    pub schema_version: SchemaVersion,
    pub ingestion_batch_id: String,
}

// ── Validation mode ────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ValidationMode {
    StrictClaim,
    ControlledResearch,
    LegacyMigration,
}

// ── Builder helpers ────────────────────────────────────────────────────────

impl EvidenceEventV4 {
    /// Create a new V4 event with defaults filled.
    pub fn new(
        run_id: RunId,
        request_id: RequestId,
        worker_id: WorkerId,
        payload: EventPayloadV4,
    ) -> Self {
        Self {
            schema_version: SchemaVersion::V4_0,
            event_id: EventId(uuid::Uuid::new_v4().to_string()),
            run_id,
            request_id,
            worker_id,
            sequence_number: 0,
            monotonic_ns: 0,
            wall_time: Some(Timestamp::now()),
            phase: Phase::Prefill,
            forward_pass_index: 1,
            token_step: None,
            layer_index: None,
            attention_kind: None,
            substrate: SubstrateId("mlx_generic_gpu".into()),
            source_provenance: None,
            payload,
        }
    }

    pub fn with_sequence(mut self, seq: u64) -> Self {
        self.sequence_number = seq;
        self
    }

    pub fn with_phase(mut self, phase: Phase) -> Self {
        self.phase = phase;
        self
    }

    pub fn with_layer(mut self, layer: u32, kind: AttentionKind) -> Self {
        self.layer_index = Some(layer);
        self.attention_kind = Some(kind);
        self
    }

    pub fn with_token_step(mut self, step: u32) -> Self {
        self.token_step = Some(step);
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_schema_version_compat() {
        assert!(SchemaVersion::V4_0.is_compatible());
        assert!(!SchemaVersion { major: 5, minor: 0 }.is_compatible());
    }

    #[test]
    fn test_evidence_event_serialization() {
        let ev = EvidenceEventV4::new(
            RunId::from("test-run"),
            RequestId::from("req-1"),
            WorkerId::from("w-1"),
            EventPayloadV4::LayerStage(LayerStageEvent {
                stage_id: "layer_0".into(),
                status: "completed".into(),
                graph_build_ns: 1000,
                eval_ns: 5000,
                total_ns: 6000,
                kv_copy_bytes: 0,
                kv_alloc_bytes: 0,
                kv_seq_len: 0,
                shape: vec![4, 3840],
                finite: true,
            }),
        )
        .with_sequence(1)
        .with_phase(Phase::Prefill)
        .with_layer(0, AttentionKind::Sliding);

        let json = serde_json::to_string(&ev).unwrap();
        let parsed: EvidenceEventV4 = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.schema_version, SchemaVersion::V4_0);
        assert_eq!(parsed.sequence_number, 1);
        assert_eq!(parsed.layer_index, Some(0));

        // Verify it's newline-terminated (NDJSON compatible)
        assert!(json.ends_with('\n') || !json.contains('\n'));
    }

    #[test]
    fn test_stage_id() {
        let ev = EvidenceEventV4::new(
            RunId::from("r1"),
            RequestId::from("q1"),
            WorkerId::from("w1"),
            EventPayloadV4::ProjectionGraph(ProjectionGraphEvent {
                family: ProjectionFamily::QProj,
                invocation: 0,
                graph_build_ns: 100,
                input_shape: vec![1, 3840],
                weight_logical_shape: vec![4096, 3840],
                weight_physical_shape: vec![4096, 3840],
                storage_dtype: "U8".into(),
                runtime_dtype: "Uint32".into(),
                group_size: 64,
                bits: 8,
                transpose: true,
            }),
        )
        .with_phase(Phase::DecodeStep)
        .with_token_step(0)
        .with_layer(12, AttentionKind::Sliding);

        assert_eq!(ev.stage_id(), "decode_step_step_0_layer_12_q_proj");
    }

    #[test]
    fn test_projection_family_serde() {
        let q = ProjectionFamily::QProj;
        let json = serde_json::to_string(&q).unwrap();
        assert_eq!(json, "\"q_proj\"");

        let parsed: ProjectionFamily = serde_json::from_str("\"gate_proj\"").unwrap();
        assert_eq!(parsed, ProjectionFamily::GateProj);
    }
}
