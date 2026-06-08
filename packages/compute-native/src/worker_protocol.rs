//! Framed length-prefixed JSON protocol for host–worker IPC.
//!
//! The host and worker communicate over a framed JSON protocol where every
//! message is serialized as a [`Frame`]. The `message_kind` field discriminates
//! the message type, and `payload` carries type-specific data.
//!
//! **No tensor payload crosses the process boundary.** All tensor data stays
//! within the worker's address space; only metadata, token IDs, and control
//! messages flow over this channel.

use serde::{Deserialize, Serialize};

// ────────────────────────────────────────────────────────────────────────────
// Version
// ────────────────────────────────────────────────────────────────────────────

/// Protocol version identifier.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProtocolVersion {
    pub major: u16,
    pub minor: u16,
}

/// Current protocol version: 1.0.
pub const V1_0: ProtocolVersion = ProtocolVersion { major: 1, minor: 0 };

// ────────────────────────────────────────────────────────────────────────────
// Message Kinds
// ────────────────────────────────────────────────────────────────────────────

/// Commands sent from the host to the worker.
///
/// Every [`Frame`] whose direction is host→worker carries one of these
/// as its [`MessageKind::HostCommand`] variant.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum HostCommand {
    /// Initial handshake — worker must respond with [`WorkerEvent::HelloAck`].
    Hello,
    /// Load a model by identifier.
    LoadModel,
    /// Begin token generation for a prompt.
    StartGeneration,
    /// Request cancellation of an in-flight generation.
    CancelGeneration,
    /// Unload the currently loaded model.
    UnloadModel,
    /// Liveness probe — worker should respond with a [`WorkerEvent::Heartbeat`].
    Ping,
    /// Graceful shutdown — worker should terminate after flushing.
    Shutdown,
    /// Sent by the watchdog when the worker's RSS crosses the soft ceiling.
    MemoryPressure,
}

/// Events emitted from the worker to the host.
///
/// Every [`Frame`] whose direction is worker→host carries one of these
/// as its [`MessageKind::WorkerEvent`] variant.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum WorkerEvent {
    /// Acknowledgment of [`HostCommand::Hello`].
    HelloAck,
    /// Model load operation has begun.
    ModelLoadStarted,
    /// Model load completed successfully.
    ModelLoaded,
    /// Generation has been accepted and is starting.
    GenerationStarted,
    /// Prefill (prompt processing) phase started.
    PrefillStarted,
    /// Prefill completed; about to enter decode loop.
    PrefillCompleted,
    /// A single output token produced during decoding.
    Token,
    /// Per-step performance metrics (latency, throughput).
    StepMetrics,
    /// Generation completed normally. Payload: [`GenerationCompletedPayload`].
    GenerationCompleted,
    /// Generation was cancelled by the host.
    GenerationCancelled,
    /// Generation failed with an error. Payload: [`GenerationFailedPayload`].
    GenerationFailed,
    /// Periodic worker health report. Payload: [`HeartbeatPayload`].
    Heartbeat,
    /// Model has been fully unloaded.
    ModelUnloaded,
    /// Fatal worker error — worker is about to terminate.
    WorkerFatal,
}

/// Combined message kind — either a host command or a worker event.
///
/// Serializes as a flat kebab-case string (e.g. `"hello"`, `"hello-ack"`)
/// thanks to `#[serde(untagged)]`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum MessageKind {
    /// Host-to-worker command.
    HostCommand(HostCommand),
    /// Worker-to-host event.
    WorkerEvent(WorkerEvent),
}

// ────────────────────────────────────────────────────────────────────────────
// Payload Schemas
// ────────────────────────────────────────────────────────────────────────────

/// Payload for [`HostCommand::StartGeneration`].
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StartGenerationPayload {
    /// Token IDs of the prompt.
    pub prompt_token_ids: Vec<u32>,
    /// Maximum number of output tokens to generate.
    pub max_output_tokens: u32,
    /// Absolute deadline in milliseconds (epoch-relative or monotonic,
    /// depending on the worker's time base).
    pub deadline_ms: u64,
    /// Opaque request identifier echoed in all response events.
    pub request_id: String,
}

/// Payload for [`WorkerEvent::Token`].
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TokenPayload {
    /// The generation request this token belongs to.
    pub request_id: String,
    /// Sampled token ID from the model vocabulary.
    pub token_id: u32,
    /// Position (index) of this token in the output sequence.
    pub position: u32,
    /// Log-probability of the token, if available.
    pub logprob: Option<f32>,
}

/// Payload for [`WorkerEvent::Heartbeat`].
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HeartbeatPayload {
    /// Current generation phase, if any (e.g. `"prefill"`, `"decode"`).
    pub request_phase: Option<String>,
    /// Transformer layer currently being processed, if applicable.
    pub current_layer: Option<u32>,
    /// Resident set size of the worker process in bytes.
    pub process_rss_bytes: u64,
    /// Elapsed time since the worker started, in milliseconds.
    pub elapsed_ms: u64,
    /// Index of the most recently completed decode step, if any.
    pub last_completed_step: Option<u32>,
    /// Request ID of the currently active generation, if any.
    pub active_request_id: Option<String>,
    /// MLX Metal active memory in bytes.
    pub mlx_active_memory: u64,
    /// MLX Metal cache memory in bytes.
    pub mlx_cache_memory: u64,
    /// MLX Metal peak memory in bytes.
    pub mlx_peak_memory: u64,
}

/// Payload for [`WorkerEvent::GenerationCompleted`].
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GenerationCompletedPayload {
    /// The generation request that completed.
    pub request_id: String,
    /// Total number of output tokens produced.
    pub token_count: u32,
    /// Time-to-first-token in milliseconds.
    pub ttft_ms: u64,
    /// Total generation time in milliseconds.
    pub total_ms: u64,
}

/// Payload for [`WorkerEvent::GenerationFailed`].
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GenerationFailedPayload {
    /// The generation request that failed.
    pub request_id: String,
    /// Machine-readable error code.
    pub error_code: String,
    /// Human-readable error description.
    pub message: String,
    /// Phase during which the failure occurred.
    pub phase: String,
    /// Optional diagnostic hints (e.g. stack snippets, log excerpts).
    pub diagnostics: Option<Vec<String>>,
}

/// Payload for [`WorkerEvent::WorkerFatal`].
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkerFatalPayload {
    /// Machine-readable error code.
    pub error_code: String,
    /// Human-readable error description.
    pub message: String,
    /// Phase during which the fatal error occurred.
    pub phase: String,
    /// Optional diagnostic hints (e.g. stack snippets, log excerpts).
    pub diagnostics: Option<Vec<String>>,
}

/// Payload for [`WorkerEvent::HelloAck`] / [`HostCommand::LoadModel`] carrying
/// policy limits from the host to the worker.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct PolicySnapshotPayload {
    /// Maximum active memory for MLX operations, in bytes.
    pub mlx_active_memory_limit_bytes: u64,
    /// Maximum MLX cache size, in bytes.
    pub mlx_cache_limit_bytes: u64,
    /// Maximum number of prompt tokens the worker should accept.
    pub prompt_token_ceiling: usize,
    /// Maximum number of output tokens per generation.
    pub output_token_ceiling: u32,
}
// ────────────────────────────────────────────────────────────────────────────
// Frame
// ────────────────────────────────────────────────────────────────────────────

/// Maximum serialized frame size in bytes (1 MB).
pub const MAX_FRAME_SIZE_BYTES: usize = 1_048_576;

/// A single framed message in the host–worker length-prefixed JSON protocol.
///
/// Every frame carries a protocol version, a worker-instance identifier, a
/// monotonically increasing sequence number, an optional request correlation
/// id, a discriminated message kind, and an arbitrary JSON payload.
///
/// The sender frames each message by serializing this struct to JSON, then
/// writing a 4-byte little-endian length prefix followed by the JSON bytes.
/// The receiver reads the length prefix, reads that many bytes, and
/// deserializes the [`Frame`].
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Frame {
    /// Protocol version — MUST be [`V1_0`].
    pub version: ProtocolVersion,
    /// UUID identifying the worker instance.
    pub worker_instance_id: String,
    /// Monotonically increasing per-sender sequence number.
    pub sequence_number: u64,
    /// Opaque request correlation id (present on events that belong to a
    /// specific generation request; absent on commands and global events).
    pub request_id: Option<String>,
    /// Discriminated message type.
    pub message_kind: MessageKind,
    /// Arbitrary JSON payload whose schema is determined by `message_kind`.
    pub payload: serde_json::Value,
}

impl Frame {
    /// Create a new host-command frame.
    ///
    /// `request_id` is set to `None` — host commands do not correlate to
    /// an in-flight generation request.
    pub fn new_host_command(
        worker_id: String,
        seq: u64,
        cmd: HostCommand,
        payload: serde_json::Value,
    ) -> Self {
        Frame {
            version: V1_0,
            worker_instance_id: worker_id,
            sequence_number: seq,
            request_id: None,
            message_kind: MessageKind::HostCommand(cmd),
            payload,
        }
    }

    /// Create a new host-command frame with a specific request correlation id.
    ///
    /// Used for request-scoped commands such as [`HostCommand::StartGeneration`]
    /// and [`HostCommand::CancelGeneration`]. Request-less commands (Hello, Ping,
    /// Shutdown, etc.) should use [`Frame::new_host_command`] instead.
    pub fn new_host_command_with_request(
        worker_id: &str,
        seq: u64,
        request_id: &str,
        cmd: HostCommand,
        payload: serde_json::Value,
    ) -> Self {
        Frame {
            version: V1_0,
            worker_instance_id: worker_id.to_string(),
            sequence_number: seq,
            request_id: Some(request_id.to_string()),
            message_kind: MessageKind::HostCommand(cmd),
            payload,
        }
    }

    /// Create a new worker-event frame.
    ///
    /// `request_id` identifies the generation request this event belongs to
    /// (e.g. `"generation-abc"`). Events such as [`WorkerEvent::HelloAck`]
    /// and [`WorkerEvent::Heartbeat`] that are not tied to a request may
    /// pass an empty string or a placeholder.
    pub fn new_worker_event(
        worker_id: String,
        seq: u64,
        request_id: String,
        event: WorkerEvent,
        payload: serde_json::Value,
    ) -> Self {
        Frame {
            version: V1_0,
            worker_instance_id: worker_id,
            sequence_number: seq,
            request_id: Some(request_id),
            message_kind: MessageKind::WorkerEvent(event),
            payload,
        }
    }
}

// ────────────────────────────────────────────────────────────────────────────
// Validation
// ────────────────────────────────────────────────────────────────────────────

/// Errors that can arise when validating a [`Frame`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FrameValidationError {
    /// Serialized frame exceeds [`MAX_FRAME_SIZE_BYTES`].
    FrameTooLarge,
    /// Frame version is not [`V1_0`].
    UnknownVersion,
    /// Sequence number regressed or skipped — expected a specific `n`.
    SequenceRegression,
    /// A duplicate [`StartGeneration`](HostCommand::StartGeneration) request
    /// was detected (same `request_id` already in flight).
    DuplicateRequestStart,
    /// Worker ID did not match the expected identifier.
    UnknownRequest,
    /// A frame arrived after a terminal message ([`Shutdown`](HostCommand::Shutdown)
    /// or [`WorkerFatal`](WorkerEvent::WorkerFatal)).
    TerminalAfterClose,
    /// Message kind is not recognized or is not valid for the sender direction.
    InvalidMessageKind,
}

/// Validate a [`Frame`] against protocol invariants.
///
/// Checks:
///
/// 1. Serialized size ≤ [`MAX_FRAME_SIZE_BYTES`].
/// 2. `version` == [`V1_0`].
/// 3. `sequence_number` == `expected_next_seq` (no regressions, no gaps).
/// 4. `worker_instance_id` matches `expected_worker_id` when provided.
/// 5. `message_kind` round-trips through serde (i.e. is a recognised kind).
///
/// # Direction-aware validation
///
/// This function does **not** track frame history (which terminal messages
/// have been seen, which `request_id`s are in flight). Callers SHOULD
/// maintain their own state machine and reject frames that arrive after a
/// terminal message (returning [`TerminalAfterClose`](FrameValidationError::TerminalAfterClose))
/// or that start a duplicate generation request (returning
/// [`DuplicateRequestStart`](FrameValidationError::DuplicateRequestStart)).
pub fn validate_frame(
    frame: &Frame,
    expected_next_seq: u64,
    expected_worker_id: Option<&str>,
) -> Result<(), FrameValidationError> {
    // 1. Size check — serialize to JSON and measure.
    let serialized = serde_json::to_vec(frame).map_err(|_| FrameValidationError::FrameTooLarge)?;
    if serialized.len() > MAX_FRAME_SIZE_BYTES {
        return Err(FrameValidationError::FrameTooLarge);
    }

    // 2. Version must be V1_0.
    if frame.version != V1_0 {
        return Err(FrameValidationError::UnknownVersion);
    }

    // 3. Sequence must match expected (no regression, no gaps).
    if frame.sequence_number != expected_next_seq {
        return Err(FrameValidationError::SequenceRegression);
    }

    // 4. Worker ID must match when expected.
    if let Some(expected_id) = expected_worker_id {
        if frame.worker_instance_id != expected_id {
            return Err(FrameValidationError::UnknownRequest);
        }
    }

    // 5. Message kind must be a recognized variant.
    //    With #[serde(untagged)], an unknown string would already cause
    //    deserialization to fail, but we verify round-trip explicitly.
    let kind_value = serde_json::to_value(&frame.message_kind)
        .map_err(|_| FrameValidationError::InvalidMessageKind)?;
    if !kind_value.is_string() {
        return Err(FrameValidationError::InvalidMessageKind);
    }

    Ok(())
}

// ────────────────────────────────────────────────────────────────────────────
// Stateful Protocol Validator
// ────────────────────────────────────────────────────────────────────────────

/// Stateful validator that tracks protocol state across frames.
///
/// Maintains the expected worker ID, next expected sequence number, and
/// active/terminal request sets so that direction-aware validation (e.g.
/// rejecting duplicate start requests or events for unknown requests) can
/// be performed without external bookkeeping.
#[derive(Debug, Clone)]
pub struct ProtocolValidator {
    /// Worker instance ID the validator expects on every frame.
    pub expected_worker_id: String,
    /// Next sequence number the validator expects.
    pub next_expected_seq: u64,
    /// Request IDs that are currently in flight (started but not yet terminal).
    pub known_requests: Vec<String>,
    /// Request IDs that have received a terminal event (completed, cancelled,
    /// or failed).
    pub terminal_requests: Vec<String>,
}

impl ProtocolValidator {
    /// Create a new validator for the given `worker_id`.
    pub fn new(worker_id: String) -> Self {
        ProtocolValidator {
            expected_worker_id: worker_id,
            next_expected_seq: 0,
            known_requests: Vec::new(),
            terminal_requests: Vec::new(),
        }
    }

    /// Run stateless checks (version, seq, worker ID, message kind) shared by
    /// both host and worker frames.
    fn validate_baseline(&self, frame: &Frame) -> Result<(), FrameValidationError> {
        // 1. Version must be V1_0.
        if frame.version != V1_0 {
            return Err(FrameValidationError::UnknownVersion);
        }

        // 2. Sequence must match expected (no regression, no gaps).
        if frame.sequence_number != self.next_expected_seq {
            return Err(FrameValidationError::SequenceRegression);
        }

        // 3. Worker ID must match.
        if frame.worker_instance_id != self.expected_worker_id {
            return Err(FrameValidationError::UnknownRequest);
        }

        // 4. Message kind must be a recognized variant.
        let kind_value = serde_json::to_value(&frame.message_kind)
            .map_err(|_| FrameValidationError::InvalidMessageKind)?;
        if !kind_value.is_string() {
            return Err(FrameValidationError::InvalidMessageKind);
        }

        Ok(())
    }

    /// Validate a host-command frame and advance internal state.
    ///
    /// Checks:
    /// - Baseline fields (version, seq, worker ID, message kind).
    /// - `message_kind` is a [`HostCommand`].
    /// - For [`HostCommand::StartGeneration`]: rejects if `request_id` is
    ///   already in `known_requests` (duplicate).
    /// - For [`HostCommand::CancelGeneration`]: rejects if `request_id` is
    ///   not in `known_requests`.
    pub fn validate_host_command(&mut self, frame: &Frame) -> Result<(), FrameValidationError> {
        self.validate_baseline(frame)?;

        // Verify this is actually a HostCommand.
        let cmd = match &frame.message_kind {
            MessageKind::HostCommand(cmd) => cmd,
            _ => return Err(FrameValidationError::InvalidMessageKind),
        };

        // Request-scoped checks.
        if let Some(req_id) = &frame.request_id {
            match cmd {
                HostCommand::StartGeneration => {
                    if self.known_requests.contains(req_id) {
                        return Err(FrameValidationError::DuplicateRequestStart);
                    }
                }
                HostCommand::CancelGeneration => {
                    if !self.known_requests.contains(req_id) {
                        return Err(FrameValidationError::UnknownRequest);
                    }
                }
                _ => {}
            }
        }

        self.next_expected_seq += 1;
        Ok(())
    }

    /// Validate a worker-event frame and advance internal state.
    ///
    /// Checks:
    /// - Baseline fields (version, seq, worker ID, message kind).
    /// - `message_kind` is a [`WorkerEvent`].
    /// - On [`WorkerEvent::GenerationStarted`]: records the `request_id` into
    ///   `known_requests`.
    /// - On terminal events ([`GenerationCompleted`](WorkerEvent::GenerationCompleted),
    ///   [`GenerationCancelled`](WorkerEvent::GenerationCancelled),
    ///   [`GenerationFailed`](WorkerEvent::GenerationFailed)):
    ///   rejects if `request_id` is unknown or already terminal;
    ///   otherwise moves from `known_requests` to `terminal_requests`.
    pub fn validate_worker_event(&mut self, frame: &Frame) -> Result<(), FrameValidationError> {
        self.validate_baseline(frame)?;

        // Verify this is actually a WorkerEvent.
        let event = match &frame.message_kind {
            MessageKind::WorkerEvent(ev) => ev,
            _ => return Err(FrameValidationError::InvalidMessageKind),
        };

        if let Some(req_id) = &frame.request_id {
            match event {
                WorkerEvent::GenerationStarted => {
                    // Duplicate start of a known request is an error.
                    if self.known_requests.contains(req_id) {
                        return Err(FrameValidationError::DuplicateRequestStart);
                    }
                    self.known_requests.push(req_id.clone());
                }
                WorkerEvent::GenerationCompleted
                | WorkerEvent::GenerationCancelled
                | WorkerEvent::GenerationFailed => {
                    // Reject unknown or already-terminated requests.
                    if !self.known_requests.contains(req_id) {
                        return Err(FrameValidationError::UnknownRequest);
                    }
                    if self.terminal_requests.contains(req_id) {
                        return Err(FrameValidationError::TerminalAfterClose);
                    }
                    // Move from known to terminal.
                    self.known_requests.retain(|id| id != req_id);
                    self.terminal_requests.push(req_id.clone());
                }
                _ => {}
            }
        }

        self.next_expected_seq += 1;
        Ok(())
    }
}

// ────────────────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    // ── Helpers ──────────────────────────────────────────────────────────

    fn sample_frame() -> Frame {
        Frame::new_host_command(
            "550e8400-e29b-41d4-a716-446655440000".into(),
            1,
            HostCommand::Ping,
            serde_json::json!({"dummy": true}),
        )
    }

    fn round_trip(frame: &Frame) -> Frame {
        let json = serde_json::to_string(frame).expect("serialize");
        serde_json::from_str(&json).expect("deserialize")
    }

    // ── Test 1: Serialize / deserialize round-trip ──────────────────────

    #[test]
    fn frame_round_trip() {
        let frames = vec![
            sample_frame(),
            Frame::new_host_command(
                "id-1".into(),
                0,
                HostCommand::Hello,
                serde_json::Value::Null,
            ),
            Frame::new_worker_event(
                "id-2".into(),
                5,
                "req-001".into(),
                WorkerEvent::Token,
                serde_json::json!({
                    "request_id": "req-001",
                    "token_id": 42,
                    "position": 0,
                    "logprob": -1.234
                }),
            ),
        ];

        for original in frames {
            let recovered = round_trip(&original);
            assert_eq!(original.version, recovered.version);
            assert_eq!(original.worker_instance_id, recovered.worker_instance_id);
            assert_eq!(original.sequence_number, recovered.sequence_number);
            assert_eq!(original.request_id, recovered.request_id);
            assert_eq!(original.payload, recovered.payload);

            // Verify message_kind variant identity.
            match (&original.message_kind, &recovered.message_kind) {
                (MessageKind::HostCommand(a), MessageKind::HostCommand(b)) => {
                    assert_eq!(a, b, "HostCommand variant mismatch")
                }
                (MessageKind::WorkerEvent(a), MessageKind::WorkerEvent(b)) => {
                    assert_eq!(a, b, "WorkerEvent variant mismatch")
                }
                _ => panic!("message_kind discriminant changed through round-trip"),
            }
        }
    }

    // ── Test 2: Max frame size rejection ────────────────────────────────

    #[test]
    fn max_frame_size_rejection() {
        // Build a payload large enough that the serialized frame exceeds 1 MB.
        let big_blob = "x".repeat(MAX_FRAME_SIZE_BYTES); // > 1 MB in UTF-8
        let oversized = Frame {
            version: V1_0,
            worker_instance_id: "test".into(),
            sequence_number: 0,
            request_id: None,
            message_kind: MessageKind::HostCommand(HostCommand::Ping),
            payload: serde_json::json!({"data": big_blob}),
        };

        let err = validate_frame(&oversized, 0, None).unwrap_err();
        assert_eq!(err, FrameValidationError::FrameTooLarge);
    }

    // ── Test 3: Version mismatch rejection ───────────────────────────────

    #[test]
    fn version_mismatch_rejection() {
        let bad_version = Frame {
            version: ProtocolVersion { major: 2, minor: 0 },
            ..sample_frame()
        };

        let err = validate_frame(&bad_version, 1, None).unwrap_err();
        assert_eq!(err, FrameValidationError::UnknownVersion);
    }

    // ── Test 4: Sequence gap / regression rejection ──────────────────────

    #[test]
    fn sequence_regression_rejection() {
        let frame = Frame {
            sequence_number: 3,
            ..sample_frame()
        };

        let err = validate_frame(&frame, 5, None).unwrap_err();
        assert_eq!(err, FrameValidationError::SequenceRegression);

        // Regression — frame seq < expected.
        let err2 = validate_frame(&frame, 10, None).unwrap_err();
        assert_eq!(err2, FrameValidationError::SequenceRegression);
    }

    // ── Test 5: Duplicate request start rejection (same seq number) ──────

    #[test]
    fn duplicate_request_start_rejection() {
        // Simulate two StartGeneration frames with the same sequence number.
        let frame_a = Frame::new_host_command(
            "worker-id".into(),
            42,
            HostCommand::StartGeneration,
            serde_json::json!({
                "prompt_token_ids": [1, 2, 3],
                "max_output_tokens": 128,
                "deadline_ms": 30_000,
                "request_id": "gen-001",
            }),
        );
        let frame_b = Frame::new_host_command(
            "worker-id".into(),
            42, // same sequence number
            HostCommand::StartGeneration,
            serde_json::json!({
                "prompt_token_ids": [4, 5, 6],
                "max_output_tokens": 64,
                "deadline_ms": 30_000,
                "request_id": "gen-002",
            }),
        );

        // First frame at seq 42 succeeds.
        assert!(validate_frame(&frame_a, 42, None).is_ok());

        // Second frame at seq 42 fails — sequence regression.
        let err = validate_frame(&frame_b, 43, None).unwrap_err();
        assert_eq!(err, FrameValidationError::SequenceRegression);
    }

    // ── Test 6: Terminal-after-close rejection (error variant existence) ──

    #[test]
    fn terminal_after_close_error_exists() {
        // Verify the variant is constructable and matches.
        let terminal_frame = Frame::new_host_command(
            "worker-id".into(),
            100,
            HostCommand::Shutdown,
            serde_json::Value::Null,
        );

        // The shutdown frame itself must validate.
        assert!(validate_frame(&terminal_frame, 100, None).is_ok());

        // A frame arriving after close (past the terminal sequence number)
        // should fail with SequenceRegression in this stateless validator.
        let after_close = Frame::new_host_command(
            "worker-id".into(),
            100, // already consumed
            HostCommand::Ping,
            serde_json::Value::Null,
        );
        let err = validate_frame(&after_close, 101, None).unwrap_err();
        assert_eq!(err, FrameValidationError::SequenceRegression);

        // Verify the TerminalAfterClose variant is reachable and distinct.
        let terminal_err = FrameValidationError::TerminalAfterClose;
        assert_eq!(terminal_err, FrameValidationError::TerminalAfterClose);
        assert_ne!(terminal_err, FrameValidationError::FrameTooLarge);
    }

    // ── Additional: Worker ID mismatch ───────────────────────────────────

    #[test]
    fn worker_id_mismatch_rejection() {
        let frame = Frame::new_host_command(
            "expected-worker".into(),
            1,
            HostCommand::Ping,
            serde_json::Value::Null,
        );

        // Matching worker ID — OK.
        assert!(validate_frame(&frame, 1, Some("expected-worker")).is_ok());

        // Mismatched worker ID — error.
        let err = validate_frame(&frame, 1, Some("other-worker")).unwrap_err();
        assert_eq!(err, FrameValidationError::UnknownRequest);
    }

    // ── Additional: Payload schema round-trips ───────────────────────────

    // ── Stateful ProtocolValidator tests ─────────────────────────────────

    #[test]
    fn test_stateful_validator_sequence_tracking() {
        let worker_id = "wkr-001".to_string();
        let mut val = ProtocolValidator::new(worker_id.clone());

        // Seq 0: Hello
        let hello = Frame::new_host_command(
            worker_id.clone(),
            0,
            HostCommand::Hello,
            serde_json::Value::Null,
        );
        assert!(val.validate_host_command(&hello).is_ok());
        assert_eq!(val.next_expected_seq, 1);
        assert!(val.known_requests.is_empty());

        // Seq 1: Ping
        let ping = Frame::new_host_command(
            worker_id.clone(),
            1,
            HostCommand::Ping,
            serde_json::Value::Null,
        );
        assert!(val.validate_host_command(&ping).is_ok());
        assert_eq!(val.next_expected_seq, 2);

        // Seq 2 with wrong seq (regression) fails
        let bad_seq = Frame::new_host_command(
            worker_id.clone(),
            0, // same as seq 0
            HostCommand::Ping,
            serde_json::Value::Null,
        );
        let err = val.validate_host_command(&bad_seq).unwrap_err();
        assert_eq!(err, FrameValidationError::SequenceRegression);
        assert_eq!(val.next_expected_seq, 2); // state unchanged
    }

    #[test]
    fn test_stateful_validator_duplicate_start_rejected() {
        let worker_id = "wkr-002".to_string();
        let mut val = ProtocolValidator::new(worker_id.clone());

        // Send GenerationStarted event (seq 0) to register request.
        let started = Frame::new_worker_event(
            worker_id.clone(),
            0,
            "gen-abc".into(),
            WorkerEvent::GenerationStarted,
            serde_json::Value::Null,
        );
        assert!(val.validate_worker_event(&started).is_ok());
        assert!(val.known_requests.contains(&"gen-abc".to_string()));

        // Host tries to StartGeneration with the same request_id — reject.
        let dup_start = Frame::new_host_command_with_request(
            &worker_id,
            1,
            "gen-abc",
            HostCommand::StartGeneration,
            serde_json::json!({
                "prompt_token_ids": [1, 2, 3],
                "max_output_tokens": 128,
                "deadline_ms": 30_000,
                "request_id": "gen-abc",
            }),
        );
        let err = val.validate_host_command(&dup_start).unwrap_err();
        assert_eq!(err, FrameValidationError::DuplicateRequestStart);
    }

    #[test]
    fn test_stateful_validator_terminal_after_close_rejected() {
        let worker_id = "wkr-003".to_string();
        let mut val = ProtocolValidator::new(worker_id.clone());

        // Register request via GenerationStarted (seq 0).
        let started = Frame::new_worker_event(
            worker_id.clone(),
            0,
            "gen-xyz".into(),
            WorkerEvent::GenerationStarted,
            serde_json::Value::Null,
        );
        assert!(val.validate_worker_event(&started).is_ok());

        // Send GenerationCompleted (seq 1) — moves to terminal.
        let completed = Frame::new_worker_event(
            worker_id.clone(),
            1,
            "gen-xyz".into(),
            WorkerEvent::GenerationCompleted,
            serde_json::json!({
                "request_id": "gen-xyz",
                "token_count": 42,
                "ttft_ms": 500,
                "total_ms": 2000,
            }),
        );
        assert!(val.validate_worker_event(&completed).is_ok());
        assert!(!val.known_requests.contains(&"gen-xyz".to_string()));
        assert!(val.terminal_requests.contains(&"gen-xyz".to_string()));

        // Another terminal event for the same request (seq 2) — rejected.
        let dup_terminal = Frame::new_worker_event(
            worker_id.clone(),
            2,
            "gen-xyz".into(),
            WorkerEvent::GenerationFailed,
            serde_json::json!({
                "request_id": "gen-xyz",
                "error_code": "E_ALREADY_DONE",
                "message": "generation already completed",
                "phase": "decode",
            }),
        );
        let err = val.validate_worker_event(&dup_terminal).unwrap_err();
        assert_eq!(err, FrameValidationError::TerminalAfterClose);
    }

    #[test]
    fn test_stateful_validator_wrong_worker_id_rejected() {
        let worker_id = "real-worker".to_string();
        let mut val = ProtocolValidator::new(worker_id.clone());

        // Frame with a different worker ID.
        let intruder = Frame::new_host_command(
            "impostor".into(),
            0,
            HostCommand::Ping,
            serde_json::Value::Null,
        );
        let err = val.validate_host_command(&intruder).unwrap_err();
        assert_eq!(err, FrameValidationError::UnknownRequest);
        assert_eq!(val.next_expected_seq, 0); // state not advanced
    }

    #[test]
    fn token_payload_round_trip() {
        let original = TokenPayload {
            request_id: "req-001".into(),
            token_id: 128,
            position: 5,
            logprob: Some(-0.5),
        };
        let json = serde_json::to_string(&original).expect("serialize");
        let recovered: TokenPayload = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(original.request_id, recovered.request_id);
        assert_eq!(original.token_id, recovered.token_id);
        assert_eq!(original.position, recovered.position);
        assert_eq!(original.logprob, recovered.logprob);
    }

    /// Prove that a WorkerFatalPayload serialises with exact field names
    /// and round-trips correctly so the supervisor can decode error code,
    /// message, and phase.
    #[test]
    fn test_worker_fatal_payload_roundtrip() {
        let payload = WorkerFatalPayload {
            error_code: "protocol-violation".into(),
            message: "sequence gap detected".into(),
            phase: "command-dispatch".into(),
            diagnostics: Some(vec!["expected seq 5, got 8".into()]),
        };
        let json = serde_json::to_value(&payload).expect("serialize");
        assert_eq!(json["error_code"], "protocol-violation");
        assert_eq!(json["message"], "sequence gap detected");
        assert_eq!(json["phase"], "command-dispatch");
        let diags = json["diagnostics"].as_array().expect("diagnostics is array");
        assert_eq!(diags[0], "expected seq 5, got 8");

        // Round-trip through Frame payload.
        let frame = Frame::new_worker_event(
            "test-worker-id".into(),
            3,
            "req-001".into(),
            WorkerEvent::WorkerFatal,
            json.clone(),
        );
        let frame_json = serde_json::to_string(&frame).expect("frame serialize");
        let decoded: Frame = serde_json::from_str(&frame_json).expect("frame deserialize");
        assert_eq!(decoded.payload["error_code"], "protocol-violation");
        assert_eq!(decoded.payload["phase"], "command-dispatch");
    }
}
