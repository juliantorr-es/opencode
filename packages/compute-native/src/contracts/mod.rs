use crate::compute_image;
use crate::research_metrics::{InstrumentationMode, MemorySnapshot};
use crate::research_trace::{ClockDomain, StageId, SubstrateId, TraceBuffer, TraceEvent};
use parking_lot::Mutex;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Instant;

pub trait ClockSource: Send + Sync {
    fn now_ns(&self) -> u64;

    fn domain(&self) -> ClockDomain {
        ClockDomain::WorkerMonotonic
    }
}

pub trait CounterSource: Send + Sync {
    fn record_materialized(&self, bytes: u64);
    fn record_file_read(&self, bytes: u64);
    fn record_kv(&self, bytes: u64);
    fn snapshot(&self) -> CounterSnapshot;
    fn reset(&self);
}

pub trait MemorySource: Send + Sync {
    fn sample(&self) -> MemorySnapshot;
}

pub trait TraceSink: Send + Sync {
    fn push(&self, event: TraceEvent) -> bool;
    fn drops(&self) -> u64;
    fn overflowed(&self) -> bool;
}

pub trait TraceCollector: Send {
    fn begin_stage(&mut self, stage: StageId, substrate: SubstrateId) -> TraceEvent;
    fn finish_stage(&mut self, event: TraceEvent, snapshot: MemorySnapshot) -> TraceEvent;
    fn record_event(&mut self, event: TraceEvent) -> bool;
    fn flush(&mut self) -> TraceFlushReceipt;
}

pub trait EvidenceRecorder: Send {
    fn record_phase_receipt(&mut self, receipt: PhaseReceipt) -> Result<(), EvidenceError>;
    fn record_fallback_receipt(&mut self, receipt: FallbackReceipt) -> Result<(), EvidenceError>;
    fn record_layout_conversion(
        &mut self,
        receipt: LayoutConversionReceipt,
    ) -> Result<(), EvidenceError>;
    fn record_trace_batch(&mut self, receipt: TraceBatchReceipt) -> Result<(), EvidenceError>;
    fn seal(self: Box<Self>) -> Result<EvidenceBundle, EvidenceError>;
}

pub trait RuntimePolicy: Send + Sync {
    fn choose_backend(
        &self,
        phase: PhaseId,
        candidates: &[BackendCandidate],
        evidence: &EvidenceState,
    ) -> BackendDecision;

    fn allow_fallback(
        &self,
        failed: BackendId,
        fallback: BackendId,
        phase: PhaseId,
        error: &ComputeError,
    ) -> FallbackDecision;

    fn instrumentation_mode(&self, request: &RequestContext) -> InstrumentationMode;
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct CounterSnapshot {
    pub materialized: u64,
    pub file_read: u64,
    pub kv: u64,
}

#[derive(Debug, Clone, Copy, Default)]
pub struct WorkerMonotonicClock;

impl ClockSource for WorkerMonotonicClock {
    fn now_ns(&self) -> u64 {
        let d = Instant::now().duration_since(origin());
        d.as_nanos() as u64
    }

    fn domain(&self) -> ClockDomain {
        ClockDomain::WorkerMonotonic
    }
}

#[derive(Debug, Default, Clone, Copy)]
pub struct AtomicCounterSource;

static MATERIALIZED_BYTES: AtomicU64 = AtomicU64::new(0);
static FILE_READ_BYTES: AtomicU64 = AtomicU64::new(0);
static KV_BYTES: AtomicU64 = AtomicU64::new(0);
static ORIGIN: std::sync::OnceLock<Instant> = std::sync::OnceLock::new();

#[derive(Debug, Default)]
pub struct RunCounterSource {
    materialized_bytes: AtomicU64,
    file_read_bytes: AtomicU64,
    kv_bytes: AtomicU64,
}

impl RunCounterSource {
    pub fn new() -> Self {
        Self::default()
    }
}

impl CounterSource for AtomicCounterSource {
    fn record_materialized(&self, bytes: u64) {
        MATERIALIZED_BYTES.fetch_add(bytes, Ordering::Relaxed);
    }

    fn record_file_read(&self, bytes: u64) {
        FILE_READ_BYTES.fetch_add(bytes, Ordering::Relaxed);
    }

    fn record_kv(&self, bytes: u64) {
        KV_BYTES.fetch_add(bytes, Ordering::Relaxed);
    }

    fn snapshot(&self) -> CounterSnapshot {
        CounterSnapshot {
            materialized: MATERIALIZED_BYTES.load(Ordering::Relaxed),
            file_read: FILE_READ_BYTES.load(Ordering::Relaxed),
            kv: KV_BYTES.load(Ordering::Relaxed),
        }
    }

    fn reset(&self) {
        MATERIALIZED_BYTES.store(0, Ordering::Relaxed);
        FILE_READ_BYTES.store(0, Ordering::Relaxed);
        KV_BYTES.store(0, Ordering::Relaxed);
    }
}

impl CounterSource for RunCounterSource {
    fn record_materialized(&self, bytes: u64) {
        self.materialized_bytes.fetch_add(bytes, Ordering::Relaxed);
    }

    fn record_file_read(&self, bytes: u64) {
        self.file_read_bytes.fetch_add(bytes, Ordering::Relaxed);
    }

    fn record_kv(&self, bytes: u64) {
        self.kv_bytes.fetch_add(bytes, Ordering::Relaxed);
    }

    fn snapshot(&self) -> CounterSnapshot {
        CounterSnapshot {
            materialized: self.materialized_bytes.load(Ordering::Relaxed),
            file_read: self.file_read_bytes.load(Ordering::Relaxed),
            kv: self.kv_bytes.load(Ordering::Relaxed),
        }
    }

    fn reset(&self) {
        self.materialized_bytes.store(0, Ordering::Relaxed);
        self.file_read_bytes.store(0, Ordering::Relaxed);
        self.kv_bytes.store(0, Ordering::Relaxed);
    }
}

#[derive(Debug, Default, Clone, Copy)]
pub struct TraceFlushReceipt {
    pub event_count: u64,
    pub dropped_count: u64,
    pub overflowed: bool,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct PhaseId(pub u16);

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct BackendId(pub u16);

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct RequestContext {
    pub request_id: u64,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct BackendCandidate {
    pub backend_id: BackendId,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct EvidenceState {
    pub complete: bool,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ComputeError;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct EvidenceError;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct BackendDecision {
    pub backend_id: BackendId,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct FallbackDecision {
    pub allow: bool,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct PhaseReceipt {
    pub phase: PhaseId,
    pub backend: BackendId,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct FallbackReceipt {
    pub failed_backend: BackendId,
    pub fallback_backend: BackendId,
    pub phase: PhaseId,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct LayoutConversionReceipt {
    pub phase: PhaseId,
    pub backend: BackendId,
    pub materialized_bytes: u64,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct TraceBatchReceipt {
    pub request_id: u64,
    pub batch_index: u64,
    pub event_count: u64,
    pub dropped_count: u64,
    pub overflowed: bool,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct EvidenceBundle {
    pub phase_receipts: u64,
    pub fallback_receipts: u64,
    pub layout_receipts: u64,
    pub trace_batches: u64,
}

#[derive(Default)]
pub struct RuntimeComposer {
    pub clock: Option<Arc<dyn ClockSource>>,
    pub counter: Option<Arc<dyn CounterSource>>,
    pub memory: Option<Arc<dyn MemorySource>>,
    pub trace_sink: Option<Arc<dyn TraceSink>>,
    pub evidence: Option<Box<dyn EvidenceRecorder>>,
    pub policy: Option<Arc<dyn RuntimePolicy>>,
}

impl RuntimeComposer {
    pub fn validate(&self) -> Result<(), ComposeError> {
        if self.clock.is_none() {
            return Err(ComposeError::MissingClock);
        }
        if self.counter.is_none() {
            return Err(ComposeError::MissingCounter);
        }
        if self.memory.is_none() {
            return Err(ComposeError::MissingMemory);
        }
        if self.trace_sink.is_none() {
            return Err(ComposeError::MissingTraceSink);
        }
        if self.policy.is_none() {
            return Err(ComposeError::MissingPolicy);
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ComposeError {
    MissingClock,
    MissingCounter,
    MissingMemory,
    MissingTraceSink,
    MissingPolicy,
}

fn origin() -> Instant {
    *ORIGIN.get_or_init(Instant::now)
}

#[derive(Debug, Default, Clone, Copy)]
pub struct ProcessMemorySource;

impl MemorySource for ProcessMemorySource {
    fn sample(&self) -> MemorySnapshot {
        sample_process_memory(DEFAULT_COUNTER_SOURCE.snapshot())
    }
}

#[derive(Clone)]
pub struct RunMemorySource {
    counter: Arc<dyn CounterSource>,
}

impl RunMemorySource {
    pub fn new(counter: Arc<dyn CounterSource>) -> Self {
        Self { counter }
    }
}

impl MemorySource for RunMemorySource {
    fn sample(&self) -> MemorySnapshot {
        sample_process_memory(self.counter.snapshot())
    }
}

pub static DEFAULT_CLOCK_SOURCE: WorkerMonotonicClock = WorkerMonotonicClock;
pub static DEFAULT_COUNTER_SOURCE: AtomicCounterSource = AtomicCounterSource;
pub static DEFAULT_MEMORY_SOURCE: ProcessMemorySource = ProcessMemorySource;

#[derive(Clone)]
pub struct RunInstrumentationContext {
    pub clock: Arc<dyn ClockSource>,
    pub counter: Arc<RunCounterSource>,
    pub memory: Arc<RunMemorySource>,
    pub collector: NativeTraceCollector,
    trace_batches: Arc<AtomicU64>,
}

impl RunInstrumentationContext {
    pub fn new(trace_capacity: usize) -> Self {
        let clock: Arc<dyn ClockSource> = Arc::new(WorkerMonotonicClock);
        let counter = Arc::new(RunCounterSource::new());
        let memory = Arc::new(RunMemorySource::new(counter.clone()));
        let collector = NativeTraceCollector::new(trace_capacity, Arc::clone(&clock));
        Self {
            clock,
            counter,
            memory,
            collector,
            trace_batches: Arc::new(AtomicU64::new(0)),
        }
    }

    pub fn counter_snapshot(&self) -> CounterSnapshot {
        self.counter.snapshot()
    }

    pub fn memory_snapshot(&self) -> MemorySnapshot {
        self.memory.sample()
    }

    pub fn reset_counters(&self) {
        self.counter.reset();
    }

    pub fn record_materialized(&self, bytes: u64) {
        self.counter.record_materialized(bytes);
    }

    pub fn record_file_read(&self, bytes: u64) {
        self.counter.record_file_read(bytes);
    }

    pub fn record_kv(&self, bytes: u64) {
        self.counter.record_kv(bytes);
    }

    pub fn record_trace_batch_summary(
        &self,
        materialized_bytes: u64,
        file_read_bytes: u64,
        kv_bytes: u64,
    ) {
        self.counter.record_materialized(materialized_bytes);
        self.counter.record_file_read(file_read_bytes);
        self.counter.record_kv(kv_bytes);
        self.trace_batches.fetch_add(1, Ordering::Relaxed);
    }

    pub fn trace_batch_count(&self) -> u64 {
        self.trace_batches.load(Ordering::Relaxed)
    }

    pub fn reset_trace_batches(&self) {
        self.trace_batches.store(0, Ordering::Relaxed);
    }

    pub fn sink(&self) -> Arc<dyn TraceSink> {
        self.collector.sink()
    }

    pub fn begin_stage(&mut self, stage: StageId, substrate: SubstrateId) -> TraceEvent {
        self.collector.begin_stage(stage, substrate)
    }

    pub fn finish_stage(&mut self, event: TraceEvent, snapshot: MemorySnapshot) -> TraceEvent {
        self.collector.finish_stage(event, snapshot)
    }

    pub fn record_event(&mut self, event: TraceEvent) -> bool {
        self.collector.record_event(event)
    }

    pub fn flush(&mut self) -> TraceFlushReceipt {
        self.collector.flush()
    }
}

fn sample_process_memory(counters: CounterSnapshot) -> MemorySnapshot {
    MemorySnapshot {
        mlx_active: compute_image::mlx_active_memory_bytes(),
        mlx_cache: compute_image::mlx_cache_memory_bytes(),
        rss: crate::worker_memory::sample_process_rss_self(),
        materialized: counters.materialized,
        file_read: counters.file_read,
        kv: counters.kv,
    }
}

#[derive(Clone)]
pub struct NativeTraceCollector {
    state: Arc<Mutex<NativeTraceCollectorState>>,
    clock: Arc<dyn ClockSource>,
}

#[derive(Debug)]
struct NativeTraceCollectorState {
    buffer: TraceBuffer,
    batch_index: u64,
    dropped_count: u64,
}

impl NativeTraceCollector {
    pub fn new(
        capacity: usize,
        clock: Arc<dyn ClockSource>,
    ) -> Self {
        Self {
            state: Arc::new(Mutex::new(NativeTraceCollectorState {
                buffer: TraceBuffer::new(capacity),
                batch_index: 0,
                dropped_count: 0,
            })),
            clock,
        }
    }

    pub fn sink(&self) -> Arc<dyn TraceSink> {
        Arc::new(NativeTraceSink {
            state: Arc::clone(&self.state),
        })
    }

    pub fn batch_index(&self) -> u64 {
        self.state.lock().batch_index
    }
}

impl TraceCollector for NativeTraceCollector {
    fn begin_stage(&mut self, stage: StageId, substrate: SubstrateId) -> TraceEvent {
        let clock = self.clock.as_ref();
        let now_ns = clock.now_ns();
        TraceEvent {
            monotonic_ns: now_ns,
            stage_id: stage as u16,
            substrate_id: substrate as u8,
            clock_domain: clock.domain() as u8,
            layer_index: 0,
            attention_kind: 0,
            status: 0,
            _reserved: [0],
            graph_build_ns: 0,
            eval_ns: 0,
            sync_ns: 0,
            mlx_active_delta: 0,
            mlx_cache_delta: 0,
            rss_delta: 0,
            materialized_bytes: 0,
            file_read_bytes: 0,
            kv_delta: 0,
        }
    }

    fn finish_stage(&mut self, event: TraceEvent, snapshot: MemorySnapshot) -> TraceEvent {
        let now_ns = self.clock.now_ns();
        let elapsed_ns = now_ns.saturating_sub(event.monotonic_ns);
        TraceEvent {
            monotonic_ns: now_ns,
            stage_id: event.stage_id,
            substrate_id: event.substrate_id,
            clock_domain: event.clock_domain,
            layer_index: event.layer_index,
            attention_kind: event.attention_kind,
            status: event.status,
            _reserved: event._reserved,
            graph_build_ns: elapsed_ns.min(u32::MAX as u64) as u32,
            eval_ns: event.eval_ns,
            sync_ns: event.sync_ns,
            mlx_active_delta: snapshot.mlx_active as i32,
            mlx_cache_delta: snapshot.mlx_cache as i32,
            rss_delta: snapshot.rss as i32,
            materialized_bytes: snapshot.materialized.min(u32::MAX as u64) as u32,
            file_read_bytes: snapshot.file_read.min(u32::MAX as u64) as u32,
            kv_delta: snapshot.kv as i32,
        }
    }

    fn record_event(&mut self, event: TraceEvent) -> bool {
        self.state.lock().buffer.push(event)
    }

    fn flush(&mut self) -> TraceFlushReceipt {
        let mut state = self.state.lock();
        let drained = state.buffer.drain();
        let drops = state.buffer.drops();
        let dropped_delta = drops.saturating_sub(state.dropped_count);
        state.dropped_count = drops;
        state.batch_index = state.batch_index.saturating_add(1);
        TraceFlushReceipt {
            event_count: drained.len() as u64,
            dropped_count: dropped_delta,
            overflowed: state.buffer.overflowed(),
        }
    }
}

#[derive(Clone)]
struct NativeTraceSink {
    state: Arc<Mutex<NativeTraceCollectorState>>,
}

impl TraceSink for NativeTraceSink {
    fn push(&self, event: TraceEvent) -> bool {
        self.state.lock().buffer.push(event)
    }

    fn drops(&self) -> u64 {
        self.state.lock().buffer.drops()
    }

    fn overflowed(&self) -> bool {
        self.state.lock().buffer.overflowed()
    }
}

#[derive(Debug, Default, Clone)]
pub struct NativeEvidenceRecorder {
    state: Arc<Mutex<NativeEvidenceRecorderState>>,
}

#[derive(Debug, Default)]
struct NativeEvidenceRecorderState {
    phase_receipts: Vec<PhaseReceipt>,
    fallback_receipts: Vec<FallbackReceipt>,
    layout_conversions: Vec<LayoutConversionReceipt>,
    trace_batches: Vec<TraceBatchReceipt>,
}

impl NativeEvidenceRecorder {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn snapshot(&self) -> EvidenceBundle {
        let state = self.state.lock();
        EvidenceBundle {
            phase_receipts: state.phase_receipts.len() as u64,
            fallback_receipts: state.fallback_receipts.len() as u64,
            layout_receipts: state.layout_conversions.len() as u64,
            trace_batches: state.trace_batches.len() as u64,
        }
    }
}

impl EvidenceRecorder for NativeEvidenceRecorder {
    fn record_phase_receipt(&mut self, receipt: PhaseReceipt) -> Result<(), EvidenceError> {
        self.state.lock().phase_receipts.push(receipt);
        Ok(())
    }

    fn record_fallback_receipt(&mut self, receipt: FallbackReceipt) -> Result<(), EvidenceError> {
        self.state.lock().fallback_receipts.push(receipt);
        Ok(())
    }

    fn record_layout_conversion(
        &mut self,
        receipt: LayoutConversionReceipt,
    ) -> Result<(), EvidenceError> {
        self.state.lock().layout_conversions.push(receipt);
        Ok(())
    }

    fn record_trace_batch(&mut self, receipt: TraceBatchReceipt) -> Result<(), EvidenceError> {
        self.state.lock().trace_batches.push(receipt);
        Ok(())
    }

    fn seal(self: Box<Self>) -> Result<EvidenceBundle, EvidenceError> {
        Ok(self.snapshot())
    }
}

#[derive(Debug, Default, Clone)]
pub struct NativeRuntimePolicy;

impl RuntimePolicy for NativeRuntimePolicy {
    fn choose_backend(
        &self,
        _phase: PhaseId,
        candidates: &[BackendCandidate],
        _evidence: &EvidenceState,
    ) -> BackendDecision {
        candidates
            .first()
            .map(|candidate| BackendDecision {
                backend_id: candidate.backend_id,
            })
            .unwrap_or_default()
    }

    fn allow_fallback(
        &self,
        _failed: BackendId,
        _fallback: BackendId,
        _phase: PhaseId,
        _error: &ComputeError,
    ) -> FallbackDecision {
        FallbackDecision { allow: true }
    }

    fn instrumentation_mode(&self, _request: &RequestContext) -> InstrumentationMode {
        InstrumentationMode::ResearchStandard
    }
}

pub struct NativeRuntime {
    pub composer: RuntimeComposer,
    pub telemetry: RunInstrumentationContext,
    pub collector: NativeTraceCollector,
    pub evidence: NativeEvidenceRecorder,
}

impl NativeRuntime {
    pub fn new(trace_capacity: usize) -> Self {
        let telemetry = RunInstrumentationContext::new(trace_capacity);
        let evidence = NativeEvidenceRecorder::new();

        Self {
            composer: RuntimeComposer {
                clock: Some(telemetry.clock.clone()),
                counter: Some(telemetry.counter.clone()),
                memory: Some(telemetry.memory.clone()),
                trace_sink: Some(telemetry.sink()),
                evidence: Some(Box::new(evidence.clone())),
                policy: Some(Arc::new(NativeRuntimePolicy)),
            },
            telemetry: telemetry.clone(),
            collector: telemetry.collector.clone(),
            evidence,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_fails_when_contracts_are_missing() {
        let composer = RuntimeComposer::default();
        assert_eq!(composer.validate(), Err(ComposeError::MissingClock));
    }

    #[test]
    fn validate_passes_when_contracts_are_present() {
        let runtime = NativeRuntime::new(8);

        assert_eq!(runtime.composer.validate(), Ok(()));
    }

    #[test]
    fn native_trace_collector_flushes_batches() {
        let mut collector = NativeTraceCollector::new(
            4,
            Arc::new(WorkerMonotonicClock),
        );
        let event = collector.begin_stage(StageId::WorkerLaunch, SubstrateId::ControlPlane);
        let snapshot = MemorySnapshot {
            mlx_active: 11,
            mlx_cache: 22,
            rss: 33,
            materialized: 44,
            file_read: 55,
            kv: 66,
        };
        let finished = collector.finish_stage(event, snapshot);

        assert!(collector.record_event(finished));
        let receipt = collector.flush();
        assert_eq!(receipt.event_count, 1);
        assert_eq!(receipt.dropped_count, 0);
        assert!(!receipt.overflowed);
        assert_eq!(collector.batch_index(), 1);
    }

    #[test]
    fn native_evidence_recorder_seals_counts() {
        let mut recorder = NativeEvidenceRecorder::new();
        recorder
            .record_phase_receipt(PhaseReceipt {
                phase: PhaseId(1),
                backend: BackendId(2),
            })
            .unwrap();
        recorder
            .record_fallback_receipt(FallbackReceipt {
                failed_backend: BackendId(3),
                fallback_backend: BackendId(4),
                phase: PhaseId(5),
            })
            .unwrap();
        recorder
            .record_layout_conversion(LayoutConversionReceipt {
                phase: PhaseId(6),
                backend: BackendId(7),
                materialized_bytes: 8,
            })
            .unwrap();
        recorder
            .record_trace_batch(TraceBatchReceipt {
                request_id: 9,
                batch_index: 10,
                event_count: 11,
                dropped_count: 12,
                overflowed: false,
            })
            .unwrap();

        assert_eq!(
            Box::new(recorder).seal().unwrap(),
            EvidenceBundle {
                phase_receipts: 1,
                fallback_receipts: 1,
                layout_receipts: 1,
                trace_batches: 1,
            }
        );
    }

    #[test]
    fn native_runtime_assembles_shared_contracts() {
        let mut runtime = NativeRuntime::new(4);
        let event = TraceEvent {
            monotonic_ns: 1,
            stage_id: StageId::WorkerLaunch as u16,
            substrate_id: SubstrateId::ControlPlane as u8,
            ..unsafe { std::mem::zeroed() }
        };

        assert!(runtime
            .composer
            .trace_sink
            .as_ref()
            .expect("trace sink")
            .push(event));

        runtime.telemetry.record_materialized(64);
        runtime.telemetry.record_file_read(32);
        runtime.telemetry.record_kv(16);
        let snapshot = runtime.telemetry.memory_snapshot();
        assert_eq!(snapshot.materialized, 64);
        assert_eq!(snapshot.file_read, 32);
        assert_eq!(snapshot.kv, 16);
        runtime
            .telemetry
            .record_trace_batch_summary(7, 5, 3);
        assert_eq!(runtime.telemetry.trace_batch_count(), 1);

        runtime
            .composer
            .evidence
            .as_mut()
            .expect("evidence")
            .record_phase_receipt(PhaseReceipt {
                phase: PhaseId(1),
                backend: BackendId(2),
            })
            .unwrap();

        let mut collector = runtime.collector.clone();
        assert_eq!(collector.flush().event_count, 1);
        assert_eq!(
            runtime.evidence.snapshot(),
            EvidenceBundle {
                phase_receipts: 1,
                fallback_receipts: 0,
                layout_receipts: 0,
                trace_batches: 0,
            }
        );
    }

    #[test]
    fn run_instrumentation_context_is_isolated() {
        let a = RunInstrumentationContext::new(2);
        let b = RunInstrumentationContext::new(2);

        a.record_materialized(10);
        a.record_file_read(20);
        a.record_trace_batch_summary(1, 2, 3);
        b.record_materialized(1);
        b.record_kv(3);

        assert_eq!(
            a.counter_snapshot(),
            CounterSnapshot {
                materialized: 11,
                file_read: 22,
                kv: 3,
            }
        );
        assert_eq!(
            b.counter_snapshot(),
            CounterSnapshot {
                materialized: 1,
                file_read: 0,
                kv: 3,
            }
        );
        assert_eq!(a.trace_batch_count(), 1);
        assert_eq!(b.trace_batch_count(), 0);

        let a_snapshot = a.memory_snapshot();
        let b_snapshot = b.memory_snapshot();
        assert!(a_snapshot.materialized >= 10);
        assert!(b_snapshot.materialized >= 1);
    }
}
