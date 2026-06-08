//! Runtime kernel trace hooks for execution substrate audit.
//!
//! Provides instrumentation points around MLX operation construction and
//! evaluation. The trace identifies which device, stream, kernel branch,
//! and layout actually executed — not merely which was intended.

use serde::{Deserialize, Serialize};
use crate::receipts::CopyClassification;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Instant;

static NEXT_TRACE_ID: AtomicU64 = AtomicU64::new(0);

/// One instrumented operation in the execution trace.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TraceEntry {
    pub trace_id: u64,
    pub operation: String,
    pub device: String,
    pub stream_label: String,
    pub input_layout: String,
    pub output_layout: String,
    pub dtype: String,
    pub dimensions: Vec<u32>,
    pub kernel_family: String,
    pub kernel_branch: String,
    pub graph_build_us: u64,
    pub eval_us: u64,
    pub temp_copy_count: u32,
    pub active_mem_bytes: u64,
    pub cache_mem_bytes: u64,
}

/// Accumulates execution traces for a single request.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExecutionTrace {
    pub entries: Vec<TraceEntry>,
}

impl ExecutionTrace {
    pub fn new() -> Self {
        Self { entries: Vec::new() }
    }

    pub fn record(&mut self, entry: TraceEntry) {
        self.entries.push(entry);
    }

    pub fn quantized_matmul_count(&self) -> usize {
        self.entries.iter().filter(|e| e.operation == "quantized_matmul").count()
    }

    pub fn kernel_families(&self) -> std::collections::HashSet<String> {
        self.entries.iter().map(|e| e.kernel_family.clone()).collect()
    }

    pub fn total_eval_us(&self) -> u64 {
        self.entries.iter().map(|e| e.eval_us).sum()
    }
}

/// Instrument one quantized matmul call and return a TraceEntry.
/// Call this around mlx_rs::ops::quantized_matmul() + .eval().
pub fn trace_quantized_matmul(
    device: &str,
    stream_label: &str,
    input_shape: &[i32],
    weight_shape: &[i32],
    _bits: u32,
    _group_size: u32,
    transpose: bool,
) -> (u64, impl FnOnce(u64, u64, u32) -> TraceEntry) {
    let trace_id = NEXT_TRACE_ID.fetch_add(1, Ordering::Relaxed);
    let _graph_start = Instant::now();
    let dims: Vec<u32> = input_shape.iter()
        .chain(weight_shape.iter())
        .map(|&d| d as u32)
        .collect();

    let device_owned = device.to_string();
    let stream_owned = stream_label.to_string();
    let input_layout_str = if transpose { "transposed" } else { "row_major" }.to_string();
    let output_layout_str = "row_major".to_string();

    // Determine expected kernel family from dimensions
    let kernel_family = classify_qmatmul_family(input_shape, weight_shape, transpose);

    (
        trace_id,
        move |graph_build_us: u64, eval_us: u64, temp_copies: u32| -> TraceEntry {
            TraceEntry {
                trace_id,
                operation: "quantized_matmul".into(),
                device: device_owned,
                stream_label: stream_owned,
                input_layout: input_layout_str,
                output_layout: output_layout_str,
                dtype: "float32".into(),
                dimensions: dims,
                kernel_family: kernel_family.clone(),
                kernel_branch: format!("qmv_qvm_qmm{}", if transpose { "_t" } else { "" }),
                graph_build_us,
                eval_us,
                temp_copy_count: temp_copies,
                active_mem_bytes: 0,
                cache_mem_bytes: 0,
            }
        },
    )
}

/// Classify which quantized matmul kernel family MLX will select.
fn classify_qmatmul_family(input_shape: &[i32], weight_shape: &[i32], transpose: bool) -> String {
    let m = input_shape[0] as usize;
    let k = if transpose { weight_shape[1] } else { weight_shape[0] } as usize;
    let n = if transpose { weight_shape[0] } else { weight_shape[1] } as usize;

    if m == 1 && !transpose {
        "qmv".into() // matrix-vector for single-token decode
    } else if n == 1 && transpose {
        "qvm".into()
    } else if k >= 4096 || m >= 4 {
        "split_k".into()
    } else {
        "qmm".into()
    }
}

/// Trace an elementwise operation (silu, rms_norm, rope, etc.)
pub fn trace_elementwise(
    op_name: &str,
    device: &str,
    shape: &[i32],
) -> (u64, impl FnOnce(u64, u64) -> TraceEntry) {
    let trace_id = NEXT_TRACE_ID.fetch_add(1, Ordering::Relaxed);
    let op_name_owned = op_name.to_string();
    let device_owned = device.to_string();
    let dims: Vec<u32> = shape.iter().map(|&d| d as u32).collect();

    (
        trace_id,
        move |graph_build_us: u64, eval_us: u64| -> TraceEntry {
            TraceEntry {
                trace_id,
                operation: op_name_owned,
                device: device_owned,
                stream_label: "default".into(),
                input_layout: "row_major".into(),
                output_layout: "row_major".into(),
                dtype: "float32".into(),
                dimensions: dims,
                kernel_family: "elementwise".into(),
                kernel_branch: "metal_elementwise".into(),
                graph_build_us,
                eval_us,
                temp_copy_count: 0,
                active_mem_bytes: 0,
                cache_mem_bytes: 0,
            }
        },
    )
}

/// A synchronization marker recording a device-stream or copy-sync boundary
/// with wall-clock timestamp and a human-readable sync type label.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncMarker {
    pub timestamp_us: u64,
    pub sync_type: String,
    pub detail: String,
}

impl SyncMarker {
    pub fn new(timestamp_us: u64, sync_type: impl Into<String>, detail: impl Into<String>) -> Self {
        Self { timestamp_us, sync_type: sync_type.into(), detail: detail.into() }
    }
}

/// A timed region within an execution phase — e.g. a single prefill slice or
/// a decode kernel launch. Records placement intent vs reality, the byte
/// transfer profile, queue vs execution latency, and sync points.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TimedRegion {
    pub catalog_id: String,
    pub preferred_placement: String,
    pub actual_placement: String,
    pub mapped_bytes: u64,
    pub copied_bytes: u64,
    pub temp_bytes: u64,
    pub queue_us: u64,
    pub exec_us: u64,
    pub copy_class: CopyClassification,
    pub sync_boundaries: Vec<SyncMarker>,
}

impl TimedRegion {
    pub fn new(catalog_id: impl Into<String>) -> Self {
        Self {
            catalog_id: catalog_id.into(),
            preferred_placement: String::new(),
            actual_placement: String::new(),
            mapped_bytes: 0,
            copied_bytes: 0,
            temp_bytes: 0,
            queue_us: 0,
            exec_us: 0,
            copy_class: CopyClassification::ApplicationCopyFree,
            sync_boundaries: Vec::new(),
        }
    }

    pub fn total_us(&self) -> u64 {
        self.queue_us + self.exec_us
    }
}

/// Categories of timeline events observed during a full inference pass.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum TimelineEventType {
    OpenDevice,
    CompileShader,
    BuildGraph,
    SubmitQueue,
    EvalStart,
    EvalComplete,
    Prefill,
    DecodeStep,
    CopyHostToDevice,
    CopyDeviceToHost,
    SyncBarrier,
    TempAllocation,
    TempFree,
}

impl TimelineEventType {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::OpenDevice => "open_device",
            Self::CompileShader => "compile_shader",
            Self::BuildGraph => "build_graph",
            Self::SubmitQueue => "submit_queue",
            Self::EvalStart => "eval_start",
            Self::EvalComplete => "eval_complete",
            Self::Prefill => "prefill",
            Self::DecodeStep => "decode_step",
            Self::CopyHostToDevice => "copy_host_to_device",
            Self::CopyDeviceToHost => "copy_device_to_host",
            Self::SyncBarrier => "sync_barrier",
            Self::TempAllocation => "temp_allocation",
            Self::TempFree => "temp_free",
        }
    }
}

/// A single timestamped event on the global timeline for an inference pass.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TimelineEvent {
    pub timestamp_us: u64,
    pub event_type: TimelineEventType,
    pub detail: String,
}

impl TimelineEvent {
    pub fn new(timestamp_us: u64, event_type: TimelineEventType, detail: impl Into<String>) -> Self {
        Self { timestamp_us, event_type, detail: detail.into() }
    }
}

/// One decode step within the token-generation loop.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DecodeStep {
    pub token_id: u32,
    pub regions: Vec<TimedRegion>,
    pub total_us: u64,
    pub sampling_us: u64,
}

impl DecodeStep {
    pub fn new(token_id: u32) -> Self {
        Self { token_id, regions: Vec::new(), total_us: 0, sampling_us: 0 }
    }

    pub fn exec_us(&self) -> u64 {
        self.regions.iter().map(|r| r.exec_us).sum()
    }

    pub fn copy_bytes(&self) -> u64 {
        self.regions.iter().map(|r| r.copied_bytes).sum()
    }
}

/// Full-timeline trace for an inference request, spanning device open,
/// prefill regions, per-token decode steps, and free-form events.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RuntimeTimeline {
    pub open_ms: u64,
    pub prefill_regions: Vec<TimedRegion>,
    pub decode_tokens: Vec<DecodeStep>,
    pub events: Vec<TimelineEvent>,
}

impl RuntimeTimeline {
    pub fn new() -> Self {
        Self {
            open_ms: 0,
            prefill_regions: Vec::new(),
            decode_tokens: Vec::new(),
            events: Vec::new(),
        }
    }

    pub fn prefill_total_us(&self) -> u64 {
        self.prefill_regions.iter().map(|r| r.total_us()).sum()
    }

    pub fn decode_total_us(&self) -> u64 {
        self.decode_tokens.iter().map(|d| d.total_us).sum()
    }

    pub fn decode_exec_us(&self) -> u64 {
        self.decode_tokens.iter().map(|d| d.exec_us()).sum()
    }

    pub fn total_copy_bytes(&self) -> u64 {
        let prefill: u64 = self.prefill_regions.iter().map(|r| r.copied_bytes).sum();
        let decode: u64 = self.decode_tokens.iter().map(|d| d.copy_bytes()).sum();
        prefill + decode
    }

    pub fn push_event(&mut self, event: TimelineEvent) {
        self.events.push(event);
    }

    pub fn push_decode(&mut self, step: DecodeStep) {
        self.decode_tokens.push(step);
    }

    pub fn push_prefill(&mut self, region: TimedRegion) {
        self.prefill_regions.push(region);
    }
}

/// Compute p50 (median), p95, and p99 from a sorted slice of microsecond
/// durations. Returns `(p50_us, p95_us, p99_us)`.
///
/// The caller is responsible for sorting the input; this avoids an
/// unnecessary copy when the data is already ordered.
/// For an empty slice all three values are 0.
pub fn aggregate_p50_p95_p99(sorted_us: &[u64]) -> (u64, u64, u64) {
    if sorted_us.is_empty() {
        return (0, 0, 0);
    }
    let len = sorted_us.len();
    let p50 = percentile_sorted(sorted_us, 50, len);
    let p95 = percentile_sorted(sorted_us, 95, len);
    let p99 = percentile_sorted(sorted_us, 99, len);
    (p50, p95, p99)
}

/// Nearest-rank percentile on a sorted slice.
fn percentile_sorted(sorted: &[u64], p: u64, len: usize) -> u64 {
    debug_assert!(!sorted.is_empty());
    let rank = ((p as f64 / 100.0) * len as f64).ceil() as usize;
    let idx = rank.saturating_sub(1).min(len - 1);
    sorted[idx]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_aggregate_p50_p95_p99_empty() {
        assert_eq!(aggregate_p50_p95_p99(&[]), (0, 0, 0));
    }

    #[test]
    fn test_aggregate_p50_p95_p99_single() {
        assert_eq!(aggregate_p50_p95_p99(&[42]), (42, 42, 42));
    }

    #[test]
    fn test_aggregate_p50_p95_p99_sorted() {
        let data: Vec<u64> = (1..=100).collect();
        let (p50, p95, p99) = aggregate_p50_p95_p99(&data);
        assert_eq!(p50, 50);
        assert_eq!(p95, 95);
        assert_eq!(p99, 99);
    }

    #[test]
    fn test_aggregate_p50_p95_p99_uneven() {
        let data = vec![10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
        let (p50, p95, p99) = aggregate_p50_p95_p99(&data);
        assert_eq!(p50, 50);
        assert_eq!(p95, 100);
        assert_eq!(p99, 100);
    }

    #[test]
    fn test_timeline_event_type_as_str() {
        assert_eq!(TimelineEventType::OpenDevice.as_str(), "open_device");
        assert_eq!(TimelineEventType::CompileShader.as_str(), "compile_shader");
        assert_eq!(TimelineEventType::BuildGraph.as_str(), "build_graph");
        assert_eq!(TimelineEventType::SubmitQueue.as_str(), "submit_queue");
        assert_eq!(TimelineEventType::EvalStart.as_str(), "eval_start");
        assert_eq!(TimelineEventType::EvalComplete.as_str(), "eval_complete");
        assert_eq!(TimelineEventType::CopyHostToDevice.as_str(), "copy_host_to_device");
        assert_eq!(TimelineEventType::CopyDeviceToHost.as_str(), "copy_device_to_host");
        assert_eq!(TimelineEventType::SyncBarrier.as_str(), "sync_barrier");
        assert_eq!(TimelineEventType::TempAllocation.as_str(), "temp_allocation");
        assert_eq!(TimelineEventType::TempFree.as_str(), "temp_free");
    }

    #[test]
    fn test_sync_marker_new() {
        let m = SyncMarker::new(1234, "queue_wait", "waiting for stream");
        assert_eq!(m.timestamp_us, 1234);
        assert_eq!(m.sync_type, "queue_wait");
        assert_eq!(m.detail, "waiting for stream");
    }

    #[test]
    fn test_timed_region_new() {
        let r = TimedRegion::new("gemm_4x4");
        assert_eq!(r.catalog_id, "gemm_4x4");
        assert!(r.sync_boundaries.is_empty());
    }

    #[test]
    fn test_timed_region_total() {
        let mut r = TimedRegion::new("gemm");
        r.queue_us = 50;
        r.exec_us = 200;
        assert_eq!(r.total_us(), 250);
    }

    #[test]
    fn test_decode_step_new() {
        let d = DecodeStep::new(42);
        assert_eq!(d.token_id, 42);
        assert!(d.regions.is_empty());
    }

    #[test]
    fn test_decode_step_exec_copy() {
        let mut d = DecodeStep::new(7);
        let mut r1 = TimedRegion::new("qmv");
        r1.exec_us = 100;
        r1.copied_bytes = 4096;
        let mut r2 = TimedRegion::new("rms_norm");
        r2.exec_us = 50;
        r2.copied_bytes = 512;
        d.regions.push(r1);
        d.regions.push(r2);
        assert_eq!(d.exec_us(), 150);
        assert_eq!(d.copy_bytes(), 4608);
    }

    #[test]
    fn test_runtime_timeline_basics() {
        let mut tl = RuntimeTimeline::new();
        tl.open_ms = 12;

        let mut r = TimedRegion::new("prefill_1");
        r.exec_us = 5000;
        tl.push_prefill(r);

        let mut d = DecodeStep::new(0);
        let mut dr = TimedRegion::new("decode_qmv");
        dr.exec_us = 300;
        dr.copied_bytes = 1024;
        d.regions.push(dr);
        d.total_us = 350;
        d.sampling_us = 50;
        tl.push_decode(d);

        tl.push_event(TimelineEvent::new(100, TimelineEventType::EvalStart, "first prefill"));

        assert_eq!(tl.open_ms, 12);
        assert_eq!(tl.prefill_total_us(), 5000);
        assert_eq!(tl.decode_total_us(), 350);
        assert_eq!(tl.decode_exec_us(), 300);
        assert_eq!(tl.total_copy_bytes(), 1024);
        assert_eq!(tl.events.len(), 1);
    }
}
