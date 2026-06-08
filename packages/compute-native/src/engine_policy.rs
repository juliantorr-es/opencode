//! Immutable execution policies for the Tribunus Compute Kernel.
//!
//! This module defines the compiled-in policy surface, pure budget resolution,
//! request admission, and deadline representation. No napi or mlx-rs imports.

use std::sync::Arc;
use std::time::{Duration, Instant};

// ── Constants ──────────────────────────────────────────────────────────────

/// In qualification mode, `max_tokens == 0` is coerced to this many generated
/// tokens so the engine always has a bounded output budget.
pub(crate) const SAFE_ZERO_MAX_TOKENS: u32 = 8;

/// Maximum allowed prompt tokens for qualification-mode requests.
const QUALIFICATION_PROMPT_TOKEN_CEILING: usize = 64;

/// Wall-clock deadline for a single qualification-mode generation request.
pub(crate) const QUALIFICATION_WALL_CLOCK_DEADLINE: Duration = Duration::from_secs(30);

// ── ExecutionPolicy ────────────────────────────────────────────────────────

/// Compiled-in execution policy whose fields are public and immutable after
/// construction. Every field is set at policy-build time and never overridden
/// per-request (except via the `private-development` override gate).
#[derive(Clone, Debug)]
pub struct ExecutionPolicy {
    /// Physical memory reserved for the process (guard page, signal handling, etc.).
    pub physical_memory_reserve_bytes: u64,
    /// Ceiling for admitting a model into memory (loading weights, KV cache).
    pub model_admission_ceiling_bytes: u64,
    /// Soft RSS limit — process should trigger memory pressure before this.
    pub worker_rss_soft_ceiling_bytes: u64,
    /// Hard RSS limit — process MUST terminate if exceeded.
    pub worker_rss_hard_ceiling_bytes: u64,
    /// MLX Metal active memory budget.
    pub mlx_active_memory_limit_bytes: u64,
    /// MLX Metal cache limit.
    pub mlx_cache_limit_bytes: u64,
    /// Maximum allowed prompt tokens for admission.
    pub prompt_token_ceiling: usize,
    /// Maximum generated tokens per request.
    pub output_token_ceiling: u32,
    /// Wall-clock deadline for a single generation request.
    pub request_deadline: Duration,
    /// Grace period after cancellation before forcible teardown.
    pub cancellation_grace_period: Duration,
    /// Worker heartbeat timeout before assumed dead.
    pub worker_heartbeat_timeout: Duration,
    /// Maximum IPC frame size (bytes).
    pub max_ipc_frame_size: usize,
    /// Whether this policy is for unqualified (non-production) use.
    /// Set to `true` by `allow_high_memory_override()` under the
    /// `private-development` feature gate.
    pub unqualified: bool,
    /// Max time to wait for model load handshake.
    pub model_load_timeout: Duration,
    /// Watchdog tick interval in milliseconds.
    pub watchdog_interval_ms: u64,
    /// RSS must fall below this to clear a soft-pressure episode.
    pub soft_pressure_reset_threshold_bytes: u64,
    /// Max worker restarts before permanent fault.
    pub restart_limit: u32,
    /// Max bytes of worker stderr kept in ring buffer.
    pub stderr_diagnostic_ceiling_bytes: usize,
}

// ── EosPolicy ──────────────────────────────────────────────────────────────

/// Controls how the generation loop decides when to stop.
#[derive(Clone, Debug)]
pub enum EosPolicy {
    /// Stop when the model emits the end-of-sequence token.
    StopAtEos,
    /// Stop when `max_tokens` have been produced, regardless of EOS.
    StopAtMaxTokens,
}

// ── SamplingRestrictions ───────────────────────────────────────────────────

/// Restrictions applied to the sampling strategy.
#[derive(Clone, Debug, PartialEq)]
pub enum SamplingRestrictions {
    /// Only greedy (argmax) sampling is permitted. Used in qualification mode
    /// to eliminate sampling variability as a confound.
    GreedyOnly,
}

// ── GenerationBudget ───────────────────────────────────────────────────────

/// A fully-resolved generation budget for a single request.
///
/// Produced by [`resolve_generation_budget`] and never mutated.
#[derive(Clone, Debug)]
pub struct GenerationBudget {
    /// Whether this budget was computed under qualification-mode rules.
    /// When `true`, `max_tokens == 0` maps to [`SAFE_ZERO_MAX_TOKENS`].
    pub qualification_mode: bool,
    /// The final token generation ceiling after policy resolution.
    pub effective_output_token_ceiling: u32,
    /// The prompt-token ceiling that was applied during admission.
    pub prompt_token_ceiling: usize,
    /// The wall-clock deadline for this generation.
    pub deadline: Duration,
    /// The end-of-sequence policy for the generation loop.
    pub eos_policy: EosPolicy,
    /// Sampling restrictions applied to this budget.
    pub sampling_restrictions: SamplingRestrictions,
    /// Memory allowance available to this generation (bytes).
    pub memory_allowance_bytes: u64,
}

// ── RequestAdmission ───────────────────────────────────────────────────────

/// The result of attempting to admit a request against a policy.
#[derive(Clone, Debug)]
pub struct RequestAdmission {
    /// Whether the request was admitted.
    pub admitted: bool,
    /// Human-readable explanation for rejection. `None` when admitted.
    pub reason: Option<String>,
    /// The resolved generation budget. `Some` only when `admitted` is `true`.
    pub budget: Option<GenerationBudget>,
}

impl RequestAdmission {
    fn admitted(budget: GenerationBudget) -> Self {
        Self {
            admitted: true,
            reason: None,
            budget: Some(budget),
        }
    }

    fn rejected(reason: impl Into<String>) -> Self {
        Self {
            admitted: false,
            reason: Some(reason.into()),
            budget: None,
        }
    }
}

// ── DeadlineGuard ──────────────────────────────────────────────────────────

/// A guard that tracks time relative to an absolute deadline using an injectable
/// monotonic clock. Useful for testing deadline-sensitive policy branches without
/// waiting on wall time.
#[derive(Clone)]
pub struct DeadlineGuard {
    /// The instant the guard was created.
    created: Instant,
    /// The absolute deadline instant.
    deadline: Instant,
    /// Injectable monotonic clock. Returns the current [`Instant`]. Must be
    /// monotonic (e.g. [`std::time::Instant::now`]).
    clock: Arc<dyn Fn() -> Instant + Send + Sync>,
}

impl std::fmt::Debug for DeadlineGuard {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DeadlineGuard")
            .field("elapsed", &self.elapsed())
            .field("remaining", &self.remaining())
            .field("is_expired", &self.is_expired())
            .finish_non_exhaustive()
    }
}

impl DeadlineGuard {
    /// Create a new guard whose deadline is `policy.request_deadline` from now
    /// according to `clock`.
    pub fn new(
        policy: &ExecutionPolicy,
        clock: impl Fn() -> Instant + Send + Sync + 'static,
    ) -> Self {
        let now = clock();
        Self {
            created: now,
            deadline: now + policy.request_deadline,
            clock: Arc::new(clock),
        }
    }

    /// Duration elapsed since the guard was created.
    pub fn elapsed(&self) -> Duration {
        (self.clock)() - self.created
    }

    /// Duration remaining until the deadline. Returns [`Duration::ZERO`] when
    /// the deadline has already passed.
    pub fn remaining(&self) -> Duration {
        let now = (self.clock)();
        if now >= self.deadline {
            Duration::ZERO
        } else {
            self.deadline - now
        }
    }

    /// Whether the deadline has passed.
    pub fn is_expired(&self) -> bool {
        (self.clock)() >= self.deadline
    }

    /// If the deadline has passed, returns the duration since expiry.
    /// Returns `None` when the deadline has not yet passed.
    pub fn time_since_expiry(&self) -> Option<Duration> {
        let now = (self.clock)();
        if now >= self.deadline {
            Some(now - self.deadline)
        } else {
            None
        }
    }
}

// ── Resolution ─────────────────────────────────────────────────────────────

/// Pure-function budget resolution.
///
/// Evaluates whether a request can be admitted under `policy` given the
/// requested maximum output tokens and the actual prompt-token count.
///
/// # Rejection criteria
///
/// - The prompt exceeds `policy.prompt_token_ceiling`.
///
/// # Output-ceiling resolution
///
/// The zero-token treatment depends on the policy's `unqualified` field:
///
/// | Context | `request_max_tokens == 0` resolves to |
/// |---|---|
/// | Qualification (`unqualified == false`) | `SAFE_ZERO_MAX_TOKENS` (8) |
/// | Non-qualification (`unqualified == true`) | `policy.output_token_ceiling` |
///
/// Non-zero values are clamped to `policy.output_token_ceiling` regardless of
/// qualification mode.
pub fn resolve_generation_budget(
    policy: &ExecutionPolicy,
    request_max_tokens: u32,
    prompt_token_count: usize,
) -> RequestAdmission {
    // Reject oversize prompts.
    if prompt_token_count > policy.prompt_token_ceiling {
        return RequestAdmission::rejected(format!(
            "prompt token count {} exceeds policy ceiling {}",
            prompt_token_count, policy.prompt_token_ceiling,
        ));
    }

    // Determine qualification context.
    // A policy is considered "qualification mode" when `unqualified` is false.
    // This is the only signal — the function has no other context.
    let is_qualification = !policy.unqualified;

    // Resolve output-token ceiling with qualification-aware zero handling.
    let effective_output = if request_max_tokens == 0 {
        if is_qualification {
            SAFE_ZERO_MAX_TOKENS
        } else {
            policy.output_token_ceiling
        }
    } else if request_max_tokens > policy.output_token_ceiling {
        policy.output_token_ceiling
    } else {
        request_max_tokens
    };

    let eos_policy = if is_qualification {
        EosPolicy::StopAtMaxTokens
    } else {
        EosPolicy::StopAtEos
    };

    let sampling = SamplingRestrictions::GreedyOnly;

    // Determine a plausible memory allowance.
    // 512 bytes per output token is a rough heuristic for KV-cache scratch
    // and temporary activations. Real budgeting lives in the arena layer.
    let memory_allowance_bytes = (effective_output as u64) * 512;

    RequestAdmission::admitted(GenerationBudget {
        qualification_mode: is_qualification,
        effective_output_token_ceiling: effective_output,
        prompt_token_ceiling: policy.prompt_token_ceiling,
        deadline: policy.request_deadline,
        eos_policy,
        sampling_restrictions: sampling,
        memory_allowance_bytes,
    })
}

// ── Known policies ─────────────────────────────────────────────────────────

/// The compiled-in qualification policy: a conservative 16-GiB profile intended
/// for automated qualification runs where determinism and bounded resource use
/// are mandatory.
///
/// | Field | Value |
/// |---|---|
/// | `physical_memory_reserve_bytes` | 1 GiB |
/// | `model_admission_ceiling_bytes` | 12 GiB |
/// | `worker_rss_soft_ceiling_bytes` | 13 GiB |
/// | `worker_rss_hard_ceiling_bytes` | 14 GiB |
/// | `mlx_active_memory_limit_bytes` | 10 GiB |
/// | `mlx_cache_limit_bytes` | 1 GiB |
/// | `prompt_token_ceiling` | 64 |
/// | `output_token_ceiling` | 8 |
/// | `request_deadline` | 30 s |
/// | `cancellation_grace_period` | 2 s |
/// | `worker_heartbeat_timeout` | 2 s |
/// | `max_ipc_frame_size` | 1 MiB |
/// | `unqualified` | `false` |
/// | `model_load_timeout` | 120 s |
/// | `watchdog_interval_ms` | 150 |
/// | `soft_pressure_reset_threshold_bytes` | 12 GiB |
/// | `restart_limit` | 3 |
/// | `stderr_diagnostic_ceiling_bytes` | 65536 (64 KiB) |
pub fn qualification_policy() -> ExecutionPolicy {
    ExecutionPolicy {
        physical_memory_reserve_bytes: 1 << 30,            // 1 GiB
        model_admission_ceiling_bytes: 12 << 30,           // 12 GiB
        worker_rss_soft_ceiling_bytes: 13 << 30,           // 13 GiB
        worker_rss_hard_ceiling_bytes: 14 << 30,           // 14 GiB
        mlx_active_memory_limit_bytes: 10 << 30,           // 10 GiB
        mlx_cache_limit_bytes: 1 << 30,                    // 1 GiB
        prompt_token_ceiling: QUALIFICATION_PROMPT_TOKEN_CEILING, // 64
        output_token_ceiling: SAFE_ZERO_MAX_TOKENS,        // 8
        request_deadline: QUALIFICATION_WALL_CLOCK_DEADLINE, // 30 s
        cancellation_grace_period: Duration::from_secs(2),
        worker_heartbeat_timeout: Duration::from_secs(2),
        max_ipc_frame_size: 1 << 20,                       // 1 MiB
        unqualified: false,
        model_load_timeout: Duration::from_secs(120),     // 120 s
        watchdog_interval_ms: 150,                         // 150 ms
        soft_pressure_reset_threshold_bytes: 12 << 30,    // 12 GiB
        restart_limit: 3,
        stderr_diagnostic_ceiling_bytes: 65536,            // 64 KiB
    }
}

/// Return a policy with elevated resource ceilings for local development.
///
/// This function is gated behind `#[cfg(feature = "private-development")]` and
/// MUST NOT be compiled into release or CI builds. The returned policy sets
/// `unqualified: true` and raises all memory and throughput limits to generous
/// values suitable for a developer workstation.
#[cfg(feature = "private-development")]
pub fn allow_high_memory_override() -> ExecutionPolicy {
    ExecutionPolicy {
        physical_memory_reserve_bytes: 1 << 30,            // 1 GiB
        model_admission_ceiling_bytes: 48 << 30,           // 48 GiB
        worker_rss_soft_ceiling_bytes: 56 << 30,           // 56 GiB
        worker_rss_hard_ceiling_bytes: 60 << 30,           // 60 GiB
        mlx_active_memory_limit_bytes: 40 << 30,           // 40 GiB
        mlx_cache_limit_bytes: 4 << 30,                    // 4 GiB
        prompt_token_ceiling: 4096,
        output_token_ceiling: 2048,
        request_deadline: Duration::from_secs(300),        // 5 min
        cancellation_grace_period: Duration::from_secs(5),
        worker_heartbeat_timeout: Duration::from_secs(10),
        max_ipc_frame_size: 16 << 20,                      // 16 MiB
        unqualified: true,
        model_load_timeout: Duration::from_secs(300),    // 5 min
        watchdog_interval_ms: 500,                         // 500 ms
        soft_pressure_reset_threshold_bytes: 60 << 30,    // 60 GiB
        restart_limit: 10,
        stderr_diagnostic_ceiling_bytes: 1 << 20,          // 1 MiB
    }
}

// ── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    // ── resolve_generation_budget ─────────────────────────────────────────

    #[test]
    fn rejects_oversize_prompt() {
        let policy = qualification_policy();
        let admission =
            resolve_generation_budget(&policy, 8, policy.prompt_token_ceiling + 1);
        assert!(!admission.admitted);
        assert!(admission.reason.unwrap().contains("exceeds"));
    }

    #[test]
    fn zero_max_tokens_maps_to_safe_zero() {
        let policy = qualification_policy();
        let admission = resolve_generation_budget(&policy, 0, 10);
        assert!(admission.admitted);
        let budget = admission.budget.unwrap();
        assert_eq!(budget.effective_output_token_ceiling, SAFE_ZERO_MAX_TOKENS);
    }

    #[test]
    fn non_zero_max_tokens_below_ceiling_is_preserved() {
        let policy = qualification_policy();
        let admission = resolve_generation_budget(&policy, 4, 10);
        assert!(admission.admitted);
        let budget = admission.budget.unwrap();
        assert_eq!(budget.effective_output_token_ceiling, 4);
    }

    #[test]
    fn max_tokens_above_ceiling_is_clamped() {
        let policy = qualification_policy();
        let admission = resolve_generation_budget(&policy, 999, 10);
        assert!(admission.admitted);
        let budget = admission.budget.unwrap();
        assert_eq!(budget.effective_output_token_ceiling, policy.output_token_ceiling);
    }

    #[test]
    fn prompt_ceiling_boundary_accepted() {
        let policy = qualification_policy();
        let admission =
            resolve_generation_budget(&policy, 8, policy.prompt_token_ceiling);
        assert!(admission.admitted);
    }

    // ── qualification_policy constants ───────────────────────────────────

    #[test]
    fn qualification_policy_values() {
        let p = qualification_policy();
        assert_eq!(p.physical_memory_reserve_bytes, 1 << 30);
        assert_eq!(p.model_admission_ceiling_bytes, 12 << 30);
        assert_eq!(p.worker_rss_soft_ceiling_bytes, 13 << 30);
        assert_eq!(p.worker_rss_hard_ceiling_bytes, 14 << 30);
        assert_eq!(p.mlx_active_memory_limit_bytes, 10 << 30);
        assert_eq!(p.mlx_cache_limit_bytes, 1 << 30);
        assert_eq!(p.prompt_token_ceiling, 64);
        assert_eq!(p.output_token_ceiling, 8);
        assert_eq!(p.request_deadline, Duration::from_secs(30));
        assert_eq!(p.cancellation_grace_period, Duration::from_secs(2));
        assert_eq!(p.worker_heartbeat_timeout, Duration::from_secs(2));
        assert_eq!(p.max_ipc_frame_size, 1 << 20);
        assert!(!p.unqualified);
        assert_eq!(p.model_load_timeout, Duration::from_secs(120));
        assert_eq!(p.watchdog_interval_ms, 150);
        assert_eq!(p.soft_pressure_reset_threshold_bytes, 12 << 30);
        assert_eq!(p.restart_limit, 3);
        assert_eq!(p.stderr_diagnostic_ceiling_bytes, 65536);
    }

    // ── DeadlineGuard ────────────────────────────────────────────────────

    #[test]
    fn deadline_guard_elapsed_before_expiry() {
        let fake_now = Arc::new(std::sync::Mutex::new(Instant::now()));
        let clock_now = Arc::clone(&fake_now);
        let clock = move || *clock_now.lock().unwrap();

        let policy = qualification_policy();
        let guard = DeadlineGuard::new(&policy, clock);
        assert!(!guard.is_expired());
        assert_eq!(guard.elapsed(), Duration::ZERO);
        assert_eq!(guard.remaining(), policy.request_deadline);
        assert!(guard.time_since_expiry().is_none());

        // Advance 10 seconds.
        *fake_now.lock().unwrap() += Duration::from_secs(10);
        assert_eq!(guard.elapsed(), Duration::from_secs(10));
        assert_eq!(guard.remaining(), policy.request_deadline - Duration::from_secs(10));
    }

    #[test]
    fn deadline_guard_expiry() {
        let policy = qualification_policy();
        let guard = DeadlineGuard::new(&policy, Instant::now);
        // Wait a tiny bit — Instant::now is monotonic and real, so this
        // actually exercises the clock.
        std::thread::sleep(Duration::from_millis(1));
        assert!(guard.elapsed() > Duration::ZERO);
    }

    #[test]
    fn deadline_guard_time_since_expiry() {
        let fake_now = Arc::new(std::sync::Mutex::new(Instant::now()));
        let clock_now = Arc::clone(&fake_now);
        let clock = move || *clock_now.lock().unwrap();

        let policy = qualification_policy();
        let guard = DeadlineGuard::new(&policy, clock);
        assert!(guard.time_since_expiry().is_none());

        // Jump past the deadline.
        *fake_now.lock().unwrap() += policy.request_deadline + Duration::from_secs(5);
        assert!(guard.is_expired());
        let since = guard.time_since_expiry().unwrap();
        assert_eq!(since, Duration::from_secs(5));
    }
}
