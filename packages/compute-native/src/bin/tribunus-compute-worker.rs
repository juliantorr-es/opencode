//! Tribunus Compute Worker — multi-threaded inference process.
//!
//! Three threads:
//!   - **Command thread**: reads stdin, parses frames, validates with
//!     ProtocolValidator.  Forwards inference commands (LoadModel,
//!     StartGeneration, CancelGeneration, UnloadModel) via a channel.
//!     Handles Ping and Shutdown directly.
//!   - **Inference thread**: owns LoadedProfiledModel and
//!     ProfiledInferenceSession.  Runs prefill+decode.  Publishes
//!     phase/layer/token to shared atomics for the heartbeat thread.
//!   - **Heartbeat thread**: emits Heartbeat frames every 250 ms, reading
//!     shared atomics for telemetry.
//!
//! All output goes through a single [`WorkerEventWriter`] so frames from
//! different threads are serialised without interleaving.
//!
//! Stderr diagnostics are prefixed with `[worker <instance-id>]`.
//! CLI: `--worker-instance-id <uuid> --image-dir <path>`.

use std::io::Read;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU32, Ordering};
use std::sync::mpsc;
use std::sync::Arc;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use serde_json::Value;

use tribunus_compute_native::kv_cache::KvCache;
use tribunus_compute_native::profiled_executor::{LoadedProfiledModel, ProfiledInferenceSession};
use tribunus_compute_native::worker_memory::{
    configure_mlx_memory_limits, sample_mlx_memory, sample_process_rss_self,
};
use tribunus_compute_native::worker_protocol::{
    Frame, GenerationCompletedPayload, GenerationFailedPayload, HeartbeatPayload, HostCommand,
    MessageKind, PolicySnapshotPayload, ProtocolValidator, StartGenerationPayload, TokenPayload,
    WorkerEvent, WorkerFatalPayload, V1_0, MAX_FRAME_SIZE_BYTES,
};

// ── Defaults ───────────────────────────────────────────────────────────────

/// Default EOS token for Gemma (used when not provided via protocol).
const DEFAULT_EOS_TOKEN: u32 = 1;

/// Heartbeat emission interval.
const HEARTBEAT_INTERVAL: Duration = Duration::from_millis(250);

// ── Phase constants for shared InferenceState ──────────────────────────────

const PHASE_IDLE: u32 = 0;
const PHASE_PREFILL: u32 = 1;
const PHASE_DECODE: u32 = 2;
const NO_LAYER: u32 = u32::MAX;
const NO_STEP: i64 = -1;

// ── Channel messages ───────────────────────────────────────────────────────

/// Commands forwarded from the command thread to the inference thread.
enum InferenceCommand {
    /// Load the model after configuring MLX limits.
    LoadModel { active_limit: u64, cache_limit: u64 },
    /// Start generation with the given prompt.
    StartGeneration {
        request_id: String,
        prompt_token_ids: Vec<u32>,
        max_output_tokens: u32,
    },
    /// Cancel the current generation.
    CancelGeneration,
    /// Unload the model and clear the session.
    UnloadModel,
    /// Shut down the inference thread.
    Shutdown,
}

// ── Shared inference state (read by heartbeat thread) ──────────────────────

/// Telemetry atoms updated by the inference thread and sampled by the
/// heartbeat thread.
struct InferenceState {
    /// 0 = idle, 1 = prefill, 2 = decode.
    request_phase: AtomicU32,
    /// Current layer index, or `NO_LAYER` if between phases.
    current_layer: AtomicU32,
    /// Most recently completed decode step index, or `NO_STEP`.
    last_completed_step: AtomicI64,
    /// Request ID of the active generation, if any.
    active_request_id: Mutex<Option<String>>,
    /// Set by the command thread on CancelGeneration; inference thread
    /// checks this at every checkpoint.
    cancel: AtomicBool,
}

impl InferenceState {
    fn new() -> Self {
        Self {
            request_phase: AtomicU32::new(PHASE_IDLE),
            current_layer: AtomicU32::new(NO_LAYER),
            last_completed_step: AtomicI64::new(NO_STEP),
            active_request_id: Mutex::new(None),
            cancel: AtomicBool::new(false),
        }
    }

    fn set_phase(&self, phase: u32) {
        self.request_phase.store(phase, Ordering::Relaxed);
    }

    fn phase_str(&self) -> Option<String> {
        match self.request_phase.load(Ordering::Relaxed) {
            PHASE_PREFILL => Some("prefill".into()),
            PHASE_DECODE => Some("decode".into()),
            _ => None,
        }
    }

    fn set_current_layer(&self, layer: u32) {
        self.current_layer.store(layer, Ordering::Relaxed);
    }

    fn clear_current_layer(&self) {
        self.current_layer.store(NO_LAYER, Ordering::Relaxed);
    }

    fn current_layer_opt(&self) -> Option<u32> {
        let l = self.current_layer.load(Ordering::Relaxed);
        if l == NO_LAYER { None } else { Some(l) }
    }

    fn set_step(&self, step: i64) {
        self.last_completed_step.store(step, Ordering::Relaxed);
    }

    fn step_opt(&self) -> Option<u32> {
        let s = self.last_completed_step.load(Ordering::Relaxed);
        if s < 0 { None } else { Some(s as u32) }
    }

    fn set_active_request(&self, id: Option<String>) {
        *self.active_request_id.lock() = id;
    }

    fn active_request(&self) -> Option<String> {
        self.active_request_id.lock().clone()
    }

    fn reset(&self) {
        self.set_phase(PHASE_IDLE);
        self.clear_current_layer();
        self.set_step(NO_STEP);
        self.set_active_request(None);
        self.cancel.store(false, Ordering::Relaxed);
    }
}

// ── WorkerEventWriter ─────────────────────────────────────────────────────

/// Single writer through which **all** event frames are emitted.
///
/// Internally wraps `BufWriter<Stdout>` with a `Mutex` so that the command,
/// inference, and heartbeat threads can all send frames concurrently.
/// Sequence numbers are atomically allocated.
struct WorkerEventWriter {
    inner: Mutex<(std::io::BufWriter<std::io::Stdout>, u64)>,
    worker_id: String,
}

impl WorkerEventWriter {
    fn new(worker_id: String) -> Self {
        Self {
            inner: Mutex::new((std::io::BufWriter::new(std::io::stdout()), 0)),
            worker_id,
        }
    }

    /// Serialize and write a worker-event frame.
    fn write_event(&self, event: WorkerEvent, request_id: Option<&str>, payload: Value) {
        let mut guard = self.inner.lock();
        let seq = {
            let (_, ref mut counter) = &mut *guard;
            let s = *counter;
            *counter += 1;
            s
        };
        let frame = Frame::new_worker_event(
            self.worker_id.clone(),
            seq,
            request_id.unwrap_or("").to_string(),
            event,
            payload,
        );
        write_frame(&mut guard.0, &frame);
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Entry Point
// ═══════════════════════════════════════════════════════════════════════════

fn main() {
    // ── CLI argument parsing ──────────────────────────────────────────────
    let args: Vec<String> = std::env::args().collect();
    let mut worker_id: Option<String> = None;
    let mut image_dir: Option<PathBuf> = None;

    let mut i = 1;
    while i < args.len() {
        match args[i].as_str() {
            "--worker-instance-id" => {
                i += 1;
                worker_id = Some(args.get(i).cloned().unwrap_or_default());
            }
            "--image-dir" => {
                i += 1;
                image_dir = args.get(i).map(|s| PathBuf::from(s));
            }
            other => {
                eprintln!("[worker] unknown argument: {}", other);
                std::process::exit(1);
            }
        }
        i += 1;
    }

    let worker_id = match worker_id {
        Some(id) if !id.is_empty() => id,
        _ => {
            eprintln!("[worker] missing required argument: --worker-instance-id <uuid>");
            std::process::exit(1);
        }
    };
    let image_dir = match image_dir {
        Some(d) => d,
        None => {
            eprintln!("[worker {}] missing required argument: --image-dir <path>", worker_id);
            std::process::exit(1);
        }
    };

    let image_dir_str = image_dir.display().to_string();
    let worker_start = Instant::now();
    eprintln!("[worker {}] starting, image_dir={}", worker_id, image_dir_str);

    // ── Shared infrastructure ─────────────────────────────────────────────
    let writer = Arc::new(WorkerEventWriter::new(worker_id.clone()));
    let state = Arc::new(InferenceState::new());
    let (cmd_tx, cmd_rx) = mpsc::channel::<InferenceCommand>();
    let shutdown = Arc::new(AtomicBool::new(false));

    // ── Spawn inference thread ────────────────────────────────────────────
    let inf_writer = Arc::clone(&writer);
    let inf_state = Arc::clone(&state);
    let inf_worker_id = worker_id.clone();
    let inf_shutdown = Arc::clone(&shutdown);
    let inf_handle = std::thread::Builder::new()
        .name("inference".into())
        .spawn(move || {
            inference_thread(inf_worker_id, &image_dir, cmd_rx, inf_writer, inf_state, inf_shutdown);
        })
        .expect("spawn inference thread");

    // ── Spawn heartbeat thread ────────────────────────────────────────────
    let hb_writer = Arc::clone(&writer);
    let hb_state = Arc::clone(&state);
    let hb_worker_id = worker_id.clone();
    let hb_shutdown = Arc::clone(&shutdown);
    let hb_handle = std::thread::Builder::new()
        .name("heartbeat".into())
        .spawn(move || {
            heartbeat_thread(hb_worker_id, worker_start, hb_writer, hb_state, hb_shutdown);
        })
        .expect("spawn heartbeat thread");

    // ── Command thread (main) ─────────────────────────────────────────────
    command_thread(&worker_id, &image_dir_str, writer, state, cmd_tx, shutdown);

    // Wait for peers; cmd_tx has been consumed by command_thread, so when
    // command_thread exits it drops the sender, which signals the receiver.
    let _ = inf_handle.join();
    let _ = hb_handle.join();
    eprintln!("[worker {}] exiting", worker_id);
}

// ═══════════════════════════════════════════════════════════════════════════
// Command Thread
// ═══════════════════════════════════════════════════════════════════════════

fn command_thread(
    worker_id: &str,
    image_dir_str: &str,
    writer: Arc<WorkerEventWriter>,
    state: Arc<InferenceState>,
    cmd_tx: mpsc::Sender<InferenceCommand>,
    shutdown: Arc<AtomicBool>,
) {
    let mut stdin = std::io::stdin().lock();
    let mut validator = ProtocolValidator::new(worker_id.to_string());

    loop {
        let frame = match read_frame(&mut stdin) {
            Ok(f) => f,
            Err(e) => {
                eprintln!("[worker {}] frame read error: {}", worker_id, e);
                shutdown.store(true, Ordering::Relaxed);
                break;
            }
        };

        // Version check
        if frame.version != V1_0 {
            eprintln!(
                "[worker {}] unsupported protocol version: {:?}",
                worker_id, frame.version
            );
            continue;
        }

        // Must be a HostCommand
        let cmd = match &frame.message_kind {
            MessageKind::HostCommand(c) => c,
            _ => {
                eprintln!(
                    "[worker {}] unexpected message kind: {:?}",
                    worker_id, frame.message_kind
                );
                continue;
            }
        };

        // Validate every frame through the protocol validator.
        if let Err(e) = validator.validate_host_command(&frame) {
            eprintln!(
                "[worker {}] protocol validation error: {:?}",
                worker_id, e
            );
            writer.write_event(
                WorkerEvent::WorkerFatal,
                None,
                serde_json::to_value(WorkerFatalPayload {
                    error_code: "protocol-violation".into(),
                    message: format!("{:?}", e),
                    phase: "command-dispatch".into(),
                    diagnostics: None,
                }).unwrap_or_default(),
            );
            shutdown.store(true, Ordering::Relaxed);
            break;
        }

        match cmd {
            HostCommand::Hello => {
                eprintln!("[worker {}] received Hello", worker_id);
                writer.write_event(
                    WorkerEvent::HelloAck,
                    None,
                    serde_json::json!({"status": "ok", "version": V1_0}),
                );
            }

            HostCommand::LoadModel => {
                eprintln!(
                    "[worker {}] LoadModel received, image_dir={}",
                    worker_id, image_dir_str
                );

                // Policy snapshot is required; fail if missing or malformed.
                let snapshot = match serde_json::from_value::<PolicySnapshotPayload>(
                    frame.payload.clone(),
                ) {
                    Ok(s) => s,
                    Err(e) => {
                        eprintln!(
                            "[worker {}] missing or invalid policy snapshot: {}",
                            worker_id, e
                        );
                        writer.write_event(
                            WorkerEvent::WorkerFatal,
                            None,
                            serde_json::to_value(WorkerFatalPayload {
                                error_code: "policy-snapshot-invalid".into(),
                                message: format!("{}", e),
                                phase: "load".into(),
                                diagnostics: None,
                            })
                            .unwrap_or_default(),
                        );
                        shutdown.store(true, Ordering::Relaxed);
                        break;
                    }
                };

                let active_limit = snapshot.mlx_active_memory_limit_bytes;
                let cache_limit = snapshot.mlx_cache_limit_bytes;

                let _ = cmd_tx.send(InferenceCommand::LoadModel {
                    active_limit,
                    cache_limit,
                });
            }

            HostCommand::StartGeneration => {
                let gen_req: StartGenerationPayload =
                    match serde_json::from_value(frame.payload.clone()) {
                        Ok(p) => p,
                        Err(e) => {
                            eprintln!(
                                "[worker {}] malformed StartGeneration payload: {}",
                                worker_id, e
                            );
                            continue;
                        }
                    };

                eprintln!(
                    "[worker {}] StartGeneration request={}, tokens={}, max={}",
                    worker_id,
                    gen_req.request_id,
                    gen_req.prompt_token_ids.len(),
                    gen_req.max_output_tokens,
                );

                let _ = cmd_tx.send(InferenceCommand::StartGeneration {
                    request_id: gen_req.request_id,
                    prompt_token_ids: gen_req.prompt_token_ids,
                    max_output_tokens: gen_req.max_output_tokens,
                });
            }

            HostCommand::CancelGeneration => {
                // Set the shared cancellation flag (primary mechanism).
                state.cancel.store(true, Ordering::Relaxed);
                // Also poke the inference thread via channel so it checks.
                let _ = cmd_tx.send(InferenceCommand::CancelGeneration);
                eprintln!("[worker {}] cancellation flagged", worker_id);
            }

            HostCommand::UnloadModel => {
                eprintln!("[worker {}] unloading model", worker_id);
                writer.write_event(
                    WorkerEvent::ModelUnloaded,
                    None,
                    serde_json::json!({"status": "ok"}),
                );
                let _ = cmd_tx.send(InferenceCommand::UnloadModel);
            }

            HostCommand::Ping => {
                let uptime = 0; // heartbeat thread tracks this; Ping is just a liveness check
                let rss = sample_process_rss_self();
                let mlx = sample_mlx_memory();
                // MLX counters are safe to call from a non-MLX thread — they
                // access static counters in the C library (no thread-local state).
                let payload = HeartbeatPayload {
                    request_phase: state.phase_str(),
                    current_layer: state.current_layer_opt(),
                    process_rss_bytes: rss,
                    elapsed_ms: uptime,
                    last_completed_step: state.step_opt(),
                    active_request_id: state.active_request(),
                    mlx_active_memory: mlx.active_bytes,
                    mlx_cache_memory: mlx.cache_bytes,
                    mlx_peak_memory: mlx.peak_bytes,
                };
                writer.write_event(
                    WorkerEvent::Heartbeat,
                    None,
                    serde_json::to_value(payload).unwrap_or_default(),
                );
            }

            HostCommand::Shutdown => {
                eprintln!("[worker {}] shutdown requested", worker_id);
                let _ = cmd_tx.send(InferenceCommand::Shutdown);
                shutdown.store(true, Ordering::Relaxed);
                break;
            }

            HostCommand::MemoryPressure => {
                eprintln!("[worker {}] memory pressure signal received", worker_id);
                let freed = tribunus_compute_native::compute_image::clear_mlx_cache();
                eprintln!("[worker {}] cleared {} bytes from MLX cache", worker_id, freed);
            }
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Inference Thread
// ═══════════════════════════════════════════════════════════════════════════

fn inference_thread(
    worker_id: String,
    image_dir: &PathBuf,
    rx: mpsc::Receiver<InferenceCommand>,
    writer: Arc<WorkerEventWriter>,
    state: Arc<InferenceState>,
    shutdown: Arc<AtomicBool>,
) {
    let mut model: Option<LoadedProfiledModel> = None;
    let mut session: Option<ProfiledInferenceSession> = None;

    for cmd in rx {
        match cmd {
            InferenceCommand::Shutdown => {
                shutdown.store(true, Ordering::Relaxed);
                break;
            }

            InferenceCommand::UnloadModel => {
                session = None;
                model = None;
                state.reset();
                state.cancel.store(false, Ordering::Relaxed);
                // Response already sent by command thread.
            }

            InferenceCommand::CancelGeneration => {
                if let Some(ref s) = session {
                    s.cancellation_flag.store(true, Ordering::Relaxed);
                    eprintln!("[worker {}] cancellation set on session", worker_id);
                }
            }

            InferenceCommand::LoadModel {
                active_limit,
                cache_limit,
            } => {
                // Configure MLX limits BEFORE loading the model.
                configure_mlx_memory_limits(active_limit, cache_limit);
                eprintln!(
                    "[worker {}] configured MLX limits: active={}, cache={}",
                    worker_id, active_limit, cache_limit
                );

                match LoadedProfiledModel::new(image_dir) {
                    Ok(m) => {
                        eprintln!("[worker {}] model loaded successfully", worker_id);
                        writer.write_event(
                            WorkerEvent::ModelLoaded,
                            None,
                            serde_json::json!({"status": "ok"}),
                        );
                        model = Some(m);
                    }
                    Err(e) => {
                        eprintln!("[worker {}] model load failed: {}", worker_id, e);
                        let err_msg = format!("{}", e);
                        writer.write_event(
                            WorkerEvent::WorkerFatal,
                            None,
                            serde_json::to_value(WorkerFatalPayload {
                                error_code: "model-load-failed".into(),
                                message: err_msg,
                                phase: "load".into(),
                                diagnostics: None,
                            })
                            .unwrap_or_default(),
                        );
                        shutdown.store(true, Ordering::Relaxed);
                        // WorkerFatal is terminal — exit the inference loop.
                        break;
                    }
                }
            }

            InferenceCommand::StartGeneration {
                request_id,
                prompt_token_ids,
                max_output_tokens,
            } => {
                // Model must be loaded.
                if model.is_none() {
                    eprintln!(
                        "[worker {}] StartGeneration with no model loaded",
                        worker_id
                    );
                    continue;
                }

                // Model-busy: reject if a session is already active.
                if session.is_some() {
                    eprintln!(
                        "[worker {}] model-busy, rejecting request {}",
                        worker_id, request_id
                    );
                    let payload = GenerationFailedPayload {
                        request_id: request_id.clone(),
                        error_code: "model-busy".into(),
                        message: "A generation is already in progress".into(),
                        phase: "admission".into(),
                        diagnostics: None,
                    };
                    writer.write_event(
                        WorkerEvent::GenerationFailed,
                        Some(&request_id),
                        serde_json::to_value(payload).unwrap_or_default(),
                    );
                    continue;
                }

                // Check cancellation before starting.
                if state.cancel.load(Ordering::Relaxed) {
                    eprintln!(
                        "[worker {}] cancelled before start, request {}",
                        worker_id, request_id
                    );
                    writer.write_event(
                        WorkerEvent::GenerationCancelled,
                        Some(&request_id),
                        serde_json::json!({"request_id": request_id}),
                    );
                    continue;
                }

                let model_ref = model.as_ref().unwrap();
                let plan = &model_ref.reader.manifest.execution_plan;

                // Build KV caches matching the execution plan layer config.
                let kv_caches: Vec<KvCache> = plan
                    .layers
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

                let mut gen_session =
                    ProfiledInferenceSession::new(request_id.clone(), kv_caches);

                // Propagate any pre-existing cancel flag into the session so
                // internal layer-loop checks in prefill / decode_one fire.
                if state.cancel.load(Ordering::Relaxed) {
                    gen_session.cancellation_flag.store(true, Ordering::Relaxed);
                }

                // ── Update shared state ───────────────────────────────────
                state.set_active_request(Some(request_id.clone()));
                state.clear_current_layer();
                state.set_step(NO_STEP);

                // GenerationStarted
                writer.write_event(
                    WorkerEvent::GenerationStarted,
                    Some(&request_id),
                    serde_json::json!({"request_id": request_id}),
                );

                // ── Prefill ───────────────────────────────────────────────
                if cancelled(&state, &writer, &request_id) {
                    state.reset();
                    continue;
                }

                state.set_phase(PHASE_PREFILL);

                writer.write_event(
                    WorkerEvent::PrefillStarted,
                    Some(&request_id),
                    serde_json::json!({"request_id": request_id}),
                );

                let start = Instant::now();
                let first_token = match gen_session.prefill(&prompt_token_ids, model_ref) {
                    Ok(t) => t,
                    Err(e) => {
                        let payload = GenerationFailedPayload {
                            request_id: request_id.clone(),
                            error_code: e.code.code().to_string(),
                            message: e.message.clone(),
                            phase: "prefill".to_string(),
                            diagnostics: None,
                        };
                        writer.write_event(
                            WorkerEvent::GenerationFailed,
                            Some(&request_id),
                            serde_json::to_value(payload).unwrap_or_default(),
                        );
                        state.reset();
                        session = None;
                        continue;
                    }
                };
                let ttft_ms = start.elapsed().as_millis() as u64;

                if cancelled(&state, &writer, &request_id) {
                    state.reset();
                    continue;
                }

                // PrefillCompleted
                state.set_phase(PHASE_DECODE);
                writer.write_event(
                    WorkerEvent::PrefillCompleted,
                    Some(&request_id),
                    serde_json::json!({"request_id": request_id}),
                );

                // Emit first token
                writer.write_event(
                    WorkerEvent::Token,
                    Some(&request_id),
                    serde_json::to_value(TokenPayload {
                        request_id: request_id.clone(),
                        token_id: first_token,
                        position: 0,
                        logprob: None,
                    })
                    .unwrap_or_default(),
                );

                state.set_step(0);

                // ── Decode loop ───────────────────────────────────────────
                let total_start = start;
                let mut token_count = 1u32;
                let mut current_token = first_token;
                let mut generation_ok = true;

                for pos in 1..max_output_tokens {
                    // Check cancellation before each decode step.
                    if cancelled(&state, &writer, &request_id) {
                        generation_ok = false;
                        break;
                    }

                    state.clear_current_layer();

                    match gen_session.decode_one(current_token, model_ref) {
                        Ok(next_token) => {
                            current_token = next_token;
                            token_count += 1;

                            // Check cancellation before emitting the token.
                            if cancelled(&state, &writer, &request_id) {
                                generation_ok = false;
                                break;
                            }

                            writer.write_event(
                                WorkerEvent::Token,
                                Some(&request_id),
                                serde_json::to_value(TokenPayload {
                                    request_id: request_id.clone(),
                                    token_id: current_token,
                                    position: pos,
                                    logprob: None,
                                })
                                .unwrap_or_default(),
                            );

                            state.set_step(pos as i64);

                            if current_token == DEFAULT_EOS_TOKEN {
                                eprintln!(
                                    "[worker {}] EOS at position {}",
                                    worker_id, pos
                                );
                                break;
                            }
                        }
                        Err(e) => {
                            let payload = GenerationFailedPayload {
                                request_id: request_id.clone(),
                                error_code: e.code.code().to_string(),
                                message: e.message.clone(),
                                phase: "decode".to_string(),
                                diagnostics: None,
                            };
                            writer.write_event(
                                WorkerEvent::GenerationFailed,
                                Some(&request_id),
                                serde_json::to_value(payload).unwrap_or_default(),
                            );
                            generation_ok = false;
                            break;
                        }
                    }
                }

                if generation_ok {
                    let total_ms = total_start.elapsed().as_millis() as u64;
                    writer.write_event(
                        WorkerEvent::GenerationCompleted,
                        Some(&request_id),
                        serde_json::to_value(GenerationCompletedPayload {
                            request_id: request_id.clone(),
                            token_count,
                            ttft_ms,
                            total_ms,
                        })
                        .unwrap_or_default(),
                    );
                }

                // Clean up per-generation state — drop the session.
                state.reset();
                session = None;
            }
        }
    }

    eprintln!("[worker {}] inference thread exiting", worker_id);
}

/// Check the cancellation flag and emit GenerationCancelled if set.
/// Returns `true` if cancelled.
fn cancelled(state: &InferenceState, writer: &WorkerEventWriter, request_id: &str) -> bool {
    if state.cancel.load(Ordering::Relaxed) {
        writer.write_event(
            WorkerEvent::GenerationCancelled,
            Some(request_id),
            serde_json::json!({"request_id": request_id}),
        );
        true
    } else {
        false
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Heartbeat Thread
// ═══════════════════════════════════════════════════════════════════════════

fn heartbeat_thread(
    _worker_id: String,
    worker_start: Instant,
    writer: Arc<WorkerEventWriter>,
    state: Arc<InferenceState>,
    shutdown: Arc<AtomicBool>,
) {
    loop {
        if shutdown.load(Ordering::Relaxed) {
            break;
        }
        std::thread::sleep(HEARTBEAT_INTERVAL);

        let uptime = worker_start.elapsed().as_millis() as u64;
        let rss = sample_process_rss_self();
        let mlx = sample_mlx_memory();

        let payload = HeartbeatPayload {
            request_phase: state.phase_str(),
            current_layer: state.current_layer_opt(),
            process_rss_bytes: rss,
            elapsed_ms: uptime,
            last_completed_step: state.step_opt(),
            active_request_id: state.active_request(),
            mlx_active_memory: mlx.active_bytes,
            mlx_cache_memory: mlx.cache_bytes,
            mlx_peak_memory: mlx.peak_bytes,
        };

        writer.write_event(
            WorkerEvent::Heartbeat,
            None,
            serde_json::to_value(payload).unwrap_or_default(),
        );
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Framing helpers (unchanged from v1)
// ═══════════════════════════════════════════════════════════════════════════

/// Read a length-prefixed JSON frame from stdin.
fn read_frame(reader: &mut impl Read) -> Result<Frame, String> {
    let mut len_buf = [0u8; 4];
    reader
        .read_exact(&mut len_buf)
        .map_err(|e| format!("read frame length: {}", e))?;
    let frame_len = u32::from_le_bytes(len_buf) as usize;

    if frame_len > MAX_FRAME_SIZE_BYTES {
        return Err(format!(
            "frame length {} exceeds max {}",
            frame_len, MAX_FRAME_SIZE_BYTES
        ));
    }

    let mut buf = vec![0u8; frame_len];
    reader
        .read_exact(&mut buf)
        .map_err(|e| format!("read frame body ({} bytes): {}", frame_len, e))?;

    serde_json::from_slice(&buf).map_err(|e| format!("deserialize frame: {}", e))
}

/// Write a length-prefixed JSON frame to stdout.
fn write_frame(writer: &mut impl std::io::Write, frame: &Frame) {
    let json = match serde_json::to_vec(frame) {
        Ok(j) => j,
        Err(e) => {
            eprintln!("[worker] serialize error: {}", e);
            return;
        }
    };
    let len = json.len() as u32;
    let header = len.to_le_bytes();
    let _ = writer.write_all(&header);
    let _ = writer.write_all(&json);
    let _ = writer.flush();
}
