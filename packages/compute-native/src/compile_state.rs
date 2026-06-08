//! CompileState — resumable compile state for long-running compilation pipelines.
//!
//! Writes and reads a `compile.state.json` file in the output directory so that
//! interrupted or multi-stage compilations can be resumed from their last known
//! point without redoing completed work.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

// ── Scheduler Configuration ────────────────────────────────────────────────

/// Scheduler admission and concurrency configuration.
///
/// Controls how many compilation sessions run concurrently,
/// how many requests can wait in the admission queue, and per-worker-type
/// queue depths for backpressure.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SchedulerConfig {
    /// Hard limit on concurrent compilation sessions.
    pub max_concurrent_sessions: u32,
    /// Maximum backlog of queued admission requests.
    pub admission_queue_capacity: u32,
    /// Per-worker queue capacities keyed by worker kind (e.g. "mlx", "coreml").
    pub worker_queue_capacities: HashMap<String, u32>,
}

/// Scheduling policy that tunes `SchedulerConfig` knobs toward a latency,
/// throughput, or balanced goal.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum SchedulerPolicy {
    /// Minimise per-session latency; low concurrency, small queues.
    LatencyFirst,
    /// Maximise aggregate throughput; high concurrency, deep queues.
    ThroughputFirst,
    /// Moderate concurrency and queue depths.
    Balanced,
    /// Batch-optimised; very deep queues, maximum concurrency.
    Bulk,
}

/// Default scheduler config tuned for low-latency interactive use
/// on an Apple M1-class device (8 CPU cores, unified memory).
///
/// - Only 2 concurrent sessions to avoid CPU contention.
/// - Tight admission queue (16 slots) for early backpressure.
/// - Shallow per-worker queues (4–8) so sessions don't pile up.
pub fn default_m1_latency_config() -> SchedulerConfig {
    let mut caps = HashMap::new();
    caps.insert("mlx".to_string(), 4);
    caps.insert("coreml".to_string(), 4);
    caps.insert("compile".to_string(), 8);
    SchedulerConfig {
        max_concurrent_sessions: 2,
        admission_queue_capacity: 16,
        worker_queue_capacities: caps,
    }
}

/// Default scheduler config tuned for maximum batch throughput
/// on an Apple M1-class device (8 CPU cores, unified memory).
///
/// - Up to 8 concurrent sessions (matching efficiency core count).
/// - Deep admission queue (128 slots) to absorb bursty submissions.
/// - Generous per-worker queues (16–32) to hide worker latency.
pub fn default_m1_throughput_config() -> SchedulerConfig {
    let mut caps = HashMap::new();
    caps.insert("mlx".to_string(), 16);
    caps.insert("coreml".to_string(), 16);
    caps.insert("compile".to_string(), 32);
    SchedulerConfig {
        max_concurrent_sessions: 8,
        admission_queue_capacity: 128,
        worker_queue_capacities: caps,
    }
}

/// Mutate `config` to match the chosen scheduling policy.
///
/// | Policy           | Sessions | Admission | Worker queues |
/// |------------------|----------|-----------|---------------|
/// | LatencyFirst     |    2     |    16     | shallow (4-8) |
/// | ThroughputFirst  |    8     |   128     | deep (16-32)  |
/// | Balanced         |    4     |    64     | moderate (8-16)|
/// | Bulk             |   16     |   512     | very deep (32-64)|
pub fn apply_policy(policy: &SchedulerPolicy, config: &mut SchedulerConfig) {
    match policy {
        SchedulerPolicy::LatencyFirst => {
            config.max_concurrent_sessions = 2;
            config.admission_queue_capacity = 16;
            config.worker_queue_capacities.insert("mlx".to_string(), 4);
            config.worker_queue_capacities.insert("coreml".to_string(), 4);
            config.worker_queue_capacities.insert("compile".to_string(), 8);
        }
        SchedulerPolicy::ThroughputFirst => {
            config.max_concurrent_sessions = 8;
            config.admission_queue_capacity = 128;
            config.worker_queue_capacities.insert("mlx".to_string(), 16);
            config.worker_queue_capacities.insert("coreml".to_string(), 16);
            config.worker_queue_capacities.insert("compile".to_string(), 32);
        }
        SchedulerPolicy::Balanced => {
            config.max_concurrent_sessions = 4;
            config.admission_queue_capacity = 64;
            config.worker_queue_capacities.insert("mlx".to_string(), 8);
            config.worker_queue_capacities.insert("coreml".to_string(), 8);
            config.worker_queue_capacities.insert("compile".to_string(), 16);
        }
        SchedulerPolicy::Bulk => {
            config.max_concurrent_sessions = 16;
            config.admission_queue_capacity = 512;
            config.worker_queue_capacities.insert("mlx".to_string(), 32);
            config.worker_queue_capacities.insert("coreml".to_string(), 32);
            config.worker_queue_capacities.insert("compile".to_string(), 64);
        }
    }
}

/// Current checkpoint of a multi-stage compilation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompileState {
    pub compiler_version: String,
    pub source_root_hash: String,
    pub target_profile_hash: String,
    pub planned_segments: Vec<SegmentCompletion>,
    pub stage: CompileStage,
}

/// Progress for a single output segment.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SegmentCompletion {
    pub segment_id: String,
    pub filename: String,
    pub total_ranges: u64,
    pub completed_ranges: Vec<(u64, u64)>, // (start, end) byte ranges
    pub hash_state: Option<String>,         // hex of current hash
}

/// Lifecycle phase of a compilation run.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum CompileStage {
    Planning,
    Emitting,
    Verifying,
    Complete,
    Cancelled,
    Failed { reason: String },
}

impl CompileState {
    /// Serialize self to `compile.state.json` inside `output_dir`.
    pub fn write(&self, output_dir: &std::path::Path) -> napi::Result<()> {
        let path = output_dir.join("compile.state.json");
        let json = serde_json::to_string_pretty(self)
            .map_err(|e| napi::Error::from_reason(format!("json: {}", e)))?;
        std::fs::write(&path, json)
            .map_err(|e| napi::Error::from_reason(format!("write state: {}", e)))?;
        Ok(())
    }

    /// Deserialize from `compile.state.json` inside `output_dir`.
    pub fn read(output_dir: &std::path::Path) -> napi::Result<Self> {
        let path = output_dir.join("compile.state.json");
        let json = std::fs::read_to_string(&path)
            .map_err(|e| napi::Error::from_reason(format!("read state: {}", e)))?;
        serde_json::from_str(&json)
            .map_err(|e| napi::Error::from_reason(format!("parse state: {}", e)))
    }
}
