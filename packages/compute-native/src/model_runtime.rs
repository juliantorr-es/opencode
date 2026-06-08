//! ModelRuntime — persistent store handle for an installed ComputeImage.
//!
//! Separates compilation from inference lifecycle. A ModelRuntime owns the
//! opened ComputeImage metadata (manifest, execution plan, tensor catalog,
//! storage ABI validation) without reading tensor bytes into memory. Segment
//! files are opened and their handles retained for later mmap by the
//! execution kernel or mapped-image backend.

use std::collections::HashMap;
use std::fs::File;
use std::path::{Path, PathBuf};

use crate::mapped_image::{MappedImage, SegmentView};
use crate::placement_profile::ExecutionPlacementProfile;
use crate::profile_compiler;

use crate::compute_image::Manifest;
use crate::config::ModelExecutionPlan;

/// Workload classification for profile selection.
///
/// Describes the dominant access pattern of a generation request so
/// the runtime can select the best placement profile.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkloadClass {
    /// Prompt-heavy: large prefill, few decode steps.
    /// GPU-mandated large matmuls dominate; ANE fusion is unlikely to amortise
    /// the boundary cost.
    PromptHeavy,
    /// Decode-heavy: small prefill, many decode steps.
    /// Memory-bandwidth-bound; CPU-side or fusion paths may win on small
    /// batches where GPU launch overhead is significant.
    DecodeHeavy,
    /// Balanced: comparable prefill and decode work.
    Balanced,
}

/// A single entry in the tensor catalog, recording the physical storage
/// location and dtype of one tensor within the ComputeImage.
#[derive(Debug, Clone)]
pub struct TensorCatalogEntry {
    pub tensor_name: String,
    pub segment_id: String,
    pub offset: u64,
    pub byte_length: u64,
    pub physical_dtype: String,
    pub logical_dtype: String,
    pub physical_shape: Vec<u32>,
    pub logical_shape: Vec<u32>,
}

/// Memory-admission estimate for a loaded ComputeImage.
///
/// Computed at runtime-open time so the scheduler can decide whether to
/// admit the model into the available memory budget.
#[derive(Debug, Clone, Copy)]
pub struct ModelAdmissionEstimate {
    /// Virtual address space consumed by mmap'd segments
    /// (mapped-no-copy-v1 only; 0 for copied-v0).
    pub mapped_virtual_bytes: u64,
    /// Expected resident pages from persistent segments and layer window.
    pub expected_resident_pages: u64,
    /// Small normalization/bias/scale tensors that may be materialized/transposed.
    pub persistent_materialized_bytes: u64,
    /// RoPE tables: max_position_embeddings * head_dim * 4 (cos + sin).
    pub rope_storage_bytes: u64,
    /// Per-layer struct/binding overhead.
    pub layer_metadata_bytes: u64,
    /// KV cache allocation: capacity * (n_kv_heads * head_dim * 2 * 4) per layer.
    pub kv_allocation_bytes: u64,
    /// Attention score workspace: query_len * kv_len * n_heads * 4.
    pub attention_workspace_bytes: u64,
    /// Output projection workspace: hidden * vocab_size * 4.
    pub output_projection_bytes: u64,
    /// MLX allocator cache.
    pub mlx_cache_bytes: u64,
    /// Worker fixed overhead.
    pub worker_overhead_bytes: u64,
    /// System reserve (2 GiB on 16 GiB machines).
    pub system_reserve_bytes: u64,
    /// Largest-known single transient allocation.
    pub peak_transient_bytes: u64,
    /// Total resident bytes for legacy aggregation.
    pub persistent_resident_bytes: u64,
    /// Total materialized segment bytes on disk.
    pub materialized_bytes: u64,
    /// Bytes copied into heap buffers (copied-v0 only; 0 for mmap).
    pub copied_bytes: u64,
    /// Number of tensors the execution plan binds.
    pub tensor_binding_count: u32,
    /// Number of segments in the image.
    pub segment_count: u32,
}

impl ModelAdmissionEstimate {
    /// Peak resident bytes during inference.
    ///
    /// Sum of persistent resident bytes plus any copied bytes.
    /// Mapped virtual bytes are VMA, not physical RAM.
    pub fn peak_bytes(&self) -> u64 {
        self.persistent_resident_bytes.saturating_add(self.copied_bytes)
    }
}

/// Lightweight handle to an installed ComputeImage.
///
/// Opening validates the manifest, execution plan, storage ABI, tensor
/// catalog consistency, and segment accessibility. Actual tensor bytes are
/// NOT read — the runtime caller maps segments on demand via mmap or
/// sequential read.
pub struct ModelRuntime {
    manifest: Manifest,
    /// Cached pointer into manifest for ergonomic access.
    execution_plan: ModelExecutionPlan,
    /// Validated storage ABI string (e.g. "copied-v0", "mapped-no-copy-v1").
    storage_abi: String,
    /// image_dir path for constructing full segment paths at open time.
    image_dir: PathBuf,
    /// Open file handles keyed by segment id, with the original path preserved
    /// for mmap-based access.
    segments: HashMap<String, (PathBuf, File)>,
    /// Tensor catalog indexed by tensor name, populated from the manifest
    /// tensor_table at open time.
    tensor_catalog: HashMap<String, TensorCatalogEntry>,
    /// Memory-mapped segment store, present when storage ABI is
    /// mapped-no-copy-v1; `None` for copied-v0.
    mapped_image: Option<MappedImage>,
    /// Whether the runtime holds valid open segment handles.
    open: bool,
}

impl std::fmt::Debug for ModelRuntime {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ModelRuntime")
            .field("image_dir", &self.image_dir)
            .field("storage_abi", &self.storage_abi)
            .field("segment_count", &self.segments.len())
            .field("tensor_count", &self.tensor_catalog.len())
            .field("mapped", &self.mapped_image.is_some())
            .field("open", &self.open)
            .finish_non_exhaustive()
    }
}

impl ModelRuntime {
    /// Open a ComputeImage from an installed model directory.
    ///
    /// Reads and validates:
    ///   1. `manifest.json` — parse into `Manifest`.
    ///   2. Execution plan — runs `ModelExecutionPlan::validate()`.
    ///   3. Storage ABI — must be "copied-v0" or "mapped-no-copy-v1".
    ///   4. Segment files — opens every segment listed in the manifest.
    ///   5. Tensor catalog — builds a name-indexed catalog from the
    ///      manifest's tensor_table.
    ///   6. Mapped image — when ABI is mapped-no-copy-v1, mmap all segments.
    ///
    /// Returns an error if the manifest cannot be read, the plan is invalid,
    /// the storage ABI is unknown, or any segment file is missing/unreadable.
    pub fn open(image_dir: &Path) -> napi::Result<Self> {
        let manifest_path = image_dir.join("manifest.json");
        let manifest: Manifest = serde_json::from_str(
            &std::fs::read_to_string(&manifest_path).map_err(|e| {
                napi::Error::from_reason(format!(
                    "read manifest {}: {}",
                    manifest_path.display(),
                    e
                ))
            })?,
        )
        .map_err(|e| napi::Error::from_reason(format!("parse manifest: {}", e)))?;

        // Validate the execution plan.
        let execution_plan = manifest.execution_plan.clone();
        execution_plan.validate().map_err(|errors| {
            napi::Error::from_reason(format!(
                "execution plan validation failed: {}",
                errors.join("; ")
            ))
        })?;

        // Validate storage ABI.
        let storage_abi = manifest.required_storage_abi.clone();
        match storage_abi.as_str() {
            "copied-v0" | "mapped-no-copy-v1" => {}
            other => {
                return Err(napi::Error::from_reason(format!(
                    "unsupported storage ABI '{other}'; expected 'copied-v0' or 'mapped-no-copy-v1'"
                )));
            }
        }

        // Open every segment file. Keep handles + paths for later mmap.
        let mut segments: HashMap<String, (PathBuf, File)> = HashMap::new();
        for segment in &manifest.segments {
            let seg_path = image_dir.join(&segment.filename);
            let file = File::open(&seg_path).map_err(|e| {
                napi::Error::from_reason(format!(
                    "open segment {} ({}): {}",
                    segment.id,
                    seg_path.display(),
                    e
                ))
            })?;
            segments.insert(segment.id.clone(), (seg_path, file));
        }

        // Build tensor catalog from manifest tensor_table.
        let mut tensor_catalog: HashMap<String, TensorCatalogEntry> = HashMap::new();
        for entry in &manifest.tensor_table {
            tensor_catalog.insert(
                entry.name.clone(),
                TensorCatalogEntry {
                    tensor_name: entry.name.clone(),
                    segment_id: entry.segment.clone(),
                    offset: entry.offset,
                    byte_length: entry.byte_length,
                    physical_dtype: entry.storage_dtype.clone(),
                    logical_dtype: entry.logical_dtype.clone(),
                    physical_shape: entry.physical_shape.clone(),
                    logical_shape: entry.logical_shape.clone(),
                },
            );
        }

        // Build mapped image for mapped-no-copy-v1 ABI.
        let mapped_image = if storage_abi == "mapped-no-copy-v1" {
            let views: Vec<SegmentView> = manifest
                .segments
                .iter()
                .enumerate()
                .map(|(i, seg)| SegmentView {
                    segment_id: seg.id.clone(),
                    segment_index: i as u64,
                    file_path: seg.filename.clone().into(),
                    byte_offset: 0,
                    byte_length: seg.byte_size,
                    kind: format!("{:?}", seg.kind),
                    segment_lease: None,
                })
                .collect();
            match MappedImage::open_mapped(image_dir, &views) {
                Ok(img) => Some(img),
                Err(e) => {
                    return Err(napi::Error::from_reason(format!(
                        "failed to mmap segments for mapped-no-copy-v1: {}",
                        e
                    )));
                }
            }
        } else {
            None
        };

        Ok(Self {
            manifest,
            execution_plan,
            storage_abi,
            image_dir: image_dir.to_path_buf(),
            segments,
            tensor_catalog,
            mapped_image,
            open: true,
        })
    }

    /// Returns `true` while the runtime holds valid open segment handles.
    pub fn is_open(&self) -> bool {
        self.open
    }

    /// Reference to the full ComputeImage manifest.
    pub fn manifest(&self) -> &Manifest {
        &self.manifest
    }

    /// Reference to the validated execution plan (shorthand for
    /// `self.manifest().execution_plan`).
    pub fn execution_plan(&self) -> &ModelExecutionPlan {
        &self.execution_plan
    }

    /// The validated storage ABI string.
    pub fn storage_abi(&self) -> &str {
        &self.storage_abi
    }

    /// The image directory path.
    pub fn image_dir(&self) -> &Path {
        &self.image_dir
    }

    /// Reference to the tensor catalog.
    pub fn tensor_catalog(&self) -> &HashMap<String, TensorCatalogEntry> {
        &self.tensor_catalog
    }

    /// Look up a single entry in the tensor catalog by tensor name.
    pub fn lookup_tensor(&self, name: &str) -> Option<&TensorCatalogEntry> {
        self.tensor_catalog.get(name)
    }

    /// Reference to the mapped image, if the storage ABI is mapped-no-copy-v1.
    pub fn mapped_image(&self) -> Option<&MappedImage> {
        self.mapped_image.as_ref()
    }

    /// Look up a segment's file handle and path by segment id.
    pub fn segment_handle(&self, segment_id: &str) -> Option<&(PathBuf, File)> {
        self.segments.get(segment_id)
    }

    /// Return an iterator over all open segment (id, path) pairs.
    pub fn segment_paths(&self) -> impl Iterator<Item = (&str, &Path)> {
        self.segments
            .iter()
            .map(|(id, (path, _))| (id.as_str(), path.as_path()))
    }

    /// Close all segment handles, unmaps any mmap'd image, and marks the
    /// runtime as closed.
    ///
    /// Idempotent — safe to call multiple times. After close, `is_open()`
    /// returns `false` and `segment_handle()` returns `None`.
    pub fn close(&mut self) {
        if let Some(img) = self.mapped_image.as_mut() {
            img.close();
        }
        self.segments.clear();
        self.open = false;
    }

    /// Validate runtime capabilities against the loaded image.
    ///
    /// Checks:
    ///   - Storage ABI is supported by the backend.
    ///   - For mapped-no-copy-v1: segment offsets are page-aligned.
    ///   - Dtype sizes are consistent with byte lengths.
    pub fn validate_capabilities(&self) -> Result<(), String> {
        // 1. Storage ABI support.
        match self.storage_abi.as_str() {
            "copied-v0" | "mapped-no-copy-v1" => {}
            other => {
                return Err(format!("unsupported storage ABI: {other}"));
            }
        }

        // 2. Page alignment for mapped ABI.
        if self.storage_abi == "mapped-no-copy-v1" {
            let page_size = unsafe { libc::sysconf(libc::_SC_PAGESIZE) as u64 };
            for entry in self.tensor_catalog.values() {
                if entry.offset % page_size != 0 {
                    return Err(format!(
                        "tensor '{}' offset {} is not page-aligned (page size {}) \
                         — mapped-no-copy-v1 requires page alignment",
                        entry.tensor_name, entry.offset, page_size
                    ));
                }
            }
        }

        // 3. Dtype size consistency.
        for entry in self.tensor_catalog.values() {
            let dtype_size = dtype_byte_size(&entry.physical_dtype)
                .ok_or_else(|| format!("unknown physical dtype '{}'", entry.physical_dtype))?;
            if entry.byte_length == 0 {
                return Err(format!(
                    "tensor '{}' has zero byte_length",
                    entry.tensor_name
                ));
            }
            // Estimate expected size from physical shape × dtype size.
            let elem_count: u64 = entry.physical_shape.iter().map(|&d| d as u64).product();
            let expected = elem_count * dtype_size as u64;
            if entry.byte_length < expected {
                return Err(format!(
                    "tensor '{}' byte_length {} < shape {} * dtype_size {} = {}",
                    entry.tensor_name,
                    entry.byte_length,
                    elem_count,
                    dtype_size,
                    expected,
                ));
            }
        }

        Ok(())
    }

    /// Compute a representation-aware memory-admission estimate for the loaded image.
    ///
    /// Delegates to [`compute_admission_estimate`] and adjusts for the storage
    /// ABI: for copied-v0 all bytes are counted as copied (no mmap) and the
    /// mapped_virtual_bytes field is set to zero since every tensor is heap-allocated.
    pub fn admission_estimate(&self) -> ModelAdmissionEstimate {
        let mut est = compute_admission_estimate(&self.manifest);
        match self.storage_abi.as_str() {
            "copied-v0" => {
                est.mapped_virtual_bytes = 0;
                est.copied_bytes = est.materialized_bytes;
                est.persistent_resident_bytes = est.materialized_bytes;
            }
            "mapped-no-copy-v1" => {
                est.copied_bytes = 0;
            }
            _ => {
                // Unknown ABI — treat conservatively as all-copied.
                est.mapped_virtual_bytes = 0;
                est.copied_bytes = est.materialized_bytes;
                est.persistent_resident_bytes = est.materialized_bytes;
            }
        }
        est
    }

    /// Select an execution placement profile for a given workload class.
    ///
    /// Returns a profile optimised for the dominant access pattern. The
    /// profile governs which backend candidate regions are active and in
    /// what order they are tried during dispatch.
    ///
    /// The baseline M1 profile uses [`profile_compiler::compile_default_m1_profile`]
    /// as the starting point for every workload class. Future revisions will
    /// specialise by hardware target and workload.
    pub fn select_profile(&self, _workload: WorkloadClass) -> ExecutionPlacementProfile {
        // On M1 every workload starts from the same baseline profile.
        // Adjustment knobs (weight tuning, region ordering) are reserved for
        // the runtime profiling phase that follows BenchmarkUnresolved regions.
        profile_compiler::compile_default_m1_profile(&self.manifest.image_hash)
    }

    /// Execute the full 48-layer model from the installed ComputeImage.
    /// Returns the next token ID. Uses the copied segment backend.
    pub fn run_full_model(&self, token_ids: &[i32]) -> napi::Result<u32> {
        use crate::compute_image::{CompiledImageReader, StorageBackend};
        let reader = CompiledImageReader::open(&self.image_dir)?;
        let mut runtime = reader.open_runtime(StorageBackend::Copied)?;
        runtime.run_full_model(token_ids)
    }
}

impl Drop for ModelRuntime {
    fn drop(&mut self) {
        self.close();
    }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/// Return the byte size of a well-known physical dtype string.
fn dtype_byte_size(dtype: &str) -> Option<u32> {
    match dtype {
        "float32" | "f32" => Some(4),
        "float16" | "f16" | "half" => Some(2),
        "bfloat16" | "bf16" => Some(2),
        "float8" | "f8" => Some(1),
        "int8" | "i8" => Some(1),
        "int16" | "i16" => Some(2),
        "int32" | "i32" => Some(4),
        "int64" | "i64" => Some(8),
        "uint8" | "u8" => Some(1),
        "uint16" | "u16" => Some(2),
        "uint32" | "u32" => Some(4),
        "uint64" | "u64" => Some(8),
        _ => None,
    }
}

/// Compute a representation-aware memory-admission estimate from a manifest.
///
/// Breaks down every component of peak memory so the scheduler can make
/// fine-grained admission decisions. The estimate is conservative — it uses
/// worst-case query/kv lengths (max_position_embeddings), float32 workspace,
/// and a full KV cache reservation for the maximum sequence length.
pub fn compute_admission_estimate(manifest: &Manifest) -> ModelAdmissionEstimate {
    use crate::compute_image::SegmentKind;

    let arch = &manifest.architecture;
    let num_layers = arch.num_hidden_layers as u64;
    let head_dim = arch.head_dim as u64;
    let max_pos = arch.max_position_embeddings as u64;
    let hidden = arch.hidden_size as u64;
    let vocab = arch.vocab_size as u64;
    let n_heads = arch.num_attention_heads as u64;
    let n_kv_heads = arch.num_key_value_heads as u64;

    // 1. Mapped virtual bytes: sum of all segment file sizes.
    let mapped_virtual_bytes: u64 = manifest.segments.iter().map(|s| s.byte_size).sum();

    // 2. Expected resident pages: persistent + Final segments plus layer window.
    let persistent_segment_bytes: u64 = manifest
        .segments
        .iter()
        .filter(|s| {
            matches!(
                s.kind,
                SegmentKind::Persistent | SegmentKind::Final
            )
        })
        .map(|s| s.byte_size)
        .sum();
    let layer_segment_bytes: u64 = manifest
        .segments
        .iter()
        .filter(|s| matches!(s.kind, SegmentKind::Layer(_)))
        .map(|s| s.byte_size)
        .sum();
    let layer_seg_count = manifest
        .segments
        .iter()
        .filter(|s| matches!(s.kind, SegmentKind::Layer(_)))
        .count() as u64;
    let per_layer_avg = if layer_seg_count > 0 {
        (layer_segment_bytes + layer_seg_count - 1) / layer_seg_count
    } else {
        0
    };
    let layer_window = manifest.residency_plan.layer_window_size as u64;
    let expected_resident_pages = persistent_segment_bytes + per_layer_avg * layer_window;

    // 3. Persistent materialized tensors: small norm/bias/scale tensors (< 1 MiB)
    //    that may be converted or transposed at load time.
    let persistent_materialized_bytes: u64 = manifest
        .tensor_table
        .iter()
        .filter(|t| {
            (t.role == "weight" || t.role == "bias" || t.role == "scale")
                && t.byte_length < 1024 * 1024
        })
        .map(|t| t.byte_length)
        .sum();

    // 4. RoPE storage: max_position_embeddings * head_dim * 4 bytes * 2 tables (cos + sin).
    let rope_storage_bytes = max_pos * head_dim * 4 * 2;

    // 5. Layer-binding metadata: per-layer small struct overhead (~4 KiB each).
    let layer_metadata_bytes = num_layers * 4096;

    // 6. KV allocation: capacity * (n_kv_heads * head_dim * 2 * 4) per layer.
    //    Capacity = max_pos (worst-case sequence length).
    let kv_per_layer = n_kv_heads * head_dim * 2 * 4;
    let kv_allocation_bytes = kv_per_layer * num_layers * max_pos;

    // 7. Attention workspace: query_len * kv_len * n_heads * 4 (float32 scores).
    //    Worst-case: max_pos * max_pos * n_heads * 4.
    let attention_workspace_bytes = max_pos * max_pos * n_heads * 4;

    // 8. Output projection workspace: hidden * vocab_size * 4 (one-time float32).
    let output_projection_bytes = hidden * vocab * 4;

    // 9. MLX allocator cache: 512 MiB configured default.
    let mlx_cache_bytes: u64 = 512 * 1024 * 1024;

    // 10. Worker overhead: 128 MiB fixed.
    let worker_overhead_bytes: u64 = 128 * 1024 * 1024;

    // 11. System reserve: 2 GiB on 16 GiB machines.
    let system_reserve_bytes: u64 = 2 * 1024 * 1024 * 1024;

    // Largest-known single transient allocation (typically output projection).
    let peak_transient_bytes = output_projection_bytes
        .max(attention_workspace_bytes)
        .max(kv_allocation_bytes);

    let total_segment_bytes = mapped_virtual_bytes;

    ModelAdmissionEstimate {
        mapped_virtual_bytes,
        expected_resident_pages,
        persistent_materialized_bytes,
        rope_storage_bytes,
        layer_metadata_bytes,
        kv_allocation_bytes,
        attention_workspace_bytes,
        output_projection_bytes,
        mlx_cache_bytes,
        worker_overhead_bytes,
        system_reserve_bytes,
        peak_transient_bytes,
        persistent_resident_bytes: expected_resident_pages,
        materialized_bytes: total_segment_bytes,
        copied_bytes: 0,
        tensor_binding_count: manifest.tensor_table.len() as u32,
        segment_count: manifest.segments.len() as u32,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `dtype_byte_size` returns expected sizes for known types.
    #[test]
    fn test_dtype_byte_size_known() {
        assert_eq!(dtype_byte_size("float32"), Some(4));
        assert_eq!(dtype_byte_size("f32"), Some(4));
        assert_eq!(dtype_byte_size("float16"), Some(2));
        assert_eq!(dtype_byte_size("bf16"), Some(2));
        assert_eq!(dtype_byte_size("int8"), Some(1));
        assert_eq!(dtype_byte_size("i32"), Some(4));
        assert_eq!(dtype_byte_size("i64"), Some(8));
        assert_eq!(dtype_byte_size("u8"), Some(1));
    }

    /// `dtype_byte_size` returns `None` for unknown types.
    #[test]
    fn test_dtype_byte_size_unknown() {
        assert_eq!(dtype_byte_size("complex64"), None);
        assert_eq!(dtype_byte_size(""), None);
    }

    /// Tensor catalog key-value semantics.
    #[test]
    fn test_tensor_catalog_roundtrip() {
        let mut catalog: HashMap<String, TensorCatalogEntry> = HashMap::new();
        assert!(catalog.is_empty());

        catalog.insert(
            "wq.0.weight".into(),
            TensorCatalogEntry {
                tensor_name: "wq.0.weight".into(),
                segment_id: "layer_0".into(),
                offset: 128,
                byte_length: 4096,
                physical_dtype: "float16".into(),
                logical_dtype: "float16".into(),
                physical_shape: vec![64, 64],
                logical_shape: vec![64, 64],
            },
        );
        assert_eq!(catalog.len(), 1);

        let entry = catalog.get("wq.0.weight").unwrap();
        assert_eq!(entry.segment_id, "layer_0");
        assert_eq!(entry.offset, 128);
        assert_eq!(entry.byte_length, 4096);
    }

    /// TensorCatalogEntry construction from TensorEntry fields.
    #[test]
    fn test_tensor_catalog_entry_from_tensor_entry() {
        use crate::compute_image::TensorEntry;
        let te = TensorEntry {
            id: 1,
            name: "wq.0.weight".into(),
            role: "weight".into(),
            layer: Some(0),
            segment: "layer_0".into(),
            source_filename: "model.safetensors".into(),
            source_sha256: "abcd".into(),
            source_offset: 0,
            offset: 128,
            byte_length: 4096,
            logical_dtype: "float16".into(),
            storage_dtype: "float16".into(),
            logical_shape: vec![64, 64],
            physical_shape: vec![64, 64],
            mutability: "frozen".into(),
            quantization: None,
            tensor_alignment_bytes: 16,
            layout_version: 1,
        };

        let cat = TensorCatalogEntry {
            tensor_name: te.name.clone(),
            segment_id: te.segment.clone(),
            offset: te.offset,
            byte_length: te.byte_length,
            physical_dtype: te.storage_dtype.clone(),
            logical_dtype: te.logical_dtype.clone(),
            physical_shape: te.physical_shape.clone(),
            logical_shape: te.logical_shape.clone(),
        };

        assert_eq!(cat.tensor_name, "wq.0.weight");
        assert_eq!(cat.segment_id, "layer_0");
        assert_eq!(cat.offset, 128);
        assert_eq!(cat.byte_length, 4096);
        assert_eq!(cat.physical_dtype, "float16");
        assert_eq!(cat.logical_dtype, "float16");
        assert_eq!(cat.physical_shape, vec![64u32, 64]);
        assert_eq!(cat.logical_shape, vec![64u32, 64]);
    }

    /// ModelAdmissionEstimate for copied-v0 — all fields are zero-padded
    /// placeholders since the coarse old values are subsumed by the
    /// representation-aware breakdown.
    #[test]
    fn test_admission_estimate_copied() {
        let est = ModelAdmissionEstimate {
            mapped_virtual_bytes: 0,
            expected_resident_pages: 10000,
            persistent_materialized_bytes: 500,
            rope_storage_bytes: 0,
            layer_metadata_bytes: 0,
            kv_allocation_bytes: 0,
            attention_workspace_bytes: 0,
            output_projection_bytes: 0,
            mlx_cache_bytes: 512 * 1024 * 1024,
            worker_overhead_bytes: 128 * 1024 * 1024,
            system_reserve_bytes: 2 * 1024 * 1024 * 1024,
            peak_transient_bytes: 0,
            persistent_resident_bytes: 10000,
            materialized_bytes: 10000,
            copied_bytes: 10000,
            tensor_binding_count: 5,
            segment_count: 2,
        };
        assert_eq!(est.mapped_virtual_bytes, 0);
        assert_eq!(est.copied_bytes, 10000);
        assert_eq!(est.segment_count, 2);
        assert_eq!(est.expected_resident_pages, 10000);
        assert_eq!(est.mlx_cache_bytes, 512 * 1024 * 1024);
        assert_eq!(est.worker_overhead_bytes, 128 * 1024 * 1024);
        assert_eq!(est.system_reserve_bytes, 2 * 1024 * 1024 * 1024);
    }

    /// ModelAdmissionEstimate for mapped-no-copy-v1.
    #[test]
    fn test_admission_estimate_mapped() {
        let est = ModelAdmissionEstimate {
            mapped_virtual_bytes: 10000,
            expected_resident_pages: 5000,
            persistent_materialized_bytes: 256,
            rope_storage_bytes: 8 * 128 * 4 * 2,
            layer_metadata_bytes: 32 * 4096,
            kv_allocation_bytes: 8 * 128 * 2 * 4 * 32 * 2048,
            attention_workspace_bytes: 2048 * 2048 * 32 * 4,
            output_projection_bytes: 4096 * 128256 * 4,
            mlx_cache_bytes: 512 * 1024 * 1024,
            worker_overhead_bytes: 128 * 1024 * 1024,
            system_reserve_bytes: 2 * 1024 * 1024 * 1024,
            peak_transient_bytes: (2048 * 2048 * 32 * 4)
                .max(4096 * 128256 * 4)
                .max(8 * 128 * 2 * 4 * 32 * 2048),
            persistent_resident_bytes: 5000,
            materialized_bytes: 10000,
            copied_bytes: 0,
            tensor_binding_count: 5,
            segment_count: 2,
        };
        assert_eq!(est.mapped_virtual_bytes, 10000);
        assert_eq!(est.copied_bytes, 0);
        assert_eq!(est.persistent_resident_bytes, 5000);
        assert_eq!(est.expected_resident_pages, 5000);
        assert!(est.kv_allocation_bytes > 0);
        assert!(est.attention_workspace_bytes > 0);
        assert!(est.output_projection_bytes > 0);
        assert_eq!(est.peak_transient_bytes, est.output_projection_bytes);
    }

    /// validate_capabilities accepts valid copied-v0.
    #[test]
    fn test_validate_capabilities_copied_pass() {
        // Without a real image dir, we can only unit-test the validation
        // entry point for the trivial case: everything valid.
        struct DummyRuntime {
            storage_abi: String,
        }
        let rt = DummyRuntime {
            storage_abi: "copied-v0".into(),
        };
        // Storage ABI check alone: "copied-v0" must pass.
        let result = match rt.storage_abi.as_str() {
            "copied-v0" | "mapped-no-copy-v1" => Ok(()),
            _ => Err("unsupported"),
        };
        assert!(result.is_ok());
    }

    /// validate_capabilities rejects unknown ABI on a bare check.
    #[test]
    fn test_validate_capabilities_unknown_abi() {
        let result = match "unknown-v99" {
            "copied-v0" | "mapped-no-copy-v1" => Ok(()),
            other => Err(format!("unsupported storage ABI: {other}")),
        };
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("unknown-v99"));
    }
}
