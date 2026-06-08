//! Tribunus Fake Worker — deterministic subprocess for integration tests.
//!
//! Supports 12 fault modes selected via `--mode`:
//!
//!   normal, identity-mismatch, no-handshake, model-load-hang,
//!   slow-prefill, ignored-cancel, heartbeat-loss, malformed-frames,
//!   sequence-gap, duplicate-terminal, crash, memory-alloc
//!
//! Uses the same framed JSON protocol as the real worker.
//! All framed output goes to stdout; diagnostics to stderr.
//!
//! CLI: `--worker-instance-id <uuid> --image-dir <path> --mode <mode>`

use std::io::{BufReader, Read, Write};
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

use serde_json::json;
use uuid::Uuid;

use tribunus_compute_native::worker_protocol::{
    Frame, GenerationCompletedPayload, HostCommand, MessageKind, TokenPayload, WorkerEvent, V1_0,
    MAX_FRAME_SIZE_BYTES,
};

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════

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

fn write_frame(writer: &mut impl Write, frame: &Frame) {
    let json = match serde_json::to_vec(frame) {
        Ok(j) => j,
        Err(e) => {
            eprintln!("[fake-worker] serialize error: {}", e);
            return;
        }
    };
    let len = json.len() as u32;
    let header = len.to_le_bytes();
    let _ = writer.write_all(&header);
    let _ = writer.write_all(&json);
    let _ = writer.flush();
}

/// Extract the `request_id` from a frame's payload if present.
fn frame_request_id(frame: &Frame) -> Option<String> {
    frame.payload.get("request_id").and_then(|v| v.as_str().map(String::from))
}

/// Check whether a frame is a host command of the given variant.
fn is_host_command(frame: &Frame, cmd: HostCommand) -> bool {
    matches!(&frame.message_kind, MessageKind::HostCommand(c) if *c == cmd)
}

// ═══════════════════════════════════════════════════════════════════════════
// Shared protocol steps (used by several modes)
// ═══════════════════════════════════════════════════════════════════════════

fn do_handshake<R: Read, W: Write>(
    reader: &mut R,
    writer: &mut W,
    worker_id: &str,
    seq: &mut u64,
) {
    let frame = read_frame(reader).expect("read Hello");
    assert!(is_host_command(&frame, HostCommand::Hello), "expected Hello");
    write_frame(
        writer,
        &Frame::new_worker_event(
            worker_id.to_string(),
            *seq,
            String::new(),
            WorkerEvent::HelloAck,
            json!({"version":{"major":1,"minor":0},"worker_id":worker_id}),
        ),
    );
    *seq += 1;
}

fn do_load_model<R: Read, W: Write>(
    reader: &mut R,
    writer: &mut W,
    worker_id: &str,
    seq: &mut u64,
) {
    let frame = read_frame(reader).expect("read LoadModel");
    assert!(is_host_command(&frame, HostCommand::LoadModel), "expected LoadModel");
    write_frame(
        writer,
        &Frame::new_worker_event(
            worker_id.to_string(),
            *seq,
            String::new(),
            WorkerEvent::ModelLoaded,
            json!({}),
        ),
    );
    *seq += 1;
}

fn do_start_generation<R: Read, W: Write>(
    reader: &mut R,
    writer: &mut W,
    worker_id: &str,
    seq: &mut u64,
) -> String {
    let frame = read_frame(reader).expect("read StartGeneration");
    assert!(
        is_host_command(&frame, HostCommand::StartGeneration),
        "expected StartGeneration"
    );
    let req_id = frame_request_id(&frame).unwrap_or_else(|| "req-000".into());
    write_frame(
        writer,
        &Frame::new_worker_event(
            worker_id.to_string(),
            *seq,
            req_id.clone(),
            WorkerEvent::GenerationStarted,
            json!({"request_id": &req_id}),
        ),
    );
    *seq += 1;
    req_id
}

fn do_emit_tokens<W: Write>(
    writer: &mut W,
    worker_id: &str,
    seq: &mut u64,
    req_id: &str,
    count: u32,
    start_id: u32,
) {
    for i in 0..count {
        let token = TokenPayload {
            request_id: req_id.to_string(),
            token_id: start_id + i,
            position: i,
            logprob: Some(-0.5),
        };
        write_frame(
            writer,
            &Frame::new_worker_event(
                worker_id.to_string(),
                *seq,
                req_id.to_string(),
                WorkerEvent::Token,
                serde_json::to_value(&token).unwrap_or_default(),
            ),
        );
        *seq += 1;
    }
}

fn do_generation_completed<W: Write>(
    writer: &mut W,
    worker_id: &str,
    seq: &mut u64,
    req_id: &str,
    token_count: u32,
    ttft_ms: u64,
    total_ms: u64,
) {
    let completed = GenerationCompletedPayload {
        request_id: req_id.to_string(),
        token_count,
        ttft_ms,
        total_ms,
    };
    write_frame(
        writer,
        &Frame::new_worker_event(
            worker_id.to_string(),
            *seq,
            req_id.to_string(),
            WorkerEvent::GenerationCompleted,
            serde_json::to_value(&completed).unwrap_or_default(),
        ),
    );
    *seq += 1;
}

fn do_unload_model<R: Read, W: Write>(
    reader: &mut R,
    writer: &mut W,
    worker_id: &str,
    seq: &mut u64,
) {
    let frame = read_frame(reader).expect("read UnloadModel");
    assert!(
        is_host_command(&frame, HostCommand::UnloadModel),
        "expected UnloadModel"
    );
    write_frame(
        writer,
        &Frame::new_worker_event(
            worker_id.to_string(),
            *seq,
            String::new(),
            WorkerEvent::ModelUnloaded,
            json!({}),
        ),
    );
    *seq += 1;
}

fn do_shutdown<R: Read, W: Write>(
    reader: &mut R,
    writer: &mut W,
    worker_id: &str,
    seq: &mut u64,
    _mode: &str,
) -> ! {
    let frame = read_frame(reader).expect("read Shutdown");
    assert!(
        is_host_command(&frame, HostCommand::Shutdown),
        "expected Shutdown"
    );
    eprintln!("[fake-worker] {} complete, exiting", _mode);
    std::process::exit(0);
}

// ═══════════════════════════════════════════════════════════════════════════
// Mode implementations
// ═══════════════════════════════════════════════════════════════════════════

/// **normal**: Complete handshake → accept LoadModel → generate 3 tokens
/// ([42, 43, 44]) → accept UnloadModel → Shutdown.
fn run_normal<R: Read, W: Write>(reader: &mut R, writer: &mut W, worker_id: &str) {
    let mut seq: u64 = 0;
    do_handshake(reader, writer, worker_id, &mut seq);
    do_load_model(reader, writer, worker_id, &mut seq);
    let req_id = do_start_generation(reader, writer, worker_id, &mut seq);
    do_emit_tokens(writer, worker_id, &mut seq, &req_id, 3, 42);
    do_generation_completed(writer, worker_id, &mut seq, &req_id, 3, 50, 150);
    do_unload_model(reader, writer, worker_id, &mut seq);
    do_shutdown(reader, writer, worker_id, &mut seq, "normal");
}

/// **identity-mismatch**: Respond to Hello with a *different* worker_id.
fn run_identity_mismatch<R: Read, W: Write>(reader: &mut R, writer: &mut W, _worker_id: &str) {
    let frame = read_frame(reader).expect("read Hello");
    assert!(is_host_command(&frame, HostCommand::Hello), "expected Hello");

    let wrong_id = Uuid::new_v4().to_string();
    let wrong_id_clone = wrong_id.clone();
    write_frame(
        writer,
        &Frame::new_worker_event(
            wrong_id_clone,
            0,
            String::new(),
            WorkerEvent::HelloAck,
            json!({"version":{"major":1,"minor":0},"worker_id":wrong_id}),
        ),
    );
    eprintln!("[fake-worker] identity-mismatch: sent HelloAck with wrong id, hanging");
    loop {
        thread::sleep(Duration::from_secs(60));
    }
}

/// **no-handshake**: Never respond to Hello.
fn run_no_handshake<R: Read, W: Write>(_reader: &mut R, _writer: &mut W, _worker_id: &str) {
    eprintln!("[fake-worker] no-handshake: ignoring Hello, waiting");
    loop {
        thread::sleep(Duration::from_secs(60));
    }
}

/// **model-load-hang**: Handshake normally, then never respond to LoadModel.
fn run_model_load_hang<R: Read, W: Write>(reader: &mut R, writer: &mut W, worker_id: &str) {
    let mut seq: u64 = 0;
    do_handshake(reader, writer, worker_id, &mut seq);
    let _ = read_frame(reader).expect("read LoadModel");
    eprintln!("[fake-worker] model-load-hang: received LoadModel, not responding");
    loop {
        thread::sleep(Duration::from_secs(60));
    }
}

/// **slow-prefill**: Accept StartGeneration, sleep 10s, then emit tokens.
/// Tests streaming returns before prefill completes and cancellation during
/// prefill.
fn run_slow_prefill<R: Read, W: Write>(reader: &mut R, writer: &mut W, worker_id: &str) {
    let mut seq: u64 = 0;
    do_handshake(reader, writer, worker_id, &mut seq);
    do_load_model(reader, writer, worker_id, &mut seq);
    let req_id = do_start_generation(reader, writer, worker_id, &mut seq);
    eprintln!("[fake-worker] slow-prefill: sleeping 10s before prefill completion");
    thread::sleep(Duration::from_secs(10));
    do_emit_tokens(writer, worker_id, &mut seq, &req_id, 3, 42);
    do_generation_completed(writer, worker_id, &mut seq, &req_id, 3, 10050, 10100);
    do_unload_model(reader, writer, worker_id, &mut seq);
    do_shutdown(reader, writer, worker_id, &mut seq, "slow-prefill");
}

/// **ignored-cancel**: Emit tokens 1/sec. When CancelGeneration arrives,
/// continue for 3 more tokens, then GenerationCompleted.
///
/// Owns its own stdin/stdout (not passed from main) so it can spawn a
/// reader thread without competing for the stdin lock.
fn run_ignored_cancel(worker_id: &str) {
    let mut seq: u64 = 0;
    let stdin = std::io::stdin();
    let stdout = std::io::stdout();
    let mut writer = stdout.lock();

    // Phase 1: blocking handshake reads via a BufReader we own.
    let mut buf_reader = BufReader::new(stdin.lock());

    let frame = read_frame(&mut buf_reader).expect("read Hello");
    assert!(is_host_command(&frame, HostCommand::Hello), "expected Hello");
    write_frame(
        &mut writer,
        &Frame::new_worker_event(
            worker_id.to_string(),
            seq,
            String::new(),
            WorkerEvent::HelloAck,
            json!({"version":{"major":1,"minor":0},"worker_id":worker_id}),
        ),
    );
    seq += 1;

    let frame = read_frame(&mut buf_reader).expect("read LoadModel");
    assert!(is_host_command(&frame, HostCommand::LoadModel), "expected LoadModel");
    write_frame(
        &mut writer,
        &Frame::new_worker_event(
            worker_id.to_string(),
            seq,
            String::new(),
            WorkerEvent::ModelLoaded,
            json!({}),
        ),
    );
    seq += 1;

    let frame = read_frame(&mut buf_reader).expect("read StartGeneration");
    assert!(
        is_host_command(&frame, HostCommand::StartGeneration),
        "expected StartGeneration"
    );
    let req_id = frame_request_id(&frame).unwrap_or_else(|| "req-000".into());

    write_frame(
        &mut writer,
        &Frame::new_worker_event(
            worker_id.to_string(),
            seq,
            req_id.clone(),
            WorkerEvent::GenerationStarted,
            json!({"request_id": &req_id}),
        ),
    );
    seq += 1;

    // Release the BufReader so the reader thread below can lock stdin.
    drop(buf_reader);

    let (tx, rx) = mpsc::channel::<Frame>();
    thread::spawn(move || {
        let mut reader = BufReader::new(std::io::stdin().lock());
        loop {
            match read_frame(&mut reader) {
                Ok(f) => {
                    if tx.send(f).is_err() {
                        break;
                    }
                }
                Err(e) => {
                    eprintln!("[fake-worker] ignored-cancel reader error: {}", e);
                    break;
                }
            }
        }
    });

    let mut cancelled = false;
    let mut tokens_after_cancel = 0u32;
    let total_tokens: u32 = 10;

    for i in 0..total_tokens {
        // Poll for CancelGeneration between tokens.
        loop {
            match rx.recv_timeout(Duration::from_millis(100)) {
                Ok(f) => {
                    if is_host_command(&f, HostCommand::CancelGeneration) {
                        eprintln!(
                            "[fake-worker] ignored-cancel: received CancelGeneration, ignoring"
                        );
                        cancelled = true;
                    }
                }
                Err(mpsc::RecvTimeoutError::Timeout) => break,
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    eprintln!("[fake-worker] ignored-cancel: reader disconnected");
                    break;
                }
            }
        }

        let token = TokenPayload {
            request_id: req_id.clone(),
            token_id: 100 + i,
            position: i,
            logprob: Some(-0.5),
        };
        write_frame(
            &mut writer,
            &Frame::new_worker_event(
                worker_id.to_string(),
                seq,
                req_id.clone(),
                WorkerEvent::Token,
                serde_json::to_value(&token).unwrap_or_default(),
            ),
        );
        seq += 1;

        if cancelled {
            tokens_after_cancel += 1;
            if tokens_after_cancel >= 3 {
                break;
            }
        }

        thread::sleep(Duration::from_secs(1));
    }

    let count = if cancelled { tokens_after_cancel } else { total_tokens };
    let completed = GenerationCompletedPayload {
        request_id: req_id.clone(),
        token_count: count,
        ttft_ms: 100,
        total_ms: (total_tokens as u64) * 1000,
    };
    write_frame(
        &mut writer,
        &Frame::new_worker_event(
            worker_id.to_string(),
            seq,
            req_id.clone(),
            WorkerEvent::GenerationCompleted,
            serde_json::to_value(&completed).unwrap_or_default(),
        ),
    );
    seq += 1;

    // Read remaining frames (UnloadModel, Shutdown)
    loop {
        match rx.recv_timeout(Duration::from_secs(5)) {
            Ok(f) => {
                if is_host_command(&f, HostCommand::UnloadModel) {
                    write_frame(
                        &mut writer,
                        &Frame::new_worker_event(
                            worker_id.to_string(),
                            seq,
                            String::new(),
                            WorkerEvent::ModelUnloaded,
                            json!({}),
                        ),
                    );
                    seq += 1;
                } else if is_host_command(&f, HostCommand::Shutdown) {
                    eprintln!("[fake-worker] ignored-cancel complete, exiting");
                    std::process::exit(0);
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                eprintln!("[fake-worker] ignored-cancel: timeout waiting for shutdown");
                std::process::exit(0);
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                eprintln!("[fake-worker] ignored-cancel: stdin disconnected");
                std::process::exit(0);
            }
        }
    }
}

/// **heartbeat-loss**: Accept generation but never emit Heartbeat events.
fn run_heartbeat_loss<R: Read, W: Write>(reader: &mut R, writer: &mut W, worker_id: &str) {
    let mut seq: u64 = 0;
    do_handshake(reader, writer, worker_id, &mut seq);
    do_load_model(reader, writer, worker_id, &mut seq);
    let req_id = do_start_generation(reader, writer, worker_id, &mut seq);
    do_emit_tokens(writer, worker_id, &mut seq, &req_id, 3, 42);
    thread::sleep(Duration::from_millis(500));
    do_generation_completed(writer, worker_id, &mut seq, &req_id, 3, 100, 1500);
    do_unload_model(reader, writer, worker_id, &mut seq);
    do_shutdown(reader, writer, worker_id, &mut seq, "heartbeat-loss");
}

/// **malformed-frames**: After handshake, write raw non-JSON to stdout,
/// then continue normally.
fn run_malformed_frames<R: Read, W: Write>(reader: &mut R, writer: &mut W, worker_id: &str) {
    let mut seq: u64 = 0;
    do_handshake(reader, writer, worker_id, &mut seq);
    eprintln!("[fake-worker] malformed-frames: writing non-JSON to stdout");
    let _ = writer.write_all(b"NOT JSON\n");
    let _ = writer.flush();
    do_load_model(reader, writer, worker_id, &mut seq);
    let req_id = do_start_generation(reader, writer, worker_id, &mut seq);
    do_emit_tokens(writer, worker_id, &mut seq, &req_id, 3, 42);
    do_generation_completed(writer, worker_id, &mut seq, &req_id, 3, 50, 150);
    do_unload_model(reader, writer, worker_id, &mut seq);
    do_shutdown(reader, writer, worker_id, &mut seq, "malformed-frames");
}

/// **sequence-gap**: After handshake, skip sequence numbers (seq 0 → seq 5).
fn run_sequence_gap<R: Read, W: Write>(reader: &mut R, writer: &mut W, worker_id: &str) {
    let mut seq: u64 = 0;
    do_handshake(reader, writer, worker_id, &mut seq);
    seq = 5; // gap: skip seq 1–4
    do_load_model(reader, writer, worker_id, &mut seq);
    let req_id = do_start_generation(reader, writer, worker_id, &mut seq);
    do_emit_tokens(writer, worker_id, &mut seq, &req_id, 3, 42);
    do_generation_completed(writer, worker_id, &mut seq, &req_id, 3, 50, 150);
    do_unload_model(reader, writer, worker_id, &mut seq);
    do_shutdown(reader, writer, worker_id, &mut seq, "sequence-gap");
}

/// **duplicate-terminal**: Emit GenerationCompleted twice for the same request.
fn run_duplicate_terminal<R: Read, W: Write>(reader: &mut R, writer: &mut W, worker_id: &str) {
    let mut seq: u64 = 0;
    do_handshake(reader, writer, worker_id, &mut seq);
    do_load_model(reader, writer, worker_id, &mut seq);
    let req_id = do_start_generation(reader, writer, worker_id, &mut seq);
    do_emit_tokens(writer, worker_id, &mut seq, &req_id, 3, 42);
    do_generation_completed(writer, worker_id, &mut seq, &req_id, 3, 50, 150);
    eprintln!("[fake-worker] duplicate-terminal: emitting second GenerationCompleted");
    do_generation_completed(writer, worker_id, &mut seq, &req_id, 3, 50, 150);
    do_unload_model(reader, writer, worker_id, &mut seq);
    do_shutdown(reader, writer, worker_id, &mut seq, "duplicate-terminal");
}

/// **crash**: After handshake and model load, exit(1) on StartGeneration.
fn run_crash<R: Read, W: Write>(reader: &mut R, writer: &mut W, worker_id: &str) {
    let mut seq: u64 = 0;
    do_handshake(reader, writer, worker_id, &mut seq);
    do_load_model(reader, writer, worker_id, &mut seq);
    let _ = read_frame(reader).expect("read StartGeneration");
    eprintln!("[fake-worker] crash: exiting with code 1");
    std::process::exit(1);
}

/// **memory-alloc**: Allocate 100MB Vec<u8>, emit tokens while holding it.
fn run_memory_alloc<R: Read, W: Write>(reader: &mut R, writer: &mut W, worker_id: &str) {
    let mut seq: u64 = 0;
    do_handshake(reader, writer, worker_id, &mut seq);
    do_load_model(reader, writer, worker_id, &mut seq);
    let req_id = do_start_generation(reader, writer, worker_id, &mut seq);
    eprintln!("[fake-worker] memory-alloc: allocating 100MB buffer");
    let _big_alloc: Vec<u8> = vec![0u8; 100 * 1024 * 1024];
    do_emit_tokens(writer, worker_id, &mut seq, &req_id, 3, 42);
    do_generation_completed(writer, worker_id, &mut seq, &req_id, 3, 50, 150);
    drop(_big_alloc);
    do_unload_model(reader, writer, worker_id, &mut seq);
    do_shutdown(reader, writer, worker_id, &mut seq, "memory-alloc");
}

// ═══════════════════════════════════════════════════════════════════════════
// Entry point
// ═══════════════════════════════════════════════════════════════════════════

fn main() {
    let args: Vec<String> = std::env::args().collect();

    let mut worker_id = String::new();
    let mut _image_dir = String::new();
    let mut mode = "normal".to_string();

    let mut i = 1;
    while i < args.len() {
        match args[i].as_str() {
            "--worker-instance-id" => {
                i += 1;
                worker_id = args.get(i).cloned().unwrap_or_default();
            }
            "--image-dir" => {
                i += 1;
                _image_dir = args.get(i).cloned().unwrap_or_default();
            }
            "--mode" => {
                i += 1;
                mode = args.get(i).cloned().unwrap_or_else(|| "normal".into());
            }
            _ => {
                eprintln!("[fake-worker] unknown argument: {}", args[i]);
                std::process::exit(1);
            }
        }
        i += 1;
    }

    if worker_id.is_empty() {
        eprintln!("[fake-worker] missing required argument: --worker-instance-id <uuid>");
        std::process::exit(1);
    }

    eprintln!(
        "[fake-worker] starting — worker_id={}, image_dir={}, mode={}",
        worker_id, _image_dir, mode
    );

    // ignored-cancel owns its own stdin/stdout handles (needs a reader thread),
    // so dispatch it before acquiring the lock in main().
    if mode == "ignored-cancel" {
        run_ignored_cancel(&worker_id);
        return;
    }

    let stdin = std::io::stdin();
    let mut reader = stdin.lock();
    let stdout = std::io::stdout();
    let mut writer = stdout.lock();

    match mode.as_str() {
        "normal" => run_normal(&mut reader, &mut writer, &worker_id),
        "identity-mismatch" => run_identity_mismatch(&mut reader, &mut writer, &worker_id),
        "no-handshake" => run_no_handshake(&mut reader, &mut writer, &worker_id),
        "model-load-hang" => run_model_load_hang(&mut reader, &mut writer, &worker_id),
        "slow-prefill" => run_slow_prefill(&mut reader, &mut writer, &worker_id),
        "heartbeat-loss" => run_heartbeat_loss(&mut reader, &mut writer, &worker_id),
        "malformed-frames" => run_malformed_frames(&mut reader, &mut writer, &worker_id),
        "sequence-gap" => run_sequence_gap(&mut reader, &mut writer, &worker_id),
        "duplicate-terminal" => run_duplicate_terminal(&mut reader, &mut writer, &worker_id),
        "crash" => run_crash(&mut reader, &mut writer, &worker_id),
        "memory-alloc" => run_memory_alloc(&mut reader, &mut writer, &worker_id),
        _ => {
            eprintln!("[fake-worker] unknown mode: {}", mode);
            std::process::exit(1);
        }
    }
}
