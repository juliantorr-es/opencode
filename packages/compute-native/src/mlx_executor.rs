//! Explicit MLX device/stream executor and bounded residency manager.
//!
//! [`MlxExecutor`] owns a concrete [`Device`] and [`Stream`] pair, providing
//! a clear ownership boundary for GPU vs CPU execution contexts without
//! implicit device-global state.
//!
//! [`run_gpu_canary`] is a standalone benchmark that measures the latency
//! difference between a quantized matmul on CPU versus GPU using Gemma-scale
//! projection dimensions (3840).

use mlx_rs::{Array, Device, Stream};
use serde::{Deserialize, Serialize};
use std::time::Instant;

// ── MlxExecutor ────────────────────────────────────────────────────────────

/// Bounded MLX executor holding an explicit device and stream.
///
/// Create via [`spawn_gpu`](MlxExecutor::spawn_gpu) or
/// [`spawn_cpu`](MlxExecutor::spawn_cpu). Designed to be moved to or created
/// on a dedicated thread so that all MLX work issued through this executor
/// sticks to the target device.
pub struct MlxExecutor {
    device: Device,
    stream: Stream,
    kind: &'static str,
}

impl MlxExecutor {
    /// Create a GPU-bound executor on the current thread.
    ///
    /// The caller should ensure this runs on a dedicated GPU thread so that
    /// MLX Metal device affinity is maintained.
    pub fn spawn_gpu() -> Self {
        let device = Device::gpu();
        let stream = Stream::new();
        MlxExecutor {
            device,
            stream,
            kind: "gpu",
        }
    }

    /// Create a CPU-bound executor on the current thread.
    ///
    /// The caller should ensure this runs on a dedicated CPU thread to avoid
    /// accidental Metal device contention.
    pub fn spawn_cpu() -> Self {
        let device = Device::cpu();
        let stream = Stream::new();
        MlxExecutor {
            device,
            stream,
            kind: "cpu",
        }
    }

    /// Returns `"gpu"` or `"cpu"` matching the backing device.
    pub fn device_kind(&self) -> &str {
        self.kind
    }

    /// Returns a human-readable device identifier string.
    pub fn device_str(&self) -> String {
        format!("{:?}", self.device)
    }

    /// Returns a human-readable stream identifier string.
    /// Used in per-layer receipt telemetry to verify the stream is consumed.
    pub fn stream_str(&self) -> String {
        format!("{:?}", self.stream)
    }
}

// ── ExecutionRecord ────────────────────────────────────────────────────────

/// Snapshot of a single execution measurement.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExecutionRecord {
    /// Device target string (`"gpu"` or `"cpu"`).
    pub device: String,
    /// Opaque stream identifier (debug representation).
    pub stream_id: String,
    /// Microseconds spent building the computation graph (ops + shape
    /// inference).
    pub graph_build_us: u64,
    /// Microseconds spent in [`eval`](Array::eval).
    pub eval_us: u64,
    /// Microseconds spent synchronising (device barrier / fence).
    pub sync_us: u64,
    /// Peak Metal / CPU active memory during this execution (bytes).
    pub peak_active_mem: u64,
    /// Peak Metal allocator cache memory during this execution (bytes).
    pub peak_cache_mem: u64,
    /// Optional error message if the execution failed partway.
    pub error: Option<String>,
}

/// Convenience constructor for an [`ExecutionRecord`] when only basic timing
/// is known.
///
/// `label` is recorded as a best-effort annotation only; callers that hold
/// a [`Stream`] reference should also fill in `stream_id` after construction.
pub fn record_execution(
    label: &str,
    device: &str,
    graph_build_us: u64,
    eval_us: u64,
) -> ExecutionRecord {
    ExecutionRecord {
        device: device.to_string(),
        stream_id: label.to_string(),
        graph_build_us,
        eval_us,
        sync_us: 0,
        peak_active_mem: 0,
        peak_cache_mem: 0,
        error: None,
    }
}

// ── Canary benchmark ───────────────────────────────────────────────────────

/// Run one [`quantized_matmul`](mlx_rs::ops::quantized_matmul) on CPU and GPU
/// with Gemma-scale projection dimensions.
///
/// Returns `(cpu_us, gpu_us, speedup_ratio)` where:
/// - `cpu_us` — elapsed wall-clock microseconds on the CPU device.
/// - `gpu_us` — elapsed wall-clock microseconds on the GPU device.
/// - `speedup_ratio` — `cpu_us / gpu_us` (or `inf` when GPU is instantaneous).
///
/// Both runs use freshly-allocated arrays so that cache effects are symmetric.
pub fn run_gpu_canary() -> (u64, u64, f64) {
    // Gemma 4 12B projection dimension: 3840
    let d: i32 = 3840;
    let n: i32 = 3840;
    let packed_dim: i32 = n * 4 / 32; // 480
    let group_size = 256;
    let bits = 4;
    let scale_rows: i32 = (d + group_size - 1) / group_size; // 15

    let x_vals: Vec<f32> = vec![0.5f32; d as usize];
    let w_vals: Vec<u32> = vec![0u32; (d as usize) * (packed_dim as usize)];
    let s_vals: Vec<f32> = vec![1.0f32; (n as usize) * (scale_rows as usize)];
    let b_vals: Vec<f32> = vec![0.0f32; (n as usize) * (scale_rows as usize)];

    let _cpu_device = Device::cpu();
    let _cpu_stream = Stream::new();
    let cpu_start = Instant::now();

    let x = Array::from_slice(&x_vals, &[1, d]);
    let w = Array::from_slice(&w_vals, &[d, packed_dim]);
    let s = Array::from_slice(&s_vals, &[n, scale_rows]);
    let b = Array::from_slice(&b_vals, &[n, scale_rows]);
    let _cpu_result = mlx_rs::ops::quantized_matmul(&x, &w, &s, &b, true, group_size, bits)
        .expect("cpu quantized_matmul");
    x.eval().expect("cpu eval");

    let cpu_us = cpu_start.elapsed().as_micros() as u64;

    // ── GPU run ──────────────────────────────────────────────────────────
    let _gpu_device = Device::gpu();
    let _gpu_stream = Stream::new();
    let gpu_start = Instant::now();

    let x2 = Array::from_slice(&x_vals, &[1, d]);
    let w2 = Array::from_slice(&w_vals, &[d, packed_dim]);
    let s2 = Array::from_slice(&s_vals, &[n, scale_rows]);
    let b2 = Array::from_slice(&b_vals, &[n, scale_rows]);
    let _gpu_result = mlx_rs::ops::quantized_matmul(&x2, &w2, &s2, &b2, true, group_size, bits)
        .expect("gpu quantized_matmul");
    x2.eval().expect("gpu eval");

    let gpu_us = gpu_start.elapsed().as_micros() as u64;

    let ratio = if gpu_us > 0 {
        cpu_us as f64 / gpu_us as f64
    } else {
        f64::INFINITY
    };

    (cpu_us, gpu_us, ratio)
}
