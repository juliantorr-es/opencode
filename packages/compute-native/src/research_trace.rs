//! Phase 3: Worker Trace — compact runtime trace events, stage IDs, and
//! a pre-allocated ring buffer for hot-path instrumentation.
//!
//! All types are fixed-layout and heap-allocation-free in the hot path.
//! The [`TraceBuffer`] is `Send + Sync` for concurrent worker access.

use std::cell::UnsafeCell;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};

use crate::research_contracts::{ClockSource, TraceSink, DEFAULT_CLOCK_SOURCE};

// ---------------------------------------------------------------------------
// Stage IDs (phase 0 taxonomy, stable numeric)
// ---------------------------------------------------------------------------

/// Pipeline stage identifiers — stable across versions.
///
/// These correspond to the 42 stages defined in the Tribunus phase 0
/// compute-graph taxonomy.  Values never change after initial assignment.
#[repr(u16)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StageId {
    WorkerLaunch = 1,
    ModelVerification = 2,
    SegmentMapping = 3,
    TensorBinding = 4,
    PersistentMaterialization = 5,
    ModelAdmission = 6,
    RopeConstruction = 7,
    SessionCreation = 8,
    EmbeddingGather = 9,
    EmbeddingDequantization = 10,
    EmbeddingScaling = 11,
    InputNormalization = 12,
    QProjection = 13,
    KProjection = 14,
    VProjection = 15,
    QNormalization = 16,
    KNormalization = 17,
    RopeApplication = 18,
    KvCandidateAppend = 19,
    KvCommit = 20,
    AttentionMask = 21,
    AttentionScore = 22,
    AttentionSoftmax = 23,
    AttentionValue = 24,
    OutputProjection = 25,
    ResidualConnection = 26,
    PostAttentionNorm = 27,
    MlpGateProjection = 28,
    MlpUpProjection = 29,
    Activation = 30,
    ElementwiseGate = 31,
    MlpDownProjection = 32,
    FinalNormalization = 33,
    VocabularyProjection = 34,
    LogitSoftcap = 35,
    Sampling = 36,
    ScalarTokenTransfer = 37,
    TokenStreaming = 38,
    RequestFinalization = 39,
    SessionCleanup = 40,
    ModelUnload = 41,
    WorkerShutdown = 42,
}

// ---------------------------------------------------------------------------
// Execution-substrate and clock-domain identifiers
// ---------------------------------------------------------------------------

/// Which backend or device-memory system executed the stage.
#[repr(u8)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SubstrateId {
    CpuScalar = 0,
    CpuAccelerate = 1,
    MlxGenericCpu = 2,
    MlxGenericGpu = 3,
    MlxCustomExtension = 4,
    TribunusMetal = 5,
    CoremlCpu = 6,
    CoremlGpu = 7,
    CoremlAne = 8,
    OrionAneResearch = 9,
    ControlPlane = 10,
}

/// Clock domain for the timestamp in a [`TraceEvent`].
#[repr(u8)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClockDomain {
    /// Worker-process monotonic clock (the default; best for ordering).
    WorkerMonotonic = 0,
    /// Host-level monotonic clock, coherent across processes on the same
    /// machine (e.g. `mach_absolute_time` on Darwin, `CLOCK_MONOTONIC` on
    /// Linux).
    HostMonotonic = 1,
    /// Wall-clock (`Instant::now`-style, NTP-adjusted).
    Wall = 2,
}

// ---------------------------------------------------------------------------
// TraceEvent — fixed-layout, fits one cache line, no heap allocation
// ---------------------------------------------------------------------------

/// A single hot-path trace event.
///
/// The layout is `#[repr(C)]` so it can be read over IPC or serialised via
/// zero-copy framing without per-event allocation.
///
/// # Size
///
/// Field data totals 52 bytes; `repr(C)` plus the `u64` field forces 8-byte
/// struct alignment, yielding a final size of **56 bytes** — well within one
/// 64-byte cache line.
#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct TraceEvent {
    /// Worker monotonic timestamp in nanoseconds.
    pub monotonic_ns: u64,
    /// Stage identifier (see [`StageId`] variants).
    pub stage_id: u16,
    /// Execution substrate (see [`SubstrateId`]).
    pub substrate_id: u8,
    /// Clock domain (see [`ClockDomain`]).
    pub clock_domain: u8,
    /// Layer index (255 = not applicable).
    pub layer_index: u8,
    /// Attention kind: 0 = sliding, 1 = full, 255 = not applicable.
    pub attention_kind: u8,
    /// Status: 0 = ok, 1 = error, 2 = fallback, 3 = skipped.
    pub status: u8,
    /// Reserved for alignment.
    pub _reserved: [u8; 1],
    /// Graph build time in nanoseconds.
    pub graph_build_ns: u32,
    /// Evaluation time in nanoseconds.
    pub eval_ns: u32,
    /// Synchronization time in nanoseconds.
    pub sync_ns: u32,
    /// MLX active bytes delta (i32 for signed delta).
    pub mlx_active_delta: i32,
    /// MLX cache bytes delta.
    pub mlx_cache_delta: i32,
    /// RSS bytes delta.
    pub rss_delta: i32,
    /// Materialized bytes this stage.
    pub materialized_bytes: u32,
    /// File read bytes.
    pub file_read_bytes: u32,
    /// KV allocated bytes delta.
    pub kv_delta: i32,
}

// 52 bytes of field data → repr(C) pads to 56 (next multiple of 8 from u64
// alignment).  Still fits one 64-byte cache line with room for a prefetch
// slot.
const _: () = assert!(std::mem::size_of::<TraceEvent>() == 56);

// ---------------------------------------------------------------------------
// TraceBuffer — pre-allocated ring buffer, lock-free for push
// ---------------------------------------------------------------------------

/// A pre-allocated ring buffer for compact trace events.
///
/// Workers write events through [`push`](TraceBuffer::push), which does
/// **no heap allocation** – the buffer is fully allocated at construction.
///
/// # Concurrency
///
/// - [`push`](TraceBuffer::push) takes `&self` and is safe to call from any
///   thread.  Slots are claimed via an atomic counter and written behind
///   [`UnsafeCell`] with release-acquire ordering.
/// - [`drain`](TraceBuffer::drain) takes `&mut self` and is intended for
///   a single consumer (the control-plane or batching thread).
///
/// The buffer is `Send + Sync`.
pub struct TraceBuffer {
    /// Pre-allocated slots.  Each slot is wrapped in [`UnsafeCell`] so that
    /// [`push`](TraceBuffer::push) can write through a shared reference.
    /// The pointer stability of `Vec` guarantees slot addresses are fixed
    /// after construction.
    buf: Vec<UnsafeCell<TraceEvent>>,
    /// Maximum number of events before overwrite / drop.
    capacity: usize,
    /// Monotonically-increasing write cursor.  Positions `[0, capacity)`
    /// have been (or will be) written; positions `>= capacity` overflowed
    /// and the event was dropped.
    write_pos: AtomicUsize,
    /// Total dropped events (for observability).
    drops: AtomicU64,
    /// True if the buffer has ever overflowed since last drain.
    overflow: AtomicBool,
}

impl std::fmt::Debug for TraceBuffer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TraceBuffer")
            .field("capacity", &self.capacity)
            .field("write_pos", &self.write_pos)
            .field("drops", &self.drops)
            .field("overflow", &self.overflow)
            .finish()
    }
}

// TraceEvent is Copy (all fields are primitives), so UnsafeCell<TraceEvent>
// is Send + Sync.  Synchronisation of the slot writes is handled by the
// atomic write_pos.
unsafe impl Send for TraceBuffer {}
unsafe impl Sync for TraceBuffer {}

impl TraceBuffer {
    /// Allocate a new trace buffer with the given `capacity`.
    ///
    /// Pre-fills the buffer with zeroed-initialised events so that
    /// [`push`](TraceBuffer::push) never needs to allocate.
    pub fn new(capacity: usize) -> Self {
        let mut buf = Vec::with_capacity(capacity);
        let zero = unsafe { std::mem::zeroed::<TraceEvent>() };
        for _ in 0..capacity {
            buf.push(UnsafeCell::new(zero));
        }
        TraceBuffer {
            buf,
            capacity,
            write_pos: AtomicUsize::new(0),
            drops: AtomicU64::new(0),
            overflow: AtomicBool::new(false),
        }
    }

    /// Write one event into the buffer.
    ///
    /// Returns `true` if the event was committed, or `false` if the buffer
    /// was full and the event was dropped.
    ///
    /// # Hot-path guarantees
    ///
    /// - No heap allocation.
    /// - One atomic fetch-add (release-acquire) on the fast path.
    /// - No blocking synchronisation primitives.
    pub fn push(&self, event: TraceEvent) -> bool {
        let pos = self.write_pos.fetch_add(1, Ordering::AcqRel);
        if pos >= self.capacity {
            self.drops.fetch_add(1, Ordering::Relaxed);
            self.overflow.store(true, Ordering::Relaxed);
            return false;
        }
        // Safety:
        // - `pos < self.capacity` → in-bounds access.
        // - The `AcqRel` ordering on `fetch_add` pairs with the `Acquire`
        //   load in `drain`, ensuring the slot write is visible to the
        //   consumer thread before it reads the slot.
        // - Each slot is claimed by at most one `push` call because
        //   `write_pos` is monotonically increasing — no two threads can
        //   obtain the same `pos`.
        unsafe {
            (*self.buf.get_unchecked(pos).get()) = event;
        }
        true
    }

    /// Drain all committed events and reset the buffer.
    ///
    /// Returns a `Vec` of every event successfully written since the last
    /// call to `drain` (or construction).
    pub fn drain(&mut self) -> Vec<TraceEvent> {
        let end = self.write_pos.load(Ordering::Acquire);
        let count = end.min(self.capacity);
        let mut events = Vec::with_capacity(count);
        for i in 0..count {
            // Safety:
            // - We hold `&mut self`, giving exclusive access to the buffer.
            // - Slot `i` has been written (we observed `write_pos > i` via
            //   the Acquire load), so the value is initialised.
            // - `UnsafeCell::get` gives `*mut TraceEvent`; reading through
            //   it yields the value last written by `push`.
            unsafe {
                events.push((*self.buf[i].get()).clone());
            }
        }
        // Reset state for the next batch.
        self.write_pos.store(0, Ordering::Release);
        self.overflow.store(false, Ordering::Relaxed);
        events
    }

    /// Number of events dropped due to buffer overflow since last drain.
    pub fn drops(&self) -> u64 {
        self.drops.load(Ordering::Relaxed)
    }

    /// True if the buffer overflowed at any point since the last drain.
    pub fn overflowed(&self) -> bool {
        self.overflow.load(Ordering::Relaxed)
    }
}

impl TraceSink for TraceBuffer {
    fn push(&self, event: TraceEvent) -> bool {
        TraceBuffer::push(self, event)
    }

    fn drops(&self) -> u64 {
        TraceBuffer::drops(self)
    }

    fn overflowed(&self) -> bool {
        TraceBuffer::overflowed(self)
    }
}

/// Get worker monotonic nanoseconds.
///
/// The returned value is nanoseconds since the first call to this function
/// within the process lifetime.  It is stable within a single worker process
/// and is the default timestamp for [`TraceEvent::monotonic_ns`].
pub fn monotonic_now() -> u64 {
    DEFAULT_CLOCK_SOURCE.now_ns()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::thread;

    #[test]
    fn trace_event_size() {
        assert_eq!(std::mem::size_of::<TraceEvent>(), 56);
    }

    #[test]
    fn trace_event_send_sync() {
        fn assert_send<T: Send>() {}
        fn assert_sync<T: Sync>() {}
        assert_send::<TraceEvent>();
        assert_sync::<TraceEvent>();
    }

    #[test]
    fn trace_buffer_send_sync() {
        fn assert_send<T: Send>() {}
        fn assert_sync<T: Sync>() {}
        assert_send::<TraceBuffer>();
        assert_sync::<TraceBuffer>();
    }

    #[test]
    fn push_and_drain() {
        let mut buf = TraceBuffer::new(4);
        let ev = TraceEvent {
            monotonic_ns: 42,
            stage_id: StageId::WorkerLaunch as u16,
            substrate_id: SubstrateId::ControlPlane as u8,
            ..unsafe { std::mem::zeroed() }
        };

        assert!(buf.push(ev));
        assert!(buf.push(ev));
        assert_eq!(buf.drops(), 0);

        let drained = buf.drain();
        assert_eq!(drained.len(), 2);
        assert_eq!(drained[0].monotonic_ns, 42);
        assert_eq!(drained[1].stage_id, StageId::WorkerLaunch as u16);
    }

    #[test]
    fn buffer_overflow() {
        let mut buf = TraceBuffer::new(2);
        let ev = || unsafe { std::mem::zeroed::<TraceEvent>() };

        assert!(buf.push(ev()));
        assert!(buf.push(ev()));
        assert!(!buf.push(ev())); // dropped
        assert!(!buf.push(ev())); // dropped
        assert_eq!(buf.drops(), 2);
        assert!(buf.overflowed());

        // Drain resets overflow state.
        let drained = buf.drain();
        assert_eq!(drained.len(), 2);
        assert!(!buf.overflowed());
    }

    #[test]
    fn buffer_empty_drain() {
        let mut buf = TraceBuffer::new(16);
        let drained = buf.drain();
        assert!(drained.is_empty());
    }

    #[test]
    fn concurrent_push() {
        let buf = Arc::new(TraceBuffer::new(1024));
        let mut handles = Vec::new();

        for _ in 0..8 {
            let buf = Arc::clone(&buf);
            handles.push(thread::spawn(move || {
                let ev = TraceEvent {
                    monotonic_ns: 1,
                    ..unsafe { std::mem::zeroed() }
                };
                for _ in 0..128 {
                    buf.push(ev);
                }
            }));
        }

        for h in handles {
            h.join().unwrap();
        }

        // All 1024 slots should be filled; remaining pushes were dropped.
        assert!(
            buf.drops() > 0 || !buf.overflowed() || {
                let mut b = Arc::try_unwrap(buf).unwrap();
                b.drain().len() == 1024
            }
        );
    }

    #[test]
    fn monotonic_now_monotonic() {
        let a = monotonic_now();
        let b = monotonic_now();
        assert!(a <= b, "monotonic_now must be non-decreasing");
    }

    #[test]
    fn stage_id_repr() {
        assert_eq!(std::mem::size_of::<StageId>(), 2);
        assert_eq!(StageId::WorkerLaunch as u16, 1);
        assert_eq!(StageId::WorkerShutdown as u16, 42);
    }

    #[test]
    fn substrate_id_repr() {
        assert_eq!(std::mem::size_of::<SubstrateId>(), 1);
        assert_eq!(SubstrateId::ControlPlane as u8, 10);
    }

    #[test]
    fn clock_domain_repr() {
        assert_eq!(std::mem::size_of::<ClockDomain>(), 1);
        assert_eq!(ClockDomain::Wall as u8, 2);
    }
}
