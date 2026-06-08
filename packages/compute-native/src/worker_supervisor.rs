//! Host-side worker supervisor — process lifecycle, framed IPC, event dispatch,
//! heartbeat tracking, deadline enforcement, RSS monitoring, cancellation
//! escalation, exit classification, and restart policy.
//!
//! Pure Rust, no napi or mlx-rs imports. Communicates with the worker over a
//! framed length-prefixed JSON protocol defined in [`worker_protocol`].

use crate::engine_error::{EngineError, EngineErrorCode};
use crate::engine_policy::{DeadlineGuard, ExecutionPolicy};
use crate::streaming::{GenerationEvent, GenerationSender, GenerationStream};
use crate::worker_protocol::{
    Frame, HeartbeatPayload, HostCommand, MessageKind, StartGenerationPayload,
    TokenPayload, WorkerEvent, MAX_FRAME_SIZE_BYTES,
};
use parking_lot::Mutex;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, BufWriter, Read, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};
use uuid::Uuid;

// ── Constants ──────────────────────────────────────────────────────────────

/// Size of the generation event channel buffer.
const GENERATION_CHANNEL_CAPACITY: usize = 256;

// ── ActiveRequest ──────────────────────────────────────────────────────────

/// An in-flight generation request tracked by the supervisor.
pub struct ActiveRequest {
    /// Opaque request identifier echoed in all protocol frames.
    pub request_id: String,
    /// Public job ID (UUID) surfaced to the consumer.
    pub public_job_id: String,
    /// Sender half of the generation event channel.
    pub stream_sender: GenerationSender,
    /// Deadline guard for wall-clock timeout enforcement.
    pub deadline: DeadlineGuard,
    /// Current generation phase ("prefill", "decode", "epilogue").
    pub phase: String,
    /// Instant the request was started.
    pub started_at: Instant,
}

// ── WorkerHandle ───────────────────────────────────────────────────────────

/// Handle for a live worker subprocess with framed IPC channels.
pub struct WorkerHandle {
    /// The child process handle.
    pub child_process: Child,
    /// UUID identifying this worker instance.
    pub worker_instance_id: String,
    /// OS process ID.
    pub pid: u32,
    /// Buffered writer to the worker's stdin.
    pub stdin: BufWriter<ChildStdin>,
    /// Buffered reader from the worker's stdout.
    pub stdout: BufReader<ChildStdout>,
    /// In-flight requests indexed by request_id.
    pub active_requests: HashMap<String, ActiveRequest>,
    /// Next sequence number for outgoing frames to the worker.
    pub next_sequence: u64,
    /// Instant the worker process was launched.
    pub launched_at: Instant,
    /// Timestamp of the most recently received heartbeat.
    pub last_heartbeat: Instant,
    /// Worker has encountered a fatal error and is considered dead.
    pub faulted: bool,
    /// Next expected incoming sequence number from the worker.
    pub next_expected_seq: u64,
}

// ── WorkerHandle methods ───────────────────────────────────────────────────

impl WorkerHandle {
    /// Send a framed host command to the worker.
    fn send_command(
        &mut self,
        cmd: HostCommand,
        payload: serde_json::Value,
    ) -> Result<(), EngineError> {
        let frame = Frame::new_host_command(
            self.worker_instance_id.clone(),
            self.next_sequence,
            cmd,
            payload,
        );
        let json = serde_json::to_vec(&frame).map_err(|e| {
            EngineError::new(
                EngineErrorCode::InternalInvariantViolation,
                format!("failed to serialize frame: {e}"),
            )
        })?;

        if json.len() > MAX_FRAME_SIZE_BYTES {
            return Err(EngineError::new(
                EngineErrorCode::InternalInvariantViolation,
                "frame exceeds max size",
            ));
        }

        // Write 4-byte LE length prefix + JSON.
        let len = json.len() as u32;
        let header = len.to_le_bytes();
        self.stdin.write_all(&header).map_err(|e| {
            EngineError::new(
                EngineErrorCode::WorkerCrashed,
                format!("failed to write to worker stdin: {e}"),
            )
        })?;
        self.stdin.write_all(&json).map_err(|e| {
            EngineError::new(
                EngineErrorCode::WorkerCrashed,
                format!("failed to write frame to worker stdin: {e}"),
            )
        })?;
        self.stdin.flush().map_err(|e| {
            EngineError::new(
                EngineErrorCode::WorkerCrashed,
                format!("failed to flush worker stdin: {e}"),
            )
        })?;

        self.next_sequence += 1;
        Ok(())
    }

    /// Read a single framed message from the worker's stdout (blocking).
    fn read_frame(&mut self) -> Result<Frame, EngineError> {
        // Read 4-byte LE length prefix.
        let mut len_buf = [0u8; 4];
        self.stdout.read_exact(&mut len_buf).map_err(|e| {
            if e.kind() == std::io::ErrorKind::UnexpectedEof {
                EngineError::new(
                    EngineErrorCode::WorkerCrashed,
                    "worker stdout closed unexpectedly",
                )
            } else {
                EngineError::new(
                    EngineErrorCode::WorkerCrashed,
                    format!("failed to read frame length: {e}"),
                )
            }
        })?;
        let frame_len = u32::from_le_bytes(len_buf) as usize;

        if frame_len > MAX_FRAME_SIZE_BYTES {
            return Err(EngineError::new(
                EngineErrorCode::WorkerProtocolViolation,
                format!("frame length {frame_len} exceeds max {MAX_FRAME_SIZE_BYTES}"),
            ));
        }

        // Read the JSON payload.
        let mut buf = vec![0u8; frame_len];
        self.stdout.read_exact(&mut buf).map_err(|e| {
            EngineError::new(
                EngineErrorCode::WorkerCrashed,
                format!("failed to read frame body: {e}"),
            )
        })?;

        let frame: Frame = serde_json::from_slice(&buf).map_err(|e| {
            EngineError::new(
                EngineErrorCode::WorkerProtocolViolation,
                format!("failed to deserialize frame: {e}"),
            )
        })?;

        // Validate sequence number.
        if frame.sequence_number != self.next_expected_seq {
            return Err(EngineError::new(
                EngineErrorCode::WorkerProtocolViolation,
                format!(
                    "sequence regression: expected {}, got {}",
                    self.next_expected_seq, frame.sequence_number
                ),
            ));
        }
        self.next_expected_seq += 1;

        // Validate worker instance ID.
        if frame.worker_instance_id != self.worker_instance_id {
            return Err(EngineError::new(
                EngineErrorCode::WorkerProtocolViolation,
                "worker instance ID mismatch",
            ));
        }

        Ok(frame)
    }

    /// Attempt a non-blocking read: return `None` if no complete frame is
    /// available in the buffer.
    fn try_read_frame(&mut self) -> Result<Option<Frame>, EngineError> {
        let filled = self.stdout.fill_buf().map_err(|e| {
            EngineError::new(
                EngineErrorCode::WorkerCrashed,
                format!("failed to peek stdout: {e}"),
            )
        })?;

        if filled.len() < 4 {
            return Ok(None);
        }

        // Parse 4-byte LE length prefix from buffer.
        let frame_len = u32::from_le_bytes(
            filled[..4].try_into().expect("4 bytes checked above"),
        ) as usize;

        let total = 4 + frame_len;
        if filled.len() < total {
            return Ok(None);
        }

        // Parse frame from the buffer without consuming yet.
        let frame: Frame = serde_json::from_slice(&filled[4..total]).map_err(|e| {
            EngineError::new(
                EngineErrorCode::WorkerProtocolViolation,
                format!("failed to deserialize frame: {e}"),
            )
        })?;

        // Validate sequence number.
        if frame.sequence_number != self.next_expected_seq {
            return Err(EngineError::new(
                EngineErrorCode::WorkerProtocolViolation,
                format!(
                    "sequence regression: expected {}, got {}",
                    self.next_expected_seq, frame.sequence_number
                ),
            ));
        }
        self.next_expected_seq += 1;

        // Validate worker instance ID.
        if frame.worker_instance_id != self.worker_instance_id {
            return Err(EngineError::new(
                EngineErrorCode::WorkerProtocolViolation,
                "worker instance ID mismatch",
            ));
        }

        // Consume the bytes from the buffer.
        self.stdout.consume(total);
        Ok(Some(frame))
    }
}

// ── WorkerSupervisor ───────────────────────────────────────────────────────

/// Host-side supervisor that owns a worker process and orchestrates its
/// lifecycle, IPC, and fault recovery.
pub struct WorkerSupervisor {
    /// The compiled-in execution policy.
    pub policy: ExecutionPolicy,
    /// Handle to a live worker process, if any.
    pub worker_handle: Option<WorkerHandle>,
    /// Hash of the loaded model image, if one is loaded.
    pub model_image_hash: Option<String>,
    /// Whether a model is currently loaded in the worker.
    pub model_loaded: bool,
    /// The single active generation request_id (v1: at most one in flight).
    pub active_generation: Option<String>,
}

impl WorkerSupervisor {
    /// Create a new supervisor with the given policy. No worker is spawned.
    pub fn new(policy: ExecutionPolicy) -> Self {
        Self {
            policy,
            worker_handle: None,
            model_image_hash: None,
            model_loaded: false,
            active_generation: None,
        }
    }

    /// Spawn the worker executable and perform the Hello/HelloAck handshake.
    ///
    /// Only `HOME` and `PATH` are passed through from the environment. The
    /// model path is passed as a positional argument to the worker binary.
    pub fn launch_worker(
        &mut self,
        worker_binary_path: &Path,
        model_image_dir: &Path,
        image_hash: &str,
    ) -> Result<(), EngineError> {
        if self.worker_handle.is_some() {
            return Err(EngineError::new(
                EngineErrorCode::InternalInvariantViolation,
                "worker already running",
            ));
        }

        let instance_id = Uuid::new_v4().to_string();

        let mut cmd = Command::new(worker_binary_path);
        cmd.arg(model_image_dir)
            .env("HOME", std::env::var("HOME").unwrap_or_default())
            .env("PATH", std::env::var("PATH").unwrap_or_default())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit());

        let mut child = cmd.spawn().map_err(|e| {
            EngineError::new(
                EngineErrorCode::WorkerLaunchFailed,
                format!("failed to spawn worker binary: {e}"),
            )
        })?;

        let pid = child.id();
        let stdin = child.stdin.take().ok_or_else(|| {
            EngineError::new(
                EngineErrorCode::InternalInvariantViolation,
                "failed to capture worker stdin",
            )
        })?;
        let stdout = child.stdout.take().ok_or_else(|| {
            EngineError::new(
                EngineErrorCode::InternalInvariantViolation,
                "failed to capture worker stdout",
            )
        })?;

        let now = Instant::now();
        let mut handle = WorkerHandle {
            child_process: child,
            worker_instance_id: instance_id.clone(),
            pid,
            stdin: BufWriter::new(stdin),
            stdout: BufReader::new(stdout),
            active_requests: HashMap::new(),
            next_sequence: 0,
            launched_at: now,
            last_heartbeat: now,
            faulted: false,
            next_expected_seq: 0,
        };

        // Send Hello command.
        handle.send_command(HostCommand::Hello, serde_json::Value::Null)?;

        // Wait for HelloAck with a polling timeout.
        let deadline = now + Duration::from_secs(5);
        let mut acked = false;
        while Instant::now() < deadline {
            match handle.try_read_frame() {
                Ok(Some(frame)) => match &frame.message_kind {
                    MessageKind::WorkerEvent(WorkerEvent::HelloAck) => {
                        acked = true;
                        break;
                    }
                    _ => {
                        return Err(EngineError::new(
                            EngineErrorCode::WorkerHandshakeFailed,
                            "unexpected frame during handshake",
                        ));
                    }
                },
                Ok(None) => {
                    std::thread::sleep(Duration::from_millis(10));
                }
                Err(e) => {
                    return Err(EngineError::new(
                        EngineErrorCode::WorkerHandshakeFailed,
                        format!("handshake read error: {e}"),
                    ));
                }
            }

            // Check if the worker has exited early.
            if let Ok(Some(status)) = handle.child_process.try_wait() {
                return Err(EngineError::new(
                    EngineErrorCode::WorkerLaunchFailed,
                    format!("worker exited before handshake: {status}"),
                ));
            }
        }

        if !acked {
            return Err(EngineError::new(
                EngineErrorCode::WorkerHandshakeFailed,
                "handshake timed out — no HelloAck received",
            ));
        }

        self.model_image_hash = Some(image_hash.to_string());
        self.worker_handle = Some(handle);
        Ok(())
    }

    /// Instruct the worker to load the model. Blocks until ModelLoaded.
    pub fn load_model(&mut self, image_hash: &str) -> Result<(), EngineError> {
        let handle = self.worker_handle.as_mut().ok_or_else(|| {
            EngineError::new(EngineErrorCode::WorkerCrashed, "no worker running")
        })?;

        let payload = serde_json::json!({ "image_hash": image_hash });
        handle.send_command(HostCommand::LoadModel, payload)?;

        let deadline = Instant::now() + Duration::from_secs(120);
        loop {
            if Instant::now() >= deadline {
                return Err(EngineError::new(
                    EngineErrorCode::WorkerUnresponsive,
                    "model load timed out",
                ));
            }

            let frame = handle.read_frame()?;
            match &frame.message_kind {
                MessageKind::WorkerEvent(WorkerEvent::ModelLoadStarted) => continue,
                MessageKind::WorkerEvent(WorkerEvent::ModelLoaded) => {
                    self.model_loaded = true;
                    self.model_image_hash = Some(image_hash.to_string());
                    return Ok(());
                }
                MessageKind::WorkerEvent(WorkerEvent::WorkerFatal) => {
                    handle.faulted = true;
                    let msg = frame
                        .payload
                        .get("message")
                        .and_then(|v| v.as_str())
                        .unwrap_or("worker fatal during model load");
                    return Err(EngineError::new(
                        EngineErrorCode::WorkerCrashed,
                        format!("worker fatal: {msg}"),
                    ));
                }
                _ => {
                    // Ignore heartbeats and other unrelated events during load.
                    continue;
                }
            }
        }
    }

    /// Start a generation request.
    ///
    /// Validates that no other generation is active (returns
    /// [`EngineErrorCode::ModelBusy`] if so), sends `StartGeneration` to the
    /// worker, creates an `ActiveRequest` with a fresh stream, and returns the
    /// consumer half immediately without waiting for prefill.
    pub fn start_generation(
        &mut self,
        request: StartGenerationPayload,
    ) -> Result<GenerationStream, EngineError> {
        if self.active_generation.is_some() {
            return Err(EngineError::new(
                EngineErrorCode::ModelBusy,
                "a generation request is already in progress",
            ));
        }

        let handle = self.worker_handle.as_mut().ok_or_else(|| {
            EngineError::new(EngineErrorCode::WorkerCrashed, "no worker running")
        })?;

        if !self.model_loaded {
            return Err(EngineError::new(
                EngineErrorCode::ModelNotLoaded,
                "model not loaded",
            ));
        }

        let request_id = request.request_id.clone();
        let public_job_id = Uuid::new_v4().to_string();

        // Create the generation event channel.
        let (sender, stream) = crate::streaming::generation_channel(
            Some(GENERATION_CHANNEL_CAPACITY as u32),
        );

        let deadline = DeadlineGuard::new(&self.policy, Instant::now);

        let active = ActiveRequest {
            request_id: request_id.clone(),
            public_job_id: public_job_id.clone(),
            stream_sender: sender,
            deadline,
            phase: "pending".into(),
            started_at: Instant::now(),
        };

        let payload = serde_json::to_value(&request).map_err(|e| {
            EngineError::new(
                EngineErrorCode::InternalInvariantViolation,
                format!("failed to serialize StartGenerationPayload: {e}"),
            )
        })?;

        handle.send_command(HostCommand::StartGeneration, payload)?;

        handle.active_requests.insert(request_id.clone(), active);
        self.active_generation = Some(request_id);

        Ok(stream)
    }

    /// Cancel a generation by job ID.
    ///
    /// Locates the active request (by either public_job_id or request_id) and
    /// sends `CancelGeneration` to the worker.
    pub fn cancel_generation(&mut self, job_id: &str) -> Result<(), EngineError> {
        let handle = self.worker_handle.as_mut().ok_or_else(|| {
            EngineError::new(EngineErrorCode::WorkerCrashed, "no worker running")
        })?;

        let matching_id = handle
            .active_requests
            .iter()
            .find(|(_id, req)| req.public_job_id == job_id || req.request_id == job_id)
            .map(|(id, _req)| id.clone())
            .ok_or_else(|| {
                EngineError::new(
                    EngineErrorCode::InvalidRequest,
                    format!("no active request found for job_id: {job_id}"),
                )
            })?;

        let payload = serde_json::json!({ "request_id": matching_id });
        handle.send_command(HostCommand::CancelGeneration, payload)
    }

    /// Read and dispatch one frame from the worker.
    ///
    /// Called internally from [`event_loop`]. Blocks until a frame is available.
    fn dispatch_frame(&mut self) -> Result<(), EngineError> {
        // Read frame while holding the handle borrow, then release it.
        let (frame, worker_faulted) = {
            let handle = self.worker_handle.as_mut().ok_or_else(|| {
                EngineError::new(EngineErrorCode::WorkerCrashed, "no worker running")
            })?;
            let frame = handle.read_frame()?;
            let faulted = handle.faulted;
            (frame, faulted)
        };

        if worker_faulted {
            return Err(EngineError::new(
                EngineErrorCode::WorkerCrashed,
                "worker is in faulted state",
            ));
        }

        // Reborrow handle for dispatch — frame is owned so no borrow conflict.
        let handle = self.worker_handle.as_mut().ok_or_else(|| {
            EngineError::new(EngineErrorCode::WorkerCrashed, "no worker running")
        })?;

        let req_id = frame.request_id.as_deref();

        match &frame.message_kind {
            MessageKind::WorkerEvent(event) => match event {
                WorkerEvent::Heartbeat => {
                    handle.last_heartbeat = Instant::now();
                    if let Some(id) = req_id {
                        if let Ok(payload) =
                            serde_json::from_value::<HeartbeatPayload>(frame.payload.clone())
                        {
                            if let Some(ref phase) = payload.request_phase {
                                if let Some(active) = handle.active_requests.get_mut(id) {
                                    active.phase = phase.clone();
                                }
                            }
                        }
                    }
                }

                WorkerEvent::Token => {
                    if let Ok(payload) =
                        serde_json::from_value::<TokenPayload>(frame.payload.clone())
                    {
                        let _ = handle
                            .active_requests
                            .get(&payload.request_id)
                            .and_then(|active| {
                                active
                                    .stream_sender
                                    .try_send(GenerationEvent::Token(payload.token_id))
                                    .ok()
                            });
                    }
                }

                WorkerEvent::GenerationStarted => {
                    if let Some(id) = req_id {
                        if let Some(active) = handle.active_requests.get_mut(id) {
                            active.phase = "prefill".into();
                            let _ = active.stream_sender.try_send(GenerationEvent::Started);
                        }
                    }
                }

                WorkerEvent::PrefillStarted => {
                    if let Some(id) = req_id {
                        if let Some(active) = handle.active_requests.get_mut(id) {
                            active.phase = "prefill".into();
                        }
                    }
                }

                WorkerEvent::PrefillCompleted => {
                    if let Some(id) = req_id {
                        if let Some(active) = handle.active_requests.get_mut(id) {
                            active.phase = "decode".into();
                        }
                    }
                }

                WorkerEvent::GenerationCompleted => {
                    if let Some(id) = req_id {
                        if let Some(active) = handle.active_requests.remove(id) {
                            self.active_generation.take();
                            let _ = active.stream_sender.try_send(GenerationEvent::Done);
                        }
                    }
                }

                WorkerEvent::GenerationCancelled => {
                    if let Some(id) = req_id {
                        if let Some(active) = handle.active_requests.remove(id) {
                            self.active_generation.take();
                            let _ = active
                                .stream_sender
                                .try_send(GenerationEvent::Error("cancelled by host".into()));
                        }
                    }
                }

                WorkerEvent::GenerationFailed => {
                    if let Some(id) = req_id {
                        if let Some(active) = handle.active_requests.remove(id) {
                            self.active_generation.take();
                            let msg = frame
                                .payload
                                .get("message")
                                .and_then(|v| v.as_str())
                                .unwrap_or("generation failed");
                            let _ = active
                                .stream_sender
                                .try_send(GenerationEvent::Error(msg.to_string()));
                        }
                    }
                }

                WorkerEvent::StepMetrics => {
                    if let Some(id) = req_id {
                        let metrics_str = frame.payload.to_string();
                        let _ = handle
                            .active_requests
                            .get(id)
                            .and_then(|active| {
                                active
                                    .stream_sender
                                    .try_send(GenerationEvent::Metrics(metrics_str.clone()))
                                    .ok()
                            });
                    }
                }

                WorkerEvent::WorkerFatal => {
                    handle.faulted = true;
                    let msg = frame
                        .payload
                        .get("message")
                        .and_then(|v| v.as_str())
                        .unwrap_or("worker fatal error");

                    let all_active: Vec<String> =
                        handle.active_requests.keys().cloned().collect();
                    for id in &all_active {
                        if let Some(active) = handle.active_requests.remove(id) {
                            let _ = active
                                .stream_sender
                                .try_send(GenerationEvent::Error(msg.to_string()));
                        }
                    }
                    self.active_generation.take();

                    return Err(EngineError::new(
                        EngineErrorCode::WorkerCrashed,
                        format!("worker fatal: {msg}"),
                    ));
                }

                WorkerEvent::ModelUnloaded => {
                    self.model_loaded = false;
                    self.model_image_hash = None;
                }

                // Events consumed synchronously during launch/load:
                _ => {}
            },

            _ => {
                return Err(EngineError::new(
                    EngineErrorCode::WorkerProtocolViolation,
                    "received host command from worker",
                ));
            }
        }

        Ok(())
    }

    /// Event loop iteration — reads one frame from the worker and dispatches
    /// it to the appropriate generation stream.
    ///
    /// Designed to be called repeatedly from a background thread. Returns an
    /// error when the worker exits, encounters a fatal error, or is faulted.
    pub fn event_loop(&mut self) -> Result<(), EngineError> {
        // Check if the worker has exited.
        if let Some(ref mut handle) = self.worker_handle {
            if handle.faulted {
                return Err(EngineError::new(
                    EngineErrorCode::WorkerCrashed,
                    "worker is in faulted state",
                ));
            }

            match handle.child_process.try_wait() {
                Ok(Some(status)) => {
                    handle.faulted = true;
                    let all_active: Vec<String> =
                        handle.active_requests.keys().cloned().collect();
                    for id in &all_active {
                        if let Some(active) = handle.active_requests.remove(id) {
                            let _ = active.stream_sender.try_send(
                                GenerationEvent::Error(format!("worker exited: {status}")),
                            );
                        }
                    }
                    self.active_generation.take();
                    return Err(EngineError::new(
                        EngineErrorCode::WorkerCrashed,
                        format!("worker exited unexpectedly: {status}"),
                    ));
                }
                Ok(None) => {}
                Err(e) => {
                    return Err(EngineError::new(
                        EngineErrorCode::InternalInvariantViolation,
                        format!("error checking worker status: {e}"),
                    ));
                }
            }
        } else {
            // No worker — nothing to do.
            return Ok(());
        }

        // Read and dispatch one frame.
        self.dispatch_frame()
    }

    /// Check deadlines for all active requests.
    ///
    /// If a request has exceeded its wall-clock deadline, first tries
    /// cooperative cancellation (sends CancelGeneration). If the grace period
    /// has also passed, escalates to forcible termination (kills the worker).
    pub fn check_deadlines(&mut self) {
        let handle = match &mut self.worker_handle {
            Some(h) => h,
            None => return,
        };

        let grace = self.policy.cancellation_grace_period;

        let expired_ids: Vec<String> = handle
            .active_requests
            .iter()
            .filter(|(_id, req)| req.deadline.is_expired())
            .map(|(id, _req)| id.clone())
            .collect();

        for id in &expired_ids {
            let expired_active = match handle.active_requests.get(id) {
                Some(a) => a,
                None => continue,
            };

            if let Some(since_expiry) = expired_active.deadline.time_since_expiry() {
                if since_expiry >= grace {
                    // Grace period passed — force kill.
                    let _ = expired_active
                        .stream_sender
                        .try_send(GenerationEvent::Error("deadline exceeded".into()));
                    if let Some(removed) = handle.active_requests.remove(id) {
                        self.active_generation.take();
                        let _ = removed
                            .stream_sender
                            .try_send(GenerationEvent::Error("deadline exceeded".into()));
                    }
                    let _ = handle.child_process.kill();
                    handle.faulted = true;
                    return;
                }
            }

            // Grace period still active — try cooperative cancel.
            let payload = serde_json::json!({ "request_id": id });
            let _ = handle.send_command(HostCommand::CancelGeneration, payload);
            if let Some(active) = handle.active_requests.get_mut(id) {
                active.phase = "cancelling".into();
            }
        }
    }

    /// Sample the worker's resident set size in bytes.
    ///
    /// Returns 0 if sampling fails or no worker is running.
    pub fn monitor_rss(&mut self) -> u64 {
        let pid = match &self.worker_handle {
            Some(h) => h.pid,
            None => return 0,
        };
        read_process_rss(pid)
    }

    /// Unload the model and shut down the worker gracefully.
    ///
    /// Cancels any active generation, sends UnloadModel and Shutdown commands,
    /// then waits for the worker to exit (with a 10-second timeout before
    /// forcible kill).
    pub fn unload_model(&mut self) -> Result<(), EngineError> {
        // Cancel any active generation.
        if let Some(ref id) = self.active_generation.clone() {
            if let Some(ref mut handle) = self.worker_handle {
                let payload = serde_json::json!({ "request_id": id });
                let _ = handle.send_command(HostCommand::CancelGeneration, payload);
                if let Some(active) = handle.active_requests.remove(id) {
                    let _ = active
                        .stream_sender
                        .try_send(GenerationEvent::Error("shutdown".into()));
                }
            }
            self.active_generation = None;
        }

        let handle = self.worker_handle.as_mut().ok_or_else(|| {
            EngineError::new(EngineErrorCode::WorkerCrashed, "no worker running")
        })?;

        // Send UnloadModel.
        handle.send_command(HostCommand::UnloadModel, serde_json::Value::Null)?;

        // Send Shutdown.
        handle.send_command(HostCommand::Shutdown, serde_json::Value::Null)?;

        // Wait for worker exit.
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            match handle.child_process.try_wait() {
                Ok(Some(_)) => break,
                Ok(None) => {
                    if Instant::now() >= deadline {
                        let _ = handle.child_process.kill();
                        let _ = handle.child_process.wait();
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(50));
                }
                Err(e) => {
                    let _ = handle.child_process.kill();
                    let _ = handle.child_process.wait();
                    return Err(EngineError::new(
                        EngineErrorCode::InternalInvariantViolation,
                        format!("error waiting for worker exit: {e}"),
                    ));
                }
            }
        }

        self.model_loaded = false;
        self.model_image_hash = None;
        self.worker_handle = None;
        Ok(())
    }

    /// Forcefully shut down the worker if still alive.
    pub fn shutdown(&mut self) {
        if let Some(mut handle) = self.worker_handle.take() {
            let _ = handle.child_process.kill();
            let _ = handle.child_process.wait();
        }
        self.model_loaded = false;
        self.model_image_hash = None;
        self.active_generation = None;
    }
}

impl Drop for WorkerSupervisor {
    fn drop(&mut self) {
        self.shutdown();
    }
}

// ── Event Forwarder ────────────────────────────────────────────────────────

/// Spawn a background thread that continuously forwards worker events to the
/// appropriate generation streams.
///
/// The thread runs `event_loop()` in a loop, releasing the mutex lock between
/// iterations. When the worker exits (event_loop returns an error), the thread
/// marks the worker as faulted and exits.
pub fn spawn_event_forwarder(
    supervisor: Arc<Mutex<WorkerSupervisor>>,
) -> JoinHandle<()> {
    std::thread::Builder::new()
        .name("worker-event-forwarder".into())
        .spawn(move || {
            loop {
                // Quick check: is the worker still alive?
                {
                    let sv = supervisor.lock();
                    let should_exit = match &sv.worker_handle {
                        None => {
                            // No worker — sleep and retry.
                            drop(sv);
                            std::thread::sleep(Duration::from_millis(100));
                            continue;
                        }
                        Some(h) => h.faulted,
                    };
                    if should_exit {
                        return;
                    }
                }

                // Event loop iteration: read + dispatch one frame.
                let result = {
                    let mut sv = supervisor.lock();
                    sv.event_loop()
                };

                match result {
                    Ok(()) => {}
                    Err(e) => {
                        eprintln!("[worker_supervisor] event_loop error: {e}");
                        let mut sv = supervisor.lock();
                        if let Some(ref mut handle) = sv.worker_handle {
                            handle.faulted = true;
                        }
                        return;
                    }
                }
            }
        })
        .expect("failed to spawn event forwarder thread")
}

// ── RSS Monitoring ─────────────────────────────────────────────────────────

/// Read the resident set size of a process by PID.
#[cfg(target_os = "macos")]
fn read_process_rss(pid: u32) -> u64 {
    use std::mem::{size_of, MaybeUninit};

    const PROC_PIDTASKINFO: i32 = 4;

    let mut info = MaybeUninit::<libc::proc_taskinfo>::uninit();
    let ret = unsafe {
        libc::proc_pidinfo(
            pid as i32,
            PROC_PIDTASKINFO,
            0,
            info.as_mut_ptr() as *mut libc::c_void,
            size_of::<libc::proc_taskinfo>() as i32,
        )
    };

    if ret > 0 {
        unsafe { (*info.as_ptr()).pti_resident_size as u64 }
    } else {
        0
    }
}

/// Read RSS via `/proc` on Linux.
#[cfg(target_os = "linux")]
fn read_process_rss(pid: u32) -> u64 {
    let path = format!("/proc/{pid}/stat");
    let content = match std::fs::read_to_string(&path) {
        Ok(c) => c,
        Err(_) => return 0,
    };
    // Field 24 (0-indexed: 23) is resident set size in pages.
    if let Some(field) = content.split_whitespace().nth(23) {
        if let Ok(pages) = field.parse::<u64>() {
            return pages.saturating_mul(4096);
        }
    }
    0
}

/// Fallback for unsupported platforms.
#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn read_process_rss(_pid: u32) -> u64 {
    0
}

// ── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine_error::EngineErrorCode;
    use crate::engine_policy::qualification_policy;

    // ── Helpers ──────────────────────────────────────────────────────────

    fn test_generation_payload(request_id: &str) -> StartGenerationPayload {
        StartGenerationPayload {
            prompt_token_ids: vec![1, 2, 3],
            max_output_tokens: 8,
            deadline_ms: 30_000,
            request_id: request_id.to_string(),
        }
    }

    fn make_supervisor() -> WorkerSupervisor {
        let mut sv = WorkerSupervisor::new(qualification_policy());
        sv.model_loaded = true;
        sv
    }

    // ── test_launch_handshake_flow ────────────────────────────────────────

    #[test]
    fn test_launch_handshake_flow() {
        // Verify pre-launch invariants.
        let sv = WorkerSupervisor::new(qualification_policy());
        assert!(sv.worker_handle.is_none());

        // load_model without a worker returns WorkerCrashed.
        let mut sv = WorkerSupervisor::new(qualification_policy());
        let result = sv.load_model("test-hash");
        assert!(result.is_err());
        assert_eq!(
            result.unwrap_err().code,
            EngineErrorCode::WorkerCrashed
        );

        // start_generation without a worker returns WorkerCrashed.
        let mut sv2 = WorkerSupervisor::new(qualification_policy());
        sv2.model_loaded = true;
        let result = sv2.start_generation(test_generation_payload("req-1"));
        assert!(result.is_err());
        let err = result.err().unwrap();
        assert_eq!(err.code, EngineErrorCode::WorkerCrashed);
    }

    // ── test_model_busy_rejection ─────────────────────────────────────────

    #[test]
    fn test_model_busy_rejection() {
        let mut sv = make_supervisor();
        sv.active_generation = Some("gen-001".into());

        let result = sv.start_generation(test_generation_payload("gen-002"));
        assert!(result.is_err());
        let err = result.err().unwrap();
        assert_eq!(err.code, EngineErrorCode::ModelBusy);
    }

    // ── test_deadline_expiry_escalation ───────────────────────────────────

    #[test]
    fn test_deadline_expiry_escalation() {
        use std::sync::Mutex;

        let fake_now = Arc::new(Mutex::new(Instant::now()));
        let clock_fn = {
            let now = Arc::clone(&fake_now);
            move || *now.lock().unwrap()
        };

        let policy = qualification_policy();
        let deadline = DeadlineGuard::new(&policy, clock_fn);

        // Advance past the deadline (1s into grace period).
        *fake_now.lock().unwrap() += policy.request_deadline + Duration::from_secs(1);
        assert!(deadline.is_expired());
        assert!(deadline.time_since_expiry().unwrap() < policy.cancellation_grace_period);

        // Advance past the grace period too.
        *fake_now.lock().unwrap() += policy.cancellation_grace_period;
        assert!(deadline.is_expired());
        assert!(deadline.time_since_expiry().unwrap() >= policy.cancellation_grace_period);

        // Verify check_deadlines is a no-op without a worker handle.
        let mut sv = WorkerSupervisor::new(qualification_policy());
        sv.check_deadlines();
    }
}
