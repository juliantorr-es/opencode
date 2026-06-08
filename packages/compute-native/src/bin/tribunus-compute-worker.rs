//! Tribunus Compute Worker — isolated inference process.
//! Reads 4-byte LE length-prefixed JSON frames from stdin, writes
//! the same format to stdout, and emits diagnostics on stderr.
//!
//! v1: one loaded model, one active session, greedy decode.

use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::time::Instant;

use tribunus_compute_native::kv_cache::KvCache;
use tribunus_compute_native::profiled_executor::{LoadedProfiledModel, ProfiledInferenceSession};
use tribunus_compute_native::worker_protocol::{
    Frame, GenerationCompletedPayload, GenerationFailedPayload, HeartbeatPayload, HostCommand,
    MessageKind, StartGenerationPayload, TokenPayload, WorkerEvent, V1_0, MAX_FRAME_SIZE_BYTES,
};

/// Hardcoded EOS token for Gemma architecture (used when not configured via protocol).
const DEFAULT_EOS_TOKEN: u32 = 1;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 2 {
        eprintln!("[worker] usage: {} <compute_image_dir>", args[0]);
        std::process::exit(1);
    }
    let image_dir = PathBuf::from(&args[1]);
    let worker_id = uuid::Uuid::new_v4().to_string();
    eprintln!(
        "[worker {}] starting, image={}",
        worker_id,
        image_dir.display()
    );

    let mut stdin = std::io::stdin().lock();
    let mut stdout = std::io::stdout().lock();

    // Worker state
    let mut seq: u64 = 0;
    let mut model: Option<LoadedProfiledModel> = None;
    let mut session: Option<ProfiledInferenceSession> = None;

    // Protocol loop
    loop {
        let frame = match read_frame(&mut stdin) {
            Ok(f) => f,
            Err(e) => {
                eprintln!("[worker {}] frame read error: {}", worker_id, e);
                break;
            }
        };

        // Validate protocol version
        if frame.version != V1_0 {
            eprintln!(
                "[worker {}] unsupported protocol version: {:?}",
                worker_id, frame.version
            );
            continue;
        }

        match &frame.message_kind {
            MessageKind::HostCommand(HostCommand::Hello) => {
                eprintln!("[worker {}] received Hello", worker_id);
                let resp = Frame::new_worker_event(
                    worker_id.clone(),
                    seq,
                    String::new(),
                    WorkerEvent::HelloAck,
                    serde_json::json!({"status": "ok", "version": V1_0}),
                );
                seq += 1;
                write_frame(&mut stdout, &resp);
            }

            MessageKind::HostCommand(HostCommand::LoadModel) => {
                eprintln!(
                    "[worker {}] loading model from {}",
                    worker_id,
                    image_dir.display()
                );
                let (event, payload) = match LoadedProfiledModel::new(&image_dir) {
                    Ok(m) => {
                        eprintln!("[worker {}] model loaded successfully", worker_id);
                        model = Some(m);
                        (WorkerEvent::ModelLoaded, serde_json::json!({"status": "ok"}))
                    }
                    Err(e) => {
                        eprintln!("[worker {}] model load failed: {}", worker_id, e);
                        (
                            WorkerEvent::WorkerFatal,
                            serde_json::json!({"error": format!("{}", e)}),
                        )
                    }
                };
                let is_fatal = matches!(event, WorkerEvent::WorkerFatal);
                let resp = Frame::new_worker_event(
                    worker_id.clone(),
                    seq,
                    String::new(),
                    event,
                    payload,
                );
                seq += 1;
                write_frame(&mut stdout, &resp);
                if is_fatal {
                    break;
                }
            }

            MessageKind::HostCommand(HostCommand::StartGeneration) => {
                if model.is_none() {
                    eprintln!("[worker {}] StartGeneration with no model loaded", worker_id);
                    continue;
                }

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

                let request_id = gen_req.request_id.clone();
                eprintln!(
                    "[worker {}] StartGeneration request={}, tokens={}, max={}",
                    worker_id,
                    request_id,
                    gen_req.prompt_token_ids.len(),
                    gen_req.max_output_tokens
                );

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
                        let n_kv_heads =
                            layer.n_global_kv_heads.unwrap_or(layer.n_kv_heads);
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

                // GenerationStarted
                write_frame(
                    &mut stdout,
                    &Frame::new_worker_event(
                        worker_id.clone(),
                        seq,
                        request_id.clone(),
                        WorkerEvent::GenerationStarted,
                        serde_json::json!({"request_id": request_id}),
                    ),
                );
                seq += 1;

                // PrefillStarted
                write_frame(
                    &mut stdout,
                    &Frame::new_worker_event(
                        worker_id.clone(),
                        seq,
                        request_id.clone(),
                        WorkerEvent::PrefillStarted,
                        serde_json::json!({"request_id": request_id}),
                    ),
                );
                seq += 1;

                // Prefill
                let start = Instant::now();
                let first_token = match gen_session
                    .prefill(&gen_req.prompt_token_ids, model_ref)
                {
                    Ok(t) => t,
                    Err(e) => {
                        let payload = GenerationFailedPayload {
                            request_id: request_id.clone(),
                                error_code: e.code.code().to_string(),
                                message: e.message.clone(),
                            phase: "prefill".to_string(),
                        };
                        write_frame(
                            &mut stdout,
                            &Frame::new_worker_event(
                                worker_id.clone(),
                                seq,
                                request_id.clone(),
                                WorkerEvent::GenerationFailed,
                                serde_json::to_value(payload).unwrap_or_default(),
                            ),
                        );
                        seq += 1;
                        continue;
                    }
                };
                let ttft_ms = start.elapsed().as_millis() as u64;

                // PrefillCompleted
                write_frame(
                    &mut stdout,
                    &Frame::new_worker_event(
                        worker_id.clone(),
                        seq,
                        request_id.clone(),
                        WorkerEvent::PrefillCompleted,
                        serde_json::json!({"request_id": request_id}),
                    ),
                );
                seq += 1;

                // Emit first token
                let token_payload = TokenPayload {
                    request_id: request_id.clone(),
                    token_id: first_token,
                    position: 0,
                    logprob: None,
                };
                write_frame(
                    &mut stdout,
                    &Frame::new_worker_event(
                        worker_id.clone(),
                        seq,
                        request_id.clone(),
                        WorkerEvent::Token,
                        serde_json::to_value(token_payload).unwrap_or_default(),
                    ),
                );
                seq += 1;

                // Decode loop
                let total_start = start;
                let mut token_count = 1u32;
                let mut current_token = first_token;
                let mut generation_ok = true;

                for pos in 1..gen_req.max_output_tokens {
                    if gen_session.cancellation_flag.load(Ordering::Relaxed) {
                        eprintln!(
                            "[worker {}] generation cancelled at position {}",
                            worker_id, pos
                        );
                        write_frame(
                            &mut stdout,
                            &Frame::new_worker_event(
                                worker_id.clone(),
                                seq,
                                request_id.clone(),
                                WorkerEvent::GenerationCancelled,
                                serde_json::json!({"request_id": request_id}),
                            ),
                        );
                        seq += 1;
                        generation_ok = false;
                        break;
                    }

                    match gen_session.decode_one(current_token, model_ref) {
                        Ok(next_token) => {
                            current_token = next_token;
                            token_count += 1;

                            let token_payload = TokenPayload {
                                request_id: request_id.clone(),
                                token_id: current_token,
                                position: pos,
                                logprob: None,
                            };
                            write_frame(
                                &mut stdout,
                                &Frame::new_worker_event(
                                    worker_id.clone(),
                                    seq,
                                    request_id.clone(),
                                    WorkerEvent::Token,
                                    serde_json::to_value(token_payload).unwrap_or_default(),
                                ),
                            );
                            seq += 1;
                            // Flush each token so partial output is visible
                            let _ = stdout.flush();

                            if current_token == DEFAULT_EOS_TOKEN {
                                eprintln!(
                                    "[worker {}] EOS at position {}",
                                    worker_id, pos
                                );
                                break;
                            }
                        }
                        Err(e) => {
                            write_frame(
                                &mut stdout,
                                &Frame::new_worker_event(
                                    worker_id.clone(),
                                    seq,
                                    request_id.clone(),
                                    WorkerEvent::GenerationFailed,
                                    serde_json::to_value(GenerationFailedPayload {
                                        request_id: request_id.clone(),
                                        error_code: e.code.code().to_string(),
                                        message: e.message.clone(),
                                        phase: "decode".to_string(),
                                    })
                                    .unwrap_or_default(),
                                ),
                            );
                            seq += 1;
                            generation_ok = false;
                            break;
                        }
                    }
                }

                if generation_ok {
                    let total_ms = total_start.elapsed().as_millis() as u64;
                    write_frame(
                        &mut stdout,
                        &Frame::new_worker_event(
                            worker_id.clone(),
                            seq,
                            request_id.clone(),
                            WorkerEvent::GenerationCompleted,
                            serde_json::to_value(GenerationCompletedPayload {
                                request_id: request_id.clone(),
                                token_count,
                                ttft_ms,
                                total_ms,
                            })
                            .unwrap_or_default(),
                        ),
                    );
                    seq += 1;
                }

                session = Some(gen_session);
            }

            MessageKind::HostCommand(HostCommand::CancelGeneration) => {
                if let Some(s) = &session {
                    s.cancellation_flag.store(true, Ordering::Relaxed);
                    eprintln!("[worker {}] cancellation flagged", worker_id);
                }
            }

            MessageKind::HostCommand(HostCommand::UnloadModel) => {
                eprintln!("[worker {}] unloading model", worker_id);
                session = None;
                model = None;
                write_frame(
                    &mut stdout,
                    &Frame::new_worker_event(
                        worker_id.clone(),
                        seq,
                        String::new(),
                        WorkerEvent::ModelUnloaded,
                        serde_json::json!({"status": "ok"}),
                    ),
                );
                seq += 1;
            }

            MessageKind::HostCommand(HostCommand::Ping) => {
                let payload = HeartbeatPayload {
                    request_phase: None,
                    current_layer: None,
                    process_rss_bytes: 0,
                    elapsed_ms: 0,
                    last_completed_step: None,
                };
                write_frame(
                    &mut stdout,
                    &Frame::new_worker_event(
                        worker_id.clone(),
                        seq,
                        String::new(),
                        WorkerEvent::Heartbeat,
                        serde_json::to_value(payload).unwrap_or_default(),
                    ),
                );
                seq += 1;
            }

            MessageKind::HostCommand(HostCommand::Shutdown) => {
                eprintln!("[worker {}] shutdown requested", worker_id);
                break;
            }

            _ => {
                eprintln!(
                    "[worker {}] unexpected message kind: {:?}",
                    worker_id, frame.message_kind
                );
            }
        }
    }

    eprintln!("[worker {}] exiting", worker_id);
}

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
fn write_frame(writer: &mut impl Write, frame: &Frame) {
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
