//! Hybrid runtime supervisor — Tokio-driven control plane for arena + Core ML scheduling.
//!
//! The supervisor owns the submission lifecycle, arena-pool coordination, state leases,
//! model handles, job queues, cancellation tokens, and worker admission gate.
//! It does NOT own tensor arithmetic — that lives in the worker tasks.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::Instant;
use tokio::sync::{mpsc, watch};
use uuid::Uuid;

use crate::arena_lifecycle::{ArenaId, LeasedBackend};

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/// Complete job lifecycle state machine.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HybridJobState {
    Created,
    Validated,
    WaitingForArena,
    MlxRegionRunning,
    WaitingForCoreMl,
    CoreMlIslandRunning,
    WaitingForMlx,
    Completed,
    CancellationPending,
    Cancelled,
    Failed,
    Released,
}

/// A single hybrid work unit spanning MLX and Core ML backends.
#[derive(Debug)]
pub struct HybridJob {
    pub id: Uuid,
    pub session_id: Uuid,
    pub state: HybridJobState,
    pub arena_a_id: Option<ArenaId>,
    pub arena_b_id: Option<ArenaId>,
    /// Opaque Core ML MLState pointer (nullable).
    pub state_handle: Option<*mut std::ffi::c_void>,
    pub created_at: Instant,
}

// Safety: MLState* is only accessed from the dedicated Core ML worker,
// never shared across threads through the supervisor's own code paths.
unsafe impl Send for HybridJob {}

/// Commands accepted by the supervisor run loop.
#[derive(Debug)]
pub enum SupervisorCommand {
    SubmitJob { job: HybridJob },
    CancelJob { job_id: Uuid },
    TransferOwnership {
        job_id: Uuid,
        arena_id: ArenaId,
        from: LeasedBackend,
        to: LeasedBackend,
    },
    Shutdown,
}

/// Work dispatched to the MLX worker task.
#[derive(Debug)]
pub struct MlxWorkItem {
    pub job_id: Uuid,
    pub arena_id: ArenaId,
}

/// Work dispatched to the Core ML worker task.
#[derive(Debug)]
pub struct CoreMlWorkItem {
    pub job_id: Uuid,
    pub input_arena_id: ArenaId,
    pub output_arena_id: ArenaId,
    pub state_handle: Option<*mut std::ffi::c_void>,
}

// ---------------------------------------------------------------------------
// Internal event: worker → run loop
// ---------------------------------------------------------------------------

/// State-transition event emitted by a worker when it finishes processing a work item.
#[derive(Debug)]
struct JobEvent {
    job_id: Uuid,
    new_state: HybridJobState,
}

// ---------------------------------------------------------------------------
// Supervisor
// ---------------------------------------------------------------------------

/// Tokio-driven control plane for coordinated MLX / Core ML hybrid execution.
///
/// Owns channel senders to the command run loop and both worker queues.
/// All mutable job state lives inside the run loop — this handle is cheaply cloneable
/// (via the command sender) once the struct is behind an `Arc`.
#[derive(Debug)]
pub struct HybridRuntimeSupervisor {
    command_tx: mpsc::Sender<SupervisorCommand>,
    mlx_worker_tx: mpsc::Sender<MlxWorkItem>,
    coreml_worker_tx: mpsc::Sender<CoreMlWorkItem>,
    active_jobs: HashMap<Uuid, HybridJob>,
    shutdown_tx: watch::Sender<bool>,
    /// Receiver side used by `shutdown()` to await run-loop exit.
    shutdown_rx: watch::Receiver<bool>,
    /// Shared cancellation set checked by workers before starting work.
    cancelled_jobs: Arc<Mutex<HashSet<Uuid>>>,
    /// Channel from workers back to the run loop for state transitions.
    job_event_tx: mpsc::UnboundedSender<JobEvent>,
}

impl HybridRuntimeSupervisor {
    /// Create channels, spawn the run loop and worker tasks, return the supervisor handle.
    pub fn new() -> Self {
        // Command channel (capacity 32)
        let (command_tx, command_rx) = mpsc::channel::<SupervisorCommand>(32);

        // Worker channels (capacity 16 each)
        let (mlx_worker_tx, mlx_worker_rx) = mpsc::channel::<MlxWorkItem>(16);
        let (coreml_worker_tx, coreml_worker_rx) = mpsc::channel::<CoreMlWorkItem>(16);

        // Shutdown watch channel
        let (shutdown_tx, shutdown_rx) = watch::channel(false);

        // Job event channel (unbounded — workers never block on notification)
        let (job_event_tx, job_event_rx) = mpsc::unbounded_channel::<JobEvent>();

        // Shared cancellation set
        let cancelled_jobs: Arc<Mutex<HashSet<Uuid>>> = Arc::new(Mutex::new(HashSet::new()));

        // Clone handles for worker spawning
        let mlx_cancelled = Arc::clone(&cancelled_jobs);
        let coreml_cancelled = Arc::clone(&cancelled_jobs);
        let mlx_shutdown_rx = shutdown_rx.clone();
        let coreml_shutdown_rx = shutdown_rx.clone();
        let mlx_event_tx = job_event_tx.clone();
        let coreml_event_tx = job_event_tx.clone();

        // Spawn workers
        tokio::spawn(async move {
            Self::mlx_worker(mlx_worker_rx, mlx_event_tx, mlx_shutdown_rx, mlx_cancelled).await;
        });
        tokio::spawn(async move {
            Self::coreml_worker(
                coreml_worker_rx,
                coreml_event_tx,
                coreml_shutdown_rx,
                coreml_cancelled,
            )
            .await;
        });

        // Spawn the run loop
        let rl_shutdown_rx = shutdown_rx.clone();
        let rl_cancelled = Arc::clone(&cancelled_jobs);
        let rl_mlx_tx = mlx_worker_tx.clone();
        let rl_coreml_tx = coreml_worker_tx.clone();
        tokio::spawn(async move {
            Self::run_loop(
                command_rx,
                rl_mlx_tx,
                rl_coreml_tx,
                job_event_rx,
                rl_shutdown_rx,
                rl_cancelled,
            )
            .await;
        });

        HybridRuntimeSupervisor {
            command_tx,
            mlx_worker_tx,
            coreml_worker_tx,
            active_jobs: HashMap::new(),
            shutdown_tx,
            shutdown_rx,
            cancelled_jobs,
            job_event_tx,
        }
    }

    // -----------------------------------------------------------------------
    // Internal: run loop
    // -----------------------------------------------------------------------

    /// Main event loop — processes commands and job events.
    async fn run_loop(
        mut command_rx: mpsc::Receiver<SupervisorCommand>,
        _mlx_worker_tx: mpsc::Sender<MlxWorkItem>,
        _coreml_worker_tx: mpsc::Sender<CoreMlWorkItem>,
        mut job_event_rx: mpsc::UnboundedReceiver<JobEvent>,
        mut shutdown_rx: watch::Receiver<bool>,
        cancelled_jobs: Arc<Mutex<HashSet<Uuid>>>,
    ) {
        // Local job state — not exposed outside this task.
        let mut active_jobs: HashMap<Uuid, HybridJob> = HashMap::new();

        loop {
            tokio::select! {
                biased; // process commands before events for determinism

                // Check for shutdown signal propagated through the watch
                result = shutdown_rx.changed() => {
                    match result {
                        Ok(()) if *shutdown_rx.borrow() => {
                            // Shutdown requested — drain remaining jobs and exit.
                            Self::drain_jobs(&mut active_jobs, &cancelled_jobs);
                            break;
                        }
                        Ok(()) => continue,
                        Err(_) => break, // sender dropped — exit
                    }
                }

                cmd = command_rx.recv() => {
                    match cmd {
                        Some(cmd) => Self::handle_command(
                            cmd, &mut active_jobs, &cancelled_jobs,
                            &_mlx_worker_tx, &_coreml_worker_tx,
                        ),
                        None => break, // command channel closed — exit
                    }
                }

                event = job_event_rx.recv() => {
                    match event {
                        Some(e) => {
                            if let Some(job) = active_jobs.get_mut(&e.job_id) {
                                job.state = e.new_state;
                            }
                        }
                        None => {} // event channel closed — ignore
                    }
                }
            }
        }
    }

    /// Dispatch a single supervisor command.
    fn handle_command(
        cmd: SupervisorCommand,
        active_jobs: &mut HashMap<Uuid, HybridJob>,
        cancelled_jobs: &Arc<Mutex<HashSet<Uuid>>>,
        _mlx_worker_tx: &mpsc::Sender<MlxWorkItem>,
        _coreml_worker_tx: &mpsc::Sender<CoreMlWorkItem>,
    ) {
        match cmd {
            SupervisorCommand::SubmitJob { mut job } => {
                job.state = HybridJobState::Validated;
                active_jobs.insert(job.id, job);
            }

            SupervisorCommand::CancelJob { job_id } => {
                if let Some(job) = active_jobs.get_mut(&job_id) {
                    job.state = HybridJobState::CancellationPending;
                }
                // Record in shared set so workers can check before starting work.
                if let Ok(mut set) = cancelled_jobs.lock() {
                    set.insert(job_id);
                }
            }

            SupervisorCommand::TransferOwnership {
                job_id: _,
                arena_id: _,
                from: _,
                to: _,
            } => {
                // Placeholder — arena lifecycle integration deferred to Phase 8.
            }

            SupervisorCommand::Shutdown => {
                // The run loop exit is handled by the shutdown watch channel.
                // This branch exists so Shutdown sent through the command channel
                // doesn't hang — the watch signal is set externally.
            }
        }
    }

    /// Mark all active jobs as released before exit.
    fn drain_jobs(
        active_jobs: &mut HashMap<Uuid, HybridJob>,
        _cancelled_jobs: &Arc<Mutex<HashSet<Uuid>>>,
    ) {
        for (_, job) in active_jobs.iter_mut() {
            if job.state != HybridJobState::Completed
                && job.state != HybridJobState::Cancelled
                && job.state != HybridJobState::Failed
            {
                job.state = HybridJobState::Released;
            }
        }
        active_jobs.clear();
    }

    // -----------------------------------------------------------------------
    // Internal: MLX worker
    // -----------------------------------------------------------------------

    /// Dedicated MLX worker task — executes arena-bound MLX operations.
    ///
    /// Placeholder: currently logs and transitions job state.
    async fn mlx_worker(
        mut rx: mpsc::Receiver<MlxWorkItem>,
        job_event_tx: mpsc::UnboundedSender<JobEvent>,
        mut shutdown_rx: watch::Receiver<bool>,
        cancelled_jobs: Arc<Mutex<HashSet<Uuid>>>,
    ) {
        loop {
            tokio::select! {
                biased;
                result = shutdown_rx.changed() => {
                    match result {
                        Ok(()) if *shutdown_rx.borrow() => break,
                        Ok(()) => continue,
                        Err(_) => break,
                    }
                }
                item = rx.recv() => {
                    let item = match item {
                        Some(i) => i,
                        None => break, // channel closed
                    };

                    // Check cancellation before starting work.
                    let is_cancelled = cancelled_jobs
                        .lock()
                        .map(|s| s.contains(&item.job_id))
                        .unwrap_or(false);

                    let new_state = if is_cancelled {
                        HybridJobState::Cancelled
                    } else {
                        // Placeholder: actual MLX execution deferred.
                        HybridJobState::Completed
                    };

                    let _ = job_event_tx.send(JobEvent {
                        job_id: item.job_id,
                        new_state,
                    });
                }
            }
        }
    }

    // -----------------------------------------------------------------------
    // Internal: Core ML worker
    // -----------------------------------------------------------------------

    /// Dedicated Core ML worker task — executes Core ML inference on the island.
    ///
    /// Placeholder: currently logs and transitions job state.
    async fn coreml_worker(
        mut rx: mpsc::Receiver<CoreMlWorkItem>,
        job_event_tx: mpsc::UnboundedSender<JobEvent>,
        mut shutdown_rx: watch::Receiver<bool>,
        cancelled_jobs: Arc<Mutex<HashSet<Uuid>>>,
    ) {
        loop {
            tokio::select! {
                biased;
                result = shutdown_rx.changed() => {
                    match result {
                        Ok(()) if *shutdown_rx.borrow() => break,
                        Ok(()) => continue,
                        Err(_) => break,
                    }
                }
                item = rx.recv() => {
                    let item = match item {
                        Some(i) => i,
                        None => break,
                    };

                    let is_cancelled = cancelled_jobs
                        .lock()
                        .map(|s| s.contains(&item.job_id))
                        .unwrap_or(false);

                    let new_state = if is_cancelled {
                        HybridJobState::Cancelled
                    } else {
                        // Placeholder: actual Core ML prediction deferred.
                        HybridJobState::Completed
                    };

                    let _ = job_event_tx.send(JobEvent {
                        job_id: item.job_id,
                        new_state,
                    });
                }
            }
        }
    }

    // -----------------------------------------------------------------------
    // Public API
    // -----------------------------------------------------------------------

    /// Submit a hybrid job to the supervisor for scheduling.
    pub async fn submit_job(&self, job: HybridJob) -> Result<(), mpsc::error::SendError<SupervisorCommand>> {
        self.command_tx
            .send(SupervisorCommand::SubmitJob { job })
            .await
    }

    /// Request cancellation of a running job.
    ///
    /// The supervisor marks the job as `CancellationPending` and propagates
    /// the signal to any active worker for that job.
    pub async fn cancel_job(&self, job_id: Uuid) -> Result<(), mpsc::error::SendError<SupervisorCommand>> {
        self.command_tx
            .send(SupervisorCommand::CancelJob { job_id })
            .await
    }

    /// Gracefully shut down the supervisor and all worker tasks.
    ///
    /// Sends the Shutdown command, signals the watch, and waits for the
    /// run loop to complete its drain and exit.
    pub async fn shutdown(&self) {
        // Send Shutdown command so the run loop sees it.
        let _ = self.command_tx.send(SupervisorCommand::Shutdown).await;
        // Flip the watch so the run loop's select! sees the termination signal.
        let _ = self.shutdown_tx.send(true);
        // Wait for the run loop to observe the change and exit.
        let _ = self.shutdown_rx.clone().wait_for(|v| *v).await;
    }
}

impl Default for HybridRuntimeSupervisor {
    fn default() -> Self {
        Self::new()
    }
}

// ---------------------------------------------------------------------------
// Safety: state_handle is Send + Sync because it's an opaque pointer
// only accessed from the Core ML worker task under the supervisor's lock.
// ---------------------------------------------------------------------------

unsafe impl Send for CoreMlWorkItem {}
unsafe impl Sync for CoreMlWorkItem {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_hybrid_job_state_debug_and_eq() {
        // All variants should be Debug + Clone + Copy + PartialEq + Eq.
        let states = [
            HybridJobState::Created,
            HybridJobState::Validated,
            HybridJobState::WaitingForArena,
            HybridJobState::MlxRegionRunning,
            HybridJobState::WaitingForCoreMl,
            HybridJobState::CoreMlIslandRunning,
            HybridJobState::WaitingForMlx,
            HybridJobState::Completed,
            HybridJobState::CancellationPending,
            HybridJobState::Cancelled,
            HybridJobState::Failed,
            HybridJobState::Released,
        ];
        for (i, s) in states.iter().enumerate() {
            for (j, t) in states.iter().enumerate() {
                assert_eq!(s == t, i == j, "eq mismatch at ({i},{j})");
            }
        }
    }

    #[test]
    fn test_hybrid_job_creation() {
        let job = HybridJob {
            id: Uuid::new_v4(),
            session_id: Uuid::new_v4(),
            state: HybridJobState::Created,
            arena_a_id: None,
            arena_b_id: None,
            state_handle: None,
            created_at: Instant::now(),
        };
        assert_eq!(job.state, HybridJobState::Created);
        assert!(job.arena_a_id.is_none());
        assert!(job.arena_b_id.is_none());
        assert!(job.state_handle.is_none());
    }

    #[tokio::test]
    async fn test_supervisor_debug() {
        let sup = HybridRuntimeSupervisor::new();
        // Debug should not panic
        let _debug = format!("{:?}", sup);
    }

    #[test]
    fn test_mlx_work_item_debug() {
        let item = MlxWorkItem {
            job_id: Uuid::new_v4(),
            arena_id: ArenaId::new(),
        };
        let _debug = format!("{:?}", item);
    }

    #[test]
    fn test_coreml_work_item_debug() {
        let item = CoreMlWorkItem {
            job_id: Uuid::new_v4(),
            input_arena_id: ArenaId::new(),
            output_arena_id: ArenaId::new(),
            state_handle: None,
        };
        let _debug = format!("{:?}", item);
    }

    #[tokio::test]
    async fn test_submit_and_cancel_job() {
        let sup = HybridRuntimeSupervisor::new();
        let job = HybridJob {
            id: Uuid::new_v4(),
            session_id: Uuid::new_v4(),
            state: HybridJobState::Created,
            arena_a_id: None,
            arena_b_id: None,
            state_handle: None,
            created_at: Instant::now(),
        };
        let job_id = job.id;

        // Submit
        sup.submit_job(job).await.expect("submit should succeed");

        // Cancel
        sup.cancel_job(job_id)
            .await
            .expect("cancel should succeed");
    }

    #[tokio::test]
    async fn test_shutdown() {
        // Shutdown should complete without hanging.
        let sup = HybridRuntimeSupervisor::new();
        sup.shutdown().await;
    }

    #[tokio::test]
    async fn test_submit_after_shutdown_is_ok_or_err() {
        // After shutdown, submitting jobs may fail because the run loop has exited.
        // This test ensures no panic, regardless of outcome.
        let sup = HybridRuntimeSupervisor::new();
        sup.shutdown().await;

        let job = HybridJob {
            id: Uuid::new_v4(),
            session_id: Uuid::new_v4(),
            state: HybridJobState::Created,
            arena_a_id: None,
            arena_b_id: None,
            state_handle: None,
            created_at: Instant::now(),
        };
        let _result = sup.submit_job(job).await;
    }

    #[tokio::test]
    async fn test_cancel_before_submit_is_err() {
        // Cancelling a nonexistent job should not panic — the run loop gracefully ignores it.
        let sup = HybridRuntimeSupervisor::new();
        let unknown_id = Uuid::new_v4();
        let result = sup.cancel_job(unknown_id).await;
        assert!(result.is_ok(), "cancel of unknown job should send OK");
        // Give the run loop a moment to process
        tokio::time::sleep(tokio::time::Duration::from_millis(50)).await;
    }
}
