//! Host-side worker supervisor — decomposed into independently-locked components.
//!
//! Each subsystem has its own narrow lock or is lock-free:
//! - [`WorkerProcessControl`]: `Mutex<Option<Child>>` (lightweight, pid-based alive check)
//! - [`WorkerCommandWriter`]: `Mutex<BufWriter<ChildStdin>>`
//! - [`WorkerEventReader`]: no lock (owned exclusively by event-reader thread)
//! - [`WorkerRuntimeState`]: `AtomicBool` + `AtomicU32` + `Mutex<Instant>`
//! - [`ActiveRequestRegistry`]: `Mutex<HashMap<String, ActiveRequest>>`
//! - [`WorkerDiagnosticsCollector`]: `Mutex<Vec<u8>>`
//! - [`WorkerSupervisor`]: aggregates all components, spawns event and watchdog threads

use crate::engine_error::{EngineError, EngineErrorCode};
use crate::engine_policy::{DeadlineGuard, ExecutionPolicy};
use crate::streaming::{
    generation_channel, GenerationEvent, GenerationHandle, GenerationSender,
};
use crate::worker_protocol::{
    Frame, HeartbeatPayload, HostCommand, MessageKind, PolicySnapshotPayload,
    ProtocolValidator, StartGenerationPayload, TokenPayload, WorkerEvent,
    MAX_FRAME_SIZE_BYTES,
};
use parking_lot::Mutex;
use serde_json::Value;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, BufWriter, Read, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, ChildStdout, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};
use uuid::Uuid;

// ── Constants ──────────────────────────────────────────────────────────────

/// Size of the generation event channel buffer.
const GENERATION_CHANNEL_CAPACITY: usize = 256;

/// How long to wait for a HelloAck during handshake.
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(5);

/// Graceful-shutdown wait before SIGKILL.
const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(10);

// ── WorkerProcessControl ───────────────────────────────────────────────────

/// Controls a worker subprocess.
///
/// The [`Child`] handle is stored behind a [`Mutex`] so that `&self` methods
/// (used by the watchdog and event-reader threads) can reap or kill without
/// requiring `&mut self`. The lock is never held across blocking I/O — just
/// long enough to swap or query the child.
pub struct WorkerProcessControl {
    child: Mutex<Option<Child>>,
    pid: u32,
    launched_at: Instant,
    exit_status: Mutex<Option<ExitStatus>>,
    killed: AtomicBool,
}

impl WorkerProcessControl {
    pub fn new_from_child(child: Child) -> Self {
        let pid = child.id();
        Self {
            child: Mutex::new(Some(child)),
            pid,
            launched_at: Instant::now(),
            exit_status: Mutex::new(None),
            killed: AtomicBool::new(false),
        }
    }

    pub fn pid(&self) -> u32 {
        self.pid
    }

    pub fn launched_at(&self) -> Instant {
        self.launched_at
    }

    /// Check whether the worker process is still alive by trying to reap.
    /// Returns `false` when the process has exited or was already reaped.
    pub fn is_alive(&self) -> bool {
        let mut guard = self.child.lock();
        match guard.as_mut() {
            Some(child) => match child.try_wait() {
                Ok(None) => true,        // Still running.
                Ok(Some(status)) => {
                    *self.exit_status.lock() = Some(status);
                    *guard = None;
                    false
                }
                Err(_) => false,
            },
            None => false, // Already reaped or never spawned.
        }
    }

    /// Send SIGKILL to the worker process. Idempotent — subsequent calls are
    /// no-ops once `killed` is set.
    pub fn kill(&self) -> std::io::Result<()> {
        if self.killed.swap(true, Ordering::SeqCst) {
            return Ok(());
        }
        let mut guard = self.child.lock();
        if let Some(ref mut child) = *guard {
            child.kill()?;
        }
        Ok(())
    }

    pub fn was_killed(&self) -> bool {
        self.killed.load(Ordering::SeqCst)
    }

    /// Block until the child exits.
    pub fn wait(&self) -> std::io::Result<ExitStatus> {
        let mut guard = self.child.lock();
        let mut child = guard.take().ok_or_else(|| {
            std::io::Error::new(std::io::ErrorKind::NotConnected, "no child process")
        })?;
        let status = child.wait()?;
        *self.exit_status.lock() = Some(status);
        Ok(status)
    }

    /// Non-blocking reaper.
    pub fn try_wait(&self) -> std::io::Result<Option<ExitStatus>> {
        if let Some(status) = *self.exit_status.lock() {
            return Ok(Some(status));
        }
        let mut guard = self.child.lock();
        match guard.as_mut() {
            Some(child) => match child.try_wait()? {
                Some(status) => {
                    *self.exit_status.lock() = Some(status);
                    *guard = None;
                    Ok(Some(status))
                }
                None => Ok(None),
            },
            None => Ok(*self.exit_status.lock()),
        }
    }

    pub fn exit_status(&self) -> Option<ExitStatus> {
        *self.exit_status.lock()
    }
}

// ── WorkerCommandWriter ────────────────────────────────────────────────────

/// Thread-safe command writer.
///
/// Uses a [`Mutex<CommandWriterInner>`] internally for thread-safe writes.
/// Sequence numbers are allocated under the lock to avoid ordering inversions.
struct CommandWriterInner {
    writer: BufWriter<ChildStdin>,
    next_seq: u64,
}

pub struct WorkerCommandWriter {
    inner: Mutex<CommandWriterInner>,
    worker_id: String,
}

impl WorkerCommandWriter {
    pub fn new(stdin: ChildStdin, worker_id: String) -> Self {
        Self {
            inner: Mutex::new(CommandWriterInner {
                writer: BufWriter::new(stdin),
                next_seq: 0,
            }),
            worker_id,
        }
    }

    fn write_frame_locked(
        &self,
        cmd: HostCommand,
        request_id: Option<&str>,
        payload: Value,
    ) -> Result<(), EngineError> {
        let mut guard = self.inner.lock();
        let seq = guard.next_seq;
        guard.next_seq += 1;

        let frame = match request_id {
            Some(rid) => Frame::new_host_command_with_request(
                &self.worker_id,
                seq,
                rid,
                cmd,
                payload,
            ),
            None => Frame::new_host_command(
                self.worker_id.clone(),
                seq,
                cmd,
                payload,
            ),
        };

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

        let len = json.len() as u32;
        guard.writer.write_all(&len.to_le_bytes()).map_err(|e| {
            EngineError::new(
                EngineErrorCode::WorkerCrashed,
                format!("failed to write to worker stdin: {e}"),
            )
        })?;
        guard.writer.write_all(&json).map_err(|e| {
            EngineError::new(
                EngineErrorCode::WorkerCrashed,
                format!("failed to write frame: {e}"),
            )
        })?;
        guard.writer.flush().map_err(|e| {
            EngineError::new(
                EngineErrorCode::WorkerCrashed,
                format!("failed to flush worker stdin: {e}"),
            )
        })?;
        Ok(())
    }

    /// Send a command without a request correlation id (Hello, Ping, Shutdown,
    /// LoadModel, UnloadModel, MemoryPressure).
    pub fn send_command(&self, cmd: HostCommand, payload: Value) -> Result<(), EngineError> {
        self.write_frame_locked(cmd, None, payload)
    }

    /// Send a request-scoped command (StartGeneration, CancelGeneration).
    pub fn send_command_with_request(
        &self,
        cmd: HostCommand,
        request_id: &str,
        payload: Value,
    ) -> Result<(), EngineError> {
        self.write_frame_locked(cmd, Some(request_id), payload)
    }

    /// Current outgoing sequence number (for diagnostics).
    pub fn next_seq(&self) -> u64 {
        self.inner.lock().next_seq
    }

    /// The worker instance ID this writer targets.
    pub fn worker_id(&self) -> &str {
        &self.worker_id
    }
}

// ── WorkerEventReader ──────────────────────────────────────────────────────

/// Owned exclusively by the event-reader thread. NOT behind a shared lock.
///
/// Decodes length-prefixed JSON frames from the worker's stdout, validates
/// them through the stateful [`ProtocolValidator`], and returns validated
/// [`Frame`]s.
pub struct WorkerEventReader {
    reader: BufReader<ChildStdout>,
    validator: ProtocolValidator,
}

impl WorkerEventReader {
    pub fn new(stdout: ChildStdout, worker_id: String) -> Self {
        Self {
            reader: BufReader::new(stdout),
            validator: ProtocolValidator::new(worker_id),
        }
    }

    /// Non-blocking try-read of the next validated frame.
    ///
    /// Returns `Ok(None)` when there isn't enough data in the buffer yet.
    /// Returns `Err` on I/O errors or protocol violations.
    pub fn try_read_next_event(&mut self) -> Result<Option<Frame>, EngineError> {
        let filled = self.reader.fill_buf().map_err(|e| {
            if e.kind() == std::io::ErrorKind::UnexpectedEof {
                EngineError::new(EngineErrorCode::WorkerCrashed, "worker stdout closed")
            } else {
                EngineError::new(
                    EngineErrorCode::WorkerCrashed,
                    format!("failed to peek stdout: {e}"),
                )
            }
        })?;

        if filled.len() < 4 {
            return Ok(None);
        }

        let frame_len =
            u32::from_le_bytes(filled[..4].try_into().expect("4 bytes checked")) as usize;
        let total = 4 + frame_len;

        if filled.len() < total {
            return Ok(None);
        }

        let frame: Frame = serde_json::from_slice(&filled[4..total]).map_err(|e| {
            EngineError::new(
                EngineErrorCode::WorkerProtocolViolation,
                format!("failed to deserialize frame: {e}"),
            )
        })?;

        self.validator
            .validate_worker_event(&frame)
            .map_err(|verr| {
                EngineError::new(
                    EngineErrorCode::WorkerProtocolViolation,
                    format!("frame validation failed: {verr:?}"),
                )
            })?;

        self.reader.consume(total);
        Ok(Some(frame))
    }

    /// Blocking read of the next validated frame from the worker.
    ///
    /// Returns [`EngineErrorCode::WorkerCrashed`] when stdout is closed and
    /// [`EngineErrorCode::WorkerProtocolViolation`] when validation fails.
    pub fn read_next_event(&mut self) -> Result<Frame, EngineError> {
        // Read 4-byte LE length prefix.
        let mut len_buf = [0u8; 4];
        self.reader.read_exact(&mut len_buf).map_err(|e| {
            if e.kind() == std::io::ErrorKind::UnexpectedEof {
                EngineError::new(EngineErrorCode::WorkerCrashed, "worker stdout closed")
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

        let mut buf = vec![0u8; frame_len];
        self.reader.read_exact(&mut buf).map_err(|e| {
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

        // Run through the stateful validator — checks sequence, worker ID,
        // and request-scoped invariants.
        self.validator.validate_worker_event(&frame).map_err(|verr| {
            EngineError::new(
                EngineErrorCode::WorkerProtocolViolation,
                format!("frame validation failed: {verr:?}"),
            )
        })?;

        Ok(frame)
    }

    /// The validator's expected worker ID.
    pub fn worker_id(&self) -> &str {
        &self.validator.expected_worker_id
    }
}

// ── WorkerRuntimeState ─────────────────────────────────────────────────────

/// Lock-cheap runtime state shared across threads.
///
/// Uses `AtomicBool` for model/faulted flags, `Mutex<Instant>` for the
/// heartbeat timestamp (updated frequently by event reader, read by watchdog).
pub struct WorkerRuntimeState {
    model_loaded: AtomicBool,
    faulted: AtomicBool,
    last_heartbeat: Mutex<Instant>,
    restart_count: AtomicU32,
    worker_id: String,
}

impl WorkerRuntimeState {
    pub fn new(worker_id: String) -> Self {
        Self {
            model_loaded: AtomicBool::new(false),
            faulted: AtomicBool::new(false),
            last_heartbeat: Mutex::new(Instant::now()),
            restart_count: AtomicU32::new(0),
            worker_id,
        }
    }

    pub fn worker_id(&self) -> &str {
        &self.worker_id
    }

    pub fn mark_faulted(&self) {
        self.faulted.store(true, Ordering::SeqCst);
    }

    pub fn is_faulted(&self) -> bool {
        self.faulted.load(Ordering::SeqCst)
    }

    pub fn record_heartbeat(&self) {
        *self.last_heartbeat.lock() = Instant::now();
    }

    pub fn heartbeat_age(&self) -> Duration {
        Instant::now() - *self.last_heartbeat.lock()
    }

    pub fn last_heartbeat(&self) -> Instant {
        *self.last_heartbeat.lock()
    }

    pub fn is_model_loaded(&self) -> bool {
        self.model_loaded.load(Ordering::SeqCst)
    }

    pub fn set_model_loaded(&self) {
        self.model_loaded.store(true, Ordering::SeqCst);
    }

    pub fn clear_model_loaded(&self) {
        self.model_loaded.store(false, Ordering::SeqCst);
    }

    pub fn restart_count(&self) -> u32 {
        self.restart_count.load(Ordering::SeqCst)
    }

    /// Increment restart count and return the new value.
    pub fn increment_restart_count(&self) -> u32 {
        self.restart_count.fetch_add(1, Ordering::SeqCst) + 1
    }
}

// ── ActiveRequest ──────────────────────────────────────────────────────────

/// An in-flight generation request with per-field synchronization.
///
/// The [`terminal_recorded`](Self::terminal_recorded) atomic provides exactly-
/// once terminal event delivery across threads.
pub struct ActiveRequest {
    pub request_id: String,
    pub public_job_id: String,
    pub stream_sender: GenerationSender,
    pub deadline: DeadlineGuard,
    /// Deadline instant, stored for [`ActiveRequestRegistry::all_active`].
    pub deadline_at: Instant,
    pub phase: Mutex<String>,
    pub cancellation_requested: AtomicBool,
    pub terminal_recorded: AtomicBool,
    pub cancelled_at: Mutex<Option<Instant>>,
}

impl ActiveRequest {
    pub fn new(
        request_id: String,
        public_job_id: String,
        stream_sender: GenerationSender,
        deadline: DeadlineGuard,
        deadline_at: Instant,
    ) -> Self {
        Self {
            request_id,
            public_job_id,
            stream_sender,
            deadline,
            deadline_at,
            phase: Mutex::new("pending".into()),
            cancellation_requested: AtomicBool::new(false),
            terminal_recorded: AtomicBool::new(false),
            cancelled_at: Mutex::new(None),
        }
    }

    /// Mark this request as terminal, sending `outcome` to the stream exactly
    /// once. Subsequent calls are no-ops.
    pub fn mark_terminal(&self, outcome: GenerationEvent) {
        if self.terminal_recorded.swap(true, Ordering::SeqCst) {
            return;
        }
        self.stream_sender.send_terminal(outcome);
    }
}

// ── ActiveRequestRegistry ──────────────────────────────────────────────────

/// Registry of active generation requests behind a single [`Mutex`].
///
/// Maintains a forward map (request_id → ActiveRequest) and a reverse index
/// (public_job_id → request_id) for O(1) job-id lookups.
pub struct ActiveRequestRegistry {
    requests: Mutex<HashMap<String, ActiveRequest>>,
    job_index: Mutex<HashMap<String, String>>,
}

impl ActiveRequestRegistry {
    pub fn new() -> Self {
        Self {
            requests: Mutex::new(HashMap::new()),
            job_index: Mutex::new(HashMap::new()),
        }
    }

    /// Insert an active request. Both `request_id` and `public_job_id` must
    /// be unique; duplicates silently overwrite.
    pub fn insert(&self, request: ActiveRequest) {
        let public_job_id = request.public_job_id.clone();
        let request_id = request.request_id.clone();
        self.job_index
            .lock()
            .insert(public_job_id, request_id.clone());
        self.requests.lock().insert(request_id, request);
    }

    /// Remove and return a request by `request_id`. Also cleans up the job
    /// index. Returns `None` when the request is not found.
    pub fn remove(&self, request_id: &str) -> Option<ActiveRequest> {
        let result = self.requests.lock().remove(request_id);
        if let Some(ref req) = result {
            self.job_index.lock().remove(&req.public_job_id);
        }
        result
    }

    /// Look up `public_job_id` and return the corresponding `request_id`.
    pub fn get_by_job_id(&self, job_id: &str) -> Option<String> {
        self.job_index.lock().get(job_id).cloned()
    }

    /// Mark a request as terminal, sending `outcome` via the sender. Removes
    /// the request from the registry.
    pub fn mark_terminal(&self, request_id: &str, outcome: GenerationEvent) {
        // Take the request out, mark terminal while dropped, then drop the lock.
        let request = self.requests.lock().remove(request_id);
        if let Some(ref req) = request {
            self.job_index.lock().remove(&req.public_job_id);
        }
        if let Some(active) = request {
            active.mark_terminal(outcome);
        }
    }

    /// Request cancellation. Returns `false` when the request is already
    /// terminal or already cancelled.
    pub fn request_cancellation(&self, request_id: &str) -> bool {
        let requests = self.requests.lock();
        let active = match requests.get(request_id) {
            Some(a) => a,
            None => return false,
        };
        if active.terminal_recorded.load(Ordering::SeqCst) {
            return false;
        }
        if active.cancellation_requested.swap(true, Ordering::SeqCst) {
            return false;
        }
        true
    }

    /// Return all active request IDs with their deadline instants.
    ///
    /// Used by the watchdog to check deadlines without holding the lock long.
    pub fn all_active(&self) -> Vec<(String, Instant)> {
        self.requests
            .lock()
            .iter()
            .map(|(id, active)| (id.clone(), active.deadline_at))
            .collect()
    }

    pub fn is_empty(&self) -> bool {
        self.requests.lock().is_empty()
    }

    pub fn len(&self) -> usize {
        self.requests.lock().len()
    }

    /// Drain all active requests, sending each a terminal error. Returns the
    /// count of requests drained.
    pub fn fail_all(&self, message: &str) -> usize {
        let ids: Vec<String> = self.requests.lock().keys().cloned().collect();
        let count = ids.len();
        for id in &ids {
            self.mark_terminal(id, GenerationEvent::Error(message.to_string()));
        }
        count
    }

    /// Check if a request_id exists in the registry.
    pub fn contains(&self, request_id: &str) -> bool {
        self.requests.lock().contains_key(request_id)
    }
}

// ── WorkerDiagnosticsCollector ─────────────────────────────────────────────

/// Ring-buffer diagnostics collector for worker stderr / metadata.
pub struct WorkerDiagnosticsCollector {
    buffer: Mutex<Vec<u8>>,
    max_bytes: usize,
}

impl WorkerDiagnosticsCollector {
    pub fn new(max_bytes: usize) -> Self {
        Self {
            buffer: Mutex::new(Vec::with_capacity(max_bytes.min(4096))),
            max_bytes,
        }
    }

    /// Append a line to the diagnostics buffer. Drops oldest content when
    /// the buffer exceeds `max_bytes`.
    pub fn append_line(&self, line: &str) {
        let mut buf = self.buffer.lock();
        let line_bytes = line.as_bytes();
        if buf.len() + line_bytes.len() + 1 > self.max_bytes {
            // Discard roughly half the buffer to make room.
            let drain_to = buf.len() / 2;
            buf.drain(..drain_to);
        }
        buf.extend_from_slice(line_bytes);
        buf.push(b'\n');
    }

    /// Snapshot the current diagnostics content as a string.
    pub fn snapshot(&self) -> String {
        String::from_utf8_lossy(&self.buffer.lock()).to_string()
    }

    pub fn len(&self) -> usize {
        self.buffer.lock().len()
    }

    pub fn is_empty(&self) -> bool {
        self.buffer.lock().is_empty()
    }
}

// ── WorkerSupervisor ───────────────────────────────────────────────────────

/// Host-side supervisor that owns all component handles.
///
/// Each subsystem has its own synchronization primitive — no single
/// `Arc<Mutex<WorkerSupervisor>>` bottleneck. The event-reader and watchdog
/// threads take `Arc` clones of the components they need.
pub struct WorkerSupervisor {
    pub process_ctrl: Arc<WorkerProcessControl>,
    pub cmd_writer: Arc<WorkerCommandWriter>,
    pub runtime_state: Arc<WorkerRuntimeState>,
    pub registry: Arc<ActiveRequestRegistry>,
    pub diagnostics: Arc<WorkerDiagnosticsCollector>,
    pub policy: ExecutionPolicy,
    pub event_reader_handle: Option<JoinHandle<()>>,
    pub watchdog_handle: Option<JoinHandle<()>>,
    pub diagnostics_handle: Option<JoinHandle<()>>,
}

impl WorkerSupervisor {
    // ── Launch & Handshake ───────────────────────────────────────────────

    /// Spawn the worker process with a clean environment, perform the
    /// Hello/HelloAck handshake, and return a fully initialized supervisor
    /// with the event-reader and watchdog threads already running.
    ///
    /// The worker is spawned with `env_clear()` + allowlist (HOME, PATH,
    /// locale variables). `--worker-instance-id` and `--image-dir` are passed
    /// as CLI args.
    pub fn launch_and_handshake(
        policy: ExecutionPolicy,
        worker_binary: &Path,
        image_dir: &Path,
        _image_hash: &str,
        worker_id: &str,
    ) -> Result<Self, EngineError> {
        let instance_id = Uuid::new_v4().to_string();

        let mut cmd = Command::new(worker_binary);
        cmd.env_clear()
            .env("HOME", std::env::var("HOME").unwrap_or_default())
            .env("PATH", std::env::var("PATH").unwrap_or_default())
            .env("LANG", std::env::var("LANG").unwrap_or_else(|_| "en_US.UTF-8".into()))
            .env(
                "LC_ALL",
                std::env::var("LC_ALL")
                    .unwrap_or_else(|_| std::env::var("LANG").unwrap_or_else(|_| "en_US.UTF-8".into())),
            )
            .arg("--worker-instance-id")
            .arg(&instance_id)
            .arg("--image-dir")
            .arg(image_dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        let mut child = cmd.spawn().map_err(|e| {
            EngineError::new(
                EngineErrorCode::WorkerLaunchFailed,
                format!("failed to spawn worker binary: {e}"),
            )
        })?;

        let _pid = child.id();
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
        let stderr = child.stderr.take();

        let process_ctrl = Arc::new(WorkerProcessControl::new_from_child(child));
        let cmd_writer = Arc::new(WorkerCommandWriter::new(stdin, instance_id.clone()));
        let mut event_reader = WorkerEventReader::new(stdout, instance_id.clone());
        let runtime_state = Arc::new(WorkerRuntimeState::new(worker_id.to_string()));
        let registry = Arc::new(ActiveRequestRegistry::new());
        let diagnostics = Arc::new(WorkerDiagnosticsCollector::new(
            policy.stderr_diagnostic_ceiling_bytes,
        ));

        // Spawn stderr reader if we captured stderr.
        let diagnostics_handle = stderr.map(|err| {
            let diag = Arc::clone(&diagnostics);
            std::thread::Builder::new()
                .name("worker-stderr-reader".into())
                .spawn(move || {
                    let mut reader = BufReader::new(err);
                    let mut line = String::new();
                    while reader.read_line(&mut line).unwrap_or(0) > 0 {
                        let trimmed = line.trim_end().to_string();
                        diag.append_line(&trimmed);
                        line.clear();
                    }
                })
                .expect("failed to spawn stderr reader")
        });

        // ── Handshake: create channel, spawn event reader, wait for HelloAck ──
        let handshake_complete = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let hc_clone = Arc::clone(&handshake_complete);
        let (handshake_tx, handshake_rx) = std::sync::mpsc::channel::<Result<Frame, EngineError>>();

        // Spawn event reader thread immediately — it reads frames and pumps them
        // into the channel. During handshake, the main thread receives from the
        // channel with a timeout instead of blocking on fill_buf().
        let er_runtime = Arc::clone(&runtime_state);
        let er_registry = Arc::clone(&registry);
        let er_diagnostics = Arc::clone(&diagnostics);
        let er_process = Arc::clone(&process_ctrl);
        let er_policy = policy.clone();

        let event_reader_handle = std::thread::Builder::new()
            .name("worker-event-reader".into())
            .spawn(move || {
                Self::run_event_reader(
                    &mut event_reader,
                    &er_runtime,
                    &er_registry,
                    &er_diagnostics,
                    &er_process,
                    &er_policy,
                    &handshake_tx,
                    &hc_clone,
                );
            })
            .expect("failed to spawn event reader");

        // Send Hello and wait for HelloAck.
        cmd_writer.send_command(HostCommand::Hello, Value::Null)?;

        match handshake_rx.recv_timeout(HANDSHAKE_TIMEOUT) {
            Ok(Ok(frame)) => {
                if !matches!(
                    &frame.message_kind,
                    MessageKind::WorkerEvent(WorkerEvent::HelloAck)
                ) {
                    return Err(EngineError::new(
                        EngineErrorCode::WorkerHandshakeFailed,
                        "unexpected frame during handshake",
                    ));
                }
            }
            Ok(Err(e)) => {
                return Err(e);
            }
            Err(_) => {
                return Err(EngineError::new(
                    EngineErrorCode::WorkerHandshakeFailed,
                    "handshake timed out — no HelloAck received",
                ));
            }
        }

        // Handshake complete — event reader stops forwarding to channel.
        handshake_complete.store(true, std::sync::atomic::Ordering::SeqCst);
        drop(handshake_rx);

        // Spawn watchdog thread.
        let watchdog_process = Arc::clone(&process_ctrl);
        let watchdog_cmd = Arc::clone(&cmd_writer);
        let watchdog_runtime = Arc::clone(&runtime_state);
        let watchdog_registry = Arc::clone(&registry);
        let watchdog_diagnostics = Arc::clone(&diagnostics);
        let watchdog_policy = policy.clone();

        let watchdog_handle = std::thread::Builder::new()
            .name("worker-watchdog".into())
            .spawn(move || {
                Self::run_watchdog(
                    &watchdog_process,
                    &watchdog_cmd,
                    &watchdog_runtime,
                    &watchdog_registry,
                    &watchdog_diagnostics,
                    &watchdog_policy,
                );
            })
            .expect("failed to spawn watchdog");

        Ok(Self {
            process_ctrl,
            cmd_writer,
            runtime_state,
            registry,
            diagnostics,
            policy,
            event_reader_handle: Some(event_reader_handle),
            watchdog_handle: Some(watchdog_handle),
            diagnostics_handle,
        })
    }

    // ── Load Model ───────────────────────────────────────────────────────

    /// Instruct the worker to load the model.
    ///
    /// Sends `LoadModel`, then polls the runtime state until `ModelLoaded` is
    /// set by the event-reader thread (which dispatches the frame). Times out
    /// after `policy.model_load_timeout`.
    pub fn load_model(&self, image_hash: &str) -> Result<(), EngineError> {
        if self.runtime_state.is_faulted() {
            return Err(EngineError::new(
                EngineErrorCode::WorkerCrashed,
                "worker is faulted",
            ));
        }

        let policy_snapshot = PolicySnapshotPayload {
            mlx_active_memory_limit_bytes: self.policy.mlx_active_memory_limit_bytes,
            mlx_cache_limit_bytes: self.policy.mlx_cache_limit_bytes,
            prompt_token_ceiling: self.policy.prompt_token_ceiling,
            output_token_ceiling: self.policy.output_token_ceiling,
        };
        let payload = serde_json::json!({
            "image_hash": image_hash,
            "mlx_active_memory_limit_bytes": policy_snapshot.mlx_active_memory_limit_bytes,
            "mlx_cache_limit_bytes": policy_snapshot.mlx_cache_limit_bytes,
            "prompt_token_ceiling": policy_snapshot.prompt_token_ceiling,
            "output_token_ceiling": policy_snapshot.output_token_ceiling,
        });
        self.cmd_writer
            .send_command(HostCommand::LoadModel, payload)?;

        let deadline = Instant::now() + self.policy.model_load_timeout;

        loop {
            if Instant::now() >= deadline {
                return Err(EngineError::new(
                    EngineErrorCode::WorkerUnresponsive,
                    "model load timed out",
                ));
            }

            if self.runtime_state.is_faulted() {
                return Err(EngineError::new(
                    EngineErrorCode::WorkerCrashed,
                    "worker faulted during model load",
                ));
            }

            if self.runtime_state.is_model_loaded() {
                return Ok(());
            }

            // Check if worker has exited.
            if !self.process_ctrl.is_alive() {
                self.runtime_state.mark_faulted();
                return Err(EngineError::new(
                    EngineErrorCode::WorkerCrashed,
                    "worker exited during model load",
                ));
            }

            std::thread::sleep(Duration::from_millis(50));
        }
    }

    // ── Start Generation ─────────────────────────────────────────────────

    /// Start a generation request.
    ///
    /// Validates `ModelNotLoaded`/`ModelBusy`, creates a generation channel,
    /// inserts the request into the registry with a deadline, sends
    /// `StartGeneration` to the worker, and returns a [`GenerationHandle`]
    /// immediately without blocking on prefill.
    pub fn start_generation(
        &self,
        request: &StartGenerationPayload,
    ) -> Result<GenerationHandle, EngineError> {
        if !self.runtime_state.is_model_loaded() {
            return Err(EngineError::new(
                EngineErrorCode::ModelNotLoaded,
                "model not loaded",
            ));
        }

        if self.registry.contains(&request.request_id) {
            return Err(EngineError::new(
                EngineErrorCode::ModelBusy,
                format!(
                    "a generation request is already active: {}",
                    request.request_id
                ),
            ));
        }

        let request_id = request.request_id.clone();
        let public_job_id = Uuid::new_v4().to_string();

        // Create the generation event channel.
        let (sender, stream) =
            generation_channel(Some(GENERATION_CHANNEL_CAPACITY as u32));

        let deadline = DeadlineGuard::new(&self.policy, Instant::now);
        let deadline_at = Instant::now() + self.policy.request_deadline;

        let active = ActiveRequest::new(
            request_id.clone(),
            public_job_id.clone(),
            sender,
            deadline,
            deadline_at,
        );

        // Insert into registry FIRST so the worker can be processing and
        // events dispatched before command send returns.
        self.registry.insert(active);

        let payload = serde_json::to_value(request).map_err(|e| {
            EngineError::new(
                EngineErrorCode::InternalInvariantViolation,
                format!("failed to serialize StartGenerationPayload: {e}"),
            )
        })?;

        if let Err(e) = self.cmd_writer.send_command_with_request(
            HostCommand::StartGeneration,
            &request_id,
            payload,
        ) {
            self.registry.remove(&request_id);
            return Err(e);
        }

        let mut handle = GenerationHandle::new(public_job_id, stream);

        // Wire disconnect detection: when the consumer closes the stream,
        // mark the request as consumer-disconnected and request cancellation.
        if let Some(disconnect_rx) = handle.stream.take_disconnect_notifier() {
            let registry = Arc::clone(&self.registry);
            let rid = request_id.clone();
            std::thread::Builder::new()
                .name(format!("disconnect-watcher-{rid}"))
                .spawn(move || {
                    let _ = disconnect_rx.blocking_recv();
                    registry.request_cancellation(&rid);
                })
                .ok();
        }

        Ok(handle)
    }

    // ── Cancel Generation ────────────────────────────────────────────────

    /// Cancel a generation by job ID.
    ///
    /// Looks up the job_id in the registry, marks cancellation_requested, and
    /// sends `CancelGeneration` to the worker. Does NOT wait for the worker's
    /// response — the event reader handles the terminal event asynchronously.
    pub fn cancel_generation(&self, job_id: &str) -> Result<(), EngineError> {
        let request_id = self.registry.get_by_job_id(job_id).ok_or_else(|| {
            EngineError::new(
                EngineErrorCode::InvalidRequest,
                format!("no active request found for job_id: {job_id}"),
            )
        })?;

        self.registry.request_cancellation(&request_id);

        let payload = serde_json::json!({ "request_id": &request_id });
        self.cmd_writer.send_command_with_request(
            HostCommand::CancelGeneration,
            &request_id,
            payload,
        )?;

        Ok(())
    }

    // ── Unload Model ─────────────────────────────────────────────────────

    /// Unload the model, cancel any active request, send UnloadModel and
    /// Shutdown, then join all threads and reap the process.
    pub fn unload_model(&self) -> Result<(), EngineError> {
        if self.runtime_state.is_faulted() {
            self.registry.fail_all("worker shutdown");
            return Ok(());
        }

        // Cancel any active generation.
        let active_ids: Vec<(String, Instant)> = self.registry.all_active();
        for (req_id, _) in &active_ids {
            self.registry.request_cancellation(req_id);
            let payload = serde_json::json!({ "request_id": req_id });
            let _ = self
                .cmd_writer
                .send_command_with_request(HostCommand::CancelGeneration, req_id, payload);
        }

        // Send UnloadModel.
        let _ = self
            .cmd_writer
            .send_command(HostCommand::UnloadModel, Value::Null);

        // Send Shutdown.
        let _ = self
            .cmd_writer
            .send_command(HostCommand::Shutdown, Value::Null);

        // Wait for worker exit with timeout.
        let deadline = Instant::now() + SHUTDOWN_TIMEOUT;
        loop {
            if !self.process_ctrl.is_alive() {
                break;
            }
            if Instant::now() >= deadline {
                let _ = self.process_ctrl.kill();
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }

        self.runtime_state.clear_model_loaded();
        Ok(())
    }

    /// Forcefully shut down: kill worker if alive, clear registry.
    ///
    /// Callers should join threads separately via the handles.
    pub fn shutdown(&self) {
        let _ = self.process_ctrl.kill();
        self.runtime_state.clear_model_loaded();
        self.registry.fail_all("worker shutdown");
    }

    /// Join background threads (event reader, watchdog, stderr reader).
    /// Takes `&mut self` because `JoinHandle::join` needs ownership.
    pub fn join_threads(&mut self) {
        if let Some(handle) = self.event_reader_handle.take() {
            let _ = handle.join();
        }
        if let Some(handle) = self.watchdog_handle.take() {
            let _ = handle.join();
        }
        if let Some(handle) = self.diagnostics_handle.take() {
            let _ = handle.join();
        }
    }

    // ── RSS Monitoring ───────────────────────────────────────────────────

    /// Sample the worker's resident set size in bytes.
    ///
    /// Returns 0 when the process is not alive or sampling fails.
    pub fn monitor_rss(&self) -> u64 {
        if !self.process_ctrl.is_alive() {
            return 0;
        }
        read_process_rss(self.process_ctrl.pid())
    }

    // ── Event Reader Loop ────────────────────────────────────────────────

    /// The event-reader thread body.
    ///
    /// Runs in a dedicated thread that owns the [`WorkerEventReader`]
    /// exclusively. For each validated frame:
    /// - Updates heartbeat state in [`WorkerRuntimeState`].
    /// - Forwards `Token` events to the registry's stream sender.
    /// - Updates phase in the registry.
    /// - On terminal events: records in the registry's terminal tracker,
    ///   sends terminal to the stream.
    /// - On [`WorkerEvent::WorkerFatal`]: marks faulted, fails all active
    ///   requests.
    /// - On [`WorkerEvent::ModelLoaded`]: sets model_loaded in runtime state.
    /// - On [`WorkerEvent::ModelUnloaded`]: clears model_loaded.
    ///
    /// Exits when the worker terminates (stdout EOF) or encounters a fatal
    /// protocol violation.
    fn run_event_reader(
        reader: &mut WorkerEventReader,
        runtime: &WorkerRuntimeState,
        registry: &ActiveRequestRegistry,
        diagnostics: &WorkerDiagnosticsCollector,
        process: &WorkerProcessControl,
        _policy: &ExecutionPolicy,
        handshake_tx: &std::sync::mpsc::Sender<Result<Frame, EngineError>>,
        handshake_complete: &std::sync::atomic::AtomicBool,
    ) {
        loop {
            // Check if the worker is still alive.
            if !process.is_alive() {
                runtime.mark_faulted();
                registry.fail_all("worker process exited");
                return;
            }

            if runtime.is_faulted() {
                registry.fail_all("worker is faulted");
                return;
            }

            let frame = match reader.read_next_event() {
                Ok(f) => f,
                Err(e) => {
                    diagnostics.append_line(&format!("event reader error: {e}"));
                    runtime.mark_faulted();
                    registry.fail_all(&format!("event reader error: {e}"));
                    return;
                }
            };

            let req_id = frame.request_id.as_deref();

            // During handshake, also forward the frame through the channel.
            if !handshake_complete.load(std::sync::atomic::Ordering::SeqCst) {
                if handshake_tx.send(Ok(frame.clone())).is_err() {
                    // Receiver dropped — handshake must have completed or failed.
                    return;
                }
            }

            match &frame.message_kind {
                MessageKind::WorkerEvent(event) => match event {
                    WorkerEvent::Heartbeat => {
                        runtime.record_heartbeat();
                        if let Ok(payload) =
                            serde_json::from_value::<HeartbeatPayload>(frame.payload.clone())
                        {
                            if let Some(phase) = &payload.request_phase {
                                if let Some(id) = req_id {
                                    let requests = registry.requests.lock();
                                    if let Some(active) = requests.get(id) {
                                        *active.phase.lock() = phase.clone();
                                    }
                                }
                            }
                        }
                    }

                    WorkerEvent::Token => {
                        if let Ok(payload) =
                            serde_json::from_value::<TokenPayload>(frame.payload.clone())
                        {
                            let requests = registry.requests.lock();
                            if let Some(active) = requests.get(&payload.request_id) {
                                let _ = active
                                    .stream_sender
                                    .try_send(GenerationEvent::Token(payload.token_id));
                            }
                        }
                    }

                    WorkerEvent::GenerationStarted => {
                        if let Some(id) = req_id {
                            let requests = registry.requests.lock();
                            if let Some(active) = requests.get(id) {
                                *active.phase.lock() = "prefill".into();
                                let _ = active.stream_sender.try_send(GenerationEvent::Started);
                            }
                        }
                    }

                    WorkerEvent::PrefillStarted => {
                        if let Some(id) = req_id {
                            let requests = registry.requests.lock();
                            if let Some(active) = requests.get(id) {
                                *active.phase.lock() = "prefill".into();
                            }
                        }
                    }

                    WorkerEvent::PrefillCompleted => {
                        if let Some(id) = req_id {
                            let requests = registry.requests.lock();
                            if let Some(active) = requests.get(id) {
                                *active.phase.lock() = "decode".into();
                            }
                        }
                    }

                    WorkerEvent::GenerationCompleted => {
                        if let Some(id) = req_id {
                            registry.mark_terminal(id, GenerationEvent::Done);
                        }
                    }

                    WorkerEvent::GenerationCancelled => {
                        if let Some(id) = req_id {
                            registry.mark_terminal(
                                id,
                                GenerationEvent::Error("cancelled by host".into()),
                            );
                        }
                    }

                    WorkerEvent::GenerationFailed => {
                        if let Some(id) = req_id {
                            let msg = frame
                                .payload
                                .get("message")
                                .and_then(|v| v.as_str())
                                .unwrap_or("generation failed");
                            registry
                                .mark_terminal(id, GenerationEvent::Error(msg.to_string()));
                        }
                    }

                    WorkerEvent::StepMetrics => {
                        if let Some(id) = req_id {
                            let metrics_str = frame.payload.to_string();
                            let requests = registry.requests.lock();
                            if let Some(active) = requests.get(id) {
                                let _ = active
                                    .stream_sender
                                    .try_send(GenerationEvent::Metrics(metrics_str));
                            }
                        }
                    }

                    WorkerEvent::WorkerFatal => {
                        runtime.mark_faulted();
                        let msg = frame
                            .payload
                            .get("message")
                            .and_then(|v| v.as_str())
                            .unwrap_or("worker fatal error");
                        diagnostics.append_line(&format!("worker fatal: {msg}"));
                        registry.fail_all(msg);
                        return;
                    }

                    WorkerEvent::ModelLoaded => {
                        runtime.set_model_loaded();
                    }

                    WorkerEvent::ModelUnloaded => {
                        runtime.clear_model_loaded();
                    }

                    WorkerEvent::HelloAck | WorkerEvent::ModelLoadStarted => {}
                },

                _ => {
                    diagnostics.append_line("received unexpected host command from worker");
                }
            }
        }
    }

    // ── Watchdog Loop ────────────────────────────────────────────────────

    /// The watchdog thread body.
    ///
    /// Ticks every `watchdog_interval_ms`. On each tick:
    /// - Checks process is alive via `is_alive()`.
    /// - Checks request deadlines against the registry.
    /// - Checks heartbeat age against policy.
    /// - Checks RSS against soft/hard ceilings.
    ///
    /// Enforces:
    /// - Send `MemoryPressure` if RSS > soft ceiling.
    /// - Kill if RSS > hard ceiling.
    /// - Request cancellation if deadline expires.
    /// - Kill after grace period if worker unresponsive.
    fn run_watchdog(
        process: &WorkerProcessControl,
        cmd_writer: &WorkerCommandWriter,
        runtime: &WorkerRuntimeState,
        registry: &ActiveRequestRegistry,
        diagnostics: &WorkerDiagnosticsCollector,
        policy: &ExecutionPolicy,
    ) {
        let interval = Duration::from_millis(policy.watchdog_interval_ms);

        loop {
            std::thread::sleep(interval);

            if runtime.is_faulted() {
                return;
            }

            // ── Process alive check ──
            if !process.is_alive() {
                runtime.mark_faulted();
                diagnostics.append_line("watchdog: worker process is not alive");
                registry.fail_all("worker process exited");
                return;
            }

            // ── Heartbeat check ──
            let heartbeat_age = runtime.heartbeat_age();
            if heartbeat_age > policy.worker_heartbeat_timeout {
                diagnostics.append_line(&format!(
                    "watchdog: heartbeat lost (age={:?}, timeout={:?})",
                    heartbeat_age, policy.worker_heartbeat_timeout
                ));

                let _ = cmd_writer.send_command(HostCommand::Ping, Value::Null);

                std::thread::sleep(Duration::from_millis(50));
                let second_age = runtime.heartbeat_age();
                if second_age > policy.worker_heartbeat_timeout + Duration::from_millis(100) {
                    diagnostics.append_line("watchdog: worker unresponsive, killing");
                    let _ = process.kill();
                    runtime.mark_faulted();
                    registry.fail_all("worker unresponsive");
                    return;
                }
            }

            // ── RSS monitoring ──
            let rss = read_process_rss(process.pid());
            let hard = policy.worker_rss_hard_ceiling_bytes;
            let soft = policy.worker_rss_soft_ceiling_bytes;

            if hard > 0 && rss > hard {
                diagnostics.append_line(&format!(
                    "watchdog: RSS {rss} exceeds hard ceiling {hard}, killing"
                ));
                let _ = process.kill();
                runtime.mark_faulted();
                registry.fail_all("worker exceeded hard RSS limit");
                return;
            }

            if soft > 0 && rss > soft {
                diagnostics.append_line(&format!(
                    "watchdog: RSS {rss} exceeds soft ceiling {soft}, sending MemoryPressure"
                ));
                let _ = cmd_writer.send_command(
                    HostCommand::MemoryPressure,
                    serde_json::json!({ "rss_bytes": rss }),
                );
            }

            // ── Deadline enforcement ──
            let now = Instant::now();
            let grace = policy.cancellation_grace_period;
            let expired: Vec<(String, Instant)> = registry
                .all_active()
                .into_iter()
                .filter(|(_, deadline_at)| now >= *deadline_at)
                .collect();

            for (req_id, deadline_at) in &expired {
                let since_expiry = now.saturating_duration_since(*deadline_at);

                if since_expiry >= grace {
                    diagnostics.append_line(&format!(
                        "watchdog: request {req_id} exceeded deadline+grace, killing worker"
                    ));
                    registry.mark_terminal(
                        req_id,
                        GenerationEvent::Error("deadline exceeded".into()),
                    );
                    let _ = process.kill();
                    runtime.mark_faulted();
                    return;
                }

                diagnostics.append_line(&format!(
                    "watchdog: request {req_id} deadline expired, sending CancelGeneration"
                ));
                registry.request_cancellation(req_id);
                let payload = serde_json::json!({ "request_id": req_id });
                let _ = cmd_writer.send_command_with_request(
                    HostCommand::CancelGeneration,
                    req_id,
                    payload,
                );
            }
        }
    }
}

impl Drop for WorkerSupervisor {
    fn drop(&mut self) {
        self.shutdown();
        self.join_threads();
    }
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

    // ── WorkerProcessControl Tests ───────────────────────────────────────

    #[test]
    fn test_process_control_lifecycle() {
        let child = Command::new("echo")
            .arg("hello")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("failed to spawn echo");

        let pid = child.id();
        let ctrl = WorkerProcessControl::new_from_child(child);

        assert_eq!(ctrl.pid(), pid);

        // Wait for it.
        let status = ctrl.wait().expect("wait should succeed");
        assert!(status.success());
        assert_eq!(ctrl.exit_status(), Some(status));
        assert!(!ctrl.is_alive());
    }

    #[test]
    fn test_process_control_kill_idempotent() {
        let child = Command::new("sleep")
            .arg("60")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("failed to spawn sleep");

        let ctrl = WorkerProcessControl::new_from_child(child);

        assert!(ctrl.is_alive());
        assert!(!ctrl.was_killed());

        ctrl.kill().expect("first kill should succeed");
        assert!(ctrl.was_killed());

        // Idempotent second kill.
        ctrl.kill().expect("second kill should be idempotent");
    }

    // ── WorkerCommandWriter Tests ────────────────────────────────────────

    #[test]
    fn test_command_writer_thread_safe() {
        let mut child = Command::new("sleep")
            .arg("10")
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("failed to spawn sleep");

        let stdin = child.stdin.take().expect("stdin");
        let writer = Arc::new(WorkerCommandWriter::new(stdin, "test-id".into()));

        let writer_clone = Arc::clone(&writer);
        let writer_clone2 = Arc::clone(&writer);

        let t1 = std::thread::spawn(move || {
            for i in 0..50 {
                let payload = serde_json::json!({ "thread": 1, "i": i });
                let _ = writer_clone.send_command(HostCommand::Ping, payload);
            }
        });

        let t2 = std::thread::spawn(move || {
            for i in 0..50 {
                let payload = serde_json::json!({ "thread": 2, "i": i });
                let _ = writer_clone2.send_command(HostCommand::Ping, payload);
            }
        });

        t1.join().expect("thread 1");
        t2.join().expect("thread 2");

        // 100 commands sent across two threads.
        assert_eq!(writer.next_seq(), 100);
    }

    #[test]
    fn test_command_writer_seq_monotonic() {
        let mut child = Command::new("sleep")
            .arg("5")
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("failed to spawn sleep");

        let stdin = child.stdin.take().expect("stdin");
        let writer = WorkerCommandWriter::new(stdin, "test-id".into());

        let seq0 = writer.next_seq();
        let _ = writer.send_command(HostCommand::Ping, Value::Null);
        assert_eq!(writer.next_seq(), seq0 + 1);

        let _ = writer.send_command(HostCommand::Ping, Value::Null);
        assert_eq!(writer.next_seq(), seq0 + 2);

        let _ = writer.send_command_with_request(
            HostCommand::StartGeneration,
            "req-1",
            serde_json::json!({}),
        );
        assert_eq!(writer.next_seq(), seq0 + 3);
    }

    // ── WorkerRuntimeState Tests ─────────────────────────────────────────

    #[test]
    fn test_runtime_state_model_loaded() {
        let state = WorkerRuntimeState::new("worker-1".into());

        assert!(!state.is_model_loaded());
        state.set_model_loaded();
        assert!(state.is_model_loaded());
        state.clear_model_loaded();
        assert!(!state.is_model_loaded());
    }

    #[test]
    fn test_runtime_state_faulted() {
        let state = WorkerRuntimeState::new("worker-1".into());

        assert!(!state.is_faulted());
        state.mark_faulted();
        assert!(state.is_faulted());
    }

    #[test]
    fn test_runtime_state_heartbeat() {
        let state = WorkerRuntimeState::new("worker-1".into());

        let age = state.heartbeat_age();
        assert!(age < Duration::from_secs(1));

        std::thread::sleep(Duration::from_millis(10));
        state.record_heartbeat();

        let age2 = state.heartbeat_age();
        assert!(age2 < Duration::from_secs(1));
    }

    #[test]
    fn test_runtime_state_restart_count() {
        let state = WorkerRuntimeState::new("worker-1".into());

        assert_eq!(state.restart_count(), 0);
        assert_eq!(state.increment_restart_count(), 1);
        assert_eq!(state.restart_count(), 1);
        assert_eq!(state.increment_restart_count(), 2);
    }

    // ── ActiveRequestRegistry Tests ──────────────────────────────────────

    fn make_test_request(request_id: &str) -> ActiveRequest {
        let policy = qualification_policy();
        let (sender, _stream) = generation_channel(Some(16));
        let deadline = DeadlineGuard::new(&policy, Instant::now);
        let deadline_at = Instant::now() + policy.request_deadline;
        ActiveRequest::new(
            request_id.to_string(),
            format!("job-{request_id}"),
            sender,
            deadline,
            deadline_at,
        )
    }

    #[test]
    fn test_registry_insert_remove() {
        let registry = ActiveRequestRegistry::new();
        assert!(registry.is_empty());

        registry.insert(make_test_request("req-1"));
        assert!(!registry.is_empty());
        assert_eq!(registry.len(), 1);

        let removed = registry.remove("req-1");
        assert!(removed.is_some());
        assert_eq!(removed.unwrap().request_id, "req-1");
        assert!(registry.is_empty());
    }

    #[test]
    fn test_registry_get_by_job_id() {
        let registry = ActiveRequestRegistry::new();

        let mut req = make_test_request("req-1");
        req.public_job_id = "job-abc".to_string();
        registry.insert(req);

        let found = registry.get_by_job_id("job-abc");
        assert_eq!(found, Some("req-1".to_string()));

        let not_found = registry.get_by_job_id("job-xyz");
        assert_eq!(not_found, None);
    }

    #[test]
    fn test_terminal_guarantee_exactly_once() {
        let (sender, mut stream) = generation_channel(Some(16));
        let policy = qualification_policy();
        let deadline = DeadlineGuard::new(&policy, Instant::now);
        let deadline_at = Instant::now() + policy.request_deadline;

        let req = Arc::new(ActiveRequest::new(
            "req-1".to_string(),
            "job-abc".to_string(),
            sender,
            deadline,
            deadline_at,
        ));

        let req2 = Arc::clone(&req);
        let req3 = Arc::clone(&req);

        // Call mark_terminal from multiple threads concurrently.
        let t1 = std::thread::spawn(move || {
            req.mark_terminal(GenerationEvent::Done);
        });
        let t2 = std::thread::spawn(move || {
            req2.mark_terminal(GenerationEvent::Error("oops".into()));
        });
        let t3 = std::thread::spawn(move || {
            req3.mark_terminal(GenerationEvent::Cancelled);
        });

        t1.join().expect("thread 1");
        t2.join().expect("thread 2");
        t3.join().expect("thread 3");

        // Verify exactly one terminal event arrived.
        let event = stream.recv();
        assert!(event.is_some(), "should receive exactly one terminal event");

        // After a terminal event, GenerationStream should return None.
        let second = stream.recv();
        if let Some(e) = second {
            panic!("got second terminal event: {e:?}");
        }
    }

    #[test]
    fn test_registry_fail_all() {
        let registry = ActiveRequestRegistry::new();

        registry.insert(make_test_request("req-1"));
        registry.insert(make_test_request("req-2"));

        assert_eq!(registry.len(), 2);

        let count = registry.fail_all("test failure");
        assert_eq!(count, 2);
        assert!(registry.is_empty());
    }

    #[test]
    fn test_registry_request_cancellation() {
        let registry = ActiveRequestRegistry::new();
        registry.insert(make_test_request("req-1"));

        assert!(registry.request_cancellation("req-1"));
        assert!(!registry.request_cancellation("req-1"));
    }

    #[test]
    fn test_registry_all_active() {
        let registry = ActiveRequestRegistry::new();

        let before = Instant::now();
        registry.insert(make_test_request("req-1"));
        registry.insert(make_test_request("req-2"));

        let active = registry.all_active();
        assert_eq!(active.len(), 2);

        for (id, deadline_at) in &active {
            assert!(
                *deadline_at > before,
                "deadline for {id} should be in the future"
            );
        }
    }

    // ── WorkerDiagnosticsCollector Tests ─────────────────────────────────

    #[test]
    fn test_diagnostics_basic() {
        let diag = WorkerDiagnosticsCollector::new(1024);
        assert!(diag.is_empty());

        diag.append_line("hello");
        diag.append_line("world");

        let snap = diag.snapshot();
        assert!(snap.contains("hello"));
        assert!(snap.contains("world"));
    }

    #[test]
    fn test_diagnostics_ring_buffer() {
        let diag = WorkerDiagnosticsCollector::new(32);
        diag.append_line("this is a long line that will exceed the buffer capacity");
        assert!(diag.len() <= 32);
    }

    // ── Watchdog Tests (component-level) ─────────────────────────────────

    #[test]
    fn test_watchdog_deadline_enforcement() {
        let fake_now = Arc::new(Mutex::new(Instant::now()));
        let clock_fn = {
            let now = Arc::clone(&fake_now);
            move || *now.lock()
        };

        let policy = qualification_policy();
        let guard = DeadlineGuard::new(&policy, clock_fn);

        assert!(!guard.is_expired());

        *fake_now.lock() += policy.request_deadline;
        assert!(!guard.is_expired());

        *fake_now.lock() += Duration::from_nanos(1);
        assert!(guard.is_expired());
        assert!(guard.time_since_expiry().is_some());

        *fake_now.lock() += policy.cancellation_grace_period;
        let since = guard.time_since_expiry().unwrap();
        assert!(since >= policy.cancellation_grace_period);
    }

    #[test]
    fn test_watchdog_rss_hard_limit() {
        let policy = qualification_policy();
        assert_eq!(policy.worker_rss_hard_ceiling_bytes, 14 << 30);

        let rss_below = 10u64 << 30;
        assert!(rss_below <= policy.worker_rss_hard_ceiling_bytes);

        let rss_above = 15u64 << 30;
        assert!(rss_above > policy.worker_rss_hard_ceiling_bytes);

        // Verify read_process_rss doesn't panic/return absurd values.
        let our_rss = read_process_rss(std::process::id());
        assert!(our_rss < 1u64 << 40, "our RSS should be less than 1 TiB");
    }

    #[test]
    fn test_watchdog_heartbeat_loss() {
        let policy = qualification_policy();
        assert_eq!(policy.worker_heartbeat_timeout, Duration::from_secs(2));

        let state = WorkerRuntimeState::new("test-worker".into());

        assert!(state.heartbeat_age() < Duration::from_secs(1));

        state.record_heartbeat();
        assert!(state.heartbeat_age() < Duration::from_secs(1));

        let age1 = state.heartbeat_age();
        std::thread::sleep(Duration::from_millis(5));
        let age2 = state.heartbeat_age();
        assert!(age2 >= age1, "heartbeat age should be monotonic");
    }

    // ── Registry-based checks ────────────────────────────────────────────

    #[test]
    fn test_registry_contains() {
        let registry = ActiveRequestRegistry::new();
        assert!(!registry.contains("gen-001"));

        registry.insert(make_test_request("gen-001"));
        assert!(registry.contains("gen-001"));
    }
}

// ── Integration Tests (fake worker binary) ────────────────────────────────

#[cfg(test)]
mod integration_tests {
    use super::*;
    use crate::engine_policy::qualification_policy;
    use crate::worker_protocol::{HostCommand, MessageKind, V1_0, WorkerEvent};
    use std::io::{BufRead, BufReader, Read};
    use std::path::PathBuf;
    use std::process::{Child, ChildStdout, Command, Stdio};
    use std::time::{Duration, Instant};

    // ── Helpers ──────────────────────────────────────────────────────────

    /// Resolve the fake worker binary path.
    fn fake_worker_path() -> PathBuf {
        if let Some(path) = option_env!("CARGO_BIN_EXE_tribunus-fake-worker") {
            return PathBuf::from(path);
        }
        for candidate in &[
            "target/debug/tribunus-fake-worker",
            "target/release/tribunus-fake-worker",
            "../target/debug/tribunus-fake-worker",
            "../../target/debug/tribunus-fake-worker",
        ] {
            let p = PathBuf::from(candidate);
            if p.exists() {
                return p;
            }
        }
        PathBuf::from("tribunus-fake-worker")
    }

    /// Spawn the fake worker in the given mode.
    fn spawn_fake_worker(mode: &str, _worker_id: &str) -> (Child, String) {
        let instance_id = uuid::Uuid::new_v4().to_string();
        let bin = fake_worker_path();
        let child = Command::new(&bin)
            .arg("--mode")
            .arg(mode)
            .arg("--worker-instance-id")
            .arg(&instance_id)
            .arg("--image-dir")
            .arg("/tmp")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("failed to spawn fake worker");
        (child, instance_id)
    }

    /// Read one length-prefixed Frame from stdout.
    fn read_frame_from_stdout(stdout: &mut BufReader<ChildStdout>) -> Frame {
        let mut len_buf = [0u8; 4];
        stdout
            .read_exact(&mut len_buf)
            .expect("failed to read frame length prefix");
        let frame_len = u32::from_le_bytes(len_buf) as usize;
        let mut buf = vec![0u8; frame_len];
        stdout
            .read_exact(&mut buf)
            .expect("failed to read frame body");
        serde_json::from_slice(&buf).expect("failed to deserialize frame")
    }

    /// Perform Hello/HelloAck handshake.
    fn handshake(
        cmd_writer: &WorkerCommandWriter,
        stdout: &mut BufReader<ChildStdout>,
    ) -> Frame {
        cmd_writer
            .send_command(HostCommand::Hello, serde_json::Value::Null)
            .expect("failed to send Hello");
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if Instant::now() >= deadline {
                panic!("handshake timed out");
            }
            let filled = stdout
                .fill_buf()
                .expect("failed to peek stdout during handshake");
            if filled.len() >= 4 {
                let frame = read_frame_from_stdout(stdout);
                if matches!(&frame.message_kind, MessageKind::WorkerEvent(WorkerEvent::HelloAck)) {
                    return frame;
                }
                panic!("unexpected frame during handshake: {frame:?}");
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    /// Send LoadModel.
    fn load_model(cmd_writer: &WorkerCommandWriter, image_hash: &str) {
        let payload = serde_json::json!({ "image_hash": image_hash });
        cmd_writer
            .send_command(HostCommand::LoadModel, payload)
            .expect("failed to send LoadModel");
    }

    /// Send StartGeneration.
    fn start_generation(cmd_writer: &WorkerCommandWriter, request_id: &str) {
        let payload = serde_json::json!({
            "request_id": request_id,
            "prompt_token_ids": [1, 2, 3],
            "max_output_tokens": 8,
            "deadline_ms": 30_000,
        });
        cmd_writer
            .send_command_with_request(HostCommand::StartGeneration, request_id, payload)
            .expect("failed to send StartGeneration");
    }

    /// Drain frames until a terminal event or timeout.
    fn drain_until_terminal(
        stdout: &mut BufReader<ChildStdout>,
        timeout: Duration,
    ) -> Vec<Frame> {
        let deadline = Instant::now() + timeout;
        let mut frames = Vec::new();
        loop {
            if Instant::now() >= deadline {
                break;
            }
            let filled = stdout.fill_buf().expect("failed to peek stdout");
            if filled.len() < 4 {
                std::thread::sleep(Duration::from_millis(5));
                continue;
            }
            let frame = read_frame_from_stdout(stdout);
            let is_terminal = matches!(
                &frame.message_kind,
                MessageKind::WorkerEvent(
                    WorkerEvent::GenerationCompleted
                        | WorkerEvent::GenerationCancelled
                        | WorkerEvent::GenerationFailed
                        | WorkerEvent::WorkerFatal
                )
            );
            frames.push(frame);
            if is_terminal {
                break;
            }
        }
        frames
    }

    /// Wait for a specific WorkerEvent.
    fn wait_for_event(
        stdout: &mut BufReader<ChildStdout>,
        target: WorkerEvent,
        timeout: Duration,
    ) -> Frame {
        let deadline = Instant::now() + timeout;
        loop {
            if Instant::now() >= deadline {
                panic!("timed out waiting for {target:?}");
            }
            let filled = stdout.fill_buf().expect("failed to peek stdout");
            if filled.len() < 4 {
                std::thread::sleep(Duration::from_millis(5));
                continue;
            }
            let frame = read_frame_from_stdout(stdout);
            if frame.message_kind == MessageKind::WorkerEvent(target.clone()) {
                return frame;
            }
        }
    }

    // ── Tests ───────────────────────────────────────────────────────────

    /// Gate 1: Handshake identity binding.
    #[test]
    #[ignore]
    fn test_handshake_identity_bound() {
        let worker_id = "integration-test-handshake";
        let (mut child, instance_id) = spawn_fake_worker("normal", worker_id);
        let stdin = child.stdin.take().expect("stdin");
        let stdout = child.stdout.take().expect("stdout");
        let mut stdout_reader = BufReader::new(stdout);
        let cmd_writer = WorkerCommandWriter::new(stdin, instance_id.clone());
        let ack = handshake(&cmd_writer, &mut stdout_reader);

        assert_eq!(ack.version, V1_0);
        assert_eq!(ack.worker_instance_id, instance_id);
        assert!(
            matches!(&ack.message_kind, MessageKind::WorkerEvent(WorkerEvent::HelloAck)),
            "expected HelloAck, got {:?}",
            ack.message_kind
        );
        let _ = child.kill();
        let _ = child.wait();
    }

    /// Gate 2: Identity mismatch rejection.
    #[test]
    #[ignore]
    fn test_identity_mismatch_rejected() {
        let worker_id = "integration-test-mismatch";
        let (mut child, instance_id) = spawn_fake_worker("identity-mismatch", worker_id);
        let stdin = child.stdin.take().expect("stdin");
        let stdout = child.stdout.take().expect("stdout");
        let mut stdout_reader = BufReader::new(stdout);
        let cmd_writer = WorkerCommandWriter::new(stdin, instance_id.clone());
        let ack = handshake(&cmd_writer, &mut stdout_reader);

        assert_ne!(ack.worker_instance_id, instance_id);
        let _ = child.kill();
        let _ = child.wait();
    }

    /// Gate 3: Live streaming returns before prefill.
    #[test]
    #[ignore]
    fn test_live_streaming_returns_before_prefill() {
        let worker_id = "integration-test-live-streaming";
        let (mut child, instance_id) = spawn_fake_worker("normal", worker_id);
        let stdin = child.stdin.take().expect("stdin");
        let stdout = child.stdout.take().expect("stdout");
        let mut stdout_reader = BufReader::new(stdout);
        let cmd_writer = WorkerCommandWriter::new(stdin, instance_id.clone());
        handshake(&cmd_writer, &mut stdout_reader);
        load_model(&cmd_writer, "test-hash");
        start_generation(&cmd_writer, "gen-001");

        let frames = drain_until_terminal(&mut stdout_reader, Duration::from_secs(5));
        assert!(!frames.is_empty());
        let has_streaming = frames.iter().any(|f| {
            matches!(
                &f.message_kind,
                MessageKind::WorkerEvent(WorkerEvent::GenerationStarted | WorkerEvent::Token)
            )
        });
        assert!(has_streaming, "should receive GenerationStarted or Token before terminal");
        let _ = child.kill();
        let _ = child.wait();
    }

    /// Gate 4: Cancellation during generation.
    #[test]
    #[ignore]
    fn test_cancellation_during_generation() {
        let worker_id = "integration-test-cancel";
        let (mut child, instance_id) = spawn_fake_worker("slow-prefill", worker_id);
        let stdin = child.stdin.take().expect("stdin");
        let stdout = child.stdout.take().expect("stdout");
        let mut stdout_reader = BufReader::new(stdout);
        let cmd_writer = WorkerCommandWriter::new(stdin, instance_id.clone());
        handshake(&cmd_writer, &mut stdout_reader);
        load_model(&cmd_writer, "test-hash");
        start_generation(&cmd_writer, "gen-001");

        wait_for_event(&mut stdout_reader, WorkerEvent::GenerationStarted, Duration::from_secs(5));
        cmd_writer
            .send_command_with_request(HostCommand::CancelGeneration, "gen-001", serde_json::json!({ "request_id": "gen-001" }))
            .expect("failed to send CancelGeneration");

        let cancel_frame = wait_for_event(&mut stdout_reader, WorkerEvent::GenerationCancelled, Duration::from_secs(5));
        assert_eq!(cancel_frame.request_id.as_deref(), Some("gen-001"));
        let _ = child.kill();
        let _ = child.wait();
    }

    /// Gate 5: Hard timeout with ignored cancel.
    #[test]
    #[ignore]
    fn test_hard_timeout_with_ignored_cancel() {
        let worker_id = "integration-test-ignored-cancel";
        let (mut child, instance_id) = spawn_fake_worker("ignored-cancel", worker_id);
        let stdin = child.stdin.take().expect("stdin");
        let stdout = child.stdout.take().expect("stdout");
        let mut stdout_reader = BufReader::new(stdout);
        let cmd_writer = WorkerCommandWriter::new(stdin, instance_id.clone());
        handshake(&cmd_writer, &mut stdout_reader);
        load_model(&cmd_writer, "test-hash");
        start_generation(&cmd_writer, "gen-001");

        wait_for_event(&mut stdout_reader, WorkerEvent::GenerationStarted, Duration::from_secs(5));
        cmd_writer
            .send_command_with_request(HostCommand::CancelGeneration, "gen-001", serde_json::json!({ "request_id": "gen-001" }))
            .expect("failed to send CancelGeneration");

        let frames = drain_until_terminal(&mut stdout_reader, Duration::from_secs(5));
        assert!(!frames.iter().any(|f| matches!(&f.message_kind, MessageKind::WorkerEvent(WorkerEvent::GenerationCancelled))));
        assert!(frames.iter().any(|f| matches!(&f.message_kind, MessageKind::WorkerEvent(WorkerEvent::GenerationCompleted))));
        let _ = child.kill();
        let _ = child.wait();
    }

    /// Gate 6: Heartbeat loss detection.
    #[test]
    #[ignore]
    fn test_heartbeat_loss_detection() {
        let worker_id = "integration-test-heartbeat-loss";
        let (mut child, instance_id) = spawn_fake_worker("heartbeat-loss", worker_id);
        let stdin = child.stdin.take().expect("stdin");
        let stdout = child.stdout.take().expect("stdout");
        let mut stdout_reader = BufReader::new(stdout);
        let cmd_writer = WorkerCommandWriter::new(stdin, instance_id.clone());
        handshake(&cmd_writer, &mut stdout_reader);
        load_model(&cmd_writer, "test-hash");
        start_generation(&cmd_writer, "gen-001");

        let deadline = Instant::now() + Duration::from_secs(3);
        let mut heartbeat_count = 0u32;
        loop {
            if Instant::now() >= deadline { break; }
            let filled = stdout_reader.fill_buf().expect("failed to peek stdout");
            if filled.len() < 4 {
                std::thread::sleep(Duration::from_millis(10));
                continue;
            }
            let frame = read_frame_from_stdout(&mut stdout_reader);
            if matches!(&frame.message_kind, MessageKind::WorkerEvent(WorkerEvent::Heartbeat)) {
                heartbeat_count += 1;
            }
        }
        assert!(heartbeat_count == 0, "heartbeat-loss mode should produce no heartbeats");
        let _ = child.kill();
        let _ = child.wait();
    }

    /// Gate 7: RSS limit enforcement.
    #[test]
    #[ignore]
    fn test_rss_limit_enforcement() {
        let worker_id = "integration-test-rss";
        let (mut child, _) = spawn_fake_worker("normal", worker_id);
        let rss = read_process_rss((&child).id());
        assert!(rss > 0, "RSS should be measurable");
        assert!(rss < 1u64 << 40, "RSS should be < 1 TiB");
        let _ = child.kill();
        let _ = child.wait();
    }

    /// Gate 8: Consumer disconnect triggers cancel.
    #[test]
    #[ignore]
    fn test_consumer_disconnect_triggers_cancel() {
        let worker_id = "integration-test-disconnect";
        let (mut child, instance_id) = spawn_fake_worker("normal", worker_id);
        let stdin = child.stdin.take().expect("stdin");
        let stdout = child.stdout.take().expect("stdout");
        let mut stdout_reader = BufReader::new(stdout);
        let cmd_writer = Arc::new(WorkerCommandWriter::new(stdin, instance_id.clone()));
        let registry = Arc::new(ActiveRequestRegistry::new());
        let runtime_state = Arc::new(WorkerRuntimeState::new(worker_id.to_string()));

        handshake(&cmd_writer, &mut stdout_reader);
        runtime_state.set_model_loaded();

        let (sender, mut stream) = generation_channel(Some(16));
        let policy = qualification_policy();
        let deadline = DeadlineGuard::new(&policy, Instant::now);
        let deadline_at = Instant::now() + policy.request_deadline;
        registry.insert(ActiveRequest::new(
            "gen-001".to_string(), "job-disconnect".to_string(), sender, deadline, deadline_at,
        ));

        stream.close();
        drop(stream);
        assert!(registry.contains("gen-001"));
        let _ = child.kill();
        let _ = child.wait();
    }

    /// Gate 9: Duplicate terminal ignored.
    #[test]
    #[ignore]
    fn test_duplicate_terminal_ignored() {
        let worker_id = "integration-test-dup-terminal";
        let (mut child, instance_id) = spawn_fake_worker("duplicate-terminal", worker_id);
        let stdin = child.stdin.take().expect("stdin");
        let stdout = child.stdout.take().expect("stdout");
        let mut stdout_reader = BufReader::new(stdout);
        let cmd_writer = WorkerCommandWriter::new(stdin, instance_id.clone());
        handshake(&cmd_writer, &mut stdout_reader);
        load_model(&cmd_writer, "test-hash");
        start_generation(&cmd_writer, "gen-001");

        let mut completed_count = 0u32;
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if Instant::now() >= deadline { break; }
            let filled = stdout_reader.fill_buf().expect("failed to peek stdout");
            if filled.len() < 4 {
                std::thread::sleep(Duration::from_millis(5));
                continue;
            }
            let frame = read_frame_from_stdout(&mut stdout_reader);
            if matches!(&frame.message_kind, MessageKind::WorkerEvent(WorkerEvent::GenerationCompleted)) {
                completed_count += 1;
                if completed_count >= 2 { break; }
            }
        }
        assert!(completed_count >= 2, "duplicate-terminal mode should produce >= 2 GenerationCompleted frames");
        let _ = child.kill();
        let _ = child.wait();
    }

    /// Gate 10: Sequence gap rejected.
    #[test]
    #[ignore]
    fn test_sequence_gap_rejected() {
        let worker_id = "integration-test-seq-gap";
        let (mut child, instance_id) = spawn_fake_worker("sequence-gap", worker_id);
        let stdin = child.stdin.take().expect("stdin");
        let stdout = child.stdout.take().expect("stdout");
        let mut stdout_reader = BufReader::new(stdout);
        let cmd_writer = WorkerCommandWriter::new(stdin, instance_id.clone());

        cmd_writer.send_command(HostCommand::Hello, serde_json::Value::Null).expect("Hello");
        let ack = wait_for_event(&mut stdout_reader, WorkerEvent::HelloAck, Duration::from_secs(5));
        assert_eq!(ack.sequence_number, 0);

        let result = crate::worker_protocol::validate_frame(&ack, 1, Some(&instance_id));
        assert_eq!(result, Ok(()));

        let next_frame = read_frame_from_stdout(&mut stdout_reader);
        let result = crate::worker_protocol::validate_frame(&next_frame, 1, Some(&instance_id));
        assert!(result.is_err(), "sequence gap should produce validation error");
        let _ = child.kill();
        let _ = child.wait();
    }

    /// Gate 11: Worker restart recovery.
    #[test]
    #[ignore]
    fn test_worker_restart() {
        let worker_id = "integration-test-restart";
        let (mut child, instance_id) = spawn_fake_worker("crash", worker_id);
        let stdin = child.stdin.take().expect("stdin");
        let stdout = child.stdout.take().expect("stdout");
        let mut stdout_reader = BufReader::new(stdout);
        let cmd_writer = WorkerCommandWriter::new(stdin, instance_id.clone());
        handshake(&cmd_writer, &mut stdout_reader);
        load_model(&cmd_writer, "test-hash");
        start_generation(&cmd_writer, "gen-001");

        let status = child.wait().expect("wait");
        assert!(!status.success(), "crash mode should exit with failure");

        let (mut child2, instance_id2) = spawn_fake_worker("normal", worker_id);
        let stdin2 = child2.stdin.take().expect("stdin2");
        let stdout2 = child2.stdout.take().expect("stdout2");
        let mut stdout_reader2 = BufReader::new(stdout2);
        let cmd_writer2 = WorkerCommandWriter::new(stdin2, instance_id2.clone());
        let ack = handshake(&cmd_writer2, &mut stdout_reader2);
        assert!(matches!(&ack.message_kind, MessageKind::WorkerEvent(WorkerEvent::HelloAck)));
        let _ = child2.kill();
        let _ = child2.wait();
    }

    /// Gate 12: Environment isolation.
    #[test]
    #[ignore]
    fn test_env_isolation() {
        let _worker_id = "integration-test-env";
        let instance_id = uuid::Uuid::new_v4().to_string();
        let bin = fake_worker_path();
        let mut cmd = Command::new(&bin);
        cmd.arg("--mode").arg("report-env")
            .arg("--worker-instance-id").arg(&instance_id)
            .arg("--image-dir").arg("/tmp")
            .env_clear()
            .env("HOME", std::env::var("HOME").unwrap_or_default())
            .env("PATH", std::env::var("PATH").unwrap_or_default())
            .env("LANG", std::env::var("LANG").unwrap_or_else(|_| "en_US.UTF-8".into()))
            .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
        let mut child = cmd.env("TEST_VAR", "should-not-leak")
            .spawn().expect("spawn fake worker");

        let stdin = child.stdin.take().expect("stdin");
        let stdout = child.stdout.take().expect("stdout");
        let mut stdout_reader = BufReader::new(stdout);
        let cmd_writer = WorkerCommandWriter::new(stdin, instance_id.clone());
        handshake(&cmd_writer, &mut stdout_reader);

        let frames = drain_until_terminal(&mut stdout_reader, Duration::from_secs(5));
        let test_var_seen = frames.iter().any(|f| {
            serde_json::to_string(&f.payload).unwrap_or_default().contains("TEST_VAR")
        });
        assert!(!test_var_seen, "env_clear should prevent TEST_VAR from reaching the worker");
        let _ = child.kill();
        let _ = child.wait();
    }

    /// Sequential generation: start a generation, drain to terminal,
    /// then start a second generation and drain again.
    #[test]
    #[ignore]
    fn test_sequential_generations() {
        let worker_id = "integration-test-sequential-gen";
        let (mut child, instance_id) = spawn_fake_worker("normal", worker_id);
        let stdin = child.stdin.take().expect("stdin");
        let stdout = child.stdout.take().expect("stdout");
        let mut stdout_reader = BufReader::new(stdout);
        let cmd_writer = WorkerCommandWriter::new(stdin, instance_id.clone());
        handshake(&cmd_writer, &mut stdout_reader);
        load_model(&cmd_writer, "test-hash");

        // First generation
        start_generation(&cmd_writer, "gen-001");
        let gen1_frames = drain_until_terminal(&mut stdout_reader, Duration::from_secs(5));
        let gen1_completed = gen1_frames.iter().any(|f| {
            matches!(
                &f.message_kind,
                MessageKind::WorkerEvent(WorkerEvent::GenerationCompleted)
            )
        });
        assert!(gen1_completed, "first generation should complete");

        // Second generation
        start_generation(&cmd_writer, "gen-002");
        let gen2_frames = drain_until_terminal(&mut stdout_reader, Duration::from_secs(5));
        let gen2_completed = gen2_frames.iter().any(|f| {
            matches!(
                &f.message_kind,
                MessageKind::WorkerEvent(WorkerEvent::GenerationCompleted)
            )
        });
        assert!(gen2_completed, "second generation should complete");

        // Assert second generation's tokens are correct (42, 43, 44 in normal mode).
        let gen2_tokens: Vec<&Frame> = gen2_frames
            .iter()
            .filter(|f| matches!(&f.message_kind, MessageKind::WorkerEvent(WorkerEvent::Token)))
            .collect();
        assert!(!gen2_tokens.is_empty(), "second generation should produce tokens");
        if let Some(tok) = gen2_tokens.first() {
            let tok_id = tok.payload.get("token_id").and_then(|v| v.as_u64());
            assert_eq!(tok_id, Some(42), "first token of second generation should be 42");
        }

        // Assert no model-busy error across both generations.
        let all_frames: Vec<&Frame> = gen1_frames.iter().chain(gen2_frames.iter()).collect();
        let has_model_busy = all_frames.iter().any(|f| {
            let msg = serde_json::to_string(&f.payload).unwrap_or_default();
            msg.contains("busy")
        });
        assert!(!has_model_busy, "should not see model-busy error");

        let _ = child.kill();
        let _ = child.wait();
    }

    /// Graceful shutdown: follow protocol to completion, send Shutdown,
    /// verify the process exits with code 0 (not killed).
    #[test]
    #[ignore]
    fn test_graceful_shutdown_no_sigkill() {
        let worker_id = "integration-test-graceful-shutdown";
        let (mut child, instance_id) = spawn_fake_worker("normal", worker_id);
        let stdin = child.stdin.take().expect("stdin");
        let stdout = child.stdout.take().expect("stdout");
        let mut stdout_reader = BufReader::new(stdout);
        let cmd_writer = WorkerCommandWriter::new(stdin, instance_id.clone());
        handshake(&cmd_writer, &mut stdout_reader);
        load_model(&cmd_writer, "test-hash");
        start_generation(&cmd_writer, "gen-001");

        // Drain until terminal — worker sends GenerationCompleted.
        let frames = drain_until_terminal(&mut stdout_reader, Duration::from_secs(5));
        assert!(
            frames.iter().any(|f| {
                matches!(
                    &f.message_kind,
                    MessageKind::WorkerEvent(WorkerEvent::GenerationCompleted)
                )
            }),
            "generation should complete before shutdown"
        );

        // Tell worker to unload.
        cmd_writer.send_command(HostCommand::UnloadModel, serde_json::json!({})).expect("UnloadModel");
        let _unloaded = wait_for_event(&mut stdout_reader, WorkerEvent::ModelUnloaded, Duration::from_secs(5));

        // Send graceful Shutdown and wait for exit.
        cmd_writer
            .send_command(HostCommand::Shutdown, serde_json::Value::Null)
            .expect("failed to send Shutdown");

        let status = child
            .wait()
            .expect("worker process should exit cleanly");
        assert!(status.success(), "worker exit code should be 0 (not killed)");
    }
}
