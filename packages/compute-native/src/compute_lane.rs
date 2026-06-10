//! Device execution lane — dedicated thread owning one TensorBackend.
//!
//! The lane receives ComputeCommand values from the Tokio control plane
//! through a bounded mpsc channel.  The lane thread owns all backend-native
//! state (tensors, models, sessions, KV caches, trace buffer).  Nothing
//! containing a backend-native handle crosses the thread boundary.

use std::sync::Arc;
use std::thread;
use tokio::sync::{mpsc, oneshot};

// ── Lane identity ──────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct ComputeLaneId(pub u32);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct RequestId(pub u64);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct ModelRuntimeId(pub u64);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct SessionId(pub u64);

// ── Identity descriptors (Send) ────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct DeviceIdentity {
    pub lane_id: ComputeLaneId,
    pub backend_name: String,
    pub substrate: String,
}

#[derive(Debug, Clone)]
pub struct ComputeImageDescriptor {
    pub image_path: String,
    pub image_hash: String,
}

#[derive(Debug, Clone)]
pub struct SessionPolicy {
    pub max_kv_tokens: u32,
    pub max_output_tokens: u32,
}

// ── Lifecycle receipts (Send) ──────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct ModelRuntimeReceipt {
    pub model_id: ModelRuntimeId,
    pub lane_id: ComputeLaneId,
    pub layer_count: u32,
    pub active_bytes: u64,
}

#[derive(Debug, Clone)]
pub struct SessionReceipt {
    pub session_id: SessionId,
    pub model_id: ModelRuntimeId,
    pub reserved_kv_bytes: u64,
}

#[derive(Debug, Clone)]
pub struct PrefillReceipt {
    pub session_id: SessionId,
    pub tokens_consumed: u32,
    pub kv_entries_created: u32,
    pub duration_ns: u64,
}

#[derive(Debug, Clone)]
pub struct DecodeEvent {
    pub token: u32,
    pub logprob: Option<f32>,
}

#[derive(Debug, Clone)]
pub struct CloseReceipt {
    pub session_id: SessionId,
    pub total_decode_tokens: u32,
}

#[derive(Debug, Clone)]
pub struct UnloadReceipt {
    pub model_id: ModelRuntimeId,
    pub bytes_released: u64,
}

#[derive(Debug, Clone)]
pub enum CancellationReason {
    Timeout,
    UserRequested,
    ShuttingDown,
    Other(String),
}

#[derive(Debug, Clone)]
pub enum ShutdownReason {
    Graceful,
    Fatal(String),
}

// ── Backend error ──────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct ComputeError {
    pub kind: ComputeErrorKind,
    pub message: String,
}

#[derive(Debug, Clone)]
pub enum ComputeErrorKind {
    BackendError,
    ModelNotFound,
    SessionNotFound,
    OutOfMemory,
    Cancelled,
    LaneFailed,
    LeaseExpired,
    InvalidHandle,
    Internal,
}

// ── Commands ───────────────────────────────────────────────────────────

/// Every command contains only Send data.  TensorHandle / QuantizedWeightHandle
/// are NEVER carried across the channel.
pub enum ComputeCommand {
    LoadModel {
        request_id: RequestId,
        model: ComputeImageDescriptor,
        reply: oneshot::Sender<Result<ModelRuntimeReceipt, ComputeError>>,
    },
    OpenSession {
        request_id: RequestId,
        model_id: ModelRuntimeId,
        session_policy: SessionPolicy,
        reply: oneshot::Sender<Result<SessionReceipt, ComputeError>>,
    },
    Prefill {
        request_id: RequestId,
        session_id: SessionId,
        tokens: Arc<[u32]>,
        reply: oneshot::Sender<Result<PrefillReceipt, ComputeError>>,
    },
    Decode {
        request_id: RequestId,
        session_id: SessionId,
        budget: u32,
        reply: mpsc::Sender<DecodeEvent>,
    },
    Cancel {
        request_id: RequestId,
        session_id: SessionId,
        reason: CancellationReason,
    },
    CloseSession {
        request_id: RequestId,
        session_id: SessionId,
        reply: oneshot::Sender<Result<CloseReceipt, ComputeError>>,
    },
    UnloadModel {
        request_id: RequestId,
        model_id: ModelRuntimeId,
        reply: oneshot::Sender<Result<UnloadReceipt, ComputeError>>,
    },
    Shutdown {
        reason: ShutdownReason,
    },
}

// ── Lane handle (Tokio-facing) ─────────────────────────────────────────

/// A handle to a running compute lane.  Send + Sync, safe to hold from
/// multiple Tokio tasks.  The channel is Send.
pub struct LaneHandle {
    pub lane_id: ComputeLaneId,
    pub device: DeviceIdentity,
    cmd_tx: mpsc::Sender<ComputeCommand>,
}

impl LaneHandle {
    pub fn new(
        lane_id: ComputeLaneId,
        device: DeviceIdentity,
        cmd_tx: mpsc::Sender<ComputeCommand>,
    ) -> Self {
        Self { lane_id, device, cmd_tx }
    }

    pub async fn send(&self, cmd: ComputeCommand) -> Result<(), ComputeError> {
        self.cmd_tx.send(cmd).await.map_err(|_| ComputeError {
            kind: ComputeErrorKind::LaneFailed,
            message: "compute lane has shut down".into(),
        })
    }
}

// ── Lane spawn ─────────────────────────────────────────────────────────

/// Spawn a compute lane on a dedicated OS thread.
///
/// The closure receives a bounded command receiver and runs synchronously
/// on the owning thread.  It is expected to call `recv_blocking` to consume
/// commands until Shutdown.
///
/// Returns a LaneHandle that the Tokio control plane uses to send commands.
pub fn spawn_lane<F>(
    lane_id: ComputeLaneId,
    device: DeviceIdentity,
    queue_capacity: usize,
    runner: F,
) -> LaneHandle
where
    F: FnOnce(mpsc::Receiver<ComputeCommand>) + Send + 'static,
{
    let (tx, rx) = mpsc::channel(queue_capacity);
    let handle = LaneHandle::new(lane_id, device, tx);

    thread::spawn(move || {
        runner(rx);
    });

    handle
}
