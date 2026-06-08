//! GenerationSession — per-generation state machine.
//!
//! A GenerationSession tracks the state of a single autoregressive generation
//! run: session identity, KV cache, token position, EOS policy, maximum token
//! budget, and a state machine governing valid transitions.
//!
//! State machine:
//!   Created → PrefillReady → PrefillRunning → Decoding → Completed
//!                                                ├── Cancelled
//!   PrefillReady ──────────────→ Cancelled
//!   PrefillRunning ────────────→ Cancelled
//!   Any ──────────────────────────────────────────────────────→ Failed

use crate::kv_cache::KvCache;

/// Generation session state machine.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SessionState {
    /// Session created, not yet ready for prefill.
    Created,
    /// Prefill input is available and ready to start.
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

impl SessionState {
    /// Returns `true` if the session is in a terminal state.
    pub fn is_terminal(&self) -> bool {
        matches!(self, Self::Completed | Self::Cancelled | Self::Failed)
    }

    /// Attempt a state transition. Returns `Ok(())` on success or `Err` with
    /// a description of the invalid transition.
    pub fn transition(&self, next: Self) -> Result<(), String> {
        match (*self, next) {
            (Self::Created, Self::PrefillReady)
            | (Self::PrefillReady, Self::PrefillRunning)
            | (Self::PrefillRunning, Self::Decoding)
            | (Self::Decoding, Self::Completed)
            | (Self::Decoding, Self::Cancelled)
            | (Self::PrefillReady, Self::Cancelled)
            | (Self::PrefillRunning, Self::Cancelled) => Ok(()),
            // Any state can transition to Failed.
            (_, Self::Failed) => Ok(()),
            // Identity transitions — no-op.
            (a, b) if a == b => Ok(()),
            _ => Err(format!(
                "Invalid state transition: {:?} → {:?}",
                self, next
            )),
        }
    }
}

/// A generation session tracking one autoregressive run.
#[derive(Debug)]
pub struct GenerationSession {
    /// Opaque session identifier.
    pub session_id: String,
    /// Optional KV cache; populated once prefill is complete.
    pub kv_cache: Option<KvCache>,
    /// Current token position in the sequence (0-indexed).
    pub position: u32,
    /// Token ID that signals end-of-sequence generation.
    pub eos_token_id: u32,
    /// Maximum number of tokens to generate (inclusive of any prompt
    /// prefix length already consumed before this session).
    pub max_tokens: u32,
    /// Current session state.
    state: SessionState,
}

impl GenerationSession {
    /// Create a new generation session.
    pub fn new(
        session_id: String,
        eos_token_id: u32,
        max_tokens: u32,
    ) -> Self {
        Self {
            session_id,
            kv_cache: None,
            position: 0,
            eos_token_id,
            max_tokens,
            state: SessionState::Created,
        }
    }

    /// Return the current state.
    pub fn state(&self) -> SessionState {
        self.state
    }

    /// Attempt a state transition. Returns `Ok(())` or `Err` on invalid
    /// transition (the state is unchanged on error).
    pub fn transition(&mut self, next: SessionState) -> Result<(), String> {
        self.state.transition(next).map(|()| self.state = next)
    }

    /// Returns `true` if the session is in a terminal state.
    pub fn is_terminal(&self) -> bool {
        self.state.is_terminal()
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

    // ── SessionState ───────────────────────────────────────────────────

    #[test]
    fn test_session_state_initial() {
        let s = SessionState::Created;
        assert!(!s.is_terminal());
    }

    #[test]
    fn test_session_state_terminal() {
        assert!(SessionState::Completed.is_terminal());
        assert!(SessionState::Cancelled.is_terminal());
        assert!(SessionState::Failed.is_terminal());
        assert!(!SessionState::Created.is_terminal());
        assert!(!SessionState::Decoding.is_terminal());
    }

    #[test]
    fn test_valid_transitions() {
        // Happy path
        assert!(SessionState::Created.transition(SessionState::PrefillReady).is_ok());
        assert!(SessionState::PrefillReady.transition(SessionState::PrefillRunning).is_ok());
        assert!(SessionState::PrefillRunning.transition(SessionState::Decoding).is_ok());
        assert!(SessionState::Decoding.transition(SessionState::Completed).is_ok());

        // Cancellation paths
        assert!(SessionState::Decoding.transition(SessionState::Cancelled).is_ok());
        assert!(SessionState::PrefillReady.transition(SessionState::Cancelled).is_ok());
        assert!(SessionState::PrefillRunning.transition(SessionState::Cancelled).is_ok());
    }

    #[test]
    fn test_failed_from_any_state() {
        let states = [
            SessionState::Created,
            SessionState::PrefillReady,
            SessionState::PrefillRunning,
            SessionState::Decoding,
            SessionState::Completed,
            SessionState::Cancelled,
            SessionState::Failed,
        ];
        for s in states {
            assert!(
                s.transition(SessionState::Failed).is_ok(),
                "Failed transition should be valid from {:?}",
                s,
            );
        }
    }

    #[test]
    fn test_identity_transitions() {
        let states = [
            SessionState::Created,
            SessionState::PrefillReady,
            SessionState::PrefillRunning,
            SessionState::Decoding,
            SessionState::Completed,
            SessionState::Cancelled,
            SessionState::Failed,
        ];
        for s in states {
            assert!(s.transition(s).is_ok(), "Identity transition should be valid for {:?}", s);
        }
    }

    #[test]
    fn test_invalid_transitions() {
        // Created can only go to PrefillReady or Failed
        assert!(SessionState::Created.transition(SessionState::Decoding).is_err());
        assert!(SessionState::Created.transition(SessionState::Completed).is_err());
        assert!(SessionState::Created.transition(SessionState::Cancelled).is_err());

        // Completed is terminal — cannot go anywhere except Failed
        assert!(SessionState::Completed.transition(SessionState::PrefillReady).is_err());
        assert!(SessionState::Completed.transition(SessionState::Decoding).is_err());

        // Cancelled is terminal
        assert!(SessionState::Cancelled.transition(SessionState::PrefillReady).is_err());

        // Failed is terminal
        assert!(SessionState::Failed.transition(SessionState::Created).is_err());

        // Skipping PrefillReady → Decoding not allowed
        assert!(SessionState::PrefillReady.transition(SessionState::Decoding).is_err());

        // PrefillRunning back to PrefillReady not allowed
        assert!(SessionState::PrefillRunning.transition(SessionState::PrefillReady).is_err());
    }

    // ── GenerationSession ────────────────────────────────────────────────

    #[test]
    fn test_generation_session_new() {
        let session = GenerationSession::new("test-1".into(), 2, 100);
        assert_eq!(session.session_id, "test-1");
        assert_eq!(session.eos_token_id, 2);
        assert_eq!(session.max_tokens, 100);
        assert_eq!(session.position, 0);
        assert!(session.kv_cache.is_none());
        assert_eq!(session.state(), SessionState::Created);
        assert!(!session.is_terminal());
    }

    #[test]
    fn test_generation_session_happy_path() {
        let mut session = GenerationSession::new("s1".into(), 2, 100);
        assert_eq!(session.state(), SessionState::Created);

        session.transition(SessionState::PrefillReady).unwrap();
        assert_eq!(session.state(), SessionState::PrefillReady);

        session.transition(SessionState::PrefillRunning).unwrap();
        assert_eq!(session.state(), SessionState::PrefillRunning);

        session.transition(SessionState::Decoding).unwrap();
        assert_eq!(session.state(), SessionState::Decoding);

        session.transition(SessionState::Completed).unwrap();
        assert_eq!(session.state(), SessionState::Completed);
        assert!(session.is_terminal());
    }

    #[test]
    fn test_generation_session_cancel_during_prefill() {
        let mut session = GenerationSession::new("s2".into(), 2, 100);
        session.transition(SessionState::PrefillReady).unwrap();
        session.transition(SessionState::Cancelled).unwrap();
        assert_eq!(session.state(), SessionState::Cancelled);
        assert!(session.is_terminal());
    }

    #[test]
    fn test_generation_session_cancel_during_decoding() {
        let mut session = GenerationSession::new("s3".into(), 2, 100);
        session.transition(SessionState::PrefillReady).unwrap();
        session.transition(SessionState::PrefillRunning).unwrap();
        session.transition(SessionState::Decoding).unwrap();
        session.transition(SessionState::Cancelled).unwrap();
        assert_eq!(session.state(), SessionState::Cancelled);
    }

    #[test]
    fn test_generation_session_fail_from_any_state() {
        for (label, mut session) in [
            ("created", GenerationSession::new("f1".into(), 2, 100)),
            ("prefill_ready", {
                let mut s = GenerationSession::new("f2".into(), 2, 100);
                s.transition(SessionState::PrefillReady).unwrap();
                s
            }),
            ("prefill_running", {
                let mut s = GenerationSession::new("f3".into(), 2, 100);
                s.transition(SessionState::PrefillReady).unwrap();
                s.transition(SessionState::PrefillRunning).unwrap();
                s
            }),
            ("decoding", {
                let mut s = GenerationSession::new("f4".into(), 2, 100);
                s.transition(SessionState::PrefillReady).unwrap();
                s.transition(SessionState::PrefillRunning).unwrap();
                s.transition(SessionState::Decoding).unwrap();
                s
            }),
            ("terminal", {
                let mut s = GenerationSession::new("f5".into(), 2, 100);
                s.transition(SessionState::PrefillReady).unwrap();
                s.transition(SessionState::PrefillRunning).unwrap();
                s.transition(SessionState::Decoding).unwrap();
                s.transition(SessionState::Completed).unwrap();
                s
            }),
        ] {
            assert!(
                session.transition(SessionState::Failed).is_ok(),
                "Failed from {:?} should be valid",
                label,
            );
            assert!(session.is_terminal());
        }
    }

    #[test]
    fn test_generation_session_invalid_transition_preserves_state() {
        let mut session = GenerationSession::new("s6".into(), 2, 100);
        assert_eq!(session.state(), SessionState::Created);

        // Cannot skip to Decoding
        assert!(session.transition(SessionState::Decoding).is_err());
        assert_eq!(session.state(), SessionState::Created);
    }

    #[test]
    fn test_generation_session_identity_transition() {
        let mut session = GenerationSession::new("s7".into(), 2, 100);
        session.transition(SessionState::PrefillReady).unwrap();
        // Identity should be a no-op
        assert!(session.transition(SessionState::PrefillReady).is_ok());
        assert_eq!(session.state(), SessionState::PrefillReady);
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
