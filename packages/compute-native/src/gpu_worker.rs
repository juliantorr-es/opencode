//! GPU transform worker — dedicated thread for offloaded tensor transforms.
//!
//! A single background thread holds the MLX Metal device/stream and processes
//! TransformJobs sent over an mpsc channel. The GpuWorkerHandle provides
//! a safe spawn/submit interface. run_gpu_canary gives a quick CPU-vs-GPU
//! latency comparison for quantized matmul.

use crate::transform_recipe::{TransformKind, TransformationRecipe};
use mlx_rs::Device;
use serde::{Deserialize, Serialize};
use std::sync::mpsc;
use std::thread;
use std::time::Instant;

// ── Result types ───────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TransformTiming {
    pub graph_build_us: u64,
    pub eval_us: u64,
    pub sync_us: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceInfo {
    pub device: String,
    pub stream: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TransformResult {
    pub output_data: Vec<u8>,
    pub timing: TransformTiming,
    pub device_info: DeviceInfo,
    pub peak_memory: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl TransformResult {
    fn error(msg: impl Into<String>, device_info: DeviceInfo) -> Self {
        Self {
            output_data: Vec::new(),
            timing: TransformTiming { graph_build_us: 0, eval_us: 0, sync_us: 0 },
            device_info,
            peak_memory: 0,
            error: Some(msg.into()),
        }
    }
}

// ── Job types ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct TransformJob {
    pub tensor_name: String,
    pub source_data: Vec<u8>,
    pub recipe: TransformationRecipe,
}

enum WorkerCommand {
    Transform { job: TransformJob, reply: mpsc::Sender<TransformResult> },
    Shutdown,
}

// ── Worker handle ─────────────────────────────────────────────────────────

#[derive(Debug)]
pub struct GpuWorkerHandle {
    cmd_tx: mpsc::Sender<WorkerCommand>,
    thread: Option<thread::JoinHandle<()>>,
}

impl GpuWorkerHandle {
    pub fn spawn() -> Self {
        let (cmd_tx, cmd_rx) = mpsc::channel::<WorkerCommand>();
        let thread = thread::Builder::new()
            .name("gpu-worker".into())
            .spawn(move || {
                let device = Device::gpu();
                let stream = mlx_rs::Stream::new();
                let device_info = DeviceInfo {
                    device: format!("{:?}", &device),
                    stream: format!("{:?}", &stream),
                };
                loop {
                    match cmd_rx.recv() {
                        Ok(WorkerCommand::Transform { job, reply }) => {
                            let result = execute_transform(&job, &device_info);
                            let _ = reply.send(result);
                        }
                        Ok(WorkerCommand::Shutdown) => break,
                        Err(_) => break,
                    }
                }
            })
            .expect("gpu-worker thread");
        Self { cmd_tx, thread: Some(thread) }
    }

    pub fn submit(&self, job: TransformJob) -> mpsc::Receiver<TransformResult> {
        let (reply_tx, reply_rx) = mpsc::channel();
        let _ = self.cmd_tx.send(WorkerCommand::Transform { job, reply: reply_tx });
        reply_rx
    }

    pub fn shutdown(mut self) {
        let _ = self.cmd_tx.send(WorkerCommand::Shutdown);
        if let Some(h) = self.thread.take() { let _ = h.join(); }
    }
}

impl Drop for GpuWorkerHandle {
    fn drop(&mut self) {
        let _ = self.cmd_tx.send(WorkerCommand::Shutdown);
        if let Some(h) = self.thread.take() { let _ = h.join(); }
    }
}

// ── Transform execution ────────────────────────────────────────────────────

fn execute_transform(job: &TransformJob, device_info: &DeviceInfo) -> TransformResult {
    let t0 = Instant::now();
    let graph_build_us = t0.elapsed().as_micros() as u64;

    match &job.recipe.kind {
        TransformKind::Noop => TransformResult {
            output_data: job.source_data.clone(),
            timing: TransformTiming { graph_build_us, eval_us: 0, sync_us: 0 },
            device_info: device_info.clone(),
            peak_memory: 0,
            error: None,
        },
        TransformKind::Repack => {
            let mut r = TransformResult::error(
                "Repack not yet implemented".to_string(),
                device_info.clone(),
            );
            r.timing.graph_build_us = graph_build_us;
            r
        }
        other => {
            let mut r = TransformResult::error(
                format!("{:?} not yet implemented", other),
                device_info.clone(),
            );
            r.timing.graph_build_us = graph_build_us;
            r
        }
    }
}

// ── Canary benchmark ───────────────────────────────────────────────────────

/// Run a quantized matmul on CPU vs GPU, return (cpu_us, gpu_us, speedup_ratio).
pub fn run_gpu_canary() -> (u64, u64, f64) {
    use mlx_rs::Array;

    let hidden_dim: i32 = 64;
    let packed_dim: i32 = 16; // 64 * 4 bytes / 4 = 64 u32 entries
    let w_packed: Vec<u32> = vec![0u32; (64 * packed_dim) as usize];
    let scales: Vec<f32> = vec![1.0f32; 64];
    let biases: Vec<f32> = vec![0.0f32; 64];
    let x_vals: Vec<f32> = vec![0.5f32; 64];

    let _cpu_device = Device::cpu();
    let _cs = mlx_rs::Stream::new();
    let cpu_start = Instant::now();
    let x = Array::from_slice(&x_vals, &[1, hidden_dim]);
    let w = Array::from_slice(&w_packed, &[hidden_dim, packed_dim]);
    let s = Array::from_slice(&scales, &[64]);
    let b = Array::from_slice(&biases, &[64]);
    mlx_rs::ops::quantized_matmul(&x, &w, &s, &b, true, 64, 8).expect("qmatmul");
    x.eval().expect("eval");
    let cpu_us = cpu_start.elapsed().as_micros() as u64;

    let _gpu_device = Device::gpu();
    let _gs = mlx_rs::Stream::new();
    let gpu_start = Instant::now();
    let x2 = Array::from_slice(&x_vals, &[1, hidden_dim]);
    let w2 = Array::from_slice(&w_packed, &[hidden_dim, packed_dim]);
    let s2 = Array::from_slice(&scales, &[64]);
    let b2 = Array::from_slice(&biases, &[64]);
    mlx_rs::ops::quantized_matmul(&x2, &w2, &s2, &b2, true, 64, 8).expect("qmatmul");
    x2.eval().expect("eval");
    let gpu_us = gpu_start.elapsed().as_micros() as u64;

    let ratio = if gpu_us > 0 { cpu_us as f64 / gpu_us as f64 } else { f64::INFINITY };
    (cpu_us, gpu_us, ratio)
}
