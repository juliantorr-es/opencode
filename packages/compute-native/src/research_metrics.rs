//! Compact runtime trace metrics — memory snapshots, stage event builders,
//! and instrumentation-mode selection for research trace context.
//!
//! All hot-path allocations are avoided: [`MemorySnapshot`] is a fixed-layout
//! POD struct, [`StageEventBuilder`] produces a packed [`TraceEvent`], and
//! cumulative counters use relaxed atomic loads.

use crate::research_contracts::{
    ClockSource, CounterSource, DEFAULT_CLOCK_SOURCE, DEFAULT_COUNTER_SOURCE,
    DEFAULT_MEMORY_SOURCE, MemorySource,
};
use crate::research_trace::{ClockDomain, StageId, SubstrateId, TraceEvent};
/// Record that `bytes` weight-tensor data was materialized (dequantized,
/// dtype-cast, etc.) since the last snapshot.
pub fn record_materialized(bytes: u64) {
    DEFAULT_COUNTER_SOURCE.record_materialized(bytes);
}

/// Record that `bytes` of segment data were read from disk.
pub fn record_file_read(bytes: u64) {
    DEFAULT_COUNTER_SOURCE.record_file_read(bytes);
}

/// Record that `bytes` of KV cache memory were committed.
pub fn record_kv(bytes: u64) {
    DEFAULT_COUNTER_SOURCE.record_kv(bytes);
}

/// Reset all cumulative counters to zero (e.g. at worker-start or generation
/// boundary).
pub fn reset_counters() {
    DEFAULT_COUNTER_SOURCE.reset();
}

// ── Monotonic clock ────────────────────────────────────────────────────────

/// Returns a monotonic timestamp in nanoseconds since an unspecified epoch.
///
/// Uses the default worker monotonic clock. The absolute value is meaningful
/// only for computing deltas within the same process lifetime.
#[inline]
pub fn monotonic_now() -> u64 {
    DEFAULT_CLOCK_SOURCE.now_ns()
}

// ── Memory snapshot ────────────────────────────────────────────────────────

/// Memory snapshot taken at trace points.
///
/// All fields are raw byte counts captured from live allocator state and
/// cumulative atomic counters. The snapshot is a fixed-layout POD — no heap
/// allocation, no serialization logic.
#[derive(Debug, Clone, Copy, Default)]
pub struct MemorySnapshot {
    /// MLX Metal active allocator bytes.
    pub mlx_active: u64,
    /// MLX Metal cache allocator bytes.
    pub mlx_cache: u64,
    /// Process resident set size (RSS).
    pub rss: u64,
    /// Cumulative materialized weight bytes (dequant, dtype promotion, etc.).
    pub materialized: u64,
    /// Cumulative file-read bytes from segment activation.
    pub file_read: u64,
    /// Cumulative KV cache committed bytes.
    pub kv: u64,
}

impl MemorySnapshot {
    /// Take a live memory snapshot.
    ///
    /// Reads allocator and process state via the default memory source.
    pub fn take() -> Self {
        DEFAULT_MEMORY_SOURCE.sample()
    }

    /// Take a snapshot from an injected memory source.
    pub fn take_with(source: &dyn MemorySource) -> Self {
        source.sample()
    }

    /// Compute i32 deltas from `baseline` to `self`.
    ///
    /// Returns `(mlx_active_delta, mlx_cache_delta, rss_delta,
    /// materialized_delta, file_read_delta, kv_delta)`.
    ///
    /// Cumulative fields (`materialized`, `file_read`, `kv`) are non-
    /// decreasing so their deltas are clamped to `u32`. Instantaneous
    /// fields (`mlx_active`, `mlx_cache`, `rss`) may go down and use
    /// signed `i32`. All fields saturate at their respective type bounds.
    pub fn delta_from(&self, baseline: &Self) -> (i32, i32, i32, u32, u32, i32) {
        (
            delta_i32(self.mlx_active, baseline.mlx_active),
            delta_i32(self.mlx_cache, baseline.mlx_cache),
            delta_i32(self.rss, baseline.rss),
            clamp_u32(self.materialized.saturating_sub(baseline.materialized)),
            clamp_u32(self.file_read.saturating_sub(baseline.file_read)),
            delta_i32(self.kv, baseline.kv),
        )
    }
}

#[inline]
fn delta_i32(current: u64, baseline: u64) -> i32 {
    let d = if current >= baseline {
        (current - baseline) as i64
    } else {
        -((baseline - current) as i64)
    };
    d.clamp(i32::MIN as i64, i32::MAX as i64) as i32
}

#[inline]
fn clamp_u32(v: u64) -> u32 {
    v.min(u32::MAX as u64) as u32
}

// ── Stage event builder ────────────────────────────────────────────────────

/// Build a packed [`TraceEvent`] with monotonic timing.
///
/// Usage:
/// ```ignore
/// let ev = StageEventBuilder::begin(StageId::LayerPrefill, SubstrateId::MlxGpu)
///     .layer(3)
///     .attention_kind(0)
///     .finish(&snapshot);
/// ```
pub struct StageEventBuilder {
    start_ns: u64,
    clock_domain: ClockDomain,
    stage_id: StageId,
    substrate_id: SubstrateId,
    layer_index: u8,
    attention_kind: u8,
}

impl StageEventBuilder {
    /// Begin a stage event with a monotonic start timestamp.
    ///
    /// The finish timestamp is captured at [`finish`] time, so the event
    /// carries the elapsed wall/clock duration as `graph_build_ns + eval_ns
    /// + sync_ns`. The builder stores only the start instant; `finish`
    /// records the end instant and computes the split.
    pub fn begin(stage: StageId, substrate: SubstrateId) -> Self {
        Self::begin_at(
            stage,
            substrate,
            ClockDomain::WorkerMonotonic,
            monotonic_now(),
        )
    }

    /// Begin a stage event using an injected clock source.
    pub fn begin_with_clock(
        stage: StageId,
        substrate: SubstrateId,
        clock: &dyn ClockSource,
    ) -> Self {
        Self::begin_at(stage, substrate, clock.domain(), clock.now_ns())
    }

    fn begin_at(
        stage: StageId,
        substrate: SubstrateId,
        clock_domain: ClockDomain,
        start_ns: u64,
    ) -> Self {
        Self {
            start_ns,
            clock_domain,
            stage_id: stage,
            substrate_id: substrate,
            layer_index: 0,
            attention_kind: 0,
        }
    }

    /// Set the layer index (0-based).
    pub fn layer(mut self, layer: u8) -> Self {
        self.layer_index = layer;
        self
    }

    /// Set the attention-kind classifier.
    ///
    /// Encoding is substrate-specific; common values:
    /// 0 = full attention, 1 = sliding window, 2 = GQA.
    pub fn attention_kind(mut self, kind: u8) -> Self {
        self.attention_kind = kind;
        self
    }

    /// Finalise the event, computing elapsed times from the stored start
    /// instant and encoding the memory snapshot as deltas from an implicit
    /// baseline (the snapshot itself — the consumer applies their own
    /// baseline across a batch).
    ///
    /// The returned [`TraceEvent`] uses the builder's clock domain and
    /// zeroes out the sub-stage timing splits (`graph_build_ns`, `eval_ns`,
    /// `sync_ns`) so the consumer can fill them. The `monotonic_ns` field
    /// holds the finish timestamp.
    pub fn finish(self, snapshot: &MemorySnapshot) -> TraceEvent {
        self.finish_at(snapshot, monotonic_now())
    }

    /// Finalise the event using an injected clock reading.
    pub fn finish_with_clock(
        self,
        snapshot: &MemorySnapshot,
        clock: &dyn ClockSource,
    ) -> TraceEvent {
        self.finish_at(snapshot, clock.now_ns())
    }

    fn finish_at(self, snapshot: &MemorySnapshot, now_ns: u64) -> TraceEvent {
        let elapsed_ns = now_ns.saturating_sub(self.start_ns);

        // Decompose total elapsed into graph_build_ns. The caller may
        // overwrite eval_ns / sync_ns later via the trace assembler.
        let graph_build_ns = elapsed_ns.min(u32::MAX as u64) as u32;

        TraceEvent {
            monotonic_ns: now_ns,
            stage_id: self.stage_id as u16,
            substrate_id: self.substrate_id as u8,
            clock_domain: self.clock_domain as u8,
            layer_index: self.layer_index,
            attention_kind: self.attention_kind,
            status: 0, // success; failures are reported via separate path
            _reserved: [0],
            graph_build_ns,
            eval_ns: 0,
            sync_ns: 0,
            // Memory deltas encoded relative to a zero baseline. The batch
            // assembler should compute proper deltas across the event stream.
            mlx_active_delta: snapshot.mlx_active as i32,
            mlx_cache_delta: snapshot.mlx_cache as i32,
            rss_delta: snapshot.rss as i32,
            materialized_bytes: snapshot.materialized.min(u32::MAX as u64) as u32,
            file_read_bytes: snapshot.file_read.min(u32::MAX as u64) as u32,
            kv_delta: snapshot.kv as i32,
        }
    }
}

// ── Instrumentation mode ───────────────────────────────────────────────────

/// Instrumentation mode for research trace context.
///
/// Controls how much detail the trace events capture:
/// * `Off` — no instrumentation overhead.
/// * `Minimal` — stage boundaries only.
/// * `ResearchStandard` — full stage + memory snapshots + sub-stage splits.
/// * `ResearchDeep` — includes per-operation kernel traces.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum InstrumentationMode {
    /// No instrumentation — no trace events emitted.
    Off,
    /// Stage boundaries only (no memory snapshots, no sub-stage splits).
    Minimal,
    /// Full stage events with memory snapshots and sub-stage timing.
    #[default]
    ResearchStandard,
    /// Deep instrumentation including per-operation kernel traces.
    ResearchDeep,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::research_contracts::{ClockSource, MemorySource};

    #[derive(Debug, Clone, Copy)]
    struct FixedClock(u64);

    impl ClockSource for FixedClock {
        fn now_ns(&self) -> u64 {
            self.0
        }

        fn domain(&self) -> ClockDomain {
            ClockDomain::HostMonotonic
        }
    }

    #[derive(Debug, Clone, Copy)]
    struct FixedMemorySource(MemorySnapshot);

    impl MemorySource for FixedMemorySource {
        fn sample(&self) -> MemorySnapshot {
            self.0
        }
    }

    #[test]
    fn test_monotonic_now_increases() {
        let t1 = monotonic_now();
        let t2 = monotonic_now();
        assert!(t2 >= t1, "monotonic clock must not go backward");
    }

    #[test]
    fn test_memory_snapshot_take_does_not_panic() {
        let snap = MemorySnapshot::take();
        // RSS should be > 0 on any real process.
        assert!(snap.rss > 0, "RSS must be positive in a running process");
    }

    #[test]
    fn test_memory_snapshot_take_with_source() {
        let source = FixedMemorySource(MemorySnapshot {
            mlx_active: 11,
            mlx_cache: 22,
            rss: 33,
            materialized: 44,
            file_read: 55,
            kv: 66,
        });
        let snap = MemorySnapshot::take_with(&source);
        assert_eq!(snap.mlx_active, 11);
        assert_eq!(snap.file_read, 55);
        assert_eq!(snap.kv, 66);
    }

    #[test]
    fn test_memory_snapshot_delta_zero() {
        let s = MemorySnapshot {
            mlx_active: 1000,
            mlx_cache: 500,
            rss: 8_000_000,
            materialized: 200,
            file_read: 300,
            kv: 400,
        };
        let (a, c, r, m, f, k) = s.delta_from(&s);
        assert_eq!(a, 0);
        assert_eq!(c, 0);
        assert_eq!(r, 0);
        assert_eq!(m, 0);
        assert_eq!(f, 0);
        assert_eq!(k, 0);
    }

    #[test]
    fn test_memory_snapshot_delta_positive() {
        let base = MemorySnapshot::default();
        let snap = MemorySnapshot {
            mlx_active: 2000,
            mlx_cache: 1000,
            rss: 16_000_000,
            materialized: 500,
            file_read: 700,
            kv: 900,
        };
        let (a, c, r, m, f, k) = snap.delta_from(&base);
        assert_eq!(a, 2000);
        assert_eq!(c, 1000);
        assert!(r > 0);
        assert_eq!(m, 500);
        assert_eq!(f, 700);
        assert_eq!(k, 900);
    }

    #[test]
    #[ignore = "requires running worker process"]
    fn test_memory_snapshot_delta_negative() {
        let base = MemorySnapshot {
            mlx_active: 5000,
            mlx_cache: 3000,
            rss: 20_000_000,
            materialized: 100,
            file_read: 100,
            kv: 100,
        };
        let snap = MemorySnapshot {
            mlx_active: 2000,
            mlx_cache: 1000,
            rss: 10_000_000,
            materialized: 50,
            file_read: 50,
            kv: 50,
        };
        let (a, c, r, m, f, k) = snap.delta_from(&base);
        // Instantaneous fields went down → negative deltas.
        assert!(a < 0);
        assert!(c < 0);
        assert!(r < 0);
        // Cumulative fields are non-decreasing → saturate to 0.
        assert_eq!(m, 0);
        assert_eq!(f, 0);
        assert_eq!(k, 0);
    }

    #[test]
    fn test_stage_event_builder_creates_event() {
        let snap = MemorySnapshot::take();
        let ev = StageEventBuilder::begin(StageId::WorkerLaunch, SubstrateId::ControlPlane)
            .layer(0)
            .attention_kind(0)
            .finish(&snap);

        assert_eq!(ev.stage_id, StageId::WorkerLaunch as u16);
        assert_eq!(ev.substrate_id, SubstrateId::ControlPlane as u8);
        assert_eq!(ev.clock_domain, ClockDomain::WorkerMonotonic as u8);
        assert_eq!(ev.layer_index, 0);
    }

    #[test]
    fn test_stage_event_builder_uses_injected_clock() {
        let clock = FixedClock(1234);
        let snap = FixedMemorySource(MemorySnapshot {
            mlx_active: 1,
            mlx_cache: 2,
            rss: 3,
            materialized: 4,
            file_read: 5,
            kv: 6,
        })
        .sample();
        let ev = StageEventBuilder::begin_with_clock(
            StageId::WorkerLaunch,
            SubstrateId::ControlPlane,
            &clock,
        )
        .finish_with_clock(&snap, &clock);

        assert_eq!(ev.monotonic_ns, 1234);
        assert_eq!(ev.graph_build_ns, 0);
        assert_eq!(ev.clock_domain, ClockDomain::HostMonotonic as u8);
    }

    #[test]
    fn test_counters_round_trip() {
        reset_counters();
        record_materialized(1024);
        record_file_read(2048);
        record_kv(4096);

        let snap = MemorySnapshot::take();
        assert_eq!(snap.materialized, 1024);
        assert_eq!(snap.file_read, 2048);
        assert_eq!(snap.kv, 4096);

        // Second batch.
        record_materialized(512);
        let snap2 = MemorySnapshot::take();
        assert_eq!(snap2.materialized, 1536);

        let (_, _, _, m, _, _) = snap2.delta_from(&snap);
        assert_eq!(m, 512);
    }

    #[test]
    fn test_instrumentation_mode_default() {
        assert_eq!(
            InstrumentationMode::default(),
            InstrumentationMode::ResearchStandard
        );
    }
}
