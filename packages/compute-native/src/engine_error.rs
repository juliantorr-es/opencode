//! Typed error taxonomy for the inference engine.
//!
//! Every error carries a stable machine-readable code, a human-readable message,
//! an optional model image hash, an optional request ID, an optional phase,
//! a retryability flag, and a worker-termination flag.
//!
//! N-API boundary conversion preserves stable error codes via `to_napi_json`.
//! The `failure_funnel` and `cancellation_funnel` functions provide canonical
//! error creation paths.

use serde_json::Value;

/// Stable kebab-case error codes for the inference engine.
///
/// Every variant maps 1:1 to a string consumers can match on without
/// depending on Rust enum layout.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EngineErrorCode {
    InvalidRequest,
    PolicyRejected,
    ModelNotLoaded,
    ModelBusy,
    ModelIntegrityFailed,
    ModelAdmissionRejected,
    WorkerLaunchFailed,
    WorkerHandshakeFailed,
    WorkerProtocolViolation,
    WorkerCrashed,
    WorkerUnresponsive,
    WorkerRestartLimitExceeded,
    DeadlineExceeded,
    MemoryLimitExceeded,
    Cancelled,
    ConsumerDisconnected,
    InferenceFailed,
    NumericalFailure,
    InternalInvariantViolation,
}

impl EngineErrorCode {
    /// Stable kebab-case string code (e.g. `"model-busy"`).
    pub fn code(&self) -> &'static str {
        match self {
            Self::InvalidRequest => "invalid-request",
            Self::PolicyRejected => "policy-rejected",
            Self::ModelNotLoaded => "model-not-loaded",
            Self::ModelBusy => "model-busy",
            Self::ModelIntegrityFailed => "model-integrity-failed",
            Self::ModelAdmissionRejected => "model-admission-rejected",
            Self::WorkerLaunchFailed => "worker-launch-failed",
            Self::WorkerHandshakeFailed => "worker-handshake-failed",
            Self::WorkerProtocolViolation => "worker-protocol-violation",
            Self::WorkerCrashed => "worker-crashed",
            Self::WorkerUnresponsive => "worker-unresponsive",
            Self::WorkerRestartLimitExceeded => "worker-restart-limit-exceeded",
            Self::DeadlineExceeded => "deadline-exceeded",
            Self::MemoryLimitExceeded => "memory-limit-exceeded",
            Self::Cancelled => "cancelled",
            Self::ConsumerDisconnected => "consumer-disconnected",
            Self::InferenceFailed => "inference-failed",
            Self::NumericalFailure => "numerical-failure",
            Self::InternalInvariantViolation => "internal-invariant-violation",
        }
    }

    /// Whether operations producing this error are safe to retry.
    pub fn retryable(&self) -> bool {
        matches!(
            self,
            Self::ModelBusy
                | Self::WorkerLaunchFailed
                | Self::WorkerHandshakeFailed
                | Self::WorkerCrashed
        )
    }

    /// Whether the error implies the worker process terminated.
    pub fn worker_terminated(&self) -> bool {
        matches!(
            self,
            Self::WorkerCrashed
                | Self::WorkerUnresponsive
                | Self::DeadlineExceeded
                | Self::MemoryLimitExceeded
        )
    }
}

/// Reasons a worker was forcibly terminated by the supervisor.
#[derive(Debug, Clone, PartialEq)]
pub enum ForcedTerminationReason {
    DeadlineExceeded { overrun_ms: u64 },
    MemoryLimitExceeded { rss_bytes: u64, hard_ceiling_bytes: u64 },
    HeartbeatLost { last_heartbeat_ms: u64, timeout_ms: u64 },
    ProtocolViolation { details: String },
    WorkerCrashed { exit_code: Option<i32>, signal: Option<i32> },
    ConsumerDisconnected,
}

/// Details about a worker process's exit.
#[derive(Debug, Clone, PartialEq)]
pub struct WorkerExitDetails {
    pub worker_pid: u32,
    pub exit_code: Option<i32>,
    pub signal: Option<i32>,
    pub uptime_ms: u64,
    pub last_heartbeat_ms: u64,
    pub peak_rss_bytes: u64,
    pub faulted: bool,
}

/// A structured inference-engine error.
///
/// Construct via [`EngineError::new`] or the builder-style helpers,
/// then convert to N-API-safe JSON with [`to_napi_json`](Self::to_napi_json).
#[derive(Debug, Clone)]
pub struct EngineError {
    pub code: EngineErrorCode,
    pub message: String,
    pub model_image_hash: Option<String>,
    pub request_id: Option<String>,
    /// One of `"admission"`, `"prefill"`, `"decode"`, `"epilogue"`, `"unknown"`.
    pub phase: Option<String>,
    pub worker_terminated: bool,
    /// Reason the worker was forcibly terminated by the supervisor, if applicable.
    pub forced_termination_reason: Option<ForcedTerminationReason>,
    /// Details about the worker process exit, if available.
    pub worker_exit_details: Option<WorkerExitDetails>,
}

// ---------------------------------------------------------------------------
// Display + Error
// ---------------------------------------------------------------------------

impl std::fmt::Display for EngineError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "[{}] {}", self.code.code(), self.message)
    }
}

impl std::fmt::Display for ForcedTerminationReason {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::DeadlineExceeded { overrun_ms } => {
                write!(f, "deadline-exceeded (overrun: {}ms)", overrun_ms)
            }
            Self::MemoryLimitExceeded { rss_bytes, hard_ceiling_bytes } => {
                write!(f, "memory-limit-exceeded (rss: {} / ceiling: {})", rss_bytes, hard_ceiling_bytes)
            }
            Self::HeartbeatLost { last_heartbeat_ms, timeout_ms } => {
                write!(f, "heartbeat-lost (last: {}ms / timeout: {}ms)", last_heartbeat_ms, timeout_ms)
            }
            Self::ProtocolViolation { details } => {
                write!(f, "protocol-violation: {}", details)
            }
            Self::WorkerCrashed { exit_code, signal } => {
                write!(f, "worker-crashed (exit: {:?} / signal: {:?})", exit_code, signal)
            }
            Self::ConsumerDisconnected => {
                write!(f, "consumer-disconnected")
            }
        }
    }
}

impl std::error::Error for EngineError {}

// ---------------------------------------------------------------------------
// Constructors
// ---------------------------------------------------------------------------

impl EngineError {
    /// Create a new error from a code and message.
    ///
    /// `worker_terminated` is derived from the code automatically.
    pub fn new(code: EngineErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            model_image_hash: None,
            request_id: None,
            phase: None,
            worker_terminated: code.worker_terminated(),
            forced_termination_reason: None,
            worker_exit_details: None,
        }
    }

    /// Create a new error with a model image hash attached.
    pub fn with_model(
        code: EngineErrorCode,
        message: impl Into<String>,
        hash: impl Into<String>,
    ) -> Self {
        Self {
            code,
            message: message.into(),
            model_image_hash: Some(hash.into()),
            request_id: None,
            phase: None,
            worker_terminated: code.worker_terminated(),
            forced_termination_reason: None,
            worker_exit_details: None,
        }
    }

    /// Create a new error with a request ID attached.
    pub fn with_request(
        code: EngineErrorCode,
        message: impl Into<String>,
        request_id: impl Into<String>,
    ) -> Self {
        Self {
            code,
            message: message.into(),
            model_image_hash: None,
            request_id: Some(request_id.into()),
            phase: None,
            worker_terminated: code.worker_terminated(),
            forced_termination_reason: None,
            worker_exit_details: None,
        }
    }

    /// Attach (or replace) the phase label.
    ///
    /// Typical values: `"admission"`, `"prefill"`, `"decode"`, `"epilogue"`, `"unknown"`.
    pub fn at_phase(mut self, phase: impl Into<String>) -> Self {
        self.phase = Some(phase.into());
        self
    }

    /// Attach a forced termination reason.
    pub fn with_forced_termination(mut self, reason: ForcedTerminationReason) -> Self {
        self.forced_termination_reason = Some(reason);
        self
    }

    /// Attach worker exit details.
    pub fn with_worker_exit(mut self, details: WorkerExitDetails) -> Self {
        self.worker_exit_details = Some(details);
        self
    }
}

// ---------------------------------------------------------------------------
// N-API conversion
// ---------------------------------------------------------------------------

impl EngineError {
    /// Serialize this error to a JSON object suitable for crossing the N-API
    /// boundary.
    ///
    /// Keys: `"code"`, `"message"`, `"modelImageHash"` (or `null`),
    /// `"requestId"` (or `null`), `"phase"`, `"retryable"`, `"workerTerminated"`,
    /// `"forcedTerminationReason"` (string or `null`),
    /// `"workerExitDetails"` (object or `null`).
    pub fn to_napi_json(&self) -> Value {
        serde_json::json!({
            "code": self.code.code(),
            "message": self.message,
            "modelImageHash": self.model_image_hash,
            "requestId": self.request_id,
            "phase": self.phase,
            "retryable": self.code.retryable(),
            "workerTerminated": self.worker_terminated,
            "forcedTerminationReason": self.forced_termination_reason.as_ref().map(|r| r.to_string()),
            "workerExitDetails": self.worker_exit_details.as_ref().map(|d| {
                serde_json::json!({
                    "workerPid": d.worker_pid,
                    "exitCode": d.exit_code,
                    "signal": d.signal,
                    "uptimeMs": d.uptime_ms,
                    "lastHeartbeatMs": d.last_heartbeat_ms,
                    "peakRssBytes": d.peak_rss_bytes,
                    "faulted": d.faulted,
                })
            }),
        })
    }
}

// ---------------------------------------------------------------------------
// Funnel functions
// ---------------------------------------------------------------------------

/// Process an error through the failure funnel.
///
/// Logs to stderr, ensures `worker_terminated` is set if the code warrants it,
/// and returns the (possibly adjusted) error.
///
/// Accepts an optional `ForcedTerminationReason` and `WorkerExitDetails` that
/// are attached to the returned error.
pub fn failure_funnel(
    error: EngineError,
    forced_termination: Option<ForcedTerminationReason>,
    worker_exit: Option<WorkerExitDetails>,
) -> EngineError {
    eprintln!("[ENGINE_ERROR] [{}] {}", error.code.code(), error.message);

    // Re-derive worker_terminated from the code so callers cannot accidentally
    // clear it when it should be set.
    let mut e = error;
    e.worker_terminated = e.code.worker_terminated();
    e.forced_termination_reason = forced_termination.or(e.forced_termination_reason);
    e.worker_exit_details = worker_exit.or(e.worker_exit_details);
    e
}

/// Create a cancellation error via the cancellation funnel.
///
/// Always returns an `EngineError` with code [`Cancelled`](EngineErrorCode::Cancelled),
/// the given reason as the message, and the optional `request_id`.
pub fn cancellation_funnel(
    request_id: Option<String>,
    reason: impl Into<String>,
) -> EngineError {
    EngineError {
        code: EngineErrorCode::Cancelled,
        message: reason.into(),
        model_image_hash: None,
        request_id,
        phase: None,
        worker_terminated: EngineErrorCode::Cancelled.worker_terminated(),
        forced_termination_reason: None,
        worker_exit_details: None,
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_code_strings() {
        let cases: Vec<(EngineErrorCode, &str)> = vec![
            (EngineErrorCode::InvalidRequest, "invalid-request"),
            (EngineErrorCode::PolicyRejected, "policy-rejected"),
            (EngineErrorCode::ModelNotLoaded, "model-not-loaded"),
            (EngineErrorCode::ModelBusy, "model-busy"),
            (EngineErrorCode::ModelIntegrityFailed, "model-integrity-failed"),
            (EngineErrorCode::ModelAdmissionRejected, "model-admission-rejected"),
            (EngineErrorCode::WorkerLaunchFailed, "worker-launch-failed"),
            (EngineErrorCode::WorkerHandshakeFailed, "worker-handshake-failed"),
            (EngineErrorCode::WorkerProtocolViolation, "worker-protocol-violation"),
            (EngineErrorCode::WorkerCrashed, "worker-crashed"),
            (EngineErrorCode::WorkerUnresponsive, "worker-unresponsive"),
            (EngineErrorCode::DeadlineExceeded, "deadline-exceeded"),
            (EngineErrorCode::MemoryLimitExceeded, "memory-limit-exceeded"),
            (EngineErrorCode::Cancelled, "cancelled"),
            (EngineErrorCode::ConsumerDisconnected, "consumer-disconnected"),
            (EngineErrorCode::InferenceFailed, "inference-failed"),
            (EngineErrorCode::NumericalFailure, "numerical-failure"),
            (
                EngineErrorCode::InternalInvariantViolation,
                "internal-invariant-violation",
            ),
        ];
        for (code, expected) in &cases {
            assert_eq!(code.code(), *expected, "code mismatch for {:?}", code);
        }
    }

    #[test]
    fn test_retryable_codes() {
        assert!(EngineErrorCode::ModelBusy.retryable());
        assert!(EngineErrorCode::WorkerLaunchFailed.retryable());
        assert!(EngineErrorCode::WorkerHandshakeFailed.retryable());
        assert!(EngineErrorCode::WorkerCrashed.retryable());

        assert!(!EngineErrorCode::InvalidRequest.retryable());
        assert!(!EngineErrorCode::PolicyRejected.retryable());
        assert!(!EngineErrorCode::ModelNotLoaded.retryable());
        assert!(!EngineErrorCode::ModelIntegrityFailed.retryable());
        assert!(!EngineErrorCode::ModelAdmissionRejected.retryable());
        assert!(!EngineErrorCode::WorkerProtocolViolation.retryable());
        assert!(!EngineErrorCode::WorkerUnresponsive.retryable());
        assert!(!EngineErrorCode::DeadlineExceeded.retryable());
        assert!(!EngineErrorCode::MemoryLimitExceeded.retryable());
        assert!(!EngineErrorCode::Cancelled.retryable());
        assert!(!EngineErrorCode::ConsumerDisconnected.retryable());
        assert!(!EngineErrorCode::InferenceFailed.retryable());
        assert!(!EngineErrorCode::NumericalFailure.retryable());
        assert!(!EngineErrorCode::InternalInvariantViolation.retryable());
    }

    #[test]
    fn test_worker_terminated_codes() {
        assert!(EngineErrorCode::WorkerCrashed.worker_terminated());
        assert!(EngineErrorCode::WorkerUnresponsive.worker_terminated());
        assert!(EngineErrorCode::DeadlineExceeded.worker_terminated());
        assert!(EngineErrorCode::MemoryLimitExceeded.worker_terminated());

        assert!(!EngineErrorCode::InvalidRequest.worker_terminated());
        assert!(!EngineErrorCode::ModelBusy.worker_terminated());
    }

    #[test]
    fn test_new_constructor() {
        let err = EngineError::new(
            EngineErrorCode::ModelBusy,
            "model is currently at capacity",
        );
        assert_eq!(err.code, EngineErrorCode::ModelBusy);
        assert_eq!(err.message, "model is currently at capacity");
        assert!(err.model_image_hash.is_none());
        assert!(err.request_id.is_none());
        assert!(err.phase.is_none());
        assert!(err.code.retryable()); // derived from code
        assert!(!err.worker_terminated); // derived from code
    }

    #[test]
    fn test_with_model_constructor() {
        let err = EngineError::with_model(
            EngineErrorCode::ModelIntegrityFailed,
            "hash mismatch",
            "abc123",
        );
        assert_eq!(err.model_image_hash.as_deref(), Some("abc123"));
    }

    #[test]
    fn test_with_request_constructor() {
        let err = EngineError::with_request(
            EngineErrorCode::InferenceFailed,
            "CUDA OOM",
            "req-42",
        );
        assert_eq!(err.request_id.as_deref(), Some("req-42"));
    }

    #[test]
    fn test_at_phase() {
        let err = EngineError::new(EngineErrorCode::DeadlineExceeded, "timeout")
            .at_phase("decode");
        assert_eq!(err.phase.as_deref(), Some("decode"));
    }

    #[test]
    fn test_display() {
        let err = EngineError::new(EngineErrorCode::WorkerCrashed, "SIGSEGV");
        let msg = format!("{}", err);
        assert!(msg.contains("worker-crashed"));
        assert!(msg.contains("SIGSEGV"));
    }

    #[test]
    fn test_to_napi_json() {
        let err = EngineError::new(EngineErrorCode::ModelBusy, "busy")
            .at_phase("prefill");
        let json = err.to_napi_json();
        assert_eq!(json["code"], "model-busy");
        assert_eq!(json["message"], "busy");
        assert!(json["modelImageHash"].is_null());
        assert!(json["requestId"].is_null());
        assert_eq!(json["phase"], "prefill");
        assert_eq!(json["retryable"], true);
        assert_eq!(json["workerTerminated"], false);
    }

    #[test]
    fn test_to_napi_json_with_fields() {
        let err = EngineError::with_request(
            EngineErrorCode::WorkerCrashed,
            "segfault in attention kernel",
            "req-7",
        )
        .at_phase("decode");
        let json = err.to_napi_json();
        assert_eq!(json["code"], "worker-crashed");
        assert_eq!(json["requestId"], "req-7");
        assert_eq!(json["phase"], "decode");
        assert_eq!(json["retryable"], true);
        assert_eq!(json["workerTerminated"], true);
    }

    #[test]
    fn test_failure_funnel_sets_worker_terminated() {
        // Create an error where worker_terminated was *not* derived from the
        // code (simulates a caller bug). The funnel should correct it.
        let err = EngineError {
            code: EngineErrorCode::WorkerCrashed,
            message: "killed".into(),
            model_image_hash: None,
            request_id: None,
            phase: None,
            worker_terminated: false, // incorrect – funnel should fix
            forced_termination_reason: None,
            worker_exit_details: None,
        };
        let err = failure_funnel(err, None, None);
        assert!(err.worker_terminated);
    }

    #[test]
    fn test_failure_funnel_preserves_non_terminated() {
        let err = EngineError::new(EngineErrorCode::PolicyRejected, "denied");
        let err = failure_funnel(err, None, None);
        assert!(!err.worker_terminated);
    }

    #[test]
    fn test_forced_termination_reason() {
        let reason = ForcedTerminationReason::DeadlineExceeded { overrun_ms: 5000 };
        let err = EngineError::new(EngineErrorCode::DeadlineExceeded, "timed out")
            .with_forced_termination(reason.clone());
        assert_eq!(err.forced_termination_reason, Some(reason));

        // Build from the funnel with extra details.
        let reason2 = ForcedTerminationReason::MemoryLimitExceeded {
            rss_bytes: 1_000_000_000,
            hard_ceiling_bytes: 2_000_000_000,
        };
        let err2 = failure_funnel(
            EngineError::new(EngineErrorCode::MemoryLimitExceeded, "OOM"),
            Some(reason2.clone()),
            None,
        );
        assert_eq!(err2.forced_termination_reason, Some(reason2));
    }

    #[test]
    fn test_worker_exit_details_roundtrip() {
        let details = WorkerExitDetails {
            worker_pid: 12345,
            exit_code: Some(1),
            signal: None,
            uptime_ms: 600_000,
            last_heartbeat_ms: 599_000,
            peak_rss_bytes: 512_000_000,
            faulted: true,
        };
        let err = EngineError::new(EngineErrorCode::WorkerCrashed, "segfault")
            .with_worker_exit(details.clone());
        assert_eq!(err.worker_exit_details, Some(details.clone()));

        // Verify JSON round-trip includes the worker exit details.
        let json = err.to_napi_json();
        let wd = json["workerExitDetails"].as_object().unwrap();
        assert_eq!(wd["workerPid"], 12345);
        assert_eq!(wd["exitCode"], serde_json::json!(1));
        assert!(wd["signal"].is_null());
        assert_eq!(wd["uptimeMs"], 600_000);
        assert_eq!(wd["lastHeartbeatMs"], 599_000);
        assert_eq!(wd["peakRssBytes"], 512_000_000);
        assert_eq!(wd["faulted"], true);

        // Verify the forcedTerminationReason is null when not set.
        assert!(json["forcedTerminationReason"].is_null());
    }

    #[test]
    fn test_failure_funnel_attaches_details() {
        let reason = ForcedTerminationReason::HeartbeatLost {
            last_heartbeat_ms: 1000,
            timeout_ms: 5000,
        };
        let details = WorkerExitDetails {
            worker_pid: 67890,
            exit_code: None,
            signal: Some(9),
            uptime_ms: 120_000,
            last_heartbeat_ms: 1000,
            peak_rss_bytes: 256_000_000,
            faulted: true,
        };
        let err = failure_funnel(
            EngineError::new(EngineErrorCode::WorkerUnresponsive, "no heartbeat"),
            Some(reason),
            Some(details),
        );
        assert!(err.worker_terminated);
        assert!(err.forced_termination_reason.is_some());
        assert!(err.worker_exit_details.is_some());
    }

    #[test]
    fn test_cancellation_funnel() {
        let err = cancellation_funnel(Some("req-1".into()), "user aborted");
        assert_eq!(err.code, EngineErrorCode::Cancelled);
        assert_eq!(err.request_id.as_deref(), Some("req-1"));
        assert_eq!(err.message, "user aborted");
        assert!(!err.code.retryable());
        assert!(!err.worker_terminated);
    }

    #[test]
    fn test_cancellation_funnel_no_request_id() {
        let err = cancellation_funnel(None, "shutdown");
        assert!(err.request_id.is_none());
        assert_eq!(err.message, "shutdown");
    }

    #[test]
    fn test_error_trait() {
        use std::error::Error;
        let err = EngineError::new(EngineErrorCode::NumericalFailure, "NaN");
        // Ensure it implements std::error::Error and can be downcast.
        let dyn_err: &dyn Error = &err;
        assert!(dyn_err.downcast_ref::<EngineError>().is_some());
    }

    #[test]
    fn test_all_variants_have_non_empty_code() {
        // Enumerate every variant to ensure no code() returns "".
        let codes = [
            EngineErrorCode::InvalidRequest,
            EngineErrorCode::PolicyRejected,
            EngineErrorCode::ModelNotLoaded,
            EngineErrorCode::ModelBusy,
            EngineErrorCode::ModelIntegrityFailed,
            EngineErrorCode::ModelAdmissionRejected,
            EngineErrorCode::WorkerLaunchFailed,
            EngineErrorCode::WorkerHandshakeFailed,
            EngineErrorCode::WorkerProtocolViolation,
            EngineErrorCode::WorkerCrashed,
            EngineErrorCode::WorkerUnresponsive,
            EngineErrorCode::WorkerRestartLimitExceeded,
            EngineErrorCode::DeadlineExceeded,
            EngineErrorCode::MemoryLimitExceeded,
            EngineErrorCode::Cancelled,
            EngineErrorCode::ConsumerDisconnected,
            EngineErrorCode::InferenceFailed,
            EngineErrorCode::NumericalFailure,
            EngineErrorCode::InternalInvariantViolation,
        ];
        for code in &codes {
            assert!(!code.code().is_empty(), "empty code for {:?}", code);
        }
    }
}
