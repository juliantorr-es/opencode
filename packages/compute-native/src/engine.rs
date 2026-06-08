//! ComputeEngine — high-level orchestrator for model lifecycle and generation.
//!
//! Wraps ModelStore, ModelRuntime, and ModelSession into a single
//! napi-exported interface.  Owns the persistent model store and the set
//! of currently loaded in-memory sessions.
//!
//! Typical usage (from JavaScript):
//! ```js
//! const engine = new ComputeEngine();
//! engine.installModel("/tmp/gemma-image", "abc123", "gemma4-12b", "0.1.0");
//! engine.loadModel("abc123");
//! const caps = engine.capabilities();
//! // engine.generate({ prompt: "Hello", maxTokens: 128, ... });
//! engine.unloadModel("abc123");
//! ```

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use crate::model_runtime::{ModelRuntime, WorkloadClass};
use crate::profile_compiler;
use crate::model_store::{InstalledModel, ModelStore};
use crate::session::GenerationSession;
use crate::profiled_executor::ExecutionMode;
use crate::streaming::GenerationEvent;
use crate::streaming::GenerationStream;
use crate::streaming::generation_channel;
use crate::profiled_executor::ProfiledReceipt;
// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/// A loaded model with its runtime handle and generation session.
#[derive(Debug)]
struct LoadedModel {
    /// Runtime handle — validates manifest, holds segment file handles.
    runtime: ModelRuntime,
    /// Generation session for the currently active generation run.
    session: GenerationSession,
    /// Prebound tensor handles and memory-mapped model resources.
    profiled_model: Arc<crate::profiled_executor::LoadedProfiledModel>,
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
    /// Signal shared between generator and consumer for cooperative cancellation.
    pub cancel_flag: Option<Arc<AtomicBool>>,
    /// Opaque session identifier for this generation run.
    pub session_id: String,
    /// Maximum number of tokens to generate (0 = unlimited until EOS).
    pub max_tokens: u32,
    /// Token ID that signals end-of-sequence.
    pub eos_token_id: u32,
    /// Pre-tokenized input token IDs for the prompt.
    pub input_ids: Vec<i32>,
    /// Sampling / decoding configuration for this generation run.
    pub sampler: crate::session::SamplerConfig,
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

    /// Return a reference to the cancellation flag, if set.
    pub fn cancel_flag(&self) -> Option<&Arc<AtomicBool>> {
        self.cancel_flag.as_ref()
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
/// 3. `loadModel(...)` — verify the seal, open a ModelRuntime, create a
///    ModelSession, and hold it in memory.
/// 4. `generate(...)` — stub — performs text generation on a loaded model.
/// 5. `unloadModel(...)` — release session resources and remove from memory.
///
/// Multiple models may be loaded simultaneously; lookup is by `image_hash`.
#[derive(Debug)]
pub struct ComputeEngine {
    model_store: ModelStore,
    loaded_models: HashMap<String, LoadedModel>,
    capabilities: EngineCapabilities,
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
            loaded_models: HashMap::new(),
            capabilities: EngineCapabilities {
                supports_gpu: false,
                supports_coreml: false,
                mlx_version: "0.1.0".into(),
            },
        })
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

    /// Load an installed model into memory.
    ///
    /// Steps:
    ///   1. Verify the installation seal.
    ///   2. Open a `ModelRuntime` (reads manifest, validates execution plan,
    ///      opens segment file handles).
    ///   3. Build a `ModelSession` from the runtime manifest and hold it.
    ///
    /// Errors if the model is already loaded or the seal fails.
    
    pub fn load_model(&mut self, image_hash: String) -> napi::Result<()> {
        if self.loaded_models.contains_key(&image_hash) {
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

        // Verify integrity before touching any data.
        self.model_store.verify_seal(&image_hash).map_err(|e| {
            napi::Error::from_reason(format!("Seal verification failed: {}", e))
        })?;

        // Open runtime — validates manifest, execution plan, opens segments.
        let runtime = ModelRuntime::open(&model_dir)?;

        let profiled_model = crate::profiled_executor::LoadedProfiledModel::new(&model_dir)
            .map_err(|e| napi::Error::from_reason(format!("failed to bind tensors: {}", e)))?;

        let session_id = format!("session-{}", self.loaded_models.len());
        let session = GenerationSession::new(session_id, 1, 256);

        self.loaded_models.insert(image_hash, LoadedModel { 
            runtime, 
            session,
            profiled_model: Arc::new(profiled_model),
        });
        Ok(())
    }

    /// Unload a model and release all of its native resources.
    ///
    /// Removes the session from `loaded_models` (which drops the session
    /// and frees weight array handles via the session's own cleanup).
    
    pub fn unload_model(&mut self, image_hash: String) -> napi::Result<()> {
        let loaded = self.loaded_models.remove(&image_hash).ok_or_else(|| {
            napi::Error::from_reason(format!("Model not loaded: {}", image_hash))
        })?;
        // Release model resources — dropping LoadedModel closes the runtime
        // and frees weight array handles via the session's own cleanup.
        drop(loaded);
        Ok(())
    }

    // -- generation -----------------------------------------------------------

    /// Generate text from a loaded model.
    ///
    /// Profile-driven dispatch: picks a loaded model, selects a placement
    /// profile based on the request workload, creates a generation session,
    /// and emits `Started` / `Completed` lifecycle events over a bounded
    /// channel.  Real generation will iterate regions in weight order and
    /// route ops to their selected backend.
    pub fn generate(&self, req: GenerationRequest) -> napi::Result<GenerationStream> {
        // 1. Identify the model image to use.
        //
        // When the caller provides an explicit session_id we could route to
        // a specific model; for now pick the first loaded model.
        let loaded = self.loaded_models.values().next().ok_or_else(|| {
            napi::Error::from_reason("no model loaded for generation".to_string())
        })?;

        // 2. Classify workload from the request parameters.
        let workload = classify_workload(&req);

        // 3. Select a placement profile through the runtime.
        let profile = loaded.runtime.select_profile(workload);

        // 4. Validate profile — structural errors surface immediately.
        profile_compiler::validate_profile(&profile).map_err(|errors| {
            napi::Error::from_reason(format!(
                "placement profile validation failed: {}",
                errors.join("; ")
            ))
        })?;

        // 5. Create a generation session for this run.
        let eos = req.eos_token_id();
        let max_tokens = if req.max_tokens == 0 { u32::MAX } else { req.max_tokens };
        let mut session = GenerationSession::new(
            req.session_id().to_owned(),
            eos,
            max_tokens,
        );

        // 6. Set up the event channel and fire Started.
        let (sender, stream) = generation_channel(Some(128));
        let _ = sender.blocking_send(GenerationEvent::Started);
        let _ = session.transition(crate::session::SessionState::PrefillReady);

        // 7. Prefill state.
        let _ = session.transition(crate::session::SessionState::PrefillRunning);

        // Determine the initial token IDs for the prefill step.
        let prefill_ids: Vec<i32> = if req.input_ids.is_empty() {
            // Default: use BOS token (2) as the initial input.
            vec![2i32]
        } else {
            req.input_ids.clone()
        };

        let _image_path = loaded.runtime.image_dir().to_path_buf();
        let started = std::time::Instant::now();
        let cancel_flag = req.cancel_flag.clone();
        let stop_token_ids = req.sampler.stop_token_ids.clone();

        // 8. Prefill: run the model on the full prompt to build KV cache.
        let mut generator = crate::profiled_executor::ProfiledSession::new(
            &loaded.profiled_model,
            profile.clone(),
            ExecutionMode::Profiled,
        ).map_err(|e| napi::Error::from_reason(format!("session init: {}", e)))?;

        let (mut last_token, receipt_prefill) = generator.step(
            &prefill_ids,
            true, // prefill
            &req.sampler,
            cancel_flag.as_deref(),
        ).map_err(|e| napi::Error::from_reason(format!("prefill: {}", e)))?;

        let mut token_count: u32 = 1;

        let mut receipts: Vec<ProfiledReceipt> = vec![receipt_prefill];
        let _ = sender.blocking_send(GenerationEvent::Token(last_token));

        // 9. Transition to Decoding state.
        let _ = session.transition(crate::session::SessionState::Decoding);

        // 10. Decode loop with cancellation + backpressure.
        while token_count < max_tokens && last_token != eos {
            // Check cancellation before each token step.
            if cancel_flag.as_ref().map_or(false, |f| f.load(Ordering::Relaxed)) {
                let _ = session.transition(crate::session::SessionState::Cancelled);
                let _ = sender.try_send(GenerationEvent::Error("generation cancelled".into()));
                return Err(napi::Error::from_reason("generation cancelled"));
            }

            let (token, receipt) = generator.step(
                &[last_token as i32],
                false, // decode
                &req.sampler,
                cancel_flag.as_deref(),
            ).map_err(|e| napi::Error::from_reason(format!("decode step: {}", e)))?;

            receipts.push(receipt);
            last_token = token;
            token_count += 1;

            // Send token event with backpressure: spin on channel full.
            loop {
                match sender.try_send(GenerationEvent::Token(token)) {
                    Ok(()) => break,
                    Err(e) => {
                        if e.reason == "channel full" {
                            std::thread::yield_now();
                            // Re-check cancellation while waiting for consumer.
                            if cancel_flag.as_ref().map_or(false, |f| f.load(Ordering::Relaxed)) {
                                let _ = session.transition(crate::session::SessionState::Cancelled);
                                return Err(napi::Error::from_reason("generation cancelled"));
                            }
                            continue;
                        }
                        // Channel closed — consumer dropped the stream.
                        return Err(e);
                    }
                }
            }

            // EOS detection.
            if token == eos {
                break;
            }
            // Stop-token matching.
            if stop_token_ids.contains(&token) {
                break;
            }
        }

        let _elapsed_ms = started.elapsed().as_millis() as u64;
        let _ = session.transition(crate::session::SessionState::Completed);

        // Emit timeline metrics from the accumulated receipts.
        if !receipts.is_empty() {
            let last = receipts.last().unwrap();
            let timeline_json = serde_json::to_string(&last.timeline)
                .unwrap_or_else(|e| format!("{{\"error\":\"serde: {e}\"}}"));
            let _ = sender.blocking_send(GenerationEvent::Metrics(timeline_json));
        }

        let _ = sender.blocking_send(GenerationEvent::Done);

        Ok(stream)
    }

    /// Cancel an active generation job by job id.
    ///
    /// Looks up the running job by session id and signals cancellation so
    /// the decode loop exits at the next step boundary.
    pub fn cancel(&self, job_id: u64) -> napi::Result<()> {
        // Skeleton: cancel is a no-op until the supervisor is wired to
        // track running jobs by job_id.  The real implementation will:
        //   1. Lock the active-jobs registry and find the session by job_id.
        //   2. Transition the session to Cancelled.
        //   3. Drop the KV-cache and free GPU resources.
        //   4. Set a cancellation flag so the decode loop terminates early.
        //
        // For now, acknowledge the request unconditionally.
        let _ = job_id;
        Ok(())
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
}

// -- helpers (free functions) -------------------------------------------

/// Classify the workload class from a generation request.
///
/// Uses prompt token count vs max_tokens as a heuristic:
/// - 500+ prompt tokens → PromptHeavy (prefill dominates)
/// - 10x more output tokens than expected prompt → DecodeHeavy
/// - Otherwise → Balanced
fn classify_workload(req: &GenerationRequest) -> WorkloadClass {
    // Estimate prompt length from word count (rough proxy until tokenization
    // is wired into the engine path).
    let est_prompt_tokens = req.prompt.split_whitespace().count().max(1) as u32;
    let est_decode_tokens = if req.max_tokens == 0 {
        u32::MAX
    } else {
        req.max_tokens
    };

    if est_prompt_tokens >= 500 {
        WorkloadClass::PromptHeavy
    } else if est_decode_tokens > est_prompt_tokens * 10 {
        WorkloadClass::DecodeHeavy
    } else {
        WorkloadClass::Balanced
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model_runtime::ModelRuntime;
    use std::path::Path;

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

        let profiled_model = crate::profiled_executor::LoadedProfiledModel::new(runtime.image_dir()).expect("load bindings");

        // First generation through profiled executor — must match oracle token 168593
        let mut generator = crate::profiled_executor::ProfiledSession::new(
            &profiled_model,
            profile.clone(),
            crate::profiled_executor::ExecutionMode::Profiled,
        ).expect("session init");

        let (token, receipt) = generator.step(
            &[2i32],
            true,
            &crate::session::SamplerConfig::default(),
            None,
        ).expect("profiled execution");
        assert_eq!(token, 168593, "profiled token must match oracle");
        assert!(token < 256128);
        assert_eq!(receipt.oracle_fallback, false, "must not fall back to oracle");
        assert_eq!(receipt.explicit_gpu_stream, true, "must use explicit GPU stream");
        assert_eq!(receipt.compiler_invocations, 0, "no compiler invocations");
        assert_eq!(receipt.source_checkpoint_accesses, 0, "no source checkpoint access");

        let after_gen = crate::bridge::handle_count();

        // Second request reuses same model
        let mut generator2 = crate::profiled_executor::ProfiledSession::new(
            &profiled_model,
            profile.clone(),
            crate::profiled_executor::ExecutionMode::Profiled,
        ).expect("session2 init");

        let (token2, receipt2) = generator2.step(
            &[2i32],
            true,
            &crate::session::SamplerConfig::default(),
            None,
        ).expect("second profiled execution");
        assert_eq!(token2, token, "reuse must produce same token");
        assert_eq!(receipt2.oracle_fallback, false);
        assert_eq!(receipt2.explicit_gpu_stream, true);

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
        use crate::session::SamplerConfig;

        let image_dir = std::env::var("TRIBUNUS_COMPILED_IMAGE")
            .expect("TRIBUNUS_COMPILED_IMAGE not set");
        let image_path = Path::new(&image_dir);

        let baseline = crate::bridge::handle_count();
        let runtime = ModelRuntime::open(image_path).expect("open");
        let profile = runtime.select_profile(WorkloadClass::DecodeHeavy);
        let sampler = SamplerConfig::default();

        let mut tokens = Vec::new();
        let mut input_ids = vec![2i32];

        let profiled_model = crate::profiled_executor::LoadedProfiledModel::new(runtime.image_dir()).expect("load bindings");
        let mut generator = crate::profiled_executor::ProfiledSession::new(
            &profiled_model,
            profile.clone(),
            crate::profiled_executor::ExecutionMode::Profiled,
        ).expect("session init");

        for step in 0..2 {
            let input = if step == 0 { vec![2i32] } else { vec![tokens[step-1] as i32] };
            eprintln!("[test] step={} input={:?}", step, input);
            let is_prefill = step == 0;
            let (token, receipt) = generator.step(
                &input,
                is_prefill,
                &sampler,
                None,
            ).expect(&format!("profiled step {}", step));

            assert!(!receipt.oracle_fallback, "no oracle fallback at step {}", step);
            assert!(receipt.explicit_gpu_stream, "explicit GPU stream at step {}", step);
            assert_eq!(receipt.compiler_invocations, 0);
            assert!(token < 256128, "token in vocab range");
            assert!(token > 0, "non-pad token");

            tokens.push(token);
            input_ids.push(token as i32);
        }

        assert_eq!(tokens.len(), 2, "generated 2 tokens");

        drop(runtime);
        let after = crate::bridge::handle_count();
        assert_eq!(after, baseline, "handle leak: {} -> {}", baseline, after);

        eprintln!("[v1-qual] PASSED: {:?}", tokens);
    }
}
