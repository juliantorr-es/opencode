use crate::compute_image;
use crate::research_metrics::MemorySnapshot;
use crate::research_trace::TraceEvent;
use crate::worker_memory;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Instant;

pub trait ClockSource: Send + Sync {
    fn now_ns(&self) -> u64;
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
}

#[derive(Debug, Default, Clone, Copy)]
pub struct AtomicCounterSource;

static MATERIALIZED_BYTES: AtomicU64 = AtomicU64::new(0);
static FILE_READ_BYTES: AtomicU64 = AtomicU64::new(0);
static KV_BYTES: AtomicU64 = AtomicU64::new(0);
static ORIGIN: std::sync::OnceLock<Instant> = std::sync::OnceLock::new();

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

#[derive(Debug, Default, Clone, Copy)]
pub struct ProcessMemorySource;

impl MemorySource for ProcessMemorySource {
    fn sample(&self) -> MemorySnapshot {
        let counters = DEFAULT_COUNTER_SOURCE.snapshot();
        MemorySnapshot {
            mlx_active: compute_image::mlx_active_memory_bytes(),
            mlx_cache: compute_image::mlx_cache_memory_bytes(),
            rss: worker_memory::sample_process_rss_self(),
            materialized: counters.materialized,
            file_read: counters.file_read,
            kv: counters.kv,
        }
    }
}

#[inline]
fn origin() -> Instant {
    *ORIGIN.get_or_init(Instant::now)
}

pub static DEFAULT_CLOCK_SOURCE: WorkerMonotonicClock = WorkerMonotonicClock;
pub static DEFAULT_COUNTER_SOURCE: AtomicCounterSource = AtomicCounterSource;
pub static DEFAULT_MEMORY_SOURCE: ProcessMemorySource = ProcessMemorySource;
