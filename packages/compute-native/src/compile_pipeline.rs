//! Parallel compilation pipeline with backpressure.
//!
//! Four lanes: source-read, relocate, write, hash — connected by bounded
//! Tokio channels. Each lane runs in `spawn_blocking` so CPU-bound work
//! doesn't starve the async runtime.
//!
//! Channels are bounded to cap in-flight memory. When the writer is slow,
//! backpressure propagates all the way to the source reader, limiting the
//! number of buffered payloads.

use crate::config::{CompilationPlan, PlannedSegment, PlannedTensor, TensorDisposition};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::mpsc;

// ── Pipeline types ─────────────────────────────────────────────────────────

/// A work unit flowing through the pipeline.
#[derive(Clone)]
pub struct RelocationUnit {
    pub tensor_id: u32,
    pub tensor_name: String,
    pub source_shard: String,
    pub source_offset: u64,
    pub source_length: u64,
    pub destination_segment: String,
    pub destination_offset: u64,
    pub disposition: String,
}

/// Resources needed by the pipeline: source files and destination directory.
pub struct PipelineResources {
    pub source_dir: PathBuf,
    pub output_dir: PathBuf,
    pub total_bytes: u64,
}

// ── Pipeline orchestration ─────────────────────────────────────────────────

/// Execute the parallel relocation pipeline.
///
/// Returns a map from segment id to SHA-256 hex digest.
pub async fn run_relocation_pipeline(
    plan: &CompilationPlan,
    resources: PipelineResources,
) -> napi::Result<HashMap<String, String>> {
    // Channel capacities: 64 permits per stage keeps ~128 MiB of
    // in-flight data under typical tensor sizes.
    let capacity = 64usize;

    let (source_tx, source_rx) = mpsc::channel::<RelocationUnit>(capacity);
    let (write_tx, write_rx) = mpsc::channel::<(RelocationUnit, Vec<u8>)>(capacity);

    let output_dir = Arc::new(resources.output_dir);
    let source_dir = Arc::new(resources.source_dir);
    let plan_tensors = Arc::new(plan.tensor_table.clone());
    let plan_segments = Arc::new(plan.segments.clone());

    // ── Lane 1: source-read ────────────────────────────────────────────
    let source_read_handle = {
        let tx = source_tx.clone();
        let tensors = plan_tensors.clone();
        let dir = source_dir.clone();
        tokio::task::spawn_blocking(move || source_read_lane(tensors, dir, tx))
    };

    // ── Lane 2: relocate ───────────────────────────────────────────────
    let relocate_handle = {
        let tx = write_tx.clone();
        tokio::task::spawn_blocking(move || relocate_lane(source_rx, tx))
    };

    // ── Lane 3: write + hash ───────────────────────────────────────────
    let writer_handle = {
        let dir = output_dir.clone();
        let segments = plan_segments.clone();
        tokio::task::spawn_blocking(move || write_lane(write_rx, dir, segments))
    };

    // Drop our sender ends so channels close when all workers drain.
    drop(source_tx);
    drop(write_tx);

    // Await completion — if any lane panicked, surface it as an error.
    let source_result = source_read_handle
        .await
        .map_err(|e| napi::Error::from_reason(format!("source read lane panicked: {}", e)))?;
    source_result?;

    let relocate_result = relocate_handle
        .await
        .map_err(|e| napi::Error::from_reason(format!("relocate lane panicked: {}", e)))?;
    relocate_result?;

    writer_handle
        .await
        .map_err(|e| napi::Error::from_reason(format!("write lane panicked: {}", e)))?
}

// ── Lane implementation ────────────────────────────────────────────────────

/// Iterate over the tensor table, skip aliases, and push a
/// `RelocationUnit` downstream for every physical tensor.
fn source_read_lane(
    tensors: Arc<Vec<PlannedTensor>>,
    _source_dir: Arc<PathBuf>,
    tx: mpsc::Sender<RelocationUnit>,
) -> napi::Result<()> {
    for tensor in tensors.iter() {
        if matches!(tensor.disposition, TensorDisposition::AliasOnly { .. }) {
            continue;
        }

        // Phase 4 will populate actual source bytes here;
        // for now we forward the metadata unit so the channel
        // topology, backpressure, and error propagation are all
        // exercised.

        tx.blocking_send(RelocationUnit {
            tensor_id: tensor.id,
            tensor_name: tensor.name.clone(),
            source_shard: tensor.source_shard.clone(),
            source_offset: tensor.source_offset,
            source_length: tensor.source_byte_length,
            destination_segment: tensor.destination_segment.clone(),
            destination_offset: tensor.destination_offset,
            disposition: format!("{:?}", tensor.disposition),
        })
        .map_err(|_| napi::Error::from_reason("source read lane: channel closed"))?;
    }
    Ok(())
}

/// Receive raw relocation units and produce payload bytes.
///
/// For `RelocateAndAlign` tensors the bytes are forwarded unchanged.
/// Future lane implementations (`CpuTransform`, `GpuTransform`) will
/// process payloads before forwarding.
fn relocate_lane(
    mut rx: mpsc::Receiver<RelocationUnit>,
    tx: mpsc::Sender<(RelocationUnit, Vec<u8>)>,
) -> napi::Result<()> {
    while let Some(unit) = rx.blocking_recv() {
        // Placeholder payload — Phase 4 will read real source bytes.
        let data = vec![0u8; unit.source_length as usize];
        tx.blocking_send((unit, data))
            .map_err(|_| napi::Error::from_reason("relocate lane: channel closed"))?;
    }
    Ok(())
}

/// Write payloads to pre-created segment files at their target offsets,
/// simultaneously updating per-segment SHA-256 hashers.
fn write_lane(
    mut rx: mpsc::Receiver<(RelocationUnit, Vec<u8>)>,
    output_dir: Arc<PathBuf>,
    segments: Arc<Vec<PlannedSegment>>,
) -> napi::Result<HashMap<String, String>> {
    use std::io::{Seek, SeekFrom, Write};

    // Open every segment file upfront so writes never touch the VFS
    // outside the critical section.
    let mut segment_files: HashMap<String, std::fs::File> = HashMap::new();
    for seg in segments.iter() {
        let path = output_dir.join("segments").join(&seg.filename);
        std::fs::create_dir_all(
            path.parent()
                .expect("segment path has no parent"),
        )
        .map_err(|e| napi::Error::from_reason(format!("mkdir: {}", e)))?;
        let file = std::fs::File::create(&path)
            .map_err(|e| napi::Error::from_reason(format!("create {}: {}", path.display(), e)))?;
        segment_files.insert(seg.id.clone(), file);
    }

    let mut hashers: HashMap<String, Sha256> = HashMap::new();
    for seg in segments.iter() {
        hashers.insert(seg.id.clone(), Sha256::new());
    }

    while let Some((unit, data)) = rx.blocking_recv() {
        let file = segment_files
            .get_mut(&unit.destination_segment)
            .ok_or_else(|| {
                napi::Error::from_reason(format!(
                    "unknown segment: {}",
                    unit.destination_segment
                ))
            })?;

        file.seek(SeekFrom::Start(unit.destination_offset))
            .map_err(|e| napi::Error::from_reason(format!("seek: {}", e)))?;
        file.write_all(&data)
            .map_err(|e| napi::Error::from_reason(format!("write: {}", e)))?;

        if let Some(h) = hashers.get_mut(&unit.destination_segment) {
            h.update(&data);
        }
    }

    let mut segment_hashes: HashMap<String, String> = HashMap::new();
    for (id, hasher) in hashers {
        segment_hashes.insert(id, format!("{:x}", hasher.finalize()));
    }
    Ok(segment_hashes)
}
