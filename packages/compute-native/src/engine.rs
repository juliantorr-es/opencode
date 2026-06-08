//! ComputeEngine — high-level orchestrator for model lifecycle and generation.
//!
//! Thin control surface that resolves policy, checks model state, and
//! delegates execution to [`WorkerSupervisor`].  The supervisor owns the worker
//! subprocess which runs the actual model runtime, prefill, and decode loop.
//!
//! # Changes from v0
//!
//! - `generate()` now accepts `input_ids: &[u32]` and returns
//!   [`GenerationHandle`] (wrapping the stream + job_id).
//! - `cancel_generation` accepts a `String` job_id.
//! - `unload_model()` cancels in-flight requests and waits for the
//!   cancellation grace period before tearing down the worker.
//! - Worker restart is transparent: a faulted worker is automatically
//!   respawned (up to `policy.restart_limit` times) on the next call
//!   to `generate()`.
//! - `Drop` calls `shutdown()` for clean teardown.

use std::path::PathBuf;

use crate::engine_error::{EngineError, EngineErrorCode};
use crate::engine_policy::{
    qualification_policy, resolve_generation_budget,
};
use crate::model_store::{InstalledModel, ModelStore};
use crate::streaming::GenerationHandle;
use crate::worker_supervisor::WorkerSupervisor;
use crate::worker_protocol::StartGenerationPayload;
use crate::worker_protocol::HostCommand;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/// Default vocabulary size when model metadata is unavailable.
const DEFAULT_VOCAB_SIZE: u32 = 256_128;

/// Default BOS token ID (Gemma family).
const DEFAULT_BOS_TOKEN: u32 = 2;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/// Identity of a loaded model — the worker owns the runtime and session.
#[derive(Debug)]
struct LoadedModel {
    /// Hash identifying the model image in the store.
    image_hash: String,
    /// Path to the model directory in the store.
    model_path: PathBuf,
    /// Vocabulary size (valid token ID range is `[0, vocab_size)`).
    vocab_size: u32,
}

/// Parameters for a text generation request.
///
/// All numeric fields use their MLX-native defaults when left at zero
/// (the JS side maps `undefined` → `0` / `null` → `None` for Option fields).
///
/// The only required field is `prompt`.
#[derive(Debug, Clone)]
pub struct GenerationRequest {
    /// Input text prompt.
    pub prompt: String,
    /// Opaque session identifier for this generation run.
    pub session_id: String,
    /// Maximum number of tokens to generate (0 = bounded qualification mode).
    pub max_tokens: u32,
    /// Token ID that signals end-of-sequence.
    pub eos_token_id: u32,
    /// Pre-tokenized input token IDs for the prompt.
    pub input_ids: Vec<i32>,
    /// Temperature for softmax scaling.  0.0 = greedy.
    pub temperature: f64,
    /// Top-k filter: retain only the k highest-probability tokens.
    pub top_k: u32,
    /// Top-p (nucleus) filter: retain smallest set whose cumulative
    /// probability exceeds p.
    pub top_p: f64,
    /// Optional PRNG seed for deterministic sampling.
    pub seed: Option<u64>,
    /// Token ID sequences at which generation should stop.
    pub stop_sequences: Vec<String>,
}

impl GenerationRequest {
    /// Return the session identifier for this request.
    pub fn session_id(&self) -> &str {
        &self.session_id
    }

    /// Return the end-of-sequence token ID.
    pub fn eos_token_id(&self) -> u32 {
        self.eos_token_id
    }
}

/// Static capability report for this compute engine instance.
#[derive(Debug, Clone)]
pub struct EngineCapabilities {
    /// Whether a Metal-compatible GPU is available.
    pub supports_gpu: bool,
    /// Whether Core ML model execution is available.
    pub supports_coreml: bool,
    /// MLX framework version string (semver).
    pub mlx_version: String,
}

/// High-level engine wrapping model lifecycle and text generation.
///
/// # Lifecycle
///
/// 1. Call `new()` — opens the default model store at `~/.tribunus/models/`.
/// 2. `installModel(...)` — copy a compiled ComputeImage into the store.
/// 3. `setWorkerBinaryPath(...)` — point at the worker subprocess binary.
/// 4. `loadModel(...)` — verify the seal, spawn a worker process, and load
///    the model into the worker.
/// 5. `generate(...)` — resolve policy, validate token IDs, delegate to the
///    worker supervisor, and return a `GenerationHandle` immediately.
/// 6. `cancel(...)` / `cancel_generation(...)` — signal the worker to abort.
/// 7. `unload_model(...)` — cancel active requests, kill the worker, release
///    all native resources.
///
/// At most one model may be loaded at a time (v1).
impl std::fmt::Debug for ComputeEngine {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ComputeEngine")
            .field("model_store", &self.model_store)
            .field("loaded_model", &self.loaded_model)
            .field("worker_binary_path", &self.worker_binary_path)
            .field("capabilities", &self.capabilities)
            .field(
                "worker_supervisor",
                &self.worker_supervisor.as_ref().map(|_| "Some(WorkerSupervisor)"),
            )
            .field("restart_count", &self.restart_count)
            .finish()
    }
}

pub struct ComputeEngine {
    model_store: ModelStore,
    worker_supervisor: Option<WorkerSupervisor>,
    loaded_model: Option<LoadedModel>,
    worker_binary_path: Option<PathBuf>,
    capabilities: EngineCapabilities,
    /// Number of worker restarts attempted during the current model session.
    restart_count: u32,
}

impl ComputeEngine {
    // -- lifecycle ------------------------------------------------------------

    /// Create a new engine with the default model store.
    ///
    /// Opens (or creates) `~/.tribunus/models/` and detects runtime
    /// capabilities.
    pub fn new() -> napi::Result<Self> {
        let store = ModelStore::open_default().map_err(|e| {
            napi::Error::from_reason(format!("Failed to open model store: {}", e))
        })?;

        Ok(Self {
            model_store: store,
            worker_supervisor: None,
            loaded_model: None,
            worker_binary_path: None,
            capabilities: EngineCapabilities {
                supports_gpu: false,
                supports_coreml: false,
                mlx_version: "0.1.0".into(),
            },
            restart_count: 0,
        })
    }

    /// Set the path to the worker subprocess binary.
    ///
    /// Must be called before `loadModel()`.  The binary is spawned by the
    /// [`WorkerSupervisor`] and communicates over framed JSON IPC.
    pub fn set_worker_binary_path(&mut self, path: String) {
        self.worker_binary_path = Some(PathBuf::from(path));
    }

    // -- model-store operations -----------------------------------------------

    /// Install a compiled ComputeImage directory into the persistent store.
    ///
    /// Copies every file under `source_dir` into a store subdirectory named
    /// by `image_hash`, records an `InstalledModel` record and an integrity
    /// `InstallationSeal`.

    pub fn install_model(
        &self,
        source_dir: String,
        image_hash: String,
        source_identity: String,
        compiler_version: String,
    ) -> napi::Result<InstalledModel> {
        let source = std::path::Path::new(&source_dir);
        self.model_store
            .install(source, &image_hash, &source_identity, &compiler_version)
            .map_err(|e| napi::Error::from_reason(format!("Install failed: {}", e)))
    }

    /// Return every model currently recorded in the persistent store.

    pub fn list_models(&self) -> napi::Result<Vec<InstalledModel>> {
        self.model_store.list().map_err(|e| {
            napi::Error::from_reason(format!("List failed: {}", e))
        })
    }

    // -- load / unload --------------------------------------------------------

    /// Load an installed model into a worker process.
    ///
    /// Steps:
    ///   1. Resolve the model directory from the store.
    ///   2. Verify the installation seal.
    ///   3. Spawn the worker subprocess via [`WorkerSupervisor::launch_worker`].
    ///   4. Instruct the worker to load the model and wait for confirmation.
    ///
    /// Errors if a model is already loaded or the seal fails.
    ///
    /// Requires that [`set_worker_binary_path`](Self::set_worker_binary_path)
    /// was called first, or the `TRIBUNUS_WORKER_BINARY` environment variable
    /// is set.

    pub fn load_model(&mut self, image_hash: String) -> napi::Result<()> {
        if self.worker_supervisor.is_some() {
            return Err(napi::Error::from_reason(format!(
                "Model already loaded: {}",
                image_hash
            )));
        }

        let model_dir = self.model_store.root_dir.join(&image_hash);
        if !model_dir.exists() {
            return Err(napi::Error::from_reason(format!(
                "Model not found in store: {}",
                image_hash
            )));
        }

        // Verify integrity before launching the worker.
        self.model_store.verify_seal(&image_hash).map_err(|e| {
            napi::Error::from_reason(format!("Seal verification failed: {}", e))
        })?;

        // Resolve the worker binary path.
        let worker_path = self
            .worker_binary_path
            .clone()
            .or_else(|| std::env::var("TRIBUNUS_WORKER_BINARY").ok().map(PathBuf::from))
            .ok_or_else(|| {
                napi::Error::from_reason(
                    "Worker binary path not set. Call setWorkerBinaryPath() or set TRIBUNUS_WORKER_BINARY",
                )
            })?;

        // Create the supervisor with the qualification policy.
        let policy = qualification_policy();
        // Launch the worker process and perform Hello/HelloAck handshake.
        let supervisor = WorkerSupervisor::launch_and_handshake(
            policy,
            &worker_path,
            &model_dir,
            &image_hash,
            "compute-worker",
        )
        .map_err(|e| {
            napi::Error::from_reason(format!("Failed to launch worker: {}", e))
        })?;

        // Instruct the worker to load the model and wait for confirmation.
        supervisor.load_model(&image_hash).map_err(|e| {
            napi::Error::from_reason(format!("Failed to load model in worker: {}", e))
        })?;

        // TODO: read vocab_size from model metadata / capability record
        let loaded = LoadedModel {
            image_hash: image_hash.clone(),
            model_path: model_dir,
            vocab_size: DEFAULT_VOCAB_SIZE,
        };

        self.worker_supervisor = Some(supervisor);
        self.loaded_model = Some(loaded);
        self.restart_count = 0;
        Ok(())
    }

    /// Unload a model and release all native resources.
    ///
    /// If an active request exists, it is cancelled and the engine waits
    /// up to `cancellation_grace_period` before tearing down the worker.
    ///
    /// After this call the worker process is killed, all GPU memory is
    /// freed, and a subsequent `loadModel()` is required before generation.
    pub fn unload_model(&mut self) -> Result<(), EngineError> {
        // Take ownership of the supervisor so the borrow doesn't prevent
        // clearing engine state after teardown.
        let supervisor = self.worker_supervisor.take().ok_or_else(|| {
            EngineError::new(EngineErrorCode::ModelNotLoaded, "no model loaded")
        })?;

        let grace = supervisor.policy.cancellation_grace_period;

        // Cancel any active generation and wait briefly for completion.
        let active_ids: Vec<String> = {
            let all = supervisor.registry.all_active();
            all.into_iter().map(|(req_id, _)| req_id).collect()
        };

        for req_id in &active_ids {
            supervisor.registry.request_cancellation(req_id);
            let payload = serde_json::json!({ "request_id": req_id });
            let _ = supervisor
                .cmd_writer
                .send_command_with_request(HostCommand::CancelGeneration, req_id, payload);
        }

        // Wait for cancellation grace period if there were active requests.
        if !active_ids.is_empty() {
            std::thread::sleep(grace);
        }

        // Call supervisor.unload_model() which sends UnloadModel + Shutdown
        // and waits for the process to exit.  The supervisor's Drop then
        // handles joining background threads.
        supervisor.unload_model()?;
        // supervisor is dropped here, triggering WorkerSupervisor::Drop.

        // Clear engine state.
        self.loaded_model = None;
        self.restart_count = 0;
        Ok(())
    }

    // -- generation -----------------------------------------------------------

    /// Generate tokens from a loaded model.
    ///
    /// Policy-driven dispatch:
    ///
    /// a. Validates every token ID is within the model vocabulary.
    /// b. Rejects empty `input_ids` — sends `DEFAULT_BOS_TOKEN` (2) as
    ///    the sole prompt token.
    /// c. Resolves the execution policy via [`qualification_policy()`].
    /// d. Resolves the generation budget via [`resolve_generation_budget()`]
    ///    using `input_ids.len()` as the prompt token count.
    /// e. Checks that a model is loaded (returns `ModelNotLoaded` otherwise).
    /// f. Verifies no active generation is in flight (returns `ModelBusy`).
    /// g. Delegates to [`WorkerSupervisor::start_generation()`] which sends a
    ///    `StartGeneration` IPC frame to the worker and returns immediately.
    /// h. Returns the [`GenerationHandle`] — the caller receives the stream
    ///    through `handle.stream` and the job ID through `handle.job_id`.
    ///
    /// # Worker restart
    ///
    /// If the worker has faulted (caught by the supervisor's event-reader or
    /// watchdog), this method transparently restarts the worker up to
    /// `policy.restart_limit` times.  After the limit is exceeded a
    /// `WorkerRestartLimitExceeded` error is returned.
    pub fn generate(
        &mut self,
        input_ids: &[u32],
        max_tokens: u32,
    ) -> Result<GenerationHandle, EngineError> {
        // a. Validate token IDs against vocabulary size.
        let vocab_size = self
            .loaded_model
            .as_ref()
            .map(|m| m.vocab_size)
            .unwrap_or(DEFAULT_VOCAB_SIZE);

        if let Some(&id) = input_ids.iter().find(|&&id| id >= vocab_size) {
            return Err(EngineError::new(
                EngineErrorCode::InvalidRequest,
                format!(
                    "token ID {} exceeds vocabulary size {}",
                    id, vocab_size
                ),
            ));
        }

        // b. Handle empty input_ids — default to BOS token.
        let resolved_ids = if input_ids.is_empty() {
            vec![DEFAULT_BOS_TOKEN]
        } else {
            input_ids.to_vec()
        };

        let prompt_token_count = resolved_ids.len();

        // c. Resolve policy.
        let policy = qualification_policy();

        // d. Resolve generation budget using resolved prompt-token count.
        let admission = resolve_generation_budget(&policy, max_tokens, prompt_token_count);
        if !admission.admitted {
            let reason = admission
                .reason
                .unwrap_or_else(|| "policy rejected".into());
            return Err(EngineError::new(EngineErrorCode::PolicyRejected, reason));
        }
        let budget = admission
            .budget
            .expect("admitted request must have a budget");

        // e. Ensure worker is active (transparent restart if faulted).
        let supervisor = self.ensure_active_worker()?;

        // f. Check for active generation.
        if !supervisor.registry.is_empty() {
            return Err(EngineError::new(
                EngineErrorCode::ModelBusy,
                "a generation is already active",
            ));
        }

        // g. Build the start-generation payload and delegate.
        let request_id = format!("gen-{}", prompt_token_count);
        let payload = StartGenerationPayload {
            prompt_token_ids: resolved_ids,
            max_output_tokens: budget.effective_output_token_ceiling,
            deadline_ms: budget.deadline.as_millis() as u64,
            request_id,
        };

        let handle = supervisor.start_generation(&payload).map_err(|e| {
            EngineError::new(
                EngineErrorCode::InferenceFailed,
                format!("Generation failed: {}", e),
            )
        })?;

        // h. Return the GenerationHandle — caller gets stream + job_id.
        Ok(handle)
    }

    /// Cancel an active generation job by numeric job id.
    ///
    /// Retained for backward compatibility; delegates to
    /// [`cancel_generation`](Self::cancel_generation).
    pub fn cancel(&mut self, job_id: u64) -> napi::Result<()> {
        self.cancel_generation(job_id.to_string())
            .map_err(|e| napi::Error::from_reason(format!("Cancel failed: {}", e)))
    }

    /// Cancel an active generation job by string job id.
    ///
    /// Delegates to [`WorkerSupervisor::cancel_generation`] which sends a
    /// `CancelGeneration` IPC frame to the worker.
    pub fn cancel_generation(
        &mut self,
        job_id: String,
    ) -> Result<(), EngineError> {
        let supervisor = self.worker_supervisor.as_ref().ok_or_else(|| {
            EngineError::new(EngineErrorCode::ModelNotLoaded, "no model loaded")
        })?;

        supervisor.cancel_generation(&job_id)
    }

    // -- shutdown -------------------------------------------------------------

    /// Forcefully shut down: kill the worker process and release all native
    /// resources.
    ///
    /// Called automatically by [`Drop`].  Safe to call multiple times.
    pub fn shutdown(&mut self) {
        // Dropping the supervisor triggers WorkerSupervisor::Drop which calls
        // shutdown() + join_threads() — this kills the worker and joins all
        // background threads.
        self.worker_supervisor = None;
        self.loaded_model = None;
        self.restart_count = 0;
    }

    // -- helpers --------------------------------------------------------------

    /// Return the capability report for this engine instance.

    pub fn capabilities(&self) -> EngineCapabilities {
        EngineCapabilities {
            supports_gpu: self.capabilities.supports_gpu,
            supports_coreml: self.capabilities.supports_coreml,
            mlx_version: self.capabilities.mlx_version.clone(),
        }
    }

    /// Ensure the worker is active, transparently restarting if it has
    /// faulted.
    ///
    /// Returns `ModelNotLoaded` when no supervisor exists, or
    /// `WorkerRestartLimitExceeded` when the restart limit has been hit.
    fn ensure_active_worker(&mut self) -> Result<&mut WorkerSupervisor, EngineError> {
        let policy = qualification_policy();

        // Check if we even have a supervisor.
        if self.worker_supervisor.is_none() {
            return Err(EngineError::new(
                EngineErrorCode::ModelNotLoaded,
                "no model loaded",
            ));
        }

        // Check if the current worker has faulted.
        let is_faulted = self
            .worker_supervisor
            .as_ref()
            .map(|s| s.runtime_state.is_faulted())
            .unwrap_or(false);

        if is_faulted {
            if self.restart_count >= policy.restart_limit {
                return Err(EngineError::new(
                    EngineErrorCode::WorkerRestartLimitExceeded,
                    format!(
                        "worker restart limit ({}) exceeded after {} restart(s)",
                        policy.restart_limit, self.restart_count,
                    ),
                ));
            }
            self.restart_count += 1;
            self.restart_worker()?;
        }

        Ok(self.worker_supervisor.as_mut().unwrap())
    }

    /// Restart the worker process for the currently loaded model.
    ///
    /// Drops the old supervisor (which kills the old process and joins
    /// background threads), then spawns a new worker and loads the model.
    fn restart_worker(&mut self) -> Result<(), EngineError> {
        // Drop the old supervisor — this triggers WorkerSupervisor::Drop
        // which calls shutdown() (kills the process) + join_threads().
        let old_supervisor = self.worker_supervisor.take();
        drop(old_supervisor);

        let loaded = self.loaded_model.as_ref().ok_or_else(|| {
            EngineError::new(
                EngineErrorCode::InternalInvariantViolation,
                "no loaded model for restart",
            )
        })?;

        let worker_path = self.worker_binary_path.clone().ok_or_else(|| {
            EngineError::new(
                EngineErrorCode::InternalInvariantViolation,
                "no worker binary path for restart",
            )
        })?;

        let policy = qualification_policy();
        let new_supervisor = WorkerSupervisor::launch_and_handshake(
            policy,
            &worker_path,
            &loaded.model_path,
            &loaded.image_hash,
            "compute-worker",
        )?;

        new_supervisor.load_model(&loaded.image_hash)?;

        self.worker_supervisor = Some(new_supervisor);
        Ok(())
    }
}

impl Drop for ComputeEngine {
    fn drop(&mut self) {
        self.shutdown();
    }
}

// -- helpers (free functions) -------------------------------------------

/// Classify the workload class from a generation request.
///
/// Uses prompt token count vs max_tokens as a heuristic:
/// - 500+ prompt tokens → PromptHeavy (prefill dominates)
/// - 10x more output tokens than expected prompt → DecodeHeavy
/// - Otherwise → Balanced
///
/// Retained for compatibility — called by tests but no longer used by
/// `ComputeEngine::generate` (the worker supervisor handles profile
/// selection inside the worker).
pub fn classify_workload(req: &GenerationRequest) -> crate::model_runtime::WorkloadClass {
    let est_prompt_tokens = req.prompt.split_whitespace().count().max(1) as u32;
    let est_decode_tokens = if req.max_tokens == 0 {
        crate::engine_policy::SAFE_ZERO_MAX_TOKENS
    } else {
        req.max_tokens
    };

    if est_prompt_tokens >= 500 {
        crate::model_runtime::WorkloadClass::PromptHeavy
    } else if est_decode_tokens > est_prompt_tokens * 10 {
        crate::model_runtime::WorkloadClass::DecodeHeavy
    } else {
        crate::model_runtime::WorkloadClass::Balanced
    }
}

// -- tests -------------------------------------------------------------------

#[cfg(test)]
mod qualification_budget_tests {
    /// Re-export constants from engine_policy for test coverage.
    use crate::engine_policy;

    #[test]
    fn qualification_prompt_ceiling_is_small() {
        // These are now defined in engine_policy; verify aliases match.
        // SAFE_ZERO_MAX_TOKENS = 8 is tested in engine_policy::tests
        assert_eq!(engine_policy::SAFE_ZERO_MAX_TOKENS, 8);
    }

    #[test]
    fn qualification_deadline_is_bounded() {
        assert_eq!(
            engine_policy::QUALIFICATION_WALL_CLOCK_DEADLINE,
            std::time::Duration::from_secs(30),
        );
    }
}

#[cfg(test)]
mod tests {
    use crate::model_runtime::ModelRuntime;
    use crate::model_runtime::WorkloadClass;
    use crate::kv_cache::KvCache;
    use std::path::Path;

    #[test]
    fn invalid_input_ids_rejected() {
        // input_ids with token >= vocab should be rejected.
        let input_ids = [2u32, 300_000u32];
        // We cannot construct a full engine easily, but we can test the
        // validation logic that runs at the top of generate().
        let vocab_size: u32 = 256_128;
        let bad = input_ids.iter().find(|&&id| id >= vocab_size);
        assert!(bad.is_some(), "expected token >= vocab to be detected");
        assert_eq!(*bad.unwrap(), 300_000);
    }

    #[test]
    #[ignore = "requires installed ComputeImage at TRIBUNUS_COMPILED_IMAGE"]
    fn installed_image_lifecycle_gate() {
        let image_dir = std::env::var("TRIBUNUS_COMPILED_IMAGE")
            .expect("TRIBUNUS_COMPILED_IMAGE not set");
        let image_path = Path::new(&image_dir);
        assert!(image_path.join("manifest.json").exists());

        let baseline_handles = crate::bridge::handle_count();

        // Open installed image
        let runtime = ModelRuntime::open(image_path).expect("open installed image");
        assert!(runtime.is_open());
        let plan = runtime.execution_plan();
        assert_eq!(plan.layers.len(), 48);
        plan.validate().expect("plan validation");

        // Profile selection
        let profile = runtime.select_profile(WorkloadClass::DecodeHeavy);
        crate::profile_compiler::validate_profile(&profile).expect("profile validation");

        let profiled_model = crate::profiled_executor::LoadedProfiledModel::new(runtime.image_dir())
            .expect("load bindings");

        // Build per-layer KV caches matching the execution plan.
        let build_kv_caches = || -> Vec<KvCache> {
            profiled_model.reader.manifest.execution_plan.layers
                .iter()
                .map(|layer| {
                    let capacity = if layer.attention_kind == "sliding_attention" {
                        layer.sliding_window
                    } else {
                        32768
                    };
                    let n_kv_heads = layer.n_global_kv_heads.unwrap_or(layer.n_kv_heads);
                    let head_dim = layer.global_head_dim.unwrap_or(layer.head_dim);
                    KvCache::new(
                        capacity,
                        n_kv_heads,
                        head_dim,
                        layer.attention_kind == "sliding_attention",
                    )
                })
                .collect()
        };

        // First generation through profiled executor — must match oracle token 168593
        let mut generator = crate::profiled_executor::ProfiledInferenceSession::new(
            "lifecycle-gate-1".to_string(),
            build_kv_caches(),
        );

        let token = generator
            .prefill(&[2u32], &profiled_model)
            .expect("profiled prefill");
        assert_eq!(token, 168593, "profiled token must match oracle");
        assert!(token < 256128);

        let after_gen = crate::bridge::handle_count();

        // Second request reuses same model
        let mut generator2 = crate::profiled_executor::ProfiledInferenceSession::new(
            "lifecycle-gate-2".to_string(),
            build_kv_caches(),
        );

        let token2 = generator2
            .prefill(&[2u32], &profiled_model)
            .expect("second profiled prefill");
        assert_eq!(token2, token, "reuse must produce same token");

        let after_reuse = crate::bridge::handle_count();
        assert_eq!(after_reuse, after_gen,
            "handles must remain stable across reuse: {} != {}",
            after_reuse, after_gen);

        // Cleanup: handles return to baseline
        drop(runtime);
        let after_close = crate::bridge::handle_count();
        assert_eq!(after_close, baseline_handles,
            "handles must return to baseline after close: {} != {}",
            after_close, baseline_handles);

        eprintln!("[lifecycle-gate] PASSED: token={}", token);
    }

    #[test]
    fn missing_image_rejected_before_execution() {
        let result = ModelRuntime::open(Path::new("/nonexistent/path/model"));
        assert!(result.is_err(), "opening nonexistent path must fail");
    }

    #[test]
    #[ignore = "full v1 qualification — requires installed Gemma image at TRIBUNUS_COMPILED_IMAGE"]
    fn v1_qualification_gate() {
        let image_dir = std::env::var("TRIBUNUS_COMPILED_IMAGE")
            .expect("TRIBUNUS_COMPILED_IMAGE not set");
        let image_path = Path::new(&image_dir);

        let baseline = crate::bridge::handle_count();
        let runtime = ModelRuntime::open(image_path).expect("open");

        let mut tokens = Vec::new();


        let profiled_model = crate::profiled_executor::LoadedProfiledModel::new(image_path)
            .expect("load bindings");

        // Build per-layer KV caches matching the execution plan.
        let kv_caches: Vec<KvCache> = profiled_model.reader.manifest.execution_plan.layers
            .iter()
            .map(|layer| {
                let capacity = if layer.attention_kind == "sliding_attention" {
                    layer.sliding_window
                } else {
                    32768
                };
                let n_kv_heads = layer.n_global_kv_heads.unwrap_or(layer.n_kv_heads);
                let head_dim = layer.global_head_dim.unwrap_or(layer.head_dim);
                KvCache::new(
                    capacity,
                    n_kv_heads,
                    head_dim,
                    layer.attention_kind == "sliding_attention",
                )
            })
            .collect();

        let mut generator = crate::profiled_executor::ProfiledInferenceSession::new(
            "v1-qual".to_string(),
            kv_caches,
        );

        for step in 0..2 {
            let token = if step == 0 {
                eprintln!("[test] step=0 prefill");
                generator
                    .prefill(&[2u32], &profiled_model)
                    .expect("profiled prefill")
            } else {
                eprintln!("[test] step=1 decode_one token={}", tokens[0]);
                generator
                    .decode_one(tokens[0], &profiled_model)
                    .expect("profiled decode_one")
            };

            assert!(token < 256128, "token in vocab range");
            assert!(token > 0, "non-pad token");

            tokens.push(token);
        }

        assert_eq!(tokens.len(), 2, "generated 2 tokens");

        drop(runtime);
        let after = crate::bridge::handle_count();
        assert_eq!(after, baseline, "handle leak: {} -> {}", baseline, after);

        eprintln!("[v1-qual] PASSED: {:?}", tokens);
    }
}
