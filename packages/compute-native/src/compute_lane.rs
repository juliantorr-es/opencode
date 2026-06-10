//! Device execution lane — dedicated thread owning one TensorBackend.
//!
//! The lane receives ComputeCommand values from the Tokio control plane
//! through a bounded mpsc channel.  The lane thread owns all backend-native
//! state (tensors, models, sessions, KV caches, trace buffer).  Nothing
//! containing a backend-native handle crosses the thread boundary.

use std::sync::Arc;
use std::thread;
use std::time::Instant;
use tokio::sync::{mpsc, oneshot};

// ── Lane identity ──────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct ComputeLaneId(pub u32);

/// Identifies a resource admission lease.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct ComputeLeaseId(pub u64);

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

/// Cancellation lifecycle receipt — measures latency across all phases.
#[derive(Debug, Clone)]
pub struct CancellationReceipt {
    pub request_id: RequestId,
    pub session_id: SessionId,
    pub received_at: std::time::SystemTime,
    pub lane_accepted_ns: u64,
    pub current_eval_completed_ns: u64,
    pub next_work_suppressed_ns: u64,
    pub session_cancelled_ns: u64,
    pub resources_released_ns: u64,
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

#[derive(Debug, Clone, PartialEq, Eq)]
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
        lease_id: Option<ComputeLeaseId>,
        session_policy: SessionPolicy,
        reply: oneshot::Sender<Result<SessionReceipt, ComputeError>>,
    },
    Prefill {
        request_id: RequestId,
        session_id: SessionId,
        lease_id: Option<ComputeLeaseId>,
        tokens: Arc<[u32]>,
        reply: oneshot::Sender<Result<PrefillReceipt, ComputeError>>,
    },
    Decode {
        request_id: RequestId,
        session_id: SessionId,
        lease_id: Option<ComputeLeaseId>,
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
    /// Query lane lifecycle state.
    Status {
        request_id: RequestId,
        reply: oneshot::Sender<LaneStatus>,
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

// ── Lane lifecycle ────────────────────────────────────────────────────

/// Lifecycle state of the lane thread.
#[derive(Debug, Clone)]
pub enum LaneLifecycle {
    Starting,
    Active,
    Draining,
    Stopped,
    Panicked(String),
}

/// Snapshot of lane state (returned by Status command).
#[derive(Debug, Clone)]
pub struct LaneStatus {
    pub lane_id: ComputeLaneId,
    pub lifecycle: LaneLifecycle,
    pub active_sessions: u32,
    pub active_models: u32,
    pub active_memory_bytes: u64,
    pub command_queue_depth: usize,
}

// ── Resource admission ────────────────────────────────────────────────

/// A resource admission lease issued by the local scheduler.
///
/// The lane may execute only commands backed by a valid, unexpired lease.
/// This prevents silent oversubscription of unified memory.
#[derive(Debug, Clone)]
pub struct ComputeLease {
    pub lease_id: ComputeLeaseId,
    pub lane_id: ComputeLaneId,
    pub model_id: ModelRuntimeId,
    pub session_id: SessionId,
    pub reserved_kv_bytes: u64,
    pub reserved_scratch_bytes: u64,
    pub expires_at: Instant,
}

impl ComputeLease {
    pub fn is_expired(&self) -> bool {
        Instant::now() >= self.expires_at
}
}

// ── Lane runtime (device-lane-owned state) ────────────────────────────

/// The lane thread's owned state.
///
/// Generic over B so a fixture backend can be substituted for tests.
/// Not exposed across the thread boundary — lives entirely on the lane thread.
pub struct ComputeLaneRuntime<B> {
    pub backend: B,
    pub lane_id: ComputeLaneId,
    pub lifecycle: LaneLifecycle,
    pub active_leases: Vec<ComputeLease>,
    pub active_sessions: u32,
    pub active_models: u32,
}

impl<B> ComputeLaneRuntime<B> {
    pub fn new(backend: B, lane_id: ComputeLaneId) -> Self {
        Self {
            backend,
            lane_id,
            lifecycle: LaneLifecycle::Starting,
            active_leases: Vec::new(),
            active_sessions: 0,
            active_models: 0,
}
}

    /// Admit a lease.  Returns `Ok(())` if capacity is available,
    /// `Err` if the lane cannot accept the lease.
    pub fn admit_lease(&mut self, lease: ComputeLease) -> Result<(), ComputeError> {
        if lease.is_expired() {
            return Err(ComputeError {
                kind: ComputeErrorKind::LeaseExpired,
                message: format!("lease {} already expired", lease.lease_id.0),
            });
}
        self.active_leases.retain(|l| !l.is_expired());
        self.active_leases.push(lease);
        Ok(())
}

    /// Release a specific lease.
    pub fn release_lease(&mut self, lease_id: ComputeLeaseId) {
        self.active_leases.retain(|l| l.lease_id != lease_id);
}

    /// Total reserved bytes across all active leases.
    pub fn total_reserved_bytes(&self) -> u64 {
        self.active_leases
            .iter()
            .map(|l| l.reserved_kv_bytes + l.reserved_scratch_bytes)
            .sum()
}
}

// ── Lane lifecycle ────────────────────────────────────────────────────

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
