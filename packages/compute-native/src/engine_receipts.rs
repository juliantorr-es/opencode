//! Receipt types for the compute engine lifecycle.
//!
//! Structured receipts capture model load, request admission, per-phase
//! execution, per-step granularity, terminal request outcomes, and worker
//! exit summaries. Each receipt type carries a builder following the
//! `new()` + `with_*()` + `build() -> Self` pattern.
//!
//! No napi or mlx-rs imports — pure serde/serde_json.

use serde::{Deserialize, Serialize};
use serde_json::Value;

// ---------------------------------------------------------------------------
// 1. ModelLoadReceipt
// ---------------------------------------------------------------------------

/// Captures the full cost of loading a compute image into a worker.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelLoadReceipt {
    pub image_hash: String,
    pub storage_abi: String,
    pub runtime_abi: String,
    pub worker_pid: u32,
    pub model_open_ms: u64,
    pub mapped_virtual_bytes: u64,
    pub persistent_resident_bytes: u64,
    pub materialized_bytes: u64,
    pub copied_bytes: u64,
    pub tensor_binding_count: u32,
    pub segment_count: u32,
    pub mlx_active_limit_bytes: u64,
    pub mlx_cache_limit_bytes: u64,
    pub rss_before_bytes: u64,
    pub rss_after_bytes: u64,
    pub admission_estimate_json: String,
}

/// Builder for [`ModelLoadReceipt`].
pub struct ModelLoadReceiptBuilder {
    image_hash: String,
    storage_abi: String,
    runtime_abi: String,
    worker_pid: u32,
    model_open_ms: u64,
    mapped_virtual_bytes: u64,
    persistent_resident_bytes: u64,
    materialized_bytes: u64,
    copied_bytes: u64,
    tensor_binding_count: u32,
    segment_count: u32,
    mlx_active_limit_bytes: u64,
    mlx_cache_limit_bytes: u64,
    rss_before_bytes: u64,
    rss_after_bytes: u64,
    admission_estimate_json: String,
}

impl ModelLoadReceiptBuilder {
    pub fn new() -> Self {
        Self {
            image_hash: String::new(),
            storage_abi: String::new(),
            runtime_abi: String::new(),
            worker_pid: 0,
            model_open_ms: 0,
            mapped_virtual_bytes: 0,
            persistent_resident_bytes: 0,
            materialized_bytes: 0,
            copied_bytes: 0,
            tensor_binding_count: 0,
            segment_count: 0,
            mlx_active_limit_bytes: 0,
            mlx_cache_limit_bytes: 0,
            rss_before_bytes: 0,
            rss_after_bytes: 0,
            admission_estimate_json: String::new(),
        }
    }

    pub fn with_image_hash(mut self, v: String) -> Self {
        self.image_hash = v;
        self
    }

    pub fn with_storage_abi(mut self, v: String) -> Self {
        self.storage_abi = v;
        self
    }

    pub fn with_runtime_abi(mut self, v: String) -> Self {
        self.runtime_abi = v;
        self
    }

    pub fn with_worker_pid(mut self, v: u32) -> Self {
        self.worker_pid = v;
        self
    }

    pub fn with_model_open_ms(mut self, v: u64) -> Self {
        self.model_open_ms = v;
        self
    }

    pub fn with_mapped_virtual_bytes(mut self, v: u64) -> Self {
        self.mapped_virtual_bytes = v;
        self
    }

    pub fn with_persistent_resident_bytes(mut self, v: u64) -> Self {
        self.persistent_resident_bytes = v;
        self
    }

    pub fn with_materialized_bytes(mut self, v: u64) -> Self {
        self.materialized_bytes = v;
        self
    }

    pub fn with_copied_bytes(mut self, v: u64) -> Self {
        self.copied_bytes = v;
        self
    }

    pub fn with_tensor_binding_count(mut self, v: u32) -> Self {
        self.tensor_binding_count = v;
        self
    }

    pub fn with_segment_count(mut self, v: u32) -> Self {
        self.segment_count = v;
        self
    }

    pub fn with_mlx_active_limit_bytes(mut self, v: u64) -> Self {
        self.mlx_active_limit_bytes = v;
        self
    }

    pub fn with_mlx_cache_limit_bytes(mut self, v: u64) -> Self {
        self.mlx_cache_limit_bytes = v;
        self
    }

    pub fn with_rss_before_bytes(mut self, v: u64) -> Self {
        self.rss_before_bytes = v;
        self
    }

    pub fn with_rss_after_bytes(mut self, v: u64) -> Self {
        self.rss_after_bytes = v;
        self
    }

    pub fn with_admission_estimate_json(mut self, v: String) -> Self {
        self.admission_estimate_json = v;
        self
    }

    pub fn build(self) -> ModelLoadReceipt {
        ModelLoadReceipt {
            image_hash: self.image_hash,
            storage_abi: self.storage_abi,
            runtime_abi: self.runtime_abi,
            worker_pid: self.worker_pid,
            model_open_ms: self.model_open_ms,
            mapped_virtual_bytes: self.mapped_virtual_bytes,
            persistent_resident_bytes: self.persistent_resident_bytes,
            materialized_bytes: self.materialized_bytes,
            copied_bytes: self.copied_bytes,
            tensor_binding_count: self.tensor_binding_count,
            segment_count: self.segment_count,
            mlx_active_limit_bytes: self.mlx_active_limit_bytes,
            mlx_cache_limit_bytes: self.mlx_cache_limit_bytes,
            rss_before_bytes: self.rss_before_bytes,
            rss_after_bytes: self.rss_after_bytes,
            admission_estimate_json: self.admission_estimate_json,
        }
    }
}

impl Default for ModelLoadReceiptBuilder {
    fn default() -> Self {
        Self::new()
    }
}

// ---------------------------------------------------------------------------
// 2. RequestAdmissionReceipt
// ---------------------------------------------------------------------------

/// Admission decision for an incoming inference request.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RequestAdmissionReceipt {
    pub policy_id: String,
    pub qualification: bool,
    pub prompt_tokens: u32,
    pub output_token_budget: u32,
    pub context_budget: u32,
    pub estimated_kv_bytes: u64,
    pub estimated_attention_workspace_bytes: u64,
    pub deadline_ms: u64,
    pub worker_rss_soft_ceiling_bytes: u64,
    pub worker_rss_hard_ceiling_bytes: u64,
    pub decision: String,
    pub reject_reason: Option<String>,
}

/// Builder for [`RequestAdmissionReceipt`].
pub struct RequestAdmissionReceiptBuilder {
    policy_id: String,
    qualification: bool,
    prompt_tokens: u32,
    output_token_budget: u32,
    context_budget: u32,
    estimated_kv_bytes: u64,
    estimated_attention_workspace_bytes: u64,
    deadline_ms: u64,
    worker_rss_soft_ceiling_bytes: u64,
    worker_rss_hard_ceiling_bytes: u64,
    decision: String,
    reject_reason: Option<String>,
}

impl RequestAdmissionReceiptBuilder {
    pub fn new() -> Self {
        Self {
            policy_id: String::new(),
            qualification: false,
            prompt_tokens: 0,
            output_token_budget: 0,
            context_budget: 0,
            estimated_kv_bytes: 0,
            estimated_attention_workspace_bytes: 0,
            deadline_ms: 0,
            worker_rss_soft_ceiling_bytes: 0,
            worker_rss_hard_ceiling_bytes: 0,
            decision: String::new(),
            reject_reason: None,
        }
    }

    pub fn with_policy_id(mut self, v: String) -> Self {
        self.policy_id = v;
        self
    }

    pub fn with_qualification(mut self, v: bool) -> Self {
        self.qualification = v;
        self
    }

    pub fn with_prompt_tokens(mut self, v: u32) -> Self {
        self.prompt_tokens = v;
        self
    }

    pub fn with_output_token_budget(mut self, v: u32) -> Self {
        self.output_token_budget = v;
        self
    }

    pub fn with_context_budget(mut self, v: u32) -> Self {
        self.context_budget = v;
        self
    }

    pub fn with_estimated_kv_bytes(mut self, v: u64) -> Self {
        self.estimated_kv_bytes = v;
        self
    }

    pub fn with_estimated_attention_workspace_bytes(mut self, v: u64) -> Self {
        self.estimated_attention_workspace_bytes = v;
        self
    }

    pub fn with_deadline_ms(mut self, v: u64) -> Self {
        self.deadline_ms = v;
        self
    }

    pub fn with_worker_rss_soft_ceiling_bytes(mut self, v: u64) -> Self {
        self.worker_rss_soft_ceiling_bytes = v;
        self
    }

    pub fn with_worker_rss_hard_ceiling_bytes(mut self, v: u64) -> Self {
        self.worker_rss_hard_ceiling_bytes = v;
        self
    }

    pub fn with_decision(mut self, v: String) -> Self {
        self.decision = v;
        self
    }

    pub fn with_reject_reason(mut self, v: Option<String>) -> Self {
        self.reject_reason = v;
        self
    }

    pub fn build(self) -> RequestAdmissionReceipt {
        RequestAdmissionReceipt {
            policy_id: self.policy_id,
            qualification: self.qualification,
            prompt_tokens: self.prompt_tokens,
            output_token_budget: self.output_token_budget,
            context_budget: self.context_budget,
            estimated_kv_bytes: self.estimated_kv_bytes,
            estimated_attention_workspace_bytes: self.estimated_attention_workspace_bytes,
            deadline_ms: self.deadline_ms,
            worker_rss_soft_ceiling_bytes: self.worker_rss_soft_ceiling_bytes,
            worker_rss_hard_ceiling_bytes: self.worker_rss_hard_ceiling_bytes,
            decision: self.decision,
            reject_reason: self.reject_reason,
        }
    }
}

impl Default for RequestAdmissionReceiptBuilder {
    fn default() -> Self {
        Self::new()
    }
}

// ---------------------------------------------------------------------------
// 3. PhaseReceipt
// ---------------------------------------------------------------------------

/// Execution-phase-level telemetry (prefill or decode).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PhaseReceipt {
    pub phase: String,
    pub wall_time_ms: u64,
    pub graph_build_ms: u64,
    pub eval_ms: u64,
    pub queue_ms: u64,
    pub file_bytes_read: u64,
    pub tensor_view_creations: u32,
    pub tensor_view_reuses: u32,
    pub mlx_active_bytes: u64,
    pub mlx_cache_bytes: u64,
    pub mlx_peak_bytes: u64,
    pub worker_rss_bytes: u64,
    pub kv_logical_position: u32,
    pub kv_allocated_bytes: u64,
    pub copy_classifications: Vec<String>,
    pub mask_bytes: u64,
}

/// Builder for [`PhaseReceipt`].
pub struct PhaseReceiptBuilder {
    phase: String,
    wall_time_ms: u64,
    graph_build_ms: u64,
    eval_ms: u64,
    queue_ms: u64,
    file_bytes_read: u64,
    tensor_view_creations: u32,
    tensor_view_reuses: u32,
    mlx_active_bytes: u64,
    mlx_cache_bytes: u64,
    mlx_peak_bytes: u64,
    worker_rss_bytes: u64,
    kv_logical_position: u32,
    kv_allocated_bytes: u64,
    copy_classifications: Vec<String>,
    mask_bytes: u64,
}

impl PhaseReceiptBuilder {
    pub fn new() -> Self {
        Self {
            phase: String::new(),
            wall_time_ms: 0,
            graph_build_ms: 0,
            eval_ms: 0,
            queue_ms: 0,
            file_bytes_read: 0,
            tensor_view_creations: 0,
            tensor_view_reuses: 0,
            mlx_active_bytes: 0,
            mlx_cache_bytes: 0,
            mlx_peak_bytes: 0,
            worker_rss_bytes: 0,
            kv_logical_position: 0,
            kv_allocated_bytes: 0,
            copy_classifications: Vec::new(),
            mask_bytes: 0,
        }
    }

    pub fn with_phase(mut self, v: String) -> Self {
        self.phase = v;
        self
    }

    pub fn with_wall_time_ms(mut self, v: u64) -> Self {
        self.wall_time_ms = v;
        self
    }

    pub fn with_graph_build_ms(mut self, v: u64) -> Self {
        self.graph_build_ms = v;
        self
    }

    pub fn with_eval_ms(mut self, v: u64) -> Self {
        self.eval_ms = v;
        self
    }

    pub fn with_queue_ms(mut self, v: u64) -> Self {
        self.queue_ms = v;
        self
    }

    pub fn with_file_bytes_read(mut self, v: u64) -> Self {
        self.file_bytes_read = v;
        self
    }

    pub fn with_tensor_view_creations(mut self, v: u32) -> Self {
        self.tensor_view_creations = v;
        self
    }

    pub fn with_tensor_view_reuses(mut self, v: u32) -> Self {
        self.tensor_view_reuses = v;
        self
    }

    pub fn with_mlx_active_bytes(mut self, v: u64) -> Self {
        self.mlx_active_bytes = v;
        self
    }

    pub fn with_mlx_cache_bytes(mut self, v: u64) -> Self {
        self.mlx_cache_bytes = v;
        self
    }

    pub fn with_mlx_peak_bytes(mut self, v: u64) -> Self {
        self.mlx_peak_bytes = v;
        self
    }

    pub fn with_worker_rss_bytes(mut self, v: u64) -> Self {
        self.worker_rss_bytes = v;
        self
    }

    pub fn with_kv_logical_position(mut self, v: u32) -> Self {
        self.kv_logical_position = v;
        self
    }

    pub fn with_kv_allocated_bytes(mut self, v: u64) -> Self {
        self.kv_allocated_bytes = v;
        self
    }

    pub fn with_copy_classifications(mut self, v: Vec<String>) -> Self {
        self.copy_classifications = v;
        self
    }

    pub fn with_mask_bytes(mut self, v: u64) -> Self {
        self.mask_bytes = v;
        self
    }

    pub fn build(self) -> PhaseReceipt {
        PhaseReceipt {
            phase: self.phase,
            wall_time_ms: self.wall_time_ms,
            graph_build_ms: self.graph_build_ms,
            eval_ms: self.eval_ms,
            queue_ms: self.queue_ms,
            file_bytes_read: self.file_bytes_read,
            tensor_view_creations: self.tensor_view_creations,
            tensor_view_reuses: self.tensor_view_reuses,
            mlx_active_bytes: self.mlx_active_bytes,
            mlx_cache_bytes: self.mlx_cache_bytes,
            mlx_peak_bytes: self.mlx_peak_bytes,
            worker_rss_bytes: self.worker_rss_bytes,
            kv_logical_position: self.kv_logical_position,
            kv_allocated_bytes: self.kv_allocated_bytes,
            copy_classifications: self.copy_classifications,
            mask_bytes: self.mask_bytes,
        }
    }
}

impl Default for PhaseReceiptBuilder {
    fn default() -> Self {
        Self::new()
    }
}

// ---------------------------------------------------------------------------
// 4. StepReceipt
// ---------------------------------------------------------------------------

/// Per-step telemetry wrapping a phase receipt.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StepReceipt {
    pub step_index: u32,
    pub token_id: u32,
    pub position: u32,
    pub wall_time_us: u64,
    pub phase_receipt: PhaseReceipt,
}

/// Builder for [`StepReceipt`].
pub struct StepReceiptBuilder {
    step_index: u32,
    token_id: u32,
    position: u32,
    wall_time_us: u64,
    phase_receipt: PhaseReceipt,
}

impl StepReceiptBuilder {
    pub fn new() -> Self {
        Self {
            step_index: 0,
            token_id: 0,
            position: 0,
            wall_time_us: 0,
            phase_receipt: PhaseReceiptBuilder::new().build(),
        }
    }

    pub fn with_step_index(mut self, v: u32) -> Self {
        self.step_index = v;
        self
    }

    pub fn with_token_id(mut self, v: u32) -> Self {
        self.token_id = v;
        self
    }

    pub fn with_position(mut self, v: u32) -> Self {
        self.position = v;
        self
    }

    pub fn with_wall_time_us(mut self, v: u64) -> Self {
        self.wall_time_us = v;
        self
    }

    pub fn with_phase_receipt(mut self, v: PhaseReceipt) -> Self {
        self.phase_receipt = v;
        self
    }

    pub fn build(self) -> StepReceipt {
        StepReceipt {
            step_index: self.step_index,
            token_id: self.token_id,
            position: self.position,
            wall_time_us: self.wall_time_us,
            phase_receipt: self.phase_receipt,
        }
    }
}

impl Default for StepReceiptBuilder {
    fn default() -> Self {
        Self::new()
    }
}

// ---------------------------------------------------------------------------
// 5. TerminalRequestReceipt
// ---------------------------------------------------------------------------

/// Terminal summary for a single inference request.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TerminalRequestReceipt {
    pub request_id: String,
    pub outcome: String,
    pub generated_token_count: u32,
    pub ttft_ms: u64,
    pub per_token_latency_ms: Vec<u64>,
    pub peak_rss_bytes: u64,
    pub peak_mlx_active_bytes: u64,
    pub peak_mlx_cache_bytes: u64,
    pub forced_termination: bool,
    pub cancellation_mode: Option<String>,
    pub worker_restart_required: bool,
    pub last_completed_phase: String,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
}

/// Builder for [`TerminalRequestReceipt`].
pub struct TerminalRequestReceiptBuilder {
    request_id: String,
    outcome: String,
    generated_token_count: u32,
    ttft_ms: u64,
    per_token_latency_ms: Vec<u64>,
    peak_rss_bytes: u64,
    peak_mlx_active_bytes: u64,
    peak_mlx_cache_bytes: u64,
    forced_termination: bool,
    cancellation_mode: Option<String>,
    worker_restart_required: bool,
    last_completed_phase: String,
    error_code: Option<String>,
    error_message: Option<String>,
}

impl TerminalRequestReceiptBuilder {
    pub fn new() -> Self {
        Self {
            request_id: String::new(),
            outcome: String::new(),
            generated_token_count: 0,
            ttft_ms: 0,
            per_token_latency_ms: Vec::new(),
            peak_rss_bytes: 0,
            peak_mlx_active_bytes: 0,
            peak_mlx_cache_bytes: 0,
            forced_termination: false,
            cancellation_mode: None,
            worker_restart_required: false,
            last_completed_phase: String::new(),
            error_code: None,
            error_message: None,
        }
    }

    pub fn with_request_id(mut self, v: String) -> Self {
        self.request_id = v;
        self
    }

    pub fn with_outcome(mut self, v: String) -> Self {
        self.outcome = v;
        self
    }

    pub fn with_generated_token_count(mut self, v: u32) -> Self {
        self.generated_token_count = v;
        self
    }

    pub fn with_ttft_ms(mut self, v: u64) -> Self {
        self.ttft_ms = v;
        self
    }

    pub fn with_per_token_latency_ms(mut self, v: Vec<u64>) -> Self {
        self.per_token_latency_ms = v;
        self
    }

    pub fn with_peak_rss_bytes(mut self, v: u64) -> Self {
        self.peak_rss_bytes = v;
        self
    }

    pub fn with_peak_mlx_active_bytes(mut self, v: u64) -> Self {
        self.peak_mlx_active_bytes = v;
        self
    }

    pub fn with_peak_mlx_cache_bytes(mut self, v: u64) -> Self {
        self.peak_mlx_cache_bytes = v;
        self
    }

    pub fn with_forced_termination(mut self, v: bool) -> Self {
        self.forced_termination = v;
        self
    }

    pub fn with_cancellation_mode(mut self, v: Option<String>) -> Self {
        self.cancellation_mode = v;
        self
    }

    pub fn with_worker_restart_required(mut self, v: bool) -> Self {
        self.worker_restart_required = v;
        self
    }

    pub fn with_last_completed_phase(mut self, v: String) -> Self {
        self.last_completed_phase = v;
        self
    }

    pub fn with_error_code(mut self, v: Option<String>) -> Self {
        self.error_code = v;
        self
    }

    pub fn with_error_message(mut self, v: Option<String>) -> Self {
        self.error_message = v;
        self
    }

    pub fn build(self) -> TerminalRequestReceipt {
        TerminalRequestReceipt {
            request_id: self.request_id,
            outcome: self.outcome,
            generated_token_count: self.generated_token_count,
            ttft_ms: self.ttft_ms,
            per_token_latency_ms: self.per_token_latency_ms,
            peak_rss_bytes: self.peak_rss_bytes,
            peak_mlx_active_bytes: self.peak_mlx_active_bytes,
            peak_mlx_cache_bytes: self.peak_mlx_cache_bytes,
            forced_termination: self.forced_termination,
            cancellation_mode: self.cancellation_mode,
            worker_restart_required: self.worker_restart_required,
            last_completed_phase: self.last_completed_phase,
            error_code: self.error_code,
            error_message: self.error_message,
        }
    }
}

impl Default for TerminalRequestReceiptBuilder {
    fn default() -> Self {
        Self::new()
    }
}

// ---------------------------------------------------------------------------
// 6. WorkerExitReceipt
// ---------------------------------------------------------------------------

/// Worker-level exit summary.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkerExitReceipt {
    pub worker_pid: u32,
    pub exit_code: Option<i32>,
    pub signal: Option<i32>,
    pub uptime_ms: u64,
    pub requests_completed: u32,
    pub requests_failed: u32,
    pub peak_rss_bytes: u64,
    pub faulted: bool,
    pub last_heartbeat_ms: u64,
}

/// Builder for [`WorkerExitReceipt`].
pub struct WorkerExitReceiptBuilder {
    worker_pid: u32,
    exit_code: Option<i32>,
    signal: Option<i32>,
    uptime_ms: u64,
    requests_completed: u32,
    requests_failed: u32,
    peak_rss_bytes: u64,
    faulted: bool,
    last_heartbeat_ms: u64,
}

impl WorkerExitReceiptBuilder {
    pub fn new() -> Self {
        Self {
            worker_pid: 0,
            exit_code: None,
            signal: None,
            uptime_ms: 0,
            requests_completed: 0,
            requests_failed: 0,
            peak_rss_bytes: 0,
            faulted: false,
            last_heartbeat_ms: 0,
        }
    }

    pub fn with_worker_pid(mut self, v: u32) -> Self {
        self.worker_pid = v;
        self
    }

    pub fn with_exit_code(mut self, v: Option<i32>) -> Self {
        self.exit_code = v;
        self
    }

    pub fn with_signal(mut self, v: Option<i32>) -> Self {
        self.signal = v;
        self
    }

    pub fn with_uptime_ms(mut self, v: u64) -> Self {
        self.uptime_ms = v;
        self
    }

    pub fn with_requests_completed(mut self, v: u32) -> Self {
        self.requests_completed = v;
        self
    }

    pub fn with_requests_failed(mut self, v: u32) -> Self {
        self.requests_failed = v;
        self
    }

    pub fn with_peak_rss_bytes(mut self, v: u64) -> Self {
        self.peak_rss_bytes = v;
        self
    }

    pub fn with_faulted(mut self, v: bool) -> Self {
        self.faulted = v;
        self
    }

    pub fn with_last_heartbeat_ms(mut self, v: u64) -> Self {
        self.last_heartbeat_ms = v;
        self
    }

    pub fn build(self) -> WorkerExitReceipt {
        WorkerExitReceipt {
            worker_pid: self.worker_pid,
            exit_code: self.exit_code,
            signal: self.signal,
            uptime_ms: self.uptime_ms,
            requests_completed: self.requests_completed,
            requests_failed: self.requests_failed,
            peak_rss_bytes: self.peak_rss_bytes,
            faulted: self.faulted,
            last_heartbeat_ms: self.last_heartbeat_ms,
        }
    }
}

impl Default for WorkerExitReceiptBuilder {
    fn default() -> Self {
        Self::new()
    }
}

// ---------------------------------------------------------------------------
// 7. ReceiptBuilder — unified builder interface
// ---------------------------------------------------------------------------

/// Unified builder for constructing all engine receipt types.
///
/// Each method returns a receipt-specific builder so callers can chain
/// `with_*()` setters followed by `build()`.
pub struct ReceiptBuilder;

impl ReceiptBuilder {
    pub fn new() -> Self {
        Self
    }

    /// Start building a [`ModelLoadReceipt`].
    pub fn model_load() -> ModelLoadReceiptBuilder {
        ModelLoadReceiptBuilder::new()
    }

    /// Start building a [`RequestAdmissionReceipt`].
    pub fn request_admission() -> RequestAdmissionReceiptBuilder {
        RequestAdmissionReceiptBuilder::new()
    }

    /// Start building a [`PhaseReceipt`].
    pub fn phase() -> PhaseReceiptBuilder {
        PhaseReceiptBuilder::new()
    }

    /// Start building a [`StepReceipt`].
    pub fn step() -> StepReceiptBuilder {
        StepReceiptBuilder::new()
    }

    /// Start building a [`TerminalRequestReceipt`].
    pub fn terminal_request() -> TerminalRequestReceiptBuilder {
        TerminalRequestReceiptBuilder::new()
    }

    /// Start building a [`WorkerExitReceipt`].
    pub fn worker_exit() -> WorkerExitReceiptBuilder {
        WorkerExitReceiptBuilder::new()
    }
}

// ---------------------------------------------------------------------------
// 8. Timeline
// ---------------------------------------------------------------------------

/// A single timestamped event in the engine timeline.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TimelineEvent {
    pub timestamp: String,
    pub event_type: String,
    pub data: Value,
}

/// Bounded event buffer that drops oldest entries once `max_events` is
/// exceeded.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Timeline {
    pub events: Vec<TimelineEvent>,
    pub max_events: usize,
}

impl Timeline {
    /// Create a new timeline with the given capacity.
    pub fn new(max_events: usize) -> Self {
        Self {
            events: Vec::with_capacity(max_events.min(16)),
            max_events,
        }
    }

    /// Append an event. If `events.len()` exceeds `max_events`, the oldest
    /// event is removed.
    pub fn append(&mut self, timestamp: String, event_type: String, data: Value) {
        if self.events.len() >= self.max_events {
            self.events.remove(0);
        }
        self.events.push(TimelineEvent {
            timestamp,
            event_type,
            data,
        });
    }

    /// Serialize this timeline as a JSON value.
    pub fn to_json(&self) -> Value {
        serde_json::to_value(self).unwrap_or(Value::Null)
    }

    /// Return the number of events currently held.
    pub fn len(&self) -> usize {
        self.events.len()
    }

    /// Returns `true` if no events have been recorded.
    pub fn is_empty(&self) -> bool {
        self.events.is_empty()
    }

    /// Remove all events.
    pub fn clear(&mut self) {
        self.events.clear();
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    // -- ModelLoadReceipt builder happy path --

    #[test]
    fn test_model_load_receipt_builder() {
        let r = ReceiptBuilder::model_load()
            .with_image_hash("abc123".into())
            .with_storage_abi("v1".into())
            .with_runtime_abi("v2".into())
            .with_worker_pid(42)
            .with_model_open_ms(1500)
            .with_mapped_virtual_bytes(6_000_000_000)
            .with_persistent_resident_bytes(4_000_000_000)
            .with_materialized_bytes(2_000_000_000)
            .with_copied_bytes(500_000_000)
            .with_tensor_binding_count(128)
            .with_segment_count(16)
            .with_mlx_active_limit_bytes(8_000_000_000)
            .with_mlx_cache_limit_bytes(2_000_000_000)
            .with_rss_before_bytes(1_000_000_000)
            .with_rss_after_bytes(3_000_000_000)
            .with_admission_estimate_json("{}".into())
            .build();

        assert_eq!(r.image_hash, "abc123");
        assert_eq!(r.worker_pid, 42);
        assert_eq!(r.model_open_ms, 1500);
        assert_eq!(r.tensor_binding_count, 128);
    }

    // -- RequestAdmissionReceipt builder --

    #[test]
    fn test_request_admission_receipt_builder() {
        let r = ReceiptBuilder::request_admission()
            .with_policy_id("policy-01".into())
            .with_qualification(true)
            .with_prompt_tokens(512)
            .with_output_token_budget(128)
            .with_context_budget(1024)
            .with_estimated_kv_bytes(300_000_000)
            .with_estimated_attention_workspace_bytes(100_000_000)
            .with_deadline_ms(5000)
            .with_worker_rss_soft_ceiling_bytes(8_000_000_000)
            .with_worker_rss_hard_ceiling_bytes(10_000_000_000)
            .with_decision("admitted".into())
            .with_reject_reason(None)
            .build();

        assert_eq!(r.policy_id, "policy-01");
        assert!(r.qualification);
        assert_eq!(r.decision, "admitted");
        assert!(r.reject_reason.is_none());
    }

    #[test]
    fn test_request_admission_receipt_rejected() {
        let r = ReceiptBuilder::request_admission()
            .with_decision("rejected".into())
            .with_reject_reason(Some("OOM: estimated kv exceeds ceiling".into()))
            .build();

        assert_eq!(r.decision, "rejected");
        assert_eq!(
            r.reject_reason.as_deref(),
            Some("OOM: estimated kv exceeds ceiling")
        );
    }

    // -- PhaseReceipt builder --

    #[test]
    fn test_phase_receipt_builder() {
        let r = ReceiptBuilder::phase()
            .with_phase("prefill".into())
            .with_wall_time_ms(1200)
            .with_graph_build_ms(300)
            .with_eval_ms(800)
            .with_queue_ms(100)
            .with_file_bytes_read(400_000)
            .with_tensor_view_creations(64)
            .with_tensor_view_reuses(32)
            .with_mlx_active_bytes(4_000_000_000)
            .with_mlx_cache_bytes(1_000_000_000)
            .with_mlx_peak_bytes(4_500_000_000)
            .with_worker_rss_bytes(5_000_000_000)
            .with_kv_logical_position(512)
            .with_kv_allocated_bytes(200_000_000)
            .with_copy_classifications(vec!["application_copy_free".into()])
            .with_mask_bytes(16_384)
            .build();

        assert_eq!(r.phase, "prefill");
        assert_eq!(r.wall_time_ms, 1200);
        assert_eq!(r.copy_classifications.len(), 1);
    }

    // -- StepReceipt builder --

    #[test]
    fn test_step_receipt_builder() {
        let phase = ReceiptBuilder::phase()
            .with_phase("decode".into())
            .with_wall_time_ms(50)
            .with_eval_ms(40)
            .build();

        let r = ReceiptBuilder::step()
            .with_step_index(5)
            .with_token_id(1234)
            .with_position(5)
            .with_wall_time_us(50_000)
            .with_phase_receipt(phase)
            .build();

        assert_eq!(r.step_index, 5);
        assert_eq!(r.token_id, 1234);
        assert_eq!(r.phase_receipt.phase, "decode");
    }

    // -- TerminalRequestReceipt builder --

    #[test]
    fn test_terminal_request_receipt_builder() {
        let r = ReceiptBuilder::terminal_request()
            .with_request_id("req-001".into())
            .with_outcome("completed".into())
            .with_generated_token_count(256)
            .with_ttft_ms(1500)
            .with_per_token_latency_ms(vec![45, 42, 48, 44])
            .with_peak_rss_bytes(6_000_000_000)
            .with_peak_mlx_active_bytes(5_000_000_000)
            .with_peak_mlx_cache_bytes(1_500_000_000)
            .with_forced_termination(false)
            .with_worker_restart_required(false)
            .with_last_completed_phase("decode".into())
            .build();

        assert_eq!(r.request_id, "req-001");
        assert_eq!(r.outcome, "completed");
        assert_eq!(r.generated_token_count, 256);
        assert!(r.cancellation_mode.is_none());
    }

    #[test]
    fn test_terminal_request_receipt_cancelled() {
        let r = ReceiptBuilder::terminal_request()
            .with_outcome("cancelled".into())
            .with_forced_termination(true)
            .with_cancellation_mode(Some("client_disconnect".into()))
            .with_last_completed_phase("prefill".into())
            .build();

        assert_eq!(r.outcome, "cancelled");
        assert!(r.forced_termination);
        assert_eq!(r.cancellation_mode.as_deref(), Some("client_disconnect"));
    }

    #[test]
    fn test_terminal_request_receipt_failed() {
        let r = ReceiptBuilder::terminal_request()
            .with_outcome("failed".into())
            .with_worker_restart_required(true)
            .with_error_code(Some("E_ENGINE_CRASH".into()))
            .with_error_message(Some("Worker segfaulted during prefill".into()))
            .build();

        assert_eq!(r.outcome, "failed");
        assert!(r.worker_restart_required);
        assert_eq!(r.error_code.as_deref(), Some("E_ENGINE_CRASH"));
    }

    // -- WorkerExitReceipt builder --

    #[test]
    fn test_worker_exit_receipt_builder() {
        let r = ReceiptBuilder::worker_exit()
            .with_worker_pid(42)
            .with_exit_code(Some(0))
            .with_uptime_ms(3600_000)
            .with_requests_completed(150)
            .with_requests_failed(2)
            .with_peak_rss_bytes(8_000_000_000)
            .with_faulted(false)
            .with_last_heartbeat_ms(3_599_900)
            .build();

        assert_eq!(r.worker_pid, 42);
        assert_eq!(r.exit_code, Some(0));
        assert!(!r.faulted);
    }

    #[test]
    fn test_worker_exit_receipt_signaled() {
        let r = ReceiptBuilder::worker_exit()
            .with_worker_pid(99)
            .with_exit_code(None)
            .with_signal(Some(11))
            .with_uptime_ms(120_000)
            .with_requests_completed(10)
            .with_requests_failed(1)
            .with_peak_rss_bytes(5_000_000_000)
            .with_faulted(true)
            .with_last_heartbeat_ms(119_900)
            .build();

        assert_eq!(r.signal, Some(11));
        assert!(r.faulted);
        assert_eq!(r.exit_code, None);
    }

    // -- Timeline --

    #[test]
    fn test_timeline_append_and_bounds() {
        let mut tl = Timeline::new(3);
        assert!(tl.is_empty());

        tl.append("t1".into(), "load".into(), Value::Null);
        tl.append("t2".into(), "admit".into(), Value::Null);
        tl.append("t3".into(), "prefill".into(), Value::Null);
        assert_eq!(tl.len(), 3);

        // Fourth push should drop the oldest
        tl.append("t4".into(), "decode".into(), Value::Null);
        assert_eq!(tl.len(), 3);
        assert_eq!(tl.events[0].timestamp, "t2");
        assert_eq!(tl.events[0].event_type, "admit");

        tl.clear();
        assert!(tl.is_empty());
    }

    #[test]
    fn test_timeline_to_json() {
        let mut tl = Timeline::new(10);
        tl.append("ts1".into(), "load".into(), serde_json::json!({"hash": "abc"}));

        let json = tl.to_json();
        assert!(json.is_object());
        let events = json["events"].as_array().unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0]["event_type"], "load");
        assert_eq!(events[0]["data"]["hash"], "abc");
    }

    #[test]
    fn test_timeline_to_json_empty() {
        let tl = Timeline::new(5);
        let json = tl.to_json();
        let events = json["events"].as_array().unwrap();
        assert!(events.is_empty());
    }

    // -- Receipt round-trip: serialize + deserialize --

    #[test]
    fn test_receipt_round_trip_model_load() {
        let r = ReceiptBuilder::model_load()
            .with_image_hash("roundtrip".into())
            .with_worker_pid(1)
            .build();

        let json = serde_json::to_value(&r).unwrap();
        let deserialized: ModelLoadReceipt = serde_json::from_value(json).unwrap();
        assert_eq!(deserialized.image_hash, "roundtrip");
        assert_eq!(deserialized.worker_pid, 1);
    }

    #[test]
    fn test_receipt_round_trip_worker_exit() {
        let r = ReceiptBuilder::worker_exit()
            .with_worker_pid(7)
            .with_signal(Some(9))
            .with_faulted(true)
            .build();

        let json = serde_json::to_value(&r).unwrap();
        let deserialized: WorkerExitReceipt = serde_json::from_value(json).unwrap();
        assert_eq!(deserialized.worker_pid, 7);
        assert_eq!(deserialized.signal, Some(9));
        assert!(deserialized.faulted);
    }
}
