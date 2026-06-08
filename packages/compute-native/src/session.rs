//! Session types for generation control (host) and inference (worker).
//!
//! The control-side state machine:
//!   Created → Admitted → Submitted → PrefillRunning → Decoding → Completed
//!                                                             ├── Cancelled
//!   PrefillReady ─────→ PrefillRunning ──────────────────────── (legacy)
//!                    ├── Cancelled
//!   Any non-terminal ─────────────────────────────────────────→ Failed
//!
//! The worker-side state machine (InferenceSessionState):
//!   Created → PrefillRunning → Decoding → Completed
//!                                     ├── Cancelled
//!   Any non-terminal ──────────────────────────────→ Failed
//!
//! Terminal states are irreversible. Failed is allowed from any non-terminal
//! state. Completed cannot transition to Failed.

use crate::kv_cache::KvCache;

/// Host-side session state machine.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ControlSessionState {
    /// Session created, pending admission.
    Created,
    /// Session admitted by the engine, awaiting worker submission.
    Admitted,
    /// Session submitted to worker, pending prefill execution.
    Submitted,
    /// Prefill input is available and ready to start (legacy path — kept for
    /// compatibility with callers that bypass admission).
    PrefillReady,
    /// Prefill is actively running.
    PrefillRunning,
    /// Autoregressive decoding loop is running.
    Decoding,
    /// Generation completed normally (EOS or max_tokens reached).
    Completed,
    /// Generation was externally cancelled.
    Cancelled,
    /// Generation failed with an error.
    Failed,
}

impl ControlSessionState {
    /// Returns `true` if the session is in a terminal state.
    pub fn is_terminal(&self) -> bool {
        matches!(self, Self::Completed | Self::Cancelled | Self::Failed)
    }

    /// Returns `true` if transitioning to `next` is a legal forward move.
    ///
    /// Terminal states reject all transitions (including to `Failed`). Failed
    /// is reachable from any non-terminal state only.
    pub fn can_transition_to(&self, next: Self) -> bool {
        use ControlSessionState::*;

        // Identity (no-op) is always permitted.
        if *self == next {
            return true;
        }

        // Terminal states reject all non-identity transitions.
        if self.is_terminal() {
            return false;
        }

        match (*self, next) {
            // Mainline path.
            (Created, Admitted)
            | (Admitted, Submitted)
            | (Submitted, PrefillRunning)
            | (PrefillRunning, Decoding)
            | (Decoding, Completed) => true,
            // Cancellation paths.
            (Decoding, Cancelled)
            | (PrefillReady, Cancelled)
            | (PrefillRunning, Cancelled)
            | (Admitted, Cancelled)
            | (Submitted, Cancelled) => true,
            // Legacy: PrefillReady can jump into the mainline at PrefillRunning.
            (PrefillReady, PrefillRunning) => true,
            // Forward to PrefillReady from Created / Admitted.
            (Created, PrefillReady) | (Admitted, PrefillReady) => true,
            // Failed from any non-terminal.
            (_, Failed) => true,
            _ => false,
        }
    }

    /// Attempt a state transition. Returns `Ok(())` on success or `Err` with
    /// a description of the invalid transition.
    pub fn transition(&self, next: Self) -> Result<(), String> {
        if self.can_transition_to(next) {
            Ok(())
        } else {
            Err(format!(
                "Invalid state transition: {:?} → {:?}",
                self, next
            ))
        }
    }
}

/// Outcome of a completed, cancelled, or failed generation session.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SessionOutcome {
    /// Generation completed with the given number of tokens produced.
    Completed {
        /// Total tokens generated (excluding prompt prefix).
        token_count: u32,
    },
    /// Generation was externally cancelled.
    Cancelled {
        /// Human-readable reason for cancellation.
        reason: String,
    },
    /// Generation failed with an error.
    Failed {
        /// Machine-readable error code (e.g. `"OOM"`, `"TIMEOUT"`).
        error_code: String,
        /// Human-readable error message.
        message: String,
    },
}

/// Host-side control session — owns identity, policy state, lifecycle state,
/// deadline tracking, stream assignment, and terminal outcome.
///
/// Owns **no** MLX arrays and **no** KV cache — those belong to the worker.
#[derive(Debug)]
pub struct GenerationControlSession {
    /// Opaque session identifier.
    pub session_id: String,
    /// Hash of the model image used for this generation.
    pub model_image_hash: Option<String>,
    /// PID of the worker process executing this session.
    pub worker_pid: Option<u32>,
    /// JSON-serialised admission receipt from the engine.
    pub admission_receipt_json: Option<String>,
    /// Terminal outcome, set when the session reaches a terminal state.
    pub terminal_outcome: Option<SessionOutcome>,
    /// Current token position in the sequence (0-indexed).
    pub position: u32,
    /// Token ID that signals end-of-sequence generation.
    pub eos_token_id: u32,
    /// Maximum number of tokens to generate (inclusive of any prompt
    /// prefix length already consumed before this session).
    pub max_tokens: u32,
    /// Current session state.
    state: ControlSessionState,
}

impl GenerationControlSession {
    /// Create a new generation control session.
    pub fn new(
        session_id: String,
        eos_token_id: u32,
        max_tokens: u32,
    ) -> Self {
        Self {
            session_id,
            model_image_hash: None,
            worker_pid: None,
            admission_receipt_json: None,
            terminal_outcome: None,
            position: 0,
            eos_token_id,
            max_tokens,
            state: ControlSessionState::Created,
        }
    }

    /// Return the current state.
    pub fn state(&self) -> ControlSessionState {
        self.state
    }

    /// Attempt a state transition. Returns `Ok(())` or `Err` on invalid
    /// transition (the state is unchanged on error).
    pub fn transition(&mut self, next: ControlSessionState) -> Result<(), String> {
        self.state.transition(next).map(|()| self.state = next)
    }

    /// Returns `true` if the session is in a terminal state.
    pub fn is_terminal(&self) -> bool {
        self.state.is_terminal()
    }
}

/// Worker-side inference session state machine.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InferenceSessionState {
    /// Session created, not yet started prefill.
    Created,
    /// Prefill is actively running.
    PrefillRunning,
    /// Autoregressive decoding loop is running.
    Decoding,
    /// Generation completed normally (EOS or max_tokens reached).
    Completed,
    /// Generation was externally cancelled.
    Cancelled,
    /// Generation failed with an error.
    Failed,
}

impl InferenceSessionState {
    /// Returns `true` if the session is in a terminal phase.
    pub fn is_terminal(&self) -> bool {
        matches!(self, Self::Completed | Self::Cancelled | Self::Failed)
    }

    /// Returns `true` if transitioning to `next` is a legal forward move.
    ///
    /// Terminal phases reject all transitions (including to `Failed`). Failed
    /// is reachable from any non-terminal phase only.
    pub fn can_transition_to(&self, next: Self) -> bool {
        // Identity (no-op) is always permitted.
        if *self == next {
            return true;
        }

        // Terminal phases reject all non-identity transitions.
        if self.is_terminal() {
            return false;
        }

        match (*self, next) {
            (Self::Created, Self::PrefillRunning)
            | (Self::PrefillRunning, Self::Decoding)
            | (Self::Decoding, Self::Completed)
            | (Self::Decoding, Self::Cancelled)
            | (Self::PrefillRunning, Self::Cancelled)
            | (_, Self::Failed) => true,
            _ => false,
        }
    }

    /// Attempt a phase transition. Returns `Ok(())` on success or `Err`.
    pub fn transition(&self, next: Self) -> Result<(), String> {
        if self.can_transition_to(next) {
            Ok(())
        } else {
            Err(format!(
                "Invalid InferenceSessionState transition: {:?} → {:?}",
                self, next
            ))
        }
    }
}

/// Worker-side inference session — owns the KV cache, generated tokens,
/// sampling state, cancellation flag, and runtime receipts.
#[derive(Debug)]
pub struct InferenceSession {
    /// Opaque session identifier (mirrors the control session id).
    pub session_id: String,
    /// Absolute token position in the sequence (0-indexed).
    pub absolute_position: u32,
    /// Per-layer KV caches, owned exclusively by this worker session.
    pub kv_caches: Vec<KvCache>,
    /// Tokens generated so far during this inference session.
    pub generated_tokens: Vec<u32>,
    /// Current inference phase.
    pub phase: InferenceSessionState,
    /// Atomic flag checked by the decode loop to request early termination.
    pub cancellation_flag: std::sync::atomic::AtomicBool,
    /// Runtime receipts (JSON strings) for provenance and observability.
    pub receipts_json: Vec<String>,
}

impl InferenceSession {
    /// Create a new inference session with the given identifier and
    /// pre-allocated per-layer KV caches.
    pub fn new(session_id: String, kv_caches: Vec<KvCache>) -> Self {
        Self {
            session_id,
            absolute_position: 0,
            kv_caches,
            generated_tokens: Vec::new(),
            phase: InferenceSessionState::Created,
            cancellation_flag: std::sync::atomic::AtomicBool::new(false),
            receipts_json: Vec::new(),
        }
    }

    /// Returns `true` if the session is in a terminal phase.
    pub fn is_terminal(&self) -> bool {
        self.phase.is_terminal()
    }

    /// Attempt a phase transition. Returns `Ok(())` or `Err` on invalid
    /// transition (the phase is unchanged on error).
    pub fn transition(&mut self, next: InferenceSessionState) -> Result<(), String> {
        self.phase.transition(next).map(|()| self.phase = next)
    }
}

/// Sampling / decoding configuration for one generation run.
///
/// All fields are optional with the following semantics:
/// - `None` → use a sensible default (greedy decoding defaults are shown
///   below).
/// - `Some(value)` → override the default.
///
/// The default configuration is greedy: `top_k = Some(1)` with all other
/// parameters effectively disabled.
#[derive(Clone, Debug, PartialEq)]
pub struct SamplerConfig {
    /// Temperature for softmax scaling. Lower values sharpen the
    /// distribution. `None` / `Some(0.0)` → greedy (always pick top token).
    /// Default: `None`.
    pub temperature: Option<f32>,
    /// Top-k filtering: retain only the `k` highest-probability tokens
    /// before sampling. `Some(1)` → greedy. `None` → no top-k filtering.
    /// Default: `Some(1)`.
    pub top_k: Option<u32>,
    /// Top-p (nucleus) filtering: retain the smallest set of tokens whose
    /// cumulative probability exceeds `p`. `None` → no top-p filtering.
    /// Default: `None`.
    pub top_p: Option<f32>,
    /// Repetition penalty applied to tokens that have already appeared.
    /// Values > 1.0 penalise repetition; < 1.0 encourage it.
    /// `None` → no penalty (equivalent to 1.0).
    /// Default: `None`.
    pub repetition_penalty: Option<f32>,
    /// PRNG seed for deterministic sampling. `None` → non-deterministic.
    /// Default: `None`.
    pub seed: Option<u64>,
    /// Token IDs at which generation should stop (in addition to `eos_token_id`).
    /// Default: empty.
    pub stop_token_ids: Vec<u32>,
}

impl Default for SamplerConfig {
    fn default() -> Self {
        Self {
            temperature: None,
            top_k: Some(1),
            top_p: None,
            repetition_penalty: None,
            seed: None,
            stop_token_ids: Vec::new(),
        }
    }
}

impl SamplerConfig {
    /// Returns `true` when the config selects greedy (argmax) decoding.
    pub fn is_greedy(&self) -> bool {
        self.top_k == Some(1) || self.temperature == Some(0.0) || self.temperature == None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── ControlSessionState ────────────────────────────────────────────

    #[test]
    fn test_control_session_state_initial() {
        let s = ControlSessionState::Created;
        assert!(!s.is_terminal());
    }

    #[test]
    fn test_control_session_state_terminal() {
        assert!(ControlSessionState::Completed.is_terminal());
        assert!(ControlSessionState::Cancelled.is_terminal());
        assert!(ControlSessionState::Failed.is_terminal());
        assert!(!ControlSessionState::Created.is_terminal());
        assert!(!ControlSessionState::Decoding.is_terminal());
    }

    #[test]
    fn test_control_state_valid_transitions() {
        // Classic legacy path
        assert!(ControlSessionState::Created.transition(ControlSessionState::PrefillReady).is_ok());
        assert!(ControlSessionState::PrefillReady.transition(ControlSessionState::PrefillRunning).is_ok());
        assert!(ControlSessionState::PrefillRunning.transition(ControlSessionState::Decoding).is_ok());
        assert!(ControlSessionState::Decoding.transition(ControlSessionState::Completed).is_ok());

        // Cancellation paths
        assert!(ControlSessionState::Decoding.transition(ControlSessionState::Cancelled).is_ok());
        assert!(ControlSessionState::PrefillReady.transition(ControlSessionState::Cancelled).is_ok());
        assert!(ControlSessionState::PrefillRunning.transition(ControlSessionState::Cancelled).is_ok());

        // New admission path
        assert!(ControlSessionState::Created.transition(ControlSessionState::Admitted).is_ok());
        assert!(ControlSessionState::Admitted.transition(ControlSessionState::Submitted).is_ok());
        assert!(ControlSessionState::Submitted.transition(ControlSessionState::PrefillRunning).is_ok());

        // New cancellation paths for Admitted / Submitted
        assert!(ControlSessionState::Admitted.transition(ControlSessionState::Cancelled).is_ok());
        assert!(ControlSessionState::Submitted.transition(ControlSessionState::Cancelled).is_ok());
    }

    #[test]
    fn test_control_state_failed_from_non_terminal() {
        let non_terminal = [
            ControlSessionState::Created,
            ControlSessionState::Admitted,
            ControlSessionState::Submitted,
            ControlSessionState::PrefillReady,
            ControlSessionState::PrefillRunning,
            ControlSessionState::Decoding,
        ];
        for s in non_terminal {
            assert!(
                s.transition(ControlSessionState::Failed).is_ok(),
                "Failed transition should be valid from {:?}",
                s,
            );
        }
    }

    #[test]
    fn test_control_state_terminal_rejects_failed() {
        // From terminal Completed / Cancelled, Failed is rejected.
        assert!(
            ControlSessionState::Completed.transition(ControlSessionState::Failed).is_err(),
            "Failed from Completed should be rejected",
        );
        assert!(
            ControlSessionState::Cancelled.transition(ControlSessionState::Failed).is_err(),
            "Failed from Cancelled should be rejected",
        );
        // From Failed itself, identity is the only valid transition.
        assert!(
            ControlSessionState::Failed.transition(ControlSessionState::Failed).is_ok(),
            "Failed identity transition should be valid",
        );
    }

    #[test]
    fn test_control_state_identity_transitions() {
        let states = [
            ControlSessionState::Created,
            ControlSessionState::Admitted,
            ControlSessionState::Submitted,
            ControlSessionState::PrefillReady,
            ControlSessionState::PrefillRunning,
            ControlSessionState::Decoding,
            ControlSessionState::Completed,
            ControlSessionState::Cancelled,
            ControlSessionState::Failed,
        ];
        for s in states {
            assert!(s.transition(s).is_ok(), "Identity transition should be valid for {:?}", s);
        }
    }

    #[test]
    fn test_control_state_invalid_transitions() {
        // Created can only go to Admitted, PrefillReady, Failed, or identity
        assert!(ControlSessionState::Created.transition(ControlSessionState::Decoding).is_err());
        assert!(ControlSessionState::Created.transition(ControlSessionState::Completed).is_err());
        assert!(ControlSessionState::Created.transition(ControlSessionState::Cancelled).is_err());

        // Completed is terminal — cannot go anywhere except identity
        assert!(ControlSessionState::Completed.transition(ControlSessionState::PrefillReady).is_err());
        assert!(ControlSessionState::Completed.transition(ControlSessionState::Decoding).is_err());

        // Cancelled is terminal
        assert!(ControlSessionState::Cancelled.transition(ControlSessionState::PrefillReady).is_err());

        // Failed is terminal
        assert!(ControlSessionState::Failed.transition(ControlSessionState::Created).is_err());

        // Skipping PrefillReady → Decoding not allowed
        assert!(ControlSessionState::PrefillReady.transition(ControlSessionState::Decoding).is_err());

        // PrefillRunning back to PrefillReady not allowed
        assert!(ControlSessionState::PrefillRunning.transition(ControlSessionState::PrefillReady).is_err());
    }

    // ── GenerationControlSession ───────────────────────────────────────

    #[test]
    fn test_control_session_new() {
        let session = GenerationControlSession::new("test-1".into(), 2, 100);
        assert_eq!(session.session_id, "test-1");
        assert_eq!(session.eos_token_id, 2);
        assert_eq!(session.max_tokens, 100);
        assert_eq!(session.position, 0);
        assert!(session.model_image_hash.is_none());
        assert!(session.worker_pid.is_none());
        assert!(session.admission_receipt_json.is_none());
        assert!(session.terminal_outcome.is_none());
        assert_eq!(session.state(), ControlSessionState::Created);
        assert!(!session.is_terminal());
    }

    #[test]
    fn test_control_session_happy_path() {
        let mut session = GenerationControlSession::new("s1".into(), 2, 100);
        assert_eq!(session.state(), ControlSessionState::Created);

        session.transition(ControlSessionState::PrefillReady).unwrap();
        assert_eq!(session.state(), ControlSessionState::PrefillReady);

        session.transition(ControlSessionState::PrefillRunning).unwrap();
        assert_eq!(session.state(), ControlSessionState::PrefillRunning);

        session.transition(ControlSessionState::Decoding).unwrap();
        assert_eq!(session.state(), ControlSessionState::Decoding);

        session.transition(ControlSessionState::Completed).unwrap();
        assert_eq!(session.state(), ControlSessionState::Completed);
        assert!(session.is_terminal());
    }

    #[test]
    fn test_control_session_cancel_during_prefill() {
        let mut session = GenerationControlSession::new("s2".into(), 2, 100);
        session.transition(ControlSessionState::PrefillReady).unwrap();
        session.transition(ControlSessionState::Cancelled).unwrap();
        assert_eq!(session.state(), ControlSessionState::Cancelled);
        assert!(session.is_terminal());
    }

    #[test]
    fn test_control_session_cancel_during_decoding() {
        let mut session = GenerationControlSession::new("s3".into(), 2, 100);
        session.transition(ControlSessionState::PrefillReady).unwrap();
        session.transition(ControlSessionState::PrefillRunning).unwrap();
        session.transition(ControlSessionState::Decoding).unwrap();
        session.transition(ControlSessionState::Cancelled).unwrap();
        assert_eq!(session.state(), ControlSessionState::Cancelled);
    }

    #[test]
    fn test_control_session_fail_from_non_terminal() {
        for (label, mut session) in [
            ("created", GenerationControlSession::new("f1".into(), 2, 100)),
            ("admitted", {
                let mut s = GenerationControlSession::new("f1a".into(), 2, 100);
                s.transition(ControlSessionState::Admitted).unwrap();
                s
            }),
            ("submitted", {
                let mut s = GenerationControlSession::new("f1b".into(), 2, 100);
                s.transition(ControlSessionState::Admitted).unwrap();
                s.transition(ControlSessionState::Submitted).unwrap();
                s
            }),
            ("prefill_ready", {
                let mut s = GenerationControlSession::new("f2".into(), 2, 100);
                s.transition(ControlSessionState::PrefillReady).unwrap();
                s
            }),
            ("prefill_running", {
                let mut s = GenerationControlSession::new("f3".into(), 2, 100);
                s.transition(ControlSessionState::PrefillReady).unwrap();
                s.transition(ControlSessionState::PrefillRunning).unwrap();
                s
            }),
            ("decoding", {
                let mut s = GenerationControlSession::new("f4".into(), 2, 100);
                s.transition(ControlSessionState::PrefillReady).unwrap();
                s.transition(ControlSessionState::PrefillRunning).unwrap();
                s.transition(ControlSessionState::Decoding).unwrap();
                s
            }),
        ] {
            assert!(
                session.transition(ControlSessionState::Failed).is_ok(),
                "Failed from {:?} should be valid",
                label,
            );
            assert!(session.is_terminal());
        }
    }

    #[test]
    fn test_control_session_fail_from_terminal_rejected() {
        // Once terminal, even Failed is rejected.
        let mut session = GenerationControlSession::new("f5".into(), 2, 100);
        session.transition(ControlSessionState::PrefillReady).unwrap();
        session.transition(ControlSessionState::PrefillRunning).unwrap();
        session.transition(ControlSessionState::Decoding).unwrap();
        session.transition(ControlSessionState::Completed).unwrap();
        assert!(session.is_terminal());

        assert!(
            session.transition(ControlSessionState::Failed).is_err(),
            "Failed from Completed should be rejected"
        );
    }

    #[test]
    fn test_control_session_invalid_transition_preserves_state() {
        let mut session = GenerationControlSession::new("s6".into(), 2, 100);
        assert_eq!(session.state(), ControlSessionState::Created);

        // Cannot skip to Decoding
        assert!(session.transition(ControlSessionState::Decoding).is_err());
        assert_eq!(session.state(), ControlSessionState::Created);
    }

    #[test]
    fn test_control_session_identity_transition() {
        let mut session = GenerationControlSession::new("s7".into(), 2, 100);
        session.transition(ControlSessionState::PrefillReady).unwrap();
        // Identity should be a no-op
        assert!(session.transition(ControlSessionState::PrefillReady).is_ok());
        assert_eq!(session.state(), ControlSessionState::PrefillReady);
    }

    // ── SessionOutcome ─────────────────────────────────────────────────

    #[test]
    fn test_session_outcome_completed() {
        let outcome = SessionOutcome::Completed { token_count: 42 };
        assert_eq!(outcome, SessionOutcome::Completed { token_count: 42 });
    }

    #[test]
    fn test_session_outcome_cancelled() {
        let outcome = SessionOutcome::Cancelled { reason: "user request".into() };
        assert_eq!(
            outcome,
            SessionOutcome::Cancelled { reason: "user request".into() }
        );
    }

    #[test]
    fn test_session_outcome_failed() {
        let outcome = SessionOutcome::Failed {
            error_code: "OOM".into(),
            message: "out of memory".into(),
        };
        assert_eq!(
            outcome,
            SessionOutcome::Failed {
                error_code: "OOM".into(),
                message: "out of memory".into(),
            }
        );
    }

    // ── InferenceSessionState ──────────────────────────────────────────

    #[test]
    fn test_inference_session_state_initial() {
        let s = InferenceSessionState::Created;
        assert!(!s.is_terminal());
    }

    #[test]
    fn test_inference_session_state_valid_transitions() {
        assert!(InferenceSessionState::Created.transition(InferenceSessionState::PrefillRunning).is_ok());
        assert!(InferenceSessionState::PrefillRunning.transition(InferenceSessionState::Decoding).is_ok());
        assert!(InferenceSessionState::Decoding.transition(InferenceSessionState::Completed).is_ok());
        // Cancellation
        assert!(InferenceSessionState::Decoding.transition(InferenceSessionState::Cancelled).is_ok());
        assert!(InferenceSessionState::PrefillRunning.transition(InferenceSessionState::Cancelled).is_ok());
    }

    #[test]
    fn test_inference_session_state_failed_from_non_terminal() {
        let non_terminal = [
            InferenceSessionState::Created,
            InferenceSessionState::PrefillRunning,
            InferenceSessionState::Decoding,
        ];
        for s in non_terminal {
            assert!(
                s.transition(InferenceSessionState::Failed).is_ok(),
                "Failed from {:?} should be valid",
                s,
            );
        }
    }

    #[test]
    fn test_inference_session_state_terminal_rejects_failed() {
        // From terminal Completed / Cancelled, Failed is rejected.
        assert!(
            InferenceSessionState::Completed.transition(InferenceSessionState::Failed).is_err(),
            "Failed from Completed should be rejected",
        );
        assert!(
            InferenceSessionState::Cancelled.transition(InferenceSessionState::Failed).is_err(),
            "Failed from Cancelled should be rejected",
        );
        // From Failed itself, identity is the only valid transition.
        assert!(
            InferenceSessionState::Failed.transition(InferenceSessionState::Failed).is_ok(),
            "Failed identity transition should be valid",
        );
    }

    #[test]
    fn test_inference_session_state_invalid_transitions() {
        // Created cannot skip to Decoding
        assert!(InferenceSessionState::Created.transition(InferenceSessionState::Decoding).is_err());
        assert!(InferenceSessionState::Created.transition(InferenceSessionState::Completed).is_err());
        // Terminal states reject all non-identity
        assert!(InferenceSessionState::Completed.transition(InferenceSessionState::PrefillRunning).is_err());
        assert!(InferenceSessionState::Cancelled.transition(InferenceSessionState::Created).is_err());
        assert!(InferenceSessionState::Failed.transition(InferenceSessionState::Created).is_err());
    }

    // ── InferenceSession ───────────────────────────────────────────────

    #[test]
    fn test_inference_session_new() {
        let session = InferenceSession::new("inf-1".into(), Vec::new());
        assert_eq!(session.session_id, "inf-1");
        assert_eq!(session.absolute_position, 0);
        assert!(session.kv_caches.is_empty());
        assert!(session.generated_tokens.is_empty());
        assert_eq!(session.phase, InferenceSessionState::Created);
        assert!(!session.cancellation_flag.load(std::sync::atomic::Ordering::Relaxed));
        assert!(session.receipts_json.is_empty());
        assert!(!session.is_terminal());
    }

    #[test]
    fn test_inference_session_happy_path() {
        let mut session = InferenceSession::new("inf-2".into(), Vec::new());
        assert_eq!(session.phase, InferenceSessionState::Created);

        session.transition(InferenceSessionState::PrefillRunning).unwrap();
        assert_eq!(session.phase, InferenceSessionState::PrefillRunning);

        session.transition(InferenceSessionState::Decoding).unwrap();
        assert_eq!(session.phase, InferenceSessionState::Decoding);

        session.transition(InferenceSessionState::Completed).unwrap();
        assert_eq!(session.phase, InferenceSessionState::Completed);
        assert!(session.is_terminal());
    }

    #[test]
    fn test_inference_session_cancellation_flag() {
        let session = InferenceSession::new("inf-3".into(), Vec::new());
        assert!(!session.cancellation_flag.load(std::sync::atomic::Ordering::Relaxed));
        session.cancellation_flag.store(true, std::sync::atomic::Ordering::Relaxed);
        assert!(session.cancellation_flag.load(std::sync::atomic::Ordering::Relaxed));
    }

    #[test]
    fn test_inference_session_receipts() {
        let mut receipts = Vec::new();
        receipts.push(r#"{"event":"prefill_started"}"#.to_string());
        receipts.push(r#"{"event":"prefill_completed"}"#.to_string());

        let session = InferenceSession {
            receipts_json: receipts.clone(),
            ..InferenceSession::new("inf-4".into(), Vec::new())
        };
        assert_eq!(session.receipts_json.len(), 2);
        assert_eq!(session.receipts_json[0], r#"{"event":"prefill_started"}"#);
    }

    // ── SamplerConfig ──────────────────────────────────────────────────

    #[test]
    fn test_sampler_config_greedy_default() {
        let config = SamplerConfig::default();
        assert!(config.temperature.is_none());
        assert_eq!(config.top_k, Some(1));
        assert!(config.top_p.is_none());
        assert!(config.repetition_penalty.is_none());
        assert!(config.seed.is_none());
        assert!(config.stop_token_ids.is_empty());
        assert!(config.is_greedy());
    }

    #[test]
    fn test_sampler_config_temperature_zero_is_greedy() {
        let config = SamplerConfig {
            temperature: Some(0.0),
            top_k: None,
            top_p: None,
            repetition_penalty: None,
            seed: None,
            stop_token_ids: Vec::new(),
        };
        assert!(config.is_greedy());
    }

    #[test]
    fn test_sampler_config_not_greedy() {
        let config = SamplerConfig {
            temperature: Some(0.8),
            top_k: Some(50),
            top_p: Some(0.9),
            repetition_penalty: Some(1.1),
            seed: Some(42),
            stop_token_ids: vec![3, 4],
        };
        assert!(!config.is_greedy());
        assert_eq!(config.stop_token_ids, vec![3, 4]);
    }

    #[test]
    fn test_sampler_config_partial_override() {
        let config = SamplerConfig {
            temperature: Some(0.9),
            ..Default::default()
        };
        assert_eq!(config.temperature, Some(0.9));
        assert_eq!(config.top_k, Some(1)); // from Default — still greedy because top_k=1
        assert!(config.top_p.is_none());
        assert!(config.is_greedy()); // top_k=1 always selects only the top token
    }

    #[test]
    fn test_sampler_config_not_greedy_with_top_k_none() {
        let config = SamplerConfig {
            temperature: Some(0.9),
            top_k: None,
            ..Default::default()
        };
        assert!(!config.is_greedy());
    }
}
