//! ModelRuntime — persistent store handle for an installed ComputeImage.
//!
//! Separates compilation from inference lifecycle. A ModelRuntime owns the
//! opened ComputeImage metadata (manifest, execution plan, segment index)
//! without reading tensor bytes into memory. Segment files are opened and
//! their handles retained for later mmap by the execution kernel.

use std::collections::HashMap;
use std::fs::File;
use std::path::{Path, PathBuf};

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

/// Lightweight handle to an installed ComputeImage.
///
/// Opening validates the manifest and execution plan, then opens every segment
/// file to obtain file handles. Actual tensor bytes are NOT read — the runtime
/// caller maps segments on demand via mmap or sequential read.
pub struct ModelRuntime {
    manifest: Manifest,
    /// Cached pointer into manifest for ergonomic access.
    execution_plan: ModelExecutionPlan,
    /// image_dir path for constructing full segment paths at open time.
    image_dir: PathBuf,
    /// Open file handles keyed by segment id, with the original path preserved
    /// for mmap-base d access.
    segments: HashMap<String, (PathBuf, File)>,
    /// Whether the runtime holds valid open segment handles.
    open: bool,
}

impl std::fmt::Debug for ModelRuntime {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ModelRuntime")
            .field("image_dir", &self.image_dir)
            .field("segment_count", &self.segments.len())
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
    ///   3. Segment files — opens every segment listed in the manifest.
    ///
    /// Returns an error if the manifest cannot be read, the plan is invalid,
    /// or any segment file is missing/unreadable.
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

        Ok(Self {
            manifest,
            execution_plan,
            image_dir: image_dir.to_path_buf(),
            segments,
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

    /// The image directory path.
    pub fn image_dir(&self) -> &Path {
        &self.image_dir
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

    /// Close all segment handles and mark the runtime as closed.
    ///
    /// Idempotent — safe to call multiple times. After close, `is_open()`
    /// returns `false` and `segment_handle()` returns `None`.
    pub fn close(&mut self) {
        self.segments.clear();
        self.open = false;
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
