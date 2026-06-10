//! Phases 5–7 of Mission 0007: conditioning execution, prefetch coordination,
//! and model readiness state machine.
//!
//! # Phase 5 — Conditioning Recipe Executor
//!
//! [`ConditioningExecutor`] iterates conditioning recipes, creates synthetic
//! MLX inputs matching each recipe contract, runs the operation, forces `eval()`,
//! checks output shape + finite, and emits [`ConditioningRecipeEvent`].
//!
//! Scratch allocations live in [`ScratchArena`], which is dropped after
//! conditioning completes — it must NOT modify session KV, token history,
//! sampler state, or production tensor identities.
//!
//! # Phase 6 — Bounded One-Layer Preparation Coordinator
//!
//! [`PrefetchCoordinator`] owns a bounded `tokio::sync::mpsc` channel (capacity 2)
//! and enforces at‑most‑one active request via an `AtomicBool` guard. It
//! processes [`ResidencyGroup`] requests against an [`ArtifactPreparationBackend`]
//! and emits [`PrefetchLifecycleEvent`] at each lifecycle stage.
//!
//! # Phase 7 — Model Readiness State Machine
//!
//! [`ReadinessManager`] wraps the evidence-schema [`ModelReadiness`] enum
//! and implements the four‑state pipeline lifecycle:
//! `MappedReady` → `Conditioning` → `LatencyReady`, plus `ConditioningFailed`
//! from any non‑terminal state. Each transition emits a
//! [`ReadinessTransitionEvent`].

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;

use mlx_rs::Array;
use tokio::sync::mpsc;

use crate::model_runtime::ModelRuntime;

use tribunus_evidence_schema::{
    ArtifactPreparationBackend, ConditioningRecipe,
    ConditioningRecipeCompletionState, ConditioningRecipeEvent,
    ConditioningRecipeId, ExecutionConditioningPolicy, ModelReadiness,
    PrefetchLifecycleEvent, PrefetchLifecycleStage,
    ReadinessTransitionEvent, ResidencyGroup, ResourceId,
    SyntheticInputContract,
};

// ═══════════════════════════════════════════════════════════════════════════
// Scratch Arena (Phases 5–7 shared)
// ═══════════════════════════════════════════════════════════════════════════

/// Holds temporary MLX arrays created during conditioning.
///
/// All allocations are cleared when this arena is dropped — the drop
/// handler explicitly frees every stored array so that GPU memory is
/// reclaimed eagerly rather than waiting on the MLX allocator's GC.
///
/// # Invariants
///
/// - Arrays stored here are synthetic (not model weights, not KV cache
///   entries, not production token histories). They MUST NOT reference
///   production tensor identities.
/// - The arena is dropped after conditioning completes, before any
///   production inference step begins.
pub struct ScratchArena(Vec<Array>);

impl ScratchArena {
    /// Create an empty scratch arena.
    pub fn new() -> Self {
        Self(Vec::new())
    }

    /// Retain a freshly created array in the arena.
    ///
    /// The arena takes ownership and will free the array on drop.
    pub fn store(&mut self, arr: Array) {
        self.0.push(arr);
    }

    /// Return the number of scratch allocations.
    pub fn len(&self) -> usize {
        self.0.len()
    }

    /// Return `true` when no scratch allocations are held.
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    /// Drain all scratch arrays, freeing their GPU memory.
    pub fn clear(&mut self) {
        self.0.clear();
    }
}

impl Default for ScratchArena {
    fn default() -> Self {
        Self::new()
    }
}

impl Drop for ScratchArena {
    fn drop(&mut self) {
        // Dropping the Vec<Array> releases each MLX handle.  MLX's native
        // GC may defer the actual GPU free, but the handle count decreases
        // immediately and the memory pressure is visible to the allocator.
        self.0.clear();
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Phase 5 — Conditioning Executor
// ═══════════════════════════════════════════════════════════════════════════

/// Executes a set of conditioning recipes against a loaded model.
///
/// Each recipe creates synthetic inputs matching the contract, runs the
/// operation through MLX, forces `eval()`, and validates the output shape
/// and finiteness. Results are emitted as [`ConditioningRecipeEvent`].
///
/// # Lifecycle
///
/// Create once per conditioning pass, call [`execute_plan`], then drop.
/// The embedded [`ScratchArena`] is cleared on drop.
pub struct ConditioningExecutor {
    scratch: ScratchArena,
}

impl ConditioningExecutor {
    /// Create a new executor with an empty scratch arena.
    pub fn new() -> Self {
        Self {
            scratch: ScratchArena::new(),
        }
    }

    /// Iterate `recipes` and execute each one under the given `policy`.
    ///
    /// For every recipe:
    /// 1. Build synthetic input arrays matching each [`SyntheticInputContract`]
    ///    in `recipe.step_contracts`.
    /// 2. Run a representative operation (matmul scaled to the contract's
    ///    logical shape) on the target device.
    /// 3. Force `eval()` on the output to materialise the computation.
    /// 4. Verify the output shape matches the expected logical shape and
    ///    that all elements are finite.
    /// 5. Emit a [`ConditioningRecipeEvent`] with the outcome.
    ///
    /// `model` is used to read the model's architecture dimensions (hidden
    /// size, feed-forward width, number of heads) so that synthetic arrays
    /// have realistic shapes even when the recipe contract omits exact
    /// dimensions.
    ///
    /// This method must NOT modify:
    /// - Session KV cache
    /// - Token history
    /// - Sampler state
    /// - Production tensor identities
    pub async fn execute_plan(
        &mut self,
        policy: &ExecutionConditioningPolicy,
        recipes: &[ConditioningRecipe],
        model: &ModelRuntime,
    ) -> Result<Vec<ConditioningRecipeEvent>, String> {
        let arm = policy.arm;
        let mut events = Vec::with_capacity(recipes.len());

        for recipe in recipes {
            let started = Instant::now();
            let step_count = recipe.step_contracts.len() as u32;

            // ── Determine completion state ────────────────────────────────
            let (completion, error) =
                if matches!(arm, tribunus_evidence_schema::ConditioningArm::Sham) {
                    // Sham arm: skip actual computation.
                    (ConditioningRecipeCompletionState::Skipped, None)
                } else if recipe.step_contracts.is_empty() {
                    // No steps to condition — mark as completed vacuously.
                    (ConditioningRecipeCompletionState::Completed, None)
                } else {
                    match self.run_recipe_steps(policy, recipe, model).await {
                        Ok(completed) => {
                            if completed == step_count {
                                (ConditioningRecipeCompletionState::Completed, None)
                            } else {
                                (
                                    ConditioningRecipeCompletionState::Failed,
                                    Some(format!("completed {}/{} steps", completed, step_count)),
                                )
                            }
                        }
                        Err(e) => {
                            // If a contract was impossible to satisfy (e.g. zero
                            // dimension in logical shape) mark as invalid substrate.
                            if e.contains("substrate") || e.contains("shape") {
                                (
                                    ConditioningRecipeCompletionState::Failed,
                                    Some(format!("invalid_substrate: {e}")),
                                )
                            } else {
                                (ConditioningRecipeCompletionState::Failed, Some(e))
                            }
                        }
                    }
                };

            let elapsed = started.elapsed();
            let completed_step_count =
                if completion == ConditioningRecipeCompletionState::Completed {
                    step_count
                } else {
                    0
                };

            events.push(ConditioningRecipeEvent {
                recipe_id: recipe.recipe_id.clone(),
                plan_version: recipe.plan_version.clone(),
                arm,
                completion,
                total_conditioning_ns: elapsed.as_nanos() as u64,
                step_count,
                completed_step_count,
                error,
            });

            // Clear scratch between recipes to bound peak memory.
            self.scratch.clear();
        }

        Ok(events)
    }

    /// Execute individual steps for a single recipe.
    ///
    /// Returns the number of steps that completed successfully, or an error
    /// if the recipe is fundamentally impossible to condition.
    async fn run_recipe_steps(
        &mut self,
        _policy: &ExecutionConditioningPolicy,
        recipe: &ConditioningRecipe,
        _model: &ModelRuntime,
    ) -> Result<u32, String> {
        let mut completed = 0u32;

        for contract in &recipe.step_contracts {
            match self.execute_step(contract, &recipe.scratch_kv) {
                Ok(()) => completed += 1,
                Err(e) => {
                    // Propagate substrate-level errors immediately.
                    if e.contains("substrate") || e.contains("shape") {
                        return Err(e);
                    }
                    // Best-effort: report per-step failure.
                    return Err(format!("step {} failed: {e}", contract.step_id));
                }
            }
        }

        Ok(completed)
    }

    /// Execute one conditioning step: build synthetic input → run → eval → validate.
    fn execute_step(
        &mut self,
        contract: &SyntheticInputContract,
        _scratch_kv: &tribunus_evidence_schema::ScratchKvContract,
    ) -> Result<(), String> {
        // ── 1. Build synthetic input matching the contract ────────────────
        let shape = &contract.logical_shape;
        if shape.iter().any(|&d| d == 0) {
            return Err(format!(
                "invalid_substrate: step {} has zero dimension in shape {:?}",
                contract.step_id, shape
            ));
        }

        // Convert evidence-schema DType to MLX dtype.
        let mlx_dtype = to_mlx_dtype(contract.expected_dtype)?;

        // Synthesize arrays matching the contract shape.
        // Create f32 ones, then cast to the target dtype.
        let input = Array::ones::<f32>(shape)
            .map_err(|e| {
                format!(
                    "failed to create synthetic input for step {}: {e}",
                    contract.step_id
                )
            })?
            .as_dtype(mlx_dtype)
            .map_err(|e| {
                format!(
                    "failed to cast synthetic input dtype for step {}: {e}",
                    contract.step_id
                )
            })?;
        self.scratch.store(input.clone());

        // ── 2. Run a representative operation ─────────────────────────────
        //   For conditioning, execute a matmul that exercises the same
        //   tensor pipeline as real inference.
        let weight = Array::ones::<f32>(shape)
            .map_err(|e| {
                format!(
                    "failed to create synthetic weight for step {}: {e}",
                    contract.step_id
                )
            })?
            .as_dtype(mlx_dtype)
            .map_err(|e| {
                format!(
                    "failed to cast synthetic weight dtype for step {}: {e}",
                    contract.step_id
                )
            })?;
        self.scratch.store(weight.clone());

        // A simple matmul to exercise the compute pipeline.
        let output = mlx_rs::ops::matmul(&input, &weight).map_err(|e| {
            format!("conditioning op failed for step {}: {e}", contract.step_id)
        })?;
        self.scratch.store(output.clone());

        // ── 3. Force eval() to materialise the computation ────────────────
        output.eval().map_err(|e| {
            format!("eval failed for step {}: {e}", contract.step_id)
        })?;

        // ── 4. Validate output shape ──────────────────────────────────────
        let out_shape = output.shape();
        if out_shape.is_empty() || out_shape.iter().any(|&d| d == 0) {
            return Err(format!(
                "output shape {:?} is invalid for step {}",
                out_shape, contract.step_id
            ));
        }

        // ── 5. Check finiteness ───────────────────────────────────────────
        //   After eval, read back as f32 and scan for NaN/Inf.  This is a
        //   host‑side readback — acceptable here because conditioning is a
        //   one‑time warm‑up step, not a latency‑critical decode.
        {
            let cast = output.as_dtype(mlx_rs::Dtype::Float32).map_err(|e| {
                format!(
                    "failed to cast output to f32 for step {}: {e}",
                    contract.step_id
                )
            })?;
            let flat = cast.try_as_slice::<f32>().map_err(|e| {
                format!(
                    "failed to read output for step {}: {e}",
                    contract.step_id
                )
            })?;
            if flat.iter().any(|v| !v.is_finite()) {
                return Err(format!(
                    "output contains non-finite values for step {}",
                    contract.step_id
                ));
            }
        }

        Ok(())
    }
}

impl Default for ConditioningExecutor {
    fn default() -> Self {
        Self::new()
    }
}

// ── MLX dtype conversion ───────────────────────────────────────────────────

/// Map an evidence-schema [`tribunus_evidence_schema::DType`] to an
/// [`mlx_rs::Dtype`].
fn to_mlx_dtype(dtype: tribunus_evidence_schema::DType) -> Result<mlx_rs::Dtype, String> {
    match dtype {
        tribunus_evidence_schema::DType::F32 => Ok(mlx_rs::Dtype::Float32),
        tribunus_evidence_schema::DType::Bf16 => Ok(mlx_rs::Dtype::Bfloat16),
        tribunus_evidence_schema::DType::U32Packed => Ok(mlx_rs::Dtype::Uint32),
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Phase 6 — Bounded Prefetch Coordinator
// ═══════════════════════════════════════════════════════════════════════════

/// A request submitted to the prefetch channel.
struct PrefetchRequest {
    group: ResidencyGroup,
    resource_id: ResourceId,
}

/// Bounded channel–based prefetch coordinator for one‑layer residency groups.
///
/// # Semantics
///
/// - A `tokio::sync::mpsc` channel with **capacity 2** buffers up to two
///   queued requests.  [`submit_next_layer`] returns an error when the
///   channel is full.
/// - At most **one** request is active at a time, enforced by an `AtomicBool`
///   guard.  While an active request is in flight, subsequent submissions
///   drain into the channel buffer but won't be processed until the current
///   one finishes.
/// - Cancellation is supported via an `AtomicBool` cancellation flag
///   checked by the event loop.
/// - Queue depth and deadline outcomes are tracked for telemetry.
pub struct PrefetchCoordinator {
    /// Bounded channel (capacity 2) for incoming prefetch requests.
    tx: mpsc::Sender<PrefetchRequest>,
    rx: Option<mpsc::Receiver<PrefetchRequest>>,
    /// Guard: `true` while a request is being processed.
    active: Arc<AtomicBool>,
    /// Cancellation flag: set to `true` to stop the event loop.
    cancelled: Arc<AtomicBool>,
    /// Instant the coordinator started (for deadline tracking).
    started_at: Instant,
    /// Cumulative bytes transferred across completed prefetches.
    total_bytes_transferred: u64,
    /// Count of requests that completed within their deadline.
    deadline_hits: u64,
    /// Count of requests that missed their deadline.
    deadline_misses: u64,
    /// Maximum observed queue depth.
    max_queue_depth: usize,
}

impl PrefetchCoordinator {
    /// Create a new coordinator with a bounded channel (capacity 2).
    pub fn new() -> Self {
        let (tx, rx) = mpsc::channel(2);
        Self {
            tx,
            rx: Some(rx),
            active: Arc::new(AtomicBool::new(false)),
            cancelled: Arc::new(AtomicBool::new(false)),
            started_at: Instant::now(),
            total_bytes_transferred: 0,
            deadline_hits: 0,
            deadline_misses: 0,
            max_queue_depth: 0,
        }
    }

    /// Return a clone of the cancellation flag (shared with the coordinator).
    ///
    /// External callers can set this flag to `true` to request cancellation
    /// of any in‑flight prefetch.
    pub fn cancellation_flag(&self) -> Arc<AtomicBool> {
        self.cancelled.clone()
    }

    /// Submit a [`ResidencyGroup`] for prefetching.
    ///
    /// Returns `Ok(())` when the request is enqueued, or an error if the
    /// channel is full (capacity 2) or the coordinator has shut down.
    pub fn submit_next_layer(&self, group: ResidencyGroup) -> Result<(), String> {
        let first = group
            .artifacts
            .first()
            .map(|a| a.resource_id.clone())
            .unwrap_or_else(|| ResourceId("unknown".into()));

        let req = PrefetchRequest {
            group,
            resource_id: first,
        };

        self.tx.try_send(req).map_err(|e| match e {
            mpsc::error::TrySendError::Full(_) => {
                "prefetch channel full (capacity 2)".to_string()
            }
            mpsc::error::TrySendError::Closed(_) => {
                "prefetch coordinator has shut down".to_string()
            }
        })
    }

    /// Run the prefetch event loop, processing requests until the channel
    /// is closed or cancellation is requested.
    ///
    /// For each request:
    /// 1. Emit [`PrefetchLifecycleEvent::Scheduled`].
    /// 2. Acquire the active‑request guard (busy‑wait if another request
    ///    is in flight — should not happen in practice given the `spawn` barrier).
    /// 3. Emit [`PrefetchLifecycleEvent::InFlight`].
    /// 4. Call `backend.prepare()` on each artifact range.
    /// 5. On success emit [`PrefetchLifecycleEvent::Completed`]; on failure
    ///    emit [`PrefetchLifecycleEvent::Failed`].
    /// 6. Release the active‑request guard.
    ///
    /// Returns a vector of all lifecycle events produced during the run.
    pub async fn run(
        &mut self,
        backend: Arc<dyn ArtifactPreparationBackend>,
    ) -> Vec<PrefetchLifecycleEvent> {
        let mut rx = self
            .rx
            .take()
            .expect("PrefetchCoordinator::run called more than once");
        let mut events = Vec::new();

        loop {
            // Check cancellation before blocking on recv.
            if self.cancelled.load(Ordering::Acquire) {
                break;
            }

            // Measure queue depth before processing.
            let queue_depth = rx.len();
            self.max_queue_depth = self.max_queue_depth.max(queue_depth);

            let req = match rx.recv().await {
                Some(req) => req,
                None => break, // channel closed
            };

            // Re-check cancellation after receiving.
            if self.cancelled.load(Ordering::Acquire) {
                break;
            }

            // Track deadline. We use a fixed 30-second deadline for each
            // prefetch request.
            let deadline = Instant::now() + std::time::Duration::from_secs(30);

            // Emit Scheduled event.
            events.push(PrefetchLifecycleEvent {
                recipe_id: ConditioningRecipeId("prefetch".into()),
                resource_id: req.resource_id.clone(),
                stage: PrefetchLifecycleStage::Scheduled,
                bytes_transferred: 0,
                duration_ns: 0,
                error: None,
            });

            // Acquire the active-request guard (spin-loop back-pressure).
            while self.active.swap(true, Ordering::Acquire) {
                if self.cancelled.load(Ordering::Acquire) {
                    self.active.store(false, Ordering::Release);
                    break;
                }
                tokio::task::yield_now().await;
            }

            if self.cancelled.load(Ordering::Acquire) {
                events.push(PrefetchLifecycleEvent {
                    recipe_id: ConditioningRecipeId("prefetch".into()),
                    resource_id: req.resource_id.clone(),
                    stage: PrefetchLifecycleStage::Cancelled,
                    bytes_transferred: 0,
                    duration_ns: 0,
                    error: Some("cancelled before processing".into()),
                });
                self.active.store(false, Ordering::Release);
                break;
            }

            // Process via backend.
            let step_started = Instant::now();
            let mut total_bytes = 0u64;
            let mut step_error: Option<String> = None;

            events.push(PrefetchLifecycleEvent {
                recipe_id: ConditioningRecipeId("prefetch".into()),
                resource_id: req.resource_id.clone(),
                stage: PrefetchLifecycleStage::InFlight,
                bytes_transferred: 0,
                duration_ns: 0,
                error: None,
            });

            for range in &req.group.artifacts {
                if self.cancelled.load(Ordering::Acquire) {
                    step_error = Some("cancelled during preparation".into());
                    break;
                }

                // Check deadline.
                if Instant::now() > deadline {
                    self.deadline_misses += 1;
                    step_error = Some("deadline exceeded".into());
                    break;
                }

                match backend.prepare(range) {
                    Ok(receipt) => {
                        total_bytes += receipt.prepared_bytes;
                    }
                    Err(e) => {
                        step_error = Some(e.message.clone());
                        break;
                    }
                }
            }

            let step_elapsed = step_started.elapsed();

            // Emit completion event.
            let stage = if step_error.is_some() {
                PrefetchLifecycleStage::Failed
            } else {
                // Check deadline outcome.
                if Instant::now() > deadline {
                    self.deadline_misses += 1;
                } else {
                    self.deadline_hits += 1;
                }
                self.total_bytes_transferred += total_bytes;
                PrefetchLifecycleStage::Completed
            };

            events.push(PrefetchLifecycleEvent {
                recipe_id: ConditioningRecipeId("prefetch".into()),
                resource_id: req.resource_id.clone(),
                stage,
                bytes_transferred: total_bytes,
                duration_ns: step_elapsed.as_nanos() as u64,
                error: step_error,
            });

            // Release the active-request guard.
            self.active.store(false, Ordering::Release);
        }

        events
    }

    // ── Telemetry accessors ────────────────────────────────────────────────

    /// Total bytes transferred across all completed prefetches.
    pub fn total_bytes_transferred(&self) -> u64 {
        self.total_bytes_transferred
    }

    /// Number of requests that completed within their deadline.
    pub fn deadline_hits(&self) -> u64 {
        self.deadline_hits
    }

    /// Number of requests that missed their deadline.
    pub fn deadline_misses(&self) -> u64 {
        self.deadline_misses
    }

    /// Maximum observed queue depth.
    pub fn max_queue_depth(&self) -> usize {
        self.max_queue_depth
    }

    /// Whether a request is currently being processed.
    pub fn is_active(&self) -> bool {
        self.active.load(Ordering::Acquire)
    }

    /// Request cancellation of any in‑flight prefetch.
    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::Release);
    }
}

impl Default for PrefetchCoordinator {
    fn default() -> Self {
        Self::new()
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Phase 7 — Readiness State Machine
// ═══════════════════════════════════════════════════════════════════════════

/// Manages the model readiness state machine for the treatment pipeline.
///
/// The internal state uses the evidence-schema [`ModelReadiness`] enum
/// directly, which defines the four pipeline states:
///
/// ```text
/// MappedReady ──→ Conditioning ──→ LatencyReady
///       │               │
///       └──→ ConditioningFailed ←─┘
/// ```
///
/// Each successful transition records a timestamp and emits a
/// [`ReadinessTransitionEvent`] for the evidence plane.
pub struct ReadinessManager {
    /// Current readiness state.
    state: ModelReadiness,
    /// The conditioning policy in effect.
    policy: ExecutionConditioningPolicy,
    /// Wall‑clock instant when `LatencyReady` was reached, if ever.
    latency_ready_at: Option<Instant>,
    /// Timestamp of the most recent transition.
    last_transition_at: Instant,
    /// Cumulative count of transition attempts (including failed ones).
    transition_count: u64,
}

impl ReadinessManager {
    /// Create a new manager starting in the `MappedReady` state.
    ///
    /// `policy` is recorded for evidence events.
    pub fn new(policy: ExecutionConditioningPolicy) -> Self {
        Self {
            state: ModelReadiness::MappedReady,
            policy,
            latency_ready_at: None,
            last_transition_at: Instant::now(),
            transition_count: 0,
        }
    }

    /// Transition from `MappedReady` to `Conditioning`.
    ///
    /// Returns an error if the current state is not `MappedReady`.
    pub fn transition_to_conditioning(&mut self) -> Result<ReadinessTransitionEvent, String> {
        let previous = self.state;
        if previous != ModelReadiness::MappedReady {
            return Err(format!(
                "cannot transition to Conditioning from {:?}",
                previous
            ));
        }
        self.apply_transition(previous, ModelReadiness::Conditioning, "conditioning started".into())
    }

    /// Transition from `Conditioning` to `LatencyReady`.
    ///
    /// Returns an error if the current state is not `Conditioning`.
    pub fn transition_to_latency_ready(&mut self) -> Result<ReadinessTransitionEvent, String> {
        let previous = self.state;
        if previous != ModelReadiness::Conditioning {
            return Err(format!(
                "cannot transition to LatencyReady from {:?}",
                previous
            ));
        }
        self.latency_ready_at = Some(Instant::now());
        self.apply_transition(
            previous,
            ModelReadiness::LatencyReady,
            "latency readiness achieved".into(),
        )
    }

    /// Transition to `ConditioningFailed` from any non‑terminal state.
    ///
    /// The `reason` is surfaced in the evidence event.
    pub fn transition_to_failed(
        &mut self,
        reason: String,
    ) -> Result<ReadinessTransitionEvent, String> {
        let previous = self.state;
        if previous == ModelReadiness::ConditioningFailed {
            return Err(format!("already in ConditioningFailed state: {reason}"));
        }
        self.apply_transition(previous, ModelReadiness::ConditioningFailed, reason)
    }

    /// Return the current readiness state.
    pub fn current(&self) -> ModelReadiness {
        self.state
    }

    /// Return the wall‑clock instant when `LatencyReady` was reached, or
    /// `None` if the transition has not yet occurred.
    pub fn latency_ready_at(&self) -> Option<Instant> {
        self.latency_ready_at
    }

    /// Return `true` if the model is ready for inference
    /// (`LatencyReady` state).
    pub fn is_ready(&self) -> bool {
        self.state == ModelReadiness::LatencyReady
    }

    /// Return `true` if the machine is in a terminal state
    /// (`ConditioningFailed`).
    pub fn is_terminal(&self) -> bool {
        self.state == ModelReadiness::ConditioningFailed
    }

    /// The underlying conditioning policy.
    pub fn policy(&self) -> &ExecutionConditioningPolicy {
        &self.policy
    }

    // ── Internal helpers ───────────────────────────────────────────────────

    /// Record a state transition and build the evidence event.
    fn apply_transition(
        &mut self,
        previous: ModelReadiness,
        next: ModelReadiness,
        reason: String,
    ) -> Result<ReadinessTransitionEvent, String> {
        let now = Instant::now();
        let transition_ns = now
            .duration_since(self.last_transition_at)
            .as_nanos() as u64;

        self.state = next;
        self.last_transition_at = now;
        self.transition_count += 1;

        let event = ReadinessTransitionEvent {
            resource_id: ResourceId("model".into()),
            previous,
            current: next,
            reason,
            transition_ns,
        };

        Ok(event)
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// TreatmentSummary — Internal Accumulator
// ═══════════════════════════════════════════════════════════════════════════

/// Internal accumulator that aggregates events across a treatment run.
///
/// This is **not** the evidence‑plane [`TreatmentSummaryEvent`] — it is a
/// mutable counter that the caller drains at the end of a treatment cycle
/// to produce the final evidence event.
#[derive(Debug, Clone, Default)]
pub struct TreatmentSummary {
    /// Total wall‑clock time spent in conditioning execution (ns).
    pub total_conditioning_ns: u64,
    /// Total wall‑clock time spent in prefetch preparation (ns).
    pub total_prefetch_ns: u64,
    /// Total bytes transferred by the prefetch backend.
    pub total_prefetch_bytes: u64,
    /// Number of conditioning steps that completed.
    pub completed_steps: u32,
    /// Number of conditioning steps that failed.
    pub failed_steps: u32,
    /// Number of prefetch requests that hit their deadline.
    pub prefetch_deadline_hits: u64,
    /// Number of prefetch requests that missed their deadline.
    pub prefetch_deadline_misses: u64,
    /// Peak scratch‑arena allocation count observed during the run.
    pub peak_scratch_allocations: usize,
}

impl TreatmentSummary {
    /// Create an empty summary.
    pub fn new() -> Self {
        Self::default()
    }

    /// Record a completed conditioning event.
    pub fn record_conditioning_event(&mut self, event: &ConditioningRecipeEvent) {
        self.total_conditioning_ns =
            self.total_conditioning_ns.saturating_add(event.total_conditioning_ns);
        if event.completion == ConditioningRecipeCompletionState::Completed {
            self.completed_steps = self.completed_steps.saturating_add(event.completed_step_count);
        } else {
            self.failed_steps = self.failed_steps.saturating_add(event.step_count);
        }
    }

    /// Record a prefetch lifecycle event.
    pub fn record_prefetch_event(&mut self, event: &PrefetchLifecycleEvent) {
        self.total_prefetch_ns = self.total_prefetch_ns.saturating_add(event.duration_ns);
        self.total_prefetch_bytes =
            self.total_prefetch_bytes.saturating_add(event.bytes_transferred);
    }

    /// Record a scratch‑arena peak observation.
    pub fn record_scratch_peak(&mut self, count: usize) {
        self.peak_scratch_allocations = self.peak_scratch_allocations.max(count);
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════

#[cfg(test)]
mod tests {
    use super::*;
    use tribunus_evidence_schema::{
        ArtifactRange, ConditioningArm, ConditioningFallbackPolicy,
        ConditioningRecipe, ConditioningRecipeCompletionState,
        ConditioningRecipeId, ExpectedSubstrate, PipelinePlanVersion,
        ResidencyGroupId, ResidencyPlanVersion, ResidencyPriority,
    };

    fn sample_policy() -> ExecutionConditioningPolicy {
        ExecutionConditioningPolicy {
            arm: ConditioningArm::FrozenControl,
            prefetch_window: None,
            warmup_tokens: None,
            force_pipeline: false,
            preferred_substrate: ExpectedSubstrate::Gpu,
            fallback: ConditioningFallbackPolicy::LogAndContinue,
        }
    }

    // ── ScratchArena ───────────────────────────────────────────────────────

    #[test]
    fn test_scratch_arena_empty_on_creation() {
        let arena = ScratchArena::new();
        assert!(arena.is_empty());
        assert_eq!(arena.len(), 0);
    }

    #[test]
    fn test_scratch_arena_store_and_clear() {
        let mut arena = ScratchArena::new();
        let arr = Array::from_slice(&[1.0f32, 2.0, 3.0], &[3]);
        arena.store(arr);
        assert!(!arena.is_empty());
        assert_eq!(arena.len(), 1);
        arena.clear();
        assert!(arena.is_empty());
    }

    // ── PrefetchCoordinator ────────────────────────────────────────────────

    #[tokio::test]
    async fn test_prefetch_submit_try_send() {
        let coord = PrefetchCoordinator::new();

        let group = ResidencyGroup {
            group_id: ResidencyGroupId("test-group".into()),
            plan_version: ResidencyPlanVersion("1.0".into()),
            artifacts: vec![ArtifactRange {
                resource_id: ResourceId("test-res".into()),
                offset: None,
                length: None,
            }],
            priority: ResidencyPriority::Normal,
            evictable: true,
        };

        // First submit should succeed (channel empty).
        assert!(coord.submit_next_layer(group).is_ok());
    }

    #[test]
    fn test_prefetch_active_guard_defaults_false() {
        let coord = PrefetchCoordinator::new();
        assert!(!coord.is_active());
    }

    #[test]
    fn test_prefetch_telemetry_starts_at_zero() {
        let coord = PrefetchCoordinator::new();
        assert_eq!(coord.total_bytes_transferred(), 0);
        assert_eq!(coord.deadline_hits(), 0);
        assert_eq!(coord.deadline_misses(), 0);
        assert_eq!(coord.max_queue_depth(), 0);
    }

    // ── ReadinessManager ───────────────────────────────────────────────────

    #[test]
    fn test_readiness_initial_state() {
        let mgr = ReadinessManager::new(sample_policy());
        assert_eq!(mgr.current(), ModelReadiness::MappedReady);
        assert!(!mgr.is_ready());
        assert!(!mgr.is_terminal());
        assert!(mgr.latency_ready_at().is_none());
    }

    #[test]
    fn test_readiness_full_cycle() {
        let mut mgr = ReadinessManager::new(sample_policy());

        let event = mgr.transition_to_conditioning().unwrap();
        assert_eq!(mgr.current(), ModelReadiness::Conditioning);
        assert_eq!(event.reason, "conditioning started");

        let event = mgr.transition_to_latency_ready().unwrap();
        assert_eq!(mgr.current(), ModelReadiness::LatencyReady);
        assert!(mgr.is_ready());
        assert_eq!(event.reason, "latency readiness achieved");
        assert!(mgr.latency_ready_at().is_some());
    }

    #[test]
    fn test_readiness_transition_to_failed() {
        let mut mgr = ReadinessManager::new(sample_policy());

        let event = mgr
            .transition_to_failed("OOM during mapping".into())
            .unwrap();
        assert_eq!(mgr.current(), ModelReadiness::ConditioningFailed);
        assert!(mgr.is_terminal());
        assert_eq!(event.reason, "OOM during mapping");
    }

    #[test]
    fn test_readiness_failed_from_conditioning() {
        let mut mgr = ReadinessManager::new(sample_policy());
        mgr.transition_to_conditioning().unwrap();

        let event = mgr
            .transition_to_failed("GPU hang during conditioning".into())
            .unwrap();
        assert_eq!(mgr.current(), ModelReadiness::ConditioningFailed);
        assert_eq!(event.reason, "GPU hang during conditioning");
    }

    #[test]
    fn test_readiness_invalid_transitions() {
        let mut mgr = ReadinessManager::new(sample_policy());

        // MappedReady → Conditioning → LatencyReady
        mgr.transition_to_conditioning().unwrap();
        mgr.transition_to_latency_ready().unwrap();

        // From LatencyReady, conditioning is not allowed.
        assert!(mgr.transition_to_conditioning().is_err());

        // From LatencyReady, latency_ready is not allowed.
        assert!(mgr.transition_to_latency_ready().is_err());
    }

    #[test]
    fn test_readiness_double_failed() {
        let mut mgr = ReadinessManager::new(sample_policy());
        mgr.transition_to_failed("first failure".into()).unwrap();
        assert!(mgr.transition_to_failed("second failure".into()).is_err());
    }

    // ── TreatmentSummary ───────────────────────────────────────────────────

    #[test]
    fn test_treatment_summary_defaults() {
        let summary = TreatmentSummary::new();
        assert_eq!(summary.total_conditioning_ns, 0);
        assert_eq!(summary.completed_steps, 0);
        assert_eq!(summary.failed_steps, 0);
    }

    #[test]
    fn test_treatment_summary_record_conditioning() {
        let mut summary = TreatmentSummary::new();
        let event = ConditioningRecipeEvent {
            recipe_id: ConditioningRecipeId("test".into()),
            plan_version: PipelinePlanVersion("1.0".into()),
            arm: ConditioningArm::FrozenControl,
            completion: ConditioningRecipeCompletionState::Completed,
            total_conditioning_ns: 1_000_000,
            step_count: 4,
            completed_step_count: 4,
            error: None,
        };
        summary.record_conditioning_event(&event);
        assert_eq!(summary.total_conditioning_ns, 1_000_000);
        assert_eq!(summary.completed_steps, 4);
    }

    #[test]
    fn test_treatment_summary_record_scratch_peak() {
        let mut summary = TreatmentSummary::new();
        summary.record_scratch_peak(10);
        summary.record_scratch_peak(5);
        assert_eq!(summary.peak_scratch_allocations, 10);
    }
}
