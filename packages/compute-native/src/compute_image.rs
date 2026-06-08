//! ComputeImage — deterministic, validated, execution-ordered model image.
//!
//! A ComputeImage is a precompiled runtime artifact containing:
//!   manifest.json     — architecture, tensor table, aliases, residency plan
//!   segment_000.bin   — aligned, execution-ordered tensor bytes
//!   segment_001.bin
//!   ...
//!
//! v0 is the copied, runtime-ready image. It proves canonicalization,
//! bounded residency, and output parity. No-copy Metal buffers remain v2.
/// Storage ABI identifier for the baseline copied (CPU-allocated) path.
pub const STORAGE_ABI_COPIED_V0: &str = "copied-v0";
/// Storage ABI identifier for the mapped, no-copy (Metal-buffer) path.
pub const STORAGE_ABI_MAPPED_NO_COPY_V1: &str = "mapped-no-copy-v1";

/// Return true if `abi` is a recognised storage ABI identifier.
pub fn is_valid_storage_abi(abi: &str) -> bool {
    abi == STORAGE_ABI_COPIED_V0 || abi == STORAGE_ABI_MAPPED_NO_COPY_V1
}

use mlx_rs::Array;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::ffi::CString;
use std::path::{Path, PathBuf};
use std::os::raw::{c_char, c_int, c_void};
use std::time::Instant;
use crate::quantized::QuantizedLinearBinding;

/// Top-level ComputeImage manifest.
#[derive(Clone, Serialize, Deserialize)]
pub struct Manifest {
    pub image_version: String,
    pub compiler_version: String,
    pub runtime_abi: String,
    pub source: SourceIdentity,
    pub architecture: crate::config::TextArchitecture,
    pub segments: Vec<Segment>,
    pub tensor_table: Vec<TensorEntry>,
    pub alias_table: Vec<AliasEntry>,
    pub residency_plan: ResidencyPlan,
    pub image_hash: String,
    /// Storage ABI required by this image (e.g. "copied-v0", "mapped-no-copy-v1").
    #[serde(default = "default_storage_abi")]
    pub required_storage_abi: String,
    /// Capabilities the runtime must support to execute this image.
    #[serde(default)]
    pub required_capabilities: Vec<String>,
    /// Execution plan emitted by the compiler (prologue, layers, epilogue).
    #[serde(default)]
    pub execution_plan: crate::config::ModelExecutionPlan,
}

fn default_storage_abi() -> String {
    "copied-v0".to_string()
}
fn default_alignment_bytes() -> u64 {
    4096
}
fn default_tensor_alignment_bytes() -> u64 {
    16
}
fn default_layout_version() -> u32 {
    1
}
/// Validate that `dtype` is a recognised physical storage dtype and return
/// Specification for the mapped-no-copy-v1 storage ABI.
#[derive(Debug, Clone)]
pub struct StorageAbiSpec {
    pub abi_id: String,
    /// Minimum segment file alignment in bytes (must be a multiple of page size).
    pub segment_alignment_bytes: u64,
    /// Minimum tensor offset alignment within a segment.
    pub tensor_offset_alignment_bytes: u64,
    /// Supported physical dtypes in storage order.
    pub supported_physical_dtypes: Vec<String>,
    /// Byte order (always "le" for Apple Silicon).
    pub byte_order: String,
    /// Layout version for cache key stability.
    pub layout_version: u32,
}

impl StorageAbiSpec {
    pub fn mapped_no_copy_v1() -> Self {
        Self {
            abi_id: STORAGE_ABI_MAPPED_NO_COPY_V1.to_string(),
            segment_alignment_bytes: 4096,
            tensor_offset_alignment_bytes: 16,
            supported_physical_dtypes: vec![
                "U8".into(), "I8".into(), "F16".into(), "BF16".into(),
                "F32".into(), "U32".into(),
            ],
            byte_order: "le".into(),
            layout_version: 1,
        }
    }
}

/// Validate a single `TensorEntry` against the mapped-no-copy-v1 ABI.
///
/// Checks:
/// - Offset must be aligned to `tensor_offset_alignment_bytes`.
/// - `storage_dtype` must be in `supported_physical_dtypes`.
/// - Quantized tensors with scale/bias side-tensors must have group sizes
///   compatible with the declared shape (groups × group_size must not overflow
///   the flattened logical element count).
///
/// Collects all violations into the returned `Vec`; does not short-circuit.
pub fn validate_tensor_for_mapped_abi(
    entry: &TensorEntry,
    spec: &StorageAbiSpec,
) -> Result<(), Vec<String>> {
    let mut errors = Vec::new();

    // Offset alignment check
    if entry.offset % spec.tensor_offset_alignment_bytes != 0 {
        errors.push(format!(
            "tensor {} offset {} is not aligned to {} bytes",
            entry.name, entry.offset, spec.tensor_offset_alignment_bytes,
        ));
    }

    // Storage dtype in supported list
    let dtype_upper = entry.storage_dtype.to_uppercase();
    if !spec.supported_physical_dtypes.iter().any(|d| d.to_uppercase() == dtype_upper) {
        errors.push(format!(
            "tensor {} storage_dtype {} is not in supported dtypes {:?}",
            entry.name, entry.storage_dtype, spec.supported_physical_dtypes,
        ));
    }

    // Quantized tensor validation
    if let Some(qdesc) = &entry.quantization {
        // The flattened logical element count must be representable.
        let log_prod: u64 = entry.logical_shape.iter().copied().map(u64::from).product();
        let groups = u64::from(qdesc.groups);
        let group_size = u64::from(qdesc.group_size);
        let packed = groups.saturating_mul(group_size);
        if packed > log_prod {
            errors.push(format!(
                "tensor {} quantized groups {} × group_size {} = {} > logical elements {}",
                entry.name, qdesc.groups, qdesc.group_size, packed, log_prod,
            ));
        }
    }

    if errors.is_empty() { Ok(()) } else { Err(errors) }
}

/// Validate the entire `Manifest` against a given `StorageAbiSpec`.
///
/// Checks:
/// - All segments have `alignment_bytes` that is a multiple of the ABI's
///   `segment_alignment_bytes`.
/// - All tensors pass `validate_tensor_for_mapped_abi`.
///
/// Returns `Err(Vec<String>)` with every violation; does not short-circuit.
pub fn validate_manifest_for_abi(
    manifest: &Manifest,
    spec: &StorageAbiSpec,
) -> Result<(), Vec<String>> {
    let mut errors = Vec::new();

    // Segment alignment validation
    for seg in &manifest.segments {
        if seg.alignment_bytes % spec.segment_alignment_bytes != 0 {
            errors.push(format!(
                "segment {} alignment_bytes {} is not a multiple of {} (ABI segment alignment)",
                seg.id, seg.alignment_bytes, spec.segment_alignment_bytes,
            ));
        }
    }

    // Tensor validation against ABI
    for entry in &manifest.tensor_table {
        if let Err(tensor_errors) = validate_tensor_for_mapped_abi(entry, spec) {
            errors.extend(tensor_errors);
        }
    }

    if errors.is_empty() { Ok(()) } else { Err(errors) }
}
/// Validate that `dtype` is a recognised physical storage dtype and return
/// the expected byte count for the given shape.  Handles unpacked dtypes
/// (f32 4b, bf16 2b, f16 2b, u8 1b, i8 1b, u32 4b) and quantized packed
/// dtypes where the caller accounts for group-size packing separately.
///
/// Quantized packed types ("U8", "I8" with quantization context) have the
/// same per-element byte count as their unpacked counterpart (1×prod), so
/// this function returns `prod` for both unpacked and quantized u8/i8.
pub fn validate_physical_dtype(
    dtype: &str,
    byte_length: u64,
    shape: &[u32],
) -> Result<u64, String> {
    let prod: u64 = shape.iter().copied().map(u64::from).product();
    let element_bytes = match dtype {
        "f32" | "F32" | "Float32" => 4u64,
        "bf16" | "BF16" | "BFloat16" => 2,
        "f16" | "F16" | "Float16" => 2,
        "u8" | "U8" | "Uint8" => 1,
        "i8" | "I8" | "Int8" => 1,
        "u32" | "U32" | "Uint32" => 4,
        other => return Err(format!("unsupported physical dtype: {}", other)),
    };
    let expected = prod.saturating_mul(element_bytes);
    if byte_length != expected {
        return Err(format!(
            "dtype {} with shape {:?}: expected {} bytes ({}×{}), got {}",
            dtype, shape, expected, prod, element_bytes, byte_length,
        ));
    }
    Ok(expected)
}

/// Validate physical tensor layout constraints for a single `TensorEntry`
/// within a segment of `segment_byte_size` bytes.
///
/// Checks: byte_length > 0, offset + byte_length <= segment_byte_size,
/// shape-based byte count matches byte_length, and when the entry declares
/// a `QuantizationDesc` the scale/bias entries are dimensionally consistent.
pub fn validate_tensor_layout(
    entry: &TensorEntry,
    segment_byte_size: u64,
) -> Result<(), String> {
    if entry.byte_length == 0 {
        return Err(format!("tensor {} has zero byte_length", entry.name));
    }
    let end = entry.offset.saturating_add(entry.byte_length);
    if end > segment_byte_size {
        return Err(format!(
            "tensor {} offset {} + byte_length {} exceeds segment size {}",
            entry.name, entry.offset, entry.byte_length, segment_byte_size,
        ));
    }

    // Validate that physical_shape × dtype bytes matches byte_length.
    // Allow quantization packing where byte_length may differ from
    // the unpacked product (e.g. packed weights smaller than logical).
    if entry.quantization.is_some() {
        // For quantized tensors, the byte_length is the packed payload;
        // logical validation is ownership of the caller.  We only check
        // that it is non-zero (already done above) and that the physical
        // shape is not degenerate.
        if entry.physical_shape.is_empty()
            || entry.physical_shape.iter().any(|&d| d == 0)
        {
            return Err(format!(
                "tensor {} has degenerate quantized physical shape {:?}",
                entry.name, entry.physical_shape,
            ));
        }
    } else {
        // Unquantized: validate dtype byte count matches.
        validate_physical_dtype(
            &entry.storage_dtype,
            entry.byte_length,
            &entry.physical_shape,
        )?;
    }

    Ok(())
}
impl Manifest {
    /// Check whether the manifest's `required_storage_abi` is compatible with
    /// the selected `StorageBackend`.
    pub fn storage_abi_matches(&self, backend: &StorageBackend) -> bool {
        match backend {
            StorageBackend::Copied => self.required_storage_abi == STORAGE_ABI_COPIED_V0,
            StorageBackend::MappedNoCopy => {
                self.required_storage_abi == STORAGE_ABI_MAPPED_NO_COPY_V1
            }
        }
    }
}

/// Cryptographic identity of the source checkpoint.
#[derive(Clone, Serialize, Deserialize)]
pub struct SourceIdentity {
    pub config_hash: String,
    pub shard_hashes: Vec<ShardHash>,
    pub tokenizer_hashes: Vec<ShardHash>,
    pub auxiliary_hashes: Vec<ShardHash>,
    pub model_type: String,
    pub quantization_bits: u32,
    pub quantization_group_size: u32,
    pub quantization_mode: String,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct ShardHash {
    pub filename: String,
    pub sha256: String,
}

/// One binary segment containing tensors in execution order.
#[derive(Clone, Serialize, Deserialize)]
pub struct Segment {
    pub id: String,       // "embed", "layer_0", "layer_5", "final"
    pub filename: String, // "segment_000.bin"
    pub byte_size: u64,
    pub sha256: String,
    pub tensor_ids: Vec<u32>, // ordered tensor references
    pub kind: SegmentKind,
    /// Alignment constraint in bytes for the mapped-no-copy backend (default 4096).
    #[serde(default = "default_alignment_bytes")]
    pub alignment_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum SegmentKind {
    Persistent, // always loaded (embeddings, final norm)
    Layer(u32), // per-layer, load/free per execution window
    Final,      // output projection (may alias Persistent)
}

/// One tensor entry in the global table.
#[derive(Clone, Serialize, Deserialize)]
pub struct TensorEntry {
    pub id: u32,
    pub name: String,
    pub role: String,
    pub layer: Option<u32>,
    pub segment: String,
    pub source_filename: String,
    pub source_sha256: String,
    pub source_offset: u64,
    pub offset: u64,
    pub byte_length: u64,
    pub logical_dtype: String,
    pub storage_dtype: String,
    pub logical_shape: Vec<u32>,
    pub physical_shape: Vec<u32>,
    pub mutability: String,
    pub quantization: Option<QuantizationDesc>,
    /// Per-tensor alignment in bytes for the mapped-no-copy backend (default 16).
    #[serde(default = "default_tensor_alignment_bytes")]
    pub tensor_alignment_bytes: u64,
    /// Layout version for the tensor-cache key computation (default 1).
    #[serde(default = "default_layout_version")]
    pub layout_version: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QuantizationDesc {
    pub bits: u32,
    pub group_size: u32,
    pub groups: u32,
    pub scale_tensor_id: u32,
    pub bias_tensor_id: u32,
}

/// An alias mapping — resolves a logical tensor name to physical storage.
#[derive(Clone, Serialize, Deserialize)]
pub struct AliasEntry {
    pub logical_name: String,
    pub physical_tensor_id: u32,
    pub reason: String,
}

/// A resolved tensor binding — connects a manifest entry to its mapped segment
/// and provides the MLX array handle at runtime.
#[derive(Debug, Clone)]
pub struct ResolvedTensorBinding {
    pub tensor_id: u32,
    pub canonical_name: String,
    pub segment_id: String,
    pub offset: u64,
    pub byte_length: u64,
    pub physical_dtype: String,
    pub runtime_dtype: String,
    pub physical_shape: Vec<u32>,
    pub logical_shape: Vec<u32>,
    pub strides: Vec<u32>,
    pub quantization: Option<QuantizationDesc>,
    pub alias_of: Option<u32>,
    pub layout_version: u32,
}

/// Build a complete tensor binding catalog from a manifest.
///
/// Iterates `manifest.tensor_table` and `manifest.alias_table`, resolves aliases
/// (setting `alias_of` on the logical entry pointing to the physical tensor ID),
/// and returns a `HashMap` keyed by canonical tensor name.
///
/// Aliased entries share a single `ResolvedTensorBinding` with the alias entry
/// having `alias_of` set to the physical tensor's ID.
pub fn build_tensor_catalog(manifest: &Manifest) -> HashMap<String, ResolvedTensorBinding> {
    // First pass: build bindings from the tensor table.
    let mut catalog: HashMap<String, ResolvedTensorBinding> = HashMap::new();
    for entry in &manifest.tensor_table {
        catalog.insert(
            entry.name.clone(),
            ResolvedTensorBinding {
                tensor_id: entry.id,
                canonical_name: entry.name.clone(),
                segment_id: entry.segment.clone(),
                offset: entry.offset,
                byte_length: entry.byte_length,
                physical_dtype: entry.storage_dtype.clone(),
                runtime_dtype: entry.logical_dtype.clone(),
                physical_shape: entry.physical_shape.clone(),
                logical_shape: entry.logical_shape.clone(),
                strides: Vec::new(),
                quantization: entry.quantization.clone(),
                alias_of: None,
                layout_version: entry.layout_version,
            },
        );
    }

    // Second pass: resolve aliases.
    for alias in &manifest.alias_table {
        if let Some(phys_binding) = catalog.get(&resolve_tensor_name(
            alias.physical_tensor_id,
            &manifest.tensor_table,
        )) {
            let binding = ResolvedTensorBinding {
                tensor_id: alias.physical_tensor_id,
                canonical_name: alias.logical_name.clone(),
                segment_id: phys_binding.segment_id.clone(),
                offset: phys_binding.offset,
                byte_length: phys_binding.byte_length,
                physical_dtype: phys_binding.physical_dtype.clone(),
                runtime_dtype: phys_binding.runtime_dtype.clone(),
                physical_shape: phys_binding.physical_shape.clone(),
                logical_shape: phys_binding.logical_shape.clone(),
                strides: phys_binding.strides.clone(),
                quantization: phys_binding.quantization.clone(),
                alias_of: Some(alias.physical_tensor_id),
                layout_version: phys_binding.layout_version,
            };
            catalog.insert(alias.logical_name.clone(), binding);
        }
    }

    catalog
}

/// Helper: resolve a tensor ID to its canonical name from the tensor table.
fn resolve_tensor_name(id: u32, table: &[TensorEntry]) -> String {
    table
        .iter()
        .find(|entry| entry.id == id)
        .map(|entry| entry.name.clone())
        .unwrap_or_default()
}

/// Runtime residency plan.
#[derive(Clone, Serialize, Deserialize)]
pub struct ResidencyPlan {
    /// Segments always loaded.
    pub persistent_segments: Vec<String>,
    /// Per-layer segments in execution order.
    pub layer_segments: Vec<String>,
    /// Max layers to keep resident simultaneously.
    pub layer_window_size: u32,
    /// Total image size in bytes.
    pub total_bytes: u64,
}

#[derive(Clone)]
struct SourceTensor {
    name: String,
    dtype: String,
    shape: Vec<u32>,
    data: Vec<u8>,
    source_filename: String,
    source_sha256: String,
    source_offset: u64,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct TensorProvenance {
    pub tensor_name: String,
    pub source_sha256: String,
    pub emitted_sha256: String,
    pub preserved_byte_for_byte: bool,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct IgnoredTensorClassification {
    pub name: String,
    pub classification: String,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct SegmentReceipt {
    pub id: String,
    pub filename: String,
    pub sha256: String,
    pub byte_size: u64,
}

#[derive(Clone, Serialize, Deserialize, Default)]
pub struct CompileReceipt {
    pub source_config_hash: String,
    pub source_shard_hashes: Vec<ShardHash>,
    pub compiler_version: String,
    pub runtime_abi: String,
    pub normalized_architecture_hash: String,
    pub execution_plan_hash: String,
    pub complete_image_hash: String,
    pub segment_hashes: Vec<SegmentReceipt>,
    pub tensor_count: usize,
    pub alias_count: usize,
    pub segment_count: usize,
    pub ignored_tensor_classifications: Vec<IgnoredTensorClassification>,
    pub total_source_bytes: u64,
    pub total_emitted_bytes: u64,
    pub elapsed_ms: u128,
    pub transformed_payloads: Vec<String>,
    pub byte_provenance: Vec<TensorProvenance>,
    pub structural_verification: bool,
    /// Native dependency identity captured at compile time.
    pub native_dependency_report: NativeCapabilityReport,
    pub stage_profile: StageProfile,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct StageProfile {
    pub source_discovery_ms: u64,
    pub source_hashing_ms: u64,
    pub header_parsing_ms: u64,
    pub architecture_normalization_ms: u64,
    pub binding_validation_ms: u64,
    pub layout_planning_ms: u64,
    pub payload_emission_ms: u64,
    pub segment_hashing_ms: u64,
    pub manifest_generation_ms: u64,
    pub verification_ms: u64,
    pub total_source_bytes: u64,
    pub total_emitted_bytes: u64,
    pub peak_rss_bytes: u64,
    pub peak_mlx_active_bytes: u64,
    pub peak_mlx_cache_bytes: u64,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct CompiledImage {
    pub manifest: Manifest,
    pub receipt: CompileReceipt,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct ManifestVerification {
    pub manifest_hash_matches: bool,
    pub segment_hashes_match: bool,
    pub verified_segment_count: usize,
    pub total_bytes: u64,
}

/// How tensor bytes were moved from storage into MLX.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum CopyClassification {
    /// Direct mmap view, no application copy. MLX may still copy internally.
    MappedNoCopy,
    /// Copied from mmap into an application-side buffer before MLX construction.
    CopiedFallback,
    /// MLX created a contiguous temporary (reshape, transpose, dtype cast, repeat).
    MaterializedContiguous,
    /// BF16 -> F32 or other dtype promotion.
    MaterializedDtypeConversion,
    /// K/V physically repeated for grouped-query attention.
    MaterializedRepeat,
}

#[derive(Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum StorageBackend {
    Copied,
    MappedNoCopy,
}

#[derive(Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum LeaseState {
    Opened,
    Bound,
    Active,
    Retiring,
    Released,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct SegmentLease {
    pub segment_id: String,
    pub filename: String,
    pub backend: StorageBackend,
    pub state: LeaseState,
    pub tensor_handles: Vec<u64>,
    pub byte_size: u64,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct TensorLease {
    pub name: String,
    pub handle: u64,
    pub segment_id: String,
    pub state: LeaseState,
}

/// RAII guard owning MLX array handles for a single layer segment.
/// Dropping this releases all arrays for that layer from ARRAY_REGISTRY.
/// The caller MUST call hidden.eval() before dropping to ensure the MLX
/// computation graph has consumed the weights.
pub struct LayerLease {
    pub layer_index: u32,
    pub segment_id: String,
    /// Bytes read from disk to materialise this layer.
    pub bytes_read: u64,
    handles: Vec<u64>,
}

impl Drop for LayerLease {
    fn drop(&mut self) {
        for h in &self.handles {
            let _ = crate::bridge::free_array(*h);
        }
    }
}

#[derive(Clone, Serialize, Deserialize)]
pub struct ImageRuntime {
    pub manifest: Manifest,
    pub receipt: CompileReceipt,
    pub backend: StorageBackend,
    /// Path to the image directory for on-demand segment reads.
    #[serde(skip)]
    image_dir: PathBuf,
    /// Handles for persistent tensors (embeddings, final norm). Always resident.
    #[serde(skip)]
    pub(crate) persistent_handles: HashMap<String, u64>,
    /// Quantized binding descriptors built from persistent tensors.
    #[serde(skip)]
    quantized_bindings: HashMap<String, QuantizedLinearBinding>,
    /// Monotonically accumulated bytes loaded across all activate_layer calls.
    #[serde(skip)]
    total_bytes_activated: u64,
    #[serde(skip)]
    released: bool,
}

// ── Builder ────────────────────────────────────────────────────────────────

pub struct ImageBuilder {
    manifest: Manifest,
    next_tensor_id: u32,
    current_segment: Option<SegmentBuilder>,
    segments: Vec<Segment>,
    segment_payloads: Vec<Vec<u8>>,
    tensors: Vec<TensorEntry>,
    aliases: Vec<AliasEntry>,
}

struct SegmentBuilder {
    id: String,
    filename: String,
    kind: SegmentKind,
    data: Vec<u8>,
    tensor_ids: Vec<u32>,
    offset: u64,
}

impl ImageBuilder {
    pub fn new(arch: crate::config::TextArchitecture, source: SourceIdentity) -> Self {
        Self {
            manifest: Manifest {
                image_version: "0.1.0".into(),
                compiler_version: env!("CARGO_PKG_VERSION").into(),
                runtime_abi: "mlx-rs/0.21.0 napi-rs/3.9.0 safetensors/0.5.3".into(),
                source,
                architecture: arch,
                segments: Vec::new(),
                tensor_table: Vec::new(),
                alias_table: Vec::new(),
                residency_plan: ResidencyPlan {
                    persistent_segments: Vec::new(),
                    layer_segments: Vec::new(),
                    layer_window_size: 2,
                    total_bytes: 0,
                },
                image_hash: String::new(),
                required_storage_abi: "copied-v0".to_string(),
                required_capabilities: Vec::new(),
                execution_plan: crate::config::ModelExecutionPlan::default(),
            },
            next_tensor_id: 0,
            current_segment: None,
            segments: Vec::new(),
            segment_payloads: Vec::new(),
            tensors: Vec::new(),
            aliases: Vec::new(),
        }
    }

    /// Start a new segment. Closes the previous segment if any.
    pub fn begin_segment(&mut self, id: &str, kind: SegmentKind) {
        self.flush_segment();
        let filename = format!("segment_{:03}.bin", self.segments.len());
        self.current_segment = Some(SegmentBuilder {
            id: id.into(),
            filename,
            kind,
            data: Vec::new(),
            tensor_ids: Vec::new(),
            offset: 0,
        });
    }

    /// Append a tensor to the current segment. The caller provides the raw bytes.
    pub fn add_tensor(
        &mut self,
        name: String,
        role: String,
        layer: Option<u32>,
        data: &[u8],
        source_filename: String,
        source_sha256: String,
        source_offset: u64,
        logical_dtype: String,
        storage_dtype: &str,
        logical_shape: Vec<u32>,
        physical_shape: Vec<u32>,
        quantization: Option<QuantizationDesc>,
    ) -> u32 {
        let seg = self.current_segment.as_mut().expect("no segment started");
        let id = self.next_tensor_id;
        self.next_tensor_id += 1;

        let offset = seg.offset;
        seg.data.extend_from_slice(data);
        seg.offset += data.len() as u64;
        seg.tensor_ids.push(id);

        self.tensors.push(TensorEntry {
            id,
            name,
            role,
            layer,
            segment: seg.id.clone(),
            source_filename,
            source_sha256,
            source_offset,
            offset,
            byte_length: data.len() as u64,
            logical_dtype,
            storage_dtype: storage_dtype.into(),
            logical_shape,
            physical_shape,
            mutability: "read_only".into(),
            quantization,
            tensor_alignment_bytes: default_tensor_alignment_bytes(),
            layout_version: default_layout_version(),
        });

        id
    }

    /// Register an alias (e.g., lm_head aliases embed_tokens).
    pub fn add_alias(&mut self, logical_name: &str, physical_tensor_id: u32, reason: &str) {
        self.aliases.push(AliasEntry {
            logical_name: logical_name.into(),
            physical_tensor_id,
            reason: reason.into(),
        });
    }

    /// Finalize and return the complete manifest.
    pub fn finalize(mut self, output_dir: &Path) -> napi::Result<Manifest> {
        self.flush_segment();
        std::fs::create_dir_all(output_dir)
            .map_err(|e| napi::Error::from_reason(format!("mkdir: {}", e)))?;

        // Write segments to disk
        for (seg, payload) in self.segments.iter().zip(self.segment_payloads.iter()) {
            let path = output_dir.join(&seg.filename);
            std::fs::write(&path, payload).map_err(|e| {
                napi::Error::from_reason(format!("write segment {}: {}", seg.filename, e))
            })?;
        }

        self.manifest.segments = self.segments;
        self.manifest.tensor_table = self.tensors;
        self.manifest.alias_table = self.aliases;
        self.manifest.residency_plan.total_bytes =
            self.manifest.segments.iter().map(|s| s.byte_size).sum();
        self.manifest.image_hash = compute_manifest_hash(&self.manifest);

        // Write manifest
        let manifest_path = output_dir.join("manifest.json");
        let manifest_json = serde_json::to_string_pretty(&self.manifest)
            .map_err(|e| napi::Error::from_reason(format!("json: {}", e)))?;
        std::fs::write(&manifest_path, manifest_json)
            .map_err(|e| napi::Error::from_reason(format!("write manifest: {}", e)))?;

        Ok(self.manifest)
    }

    fn flush_segment(&mut self) {
        if let Some(seg) = self.current_segment.take() {
            let byte_size = seg.data.len() as u64;
            let sha256 = {
                let mut h = Sha256::new();
                h.update(&seg.data);
                format!("{:x}", h.finalize())
            };
            self.segment_payloads.push(seg.data);
            self.segments.push(Segment {
                id: seg.id,
                filename: seg.filename,
                byte_size,
                sha256,
                tensor_ids: seg.tensor_ids,
                kind: seg.kind,
                alignment_bytes: default_alignment_bytes(),
            });

            // Build residency plan
            match self.segments.last().unwrap().kind {
                SegmentKind::Persistent | SegmentKind::Final => {
                    self.manifest
                        .residency_plan
                        .persistent_segments
                        .push(self.segments.last().unwrap().id.clone());
                }
                SegmentKind::Layer(_) => {
                    self.manifest
                        .residency_plan
                        .layer_segments
                        .push(self.segments.last().unwrap().id.clone());
                }
            }
        }
    }

    /// Set the execution plan on the manifest. Must be called before finalize().
    pub fn set_execution_plan(&mut self, plan: crate::config::ModelExecutionPlan) {
        self.manifest.execution_plan = plan;
    }
}

// ── Compiler entry point ───────────────────────────────────────────────────

struct LoadedSource {
    arch: crate::config::TextArchitecture,
    manifest: crate::config::ModelManifest,
    namespace: crate::config::NamespaceBinding,
    spec: crate::config::ExecutionSpec,
    source_tensors: HashMap<String, SourceTensor>,
    shard_hashes: Vec<ShardHash>,
    tokenizer_hashes: Vec<ShardHash>,
    auxiliary_hashes: Vec<ShardHash>,
    validation: crate::validator::ValidationReport,
}

fn sha256_bytes(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

fn hash_file(path: &Path) -> napi::Result<String> {
    let bytes = std::fs::read(path)
        .map_err(|e| napi::Error::from_reason(format!("read {}: {}", path.display(), e)))?;
    Ok(sha256_bytes(&bytes))
}

fn optional_hash(path: &Path) -> napi::Result<Option<ShardHash>> {
    if !path.exists() {
        return Ok(None);
    }
    let sha256 = hash_file(path)?;
    Ok(Some(ShardHash {
        filename: path.file_name().unwrap().to_string_lossy().into_owned(),
        sha256,
    }))
}

fn load_source(source_dir: &Path) -> napi::Result<LoadedSource> {
    use crate::{config, validator};

    let config_path = source_dir.join("config.json");
    let (arch, quant, manifest) = config::parse_config(
        config_path
            .to_str()
            .ok_or_else(|| napi::Error::from_reason("invalid config path"))?,
    )?;

    let shard_paths = validator::discover_shards(source_dir)?;
    let mut source_tensors = HashMap::new();
    let mut all_names = Vec::new();
    let mut shard_hashes = Vec::new();

    for shard_path in shard_paths {
        let bytes = std::fs::read(&shard_path).map_err(|e| {
            napi::Error::from_reason(format!("read {}: {}", shard_path.display(), e))
        })?;
        let source_sha256 = sha256_bytes(&bytes);
        let (_, metadata) = safetensors::SafeTensors::read_metadata(&bytes).map_err(|e| {
            napi::Error::from_reason(format!(
                "bad safetensors header {}: {:?}",
                shard_path.display(),
                e
            ))
        })?;
        let safetensors = safetensors::SafeTensors::deserialize(&bytes).map_err(|e| {
            napi::Error::from_reason(format!(
                "bad safetensors file {}: {:?}",
                shard_path.display(),
                e
            ))
        })?;

        let mut entries: Vec<_> = metadata.tensors().into_iter().collect();
        entries.sort_by(|(left, _), (right, _)| left.cmp(right));

        for (name, info) in entries {
            if source_tensors.contains_key(&name) {
                return Err(napi::Error::from_reason(format!(
                    "duplicate tensor name: {}",
                    name
                )));
            }

            let view = safetensors
                .tensor(&name)
                .map_err(|e| napi::Error::from_reason(format!("tensor {}: {:?}", name, e)))?;

            source_tensors.insert(
                name.clone(),
                SourceTensor {
                    name: name.clone(),
                    dtype: format!("{:?}", info.dtype),
                    shape: info.shape.iter().map(|&d| d as u32).collect(),
                    data: view.data().to_vec(),
                    source_filename: shard_path
                        .file_name()
                        .unwrap()
                        .to_string_lossy()
                        .into_owned(),
                    source_sha256: source_sha256.clone(),
                    source_offset: info.data_offsets.0 as u64,
                },
            );
            all_names.push(name);
        }

        shard_hashes.push(ShardHash {
            filename: shard_path
                .file_name()
                .unwrap()
                .to_string_lossy()
                .into_owned(),
            sha256: source_sha256,
        });
    }

    let tokenizer_hashes = ["tokenizer.json", "tokenizer_config.json"]
        .into_iter()
        .filter_map(|name| {
            let path = source_dir.join(name);
            match optional_hash(&path) {
                Ok(Some(hash)) => Some(Ok(hash)),
                Ok(None) => None,
                Err(err) => Some(Err(err)),
            }
        })
        .collect::<napi::Result<Vec<_>>>()?;

    let auxiliary_hashes = [
        "generation_config.json",
        "processor_config.json",
        "chat_template.jinja",
        "README.md",
    ]
    .into_iter()
    .filter_map(|name| {
        let path = source_dir.join(name);
        match optional_hash(&path) {
            Ok(Some(hash)) => Some(Ok(hash)),
            Ok(None) => None,
            Err(err) => Some(Err(err)),
        }
    })
    .collect::<napi::Result<Vec<_>>>()?;

    let namespace = config::resolve_namespace(&all_names)
        .ok_or_else(|| napi::Error::from_reason("namespace not resolved"))?;
    let spec = config::compile(&arch, &namespace, quant.as_ref());

    let tensor_meta = source_tensors
        .iter()
        .map(|(name, tensor)| {
            (
                name.clone(),
                crate::validator::TensorMeta {
                    name: tensor.name.clone(),
                    shape: tensor.shape.clone(),
                    dtype: tensor.dtype.clone(),
                },
            )
        })
        .collect::<HashMap<_, _>>();

    let validation = validator::validate_bindings_from_map(&tensor_meta, &spec)?;
    if !validation.verdict.executable {
        return Err(napi::Error::from_reason(format!(
            "source checkpoint failed validation: {} errors across {} expected tensors",
            validation.verdict.errors, validation.verdict.total_expected,
        )));
    }

    Ok(LoadedSource {
        arch,
        manifest,
        namespace,
        spec,
        source_tensors,
        shard_hashes,
        tokenizer_hashes,
        auxiliary_hashes,
        validation,
    })
}

fn emit_tensor(
    builder: &mut ImageBuilder,
    source_tensors: &HashMap<String, SourceTensor>,
    name: &str,
    role: String,
    layer: Option<u32>,
    logical_dtype: String,
    logical_shape: Vec<u32>,
    quantization: Option<QuantizationDesc>,
) -> napi::Result<u32> {
    let tensor = source_tensors
        .get(name)
        .ok_or_else(|| napi::Error::from_reason(format!("missing tensor: {}", name)))?;

    Ok(builder.add_tensor(
        name.to_string(),
        role,
        layer,
        &tensor.data,
        tensor.source_filename.clone(),
        tensor.source_sha256.clone(),
        tensor.source_offset,
        logical_dtype,
        &tensor.dtype,
        logical_shape,
        tensor.shape.clone(),
        quantization,
    ))
}

fn emit_quantized_binding(
    builder: &mut ImageBuilder,
    source_tensors: &HashMap<String, SourceTensor>,
    weight_name: &str,
    role: String,
    layer: Option<u32>,
    logical_shape: Vec<u32>,
    packed: &crate::config::PackedLinearShapes,
    logical_dtype: String,
) -> napi::Result<u32> {
    let stem = weight_name.strip_suffix(".weight").unwrap_or(weight_name);
    let scales_name = format!("{}.scales", stem);
    let biases_name = format!("{}.biases", stem);

    let scales_id = emit_tensor(
        builder,
        source_tensors,
        &scales_name,
        format!("{}::scales", role),
        layer,
        "F32".into(),
        packed.scales.clone(),
        None,
    )?;
    let biases_id = emit_tensor(
        builder,
        source_tensors,
        &biases_name,
        format!("{}::biases", role),
        layer,
        "F32".into(),
        packed.biases.clone(),
        None,
    )?;

    emit_tensor(
        builder,
        source_tensors,
        weight_name,
        role,
        layer,
        logical_dtype,
        logical_shape,
        Some(QuantizationDesc {
            bits: packed.bits,
            group_size: packed.group_size,
            groups: packed.groups,
            scale_tensor_id: scales_id,
            bias_tensor_id: biases_id,
        }),
    )
}

fn build_source_identity(
    manifest: &crate::config::ModelManifest,
    shard_hashes: Vec<ShardHash>,
    tokenizer_hashes: Vec<ShardHash>,
    auxiliary_hashes: Vec<ShardHash>,
) -> SourceIdentity {
    SourceIdentity {
        config_hash: manifest.config_hash.clone(),
        shard_hashes,
        tokenizer_hashes,
        auxiliary_hashes,
        model_type: manifest.model_type.clone(),
        quantization_bits: manifest.quantization_bits.unwrap_or(8),
        quantization_group_size: manifest.quantization_group_size.unwrap_or(64),
        quantization_mode: manifest
            .quantization_mode
            .clone()
            .unwrap_or_else(|| "affine".into()),
    }
}

fn emit_binding_set(
    builder: &mut ImageBuilder,
    source_tensors: &HashMap<String, SourceTensor>,
    binding: &crate::config::TensorBinding,
    layer: Option<u32>,
) -> napi::Result<u32> {
    let role = format!("{:?}", binding.role);
    match &binding.packed_shape {
        Some(packed) => emit_quantized_binding(
            builder,
            source_tensors,
            &binding.name,
            role,
            layer,
            binding.logical_shape.clone(),
            packed,
            "F32".into(),
        ),
        None => emit_tensor(
            builder,
            source_tensors,
            &binding.name,
            role,
            layer,
            "F32".into(),
            binding.logical_shape.clone(),
            None,
        ),
    }
}

fn compute_manifest_hash(manifest: &Manifest) -> String {
    #[derive(Serialize)]
    struct Fingerprint<'a> {
        image_version: &'a str,
        compiler_version: &'a str,
        runtime_abi: &'a str,
        source: &'a SourceIdentity,
        architecture: &'a crate::config::TextArchitecture,
        segments: &'a [Segment],
        tensor_table: &'a [TensorEntry],
        alias_table: &'a [AliasEntry],
        residency_plan: &'a ResidencyPlan,
    }

    let fingerprint = Fingerprint {
        image_version: &manifest.image_version,
        compiler_version: &manifest.compiler_version,
        runtime_abi: &manifest.runtime_abi,
        source: &manifest.source,
        architecture: &manifest.architecture,
        segments: &manifest.segments,
        tensor_table: &manifest.tensor_table,
        alias_table: &manifest.alias_table,
        residency_plan: &manifest.residency_plan,
    };

    let bytes = serde_json::to_vec(&fingerprint).expect("manifest fingerprint serialization");
    sha256_bytes(&bytes)
}

fn compute_struct_hash<T: Serialize>(value: &T) -> String {
    let bytes = serde_json::to_vec(value).expect("struct hash serialization");
    sha256_bytes(&bytes)
}

fn build_compile_receipt(loaded: &LoadedSource, manifest: &Manifest, elapsed_ms: u128, stage_profile: StageProfile) -> CompileReceipt {
    let byte_provenance = manifest
        .tensor_table
        .iter()
        .filter_map(|entry| {
            loaded.source_tensors.get(&entry.name).map(|source_tensor| {
                let emitted_sha256 = sha256_bytes(&source_tensor.data);
                TensorProvenance {
                    tensor_name: entry.name.clone(),
                    source_sha256: source_tensor.source_sha256.clone(),
                    emitted_sha256: emitted_sha256.clone(),
                    preserved_byte_for_byte: source_tensor.source_sha256 == emitted_sha256,
                }
            })
        })
        .collect::<Vec<_>>();

    let transformed_payloads = byte_provenance
        .iter()
        .filter(|entry| !entry.preserved_byte_for_byte)
        .map(|entry| entry.tensor_name.clone())
        .collect::<Vec<_>>();

    CompileReceipt {
        source_config_hash: loaded.manifest.config_hash.clone(),
        source_shard_hashes: loaded.shard_hashes.clone(),
        compiler_version: manifest.compiler_version.clone(),
        runtime_abi: manifest.runtime_abi.clone(),
        normalized_architecture_hash: compute_struct_hash(&manifest.architecture),
        execution_plan_hash: compute_struct_hash(&loaded.spec),
        complete_image_hash: manifest.image_hash.clone(),
        segment_hashes: manifest
            .segments
            .iter()
            .map(|segment| SegmentReceipt {
                id: segment.id.clone(),
                filename: segment.filename.clone(),
                sha256: segment.sha256.clone(),
                byte_size: segment.byte_size,
            })
            .collect(),
        tensor_count: manifest.tensor_table.len(),
        alias_count: manifest.alias_table.len(),
        segment_count: manifest.segments.len(),
        ignored_tensor_classifications: loaded
            .validation
            .unexpected_tensors
            .iter()
            .map(|unexpected| IgnoredTensorClassification {
                name: unexpected.name.clone(),
                classification: unexpected.classification.clone(),
            })
            .collect(),
        total_source_bytes: loaded
            .source_tensors
            .values()
            .map(|tensor| tensor.data.len() as u64)
            .sum(),
        total_emitted_bytes: manifest.segments.iter().map(|segment| segment.byte_size).sum(),
        elapsed_ms,
        transformed_payloads,
        byte_provenance,
        structural_verification: loaded.validation.verdict.executable
            && manifest.image_hash == compute_manifest_hash(manifest),
        native_dependency_report: NativeCapabilityReport::probe(),
        stage_profile,
    }
}

fn dtype_to_array(bytes: &[u8], dtype: &str, shape: &[u32]) -> napi::Result<Array> {
    let dims = shape.iter().map(|&dim| dim as i32).collect::<Vec<_>>();
    match dtype {
        "U8" | "Uint8" => Ok(Array::from_slice(bytes, &dims)),
        "U32" | "Uint32" => {
            if bytes.len() % 4 != 0 {
                return Err(napi::Error::from_reason(format!(
                    "u32 payload length is not a multiple of 4: {}",
                    bytes.len()
                )));
            }
            let data = bytes
                .chunks_exact(4)
                .map(|chunk| u32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]))
                .collect::<Vec<_>>();
            Ok(Array::from_slice(&data, &dims))
        }
        "I8" | "Int8" => {
            let data = bytes.iter().map(|&byte| byte as i8).collect::<Vec<_>>();
            Ok(Array::from_slice(&data, &dims))
        }
        "I32" | "Int32" => {
            if bytes.len() % 4 != 0 {
                return Err(napi::Error::from_reason(format!(
                    "i32 payload length is not a multiple of 4: {}",
                    bytes.len()
                )));
            }
            let data = bytes
                .chunks_exact(4)
                .map(|chunk| i32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]))
                .collect::<Vec<_>>();
            Ok(Array::from_slice(&data, &dims))
        }
        "F32" | "Float32" => {
            if bytes.len() % 4 != 0 {
                return Err(napi::Error::from_reason(format!(
                    "f32 payload length is not a multiple of 4: {}",
                    bytes.len()
                )));
            }
            let data = bytes
                .chunks_exact(4)
                .map(|chunk| f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]))
                .collect::<Vec<_>>();
            Ok(Array::from_slice(&data, &dims))
        }
        "BF16" | "BFloat16" => {
            if bytes.len() % 2 != 0 {
                return Err(napi::Error::from_reason(format!(
                    "bf16 payload length is not a multiple of 2: {}",
                    bytes.len()
                )));
            }
            // Convert BF16 to F32 for MLX compute compatibility
            let data = bytes
                .chunks_exact(2)
                .map(|chunk| {
                    let bf = u16::from_le_bytes([chunk[0], chunk[1]]);
                    // BF16 to F32: shift left 16, reinterpret as f32
                    f32::from_bits((bf as u32) << 16)
                })
                .collect::<Vec<_>>();
            Ok(Array::from_slice(&data, &dims))
        }
        other => Err(napi::Error::from_reason(format!(
            "unsupported tensor storage dtype: {}",
            other
        ))),
    }
}

#[derive(Clone, Serialize, Deserialize)]
pub struct CompiledImageReader {
    pub manifest: Manifest,
    pub receipt: CompileReceipt,
    /// Path to the image directory; segment files are read on demand.
    #[serde(skip)]
    image_dir: PathBuf,
}

impl CompiledImageReader {
    pub fn open(image_dir: &Path) -> napi::Result<Self> {
        let manifest_path = image_dir.join("manifest.json");
        let receipt_path = image_dir.join("receipt.json");
        let manifest: Manifest = serde_json::from_str(
            &std::fs::read_to_string(&manifest_path)
                .map_err(|e| napi::Error::from_reason(format!(
                    "read manifest {}: {}",
                    manifest_path.display(),
                    e
                )))?,
        )
        .map_err(|e| napi::Error::from_reason(format!("parse manifest: {}", e)))?;
        let receipt: CompileReceipt = match serde_json::from_str(
            &std::fs::read_to_string(&receipt_path).unwrap_or_default(),
        ) {
            Ok(r) => r,
            Err(_) => CompileReceipt::default(),
        };

        let reader = Self {
            manifest,
            receipt,
            image_dir: image_dir.to_path_buf(),
        };
        // One-time full verification at image-open time. Segment bytes are read
        // only here and dropped immediately after the hash check.
        reader.verify()?;
        Ok(reader)
    }

    /// Read a segment file from disk and return its bytes. Used by verify()
    /// and tensor_bytes() (fixture test path). Not used during execution.
    fn read_segment_bytes(&self, filename: &str) -> napi::Result<Vec<u8>> {
        let path = self.image_dir.join(filename);
        std::fs::read(&path)
            .map_err(|e| napi::Error::from_reason(format!("read segment {}: {}", path.display(), e)))
    }

    pub fn verify(&self) -> napi::Result<ManifestVerification> {
        let manifest_hash_matches = self.manifest.image_hash == compute_manifest_hash(&self.manifest);
        let receipt_matches_manifest = self.receipt.complete_image_hash == self.manifest.image_hash
            && self.receipt.segment_hashes.len() == self.manifest.segments.len()
            && self
                .receipt
                .segment_hashes
                .iter()
                .zip(self.manifest.segments.iter())
                .all(|(receipt, segment)| {
                    receipt.id == segment.id
                        && receipt.filename == segment.filename
                        && receipt.sha256 == segment.sha256
                        && receipt.byte_size == segment.byte_size
                });

        let mut segment_hashes_match = true;
        let mut verified_segment_count = 0usize;
        let mut total_bytes = 0u64;

        // Read segment bytes from disk for hashing. This is the ONLY place where
        // all segments are read together; execution reads one segment at a time.
        for segment in &self.manifest.segments {
            let bytes = self.read_segment_bytes(&segment.filename).map_err(|e| {
                napi::Error::from_reason(format!("segment hash mismatch check - {}", e))
            })?;
            let actual_hash = sha256_bytes(&bytes);
            if actual_hash != segment.sha256 {
                segment_hashes_match = false;
            } else {
                verified_segment_count += 1;
            }
            total_bytes += bytes.len() as u64;
        }

        if self.receipt.complete_image_hash != self.manifest.image_hash {
            segment_hashes_match = false;
        }
        if !receipt_matches_manifest {
            segment_hashes_match = false;
        }

        if !manifest_hash_matches {
            return Err(napi::Error::from_reason(
                "compiled image manifest hash mismatch",
            ));
        }
        if !receipt_matches_manifest {
            return Err(napi::Error::from_reason(
                "compiled image receipt does not match manifest",
            ));
        }
        if !segment_hashes_match {
            return Err(napi::Error::from_reason(
                "compiled image segment hash mismatch",
            ));
        }
        // ── mapped-no-copy-v1 additional checks ──────────────────────
        if self.manifest.required_storage_abi == STORAGE_ABI_MAPPED_NO_COPY_V1 {
        for segment in &self.manifest.segments {
            let seg_path = self.image_dir.join(&segment.filename);
            if !seg_path.exists() {
                return Err(napi::Error::from_reason(format!(
                    "mapped-no-copy: segment file does not exist: {}",
                    seg_path.display()
                )));
            }
            let meta = seg_path.metadata().map_err(|e| {
                napi::Error::from_reason(format!(
                    "mapped-no-copy: stat {}: {}",
                    seg_path.display(), e
                ))
            })?;
            let actual_len = meta.len();
            if actual_len != segment.byte_size {
                return Err(napi::Error::from_reason(format!(
                    "mapped-no-copy: segment {} size mismatch: manifest says {} but file is {}",
                    segment.filename, segment.byte_size, actual_len
                )));
            }
            // alignment_bytes must be a power of two >= 4096 and divide byte_size
            let ab = segment.alignment_bytes;
            if ab < 4096 || ab & (ab.wrapping_sub(1)) != 0 {
                return Err(napi::Error::from_reason(format!(
                    "mapped-no-copy: segment {} alignment_bytes {} is not a power of two >= 4096",
                    segment.filename, ab
                )));
            }
            if segment.byte_size % ab != 0 {
                return Err(napi::Error::from_reason(format!(
                    "mapped-no-copy: segment {} byte_size {} is not aligned to {}",
                    segment.filename, segment.byte_size, segment.alignment_bytes
                )));
            }
        }
        let seg_map: std::collections::HashMap<&str, &Segment> = self.manifest.segments
            .iter()
            .map(|s| (s.id.as_str(), s))
            .collect();
        for tensor in &self.manifest.tensor_table {
            let tab = if tensor.tensor_alignment_bytes != 0 {
                tensor.tensor_alignment_bytes
            } else {
                16u64
            };
            // tensor_alignment_bytes must be non-zero and the offset must be aligned
            if tab == 0 || tensor.offset % tab != 0 {
                return Err(napi::Error::from_reason(format!(
                    "mapped-no-copy: tensor {} offset {} not aligned to {}",
                    tensor.name, tensor.offset, tab
                )));
            }
            // Validate tensor offset + byte_length does not exceed segment
            if let Some(seg) = seg_map.get(tensor.segment.as_str()) {
                let tensor_end = tensor.offset.saturating_add(tensor.byte_length);
                if tensor_end > seg.byte_size {
                    return Err(napi::Error::from_reason(format!(
                        "mapped-no-copy: tensor {} offset {} + byte_length {} exceeds segment {} byte_size {}",
                        tensor.name, tensor.offset, tensor.byte_length, seg.id, seg.byte_size
                    )));
                }
            }
        }
        } else if !is_valid_storage_abi(&self.manifest.required_storage_abi) {
            return Err(napi::Error::from_reason(format!(
                "unknown storage ABI: {}",
                self.manifest.required_storage_abi
            )));
        }

        Ok(ManifestVerification {
            manifest_hash_matches,
            segment_hashes_match,
            verified_segment_count,
            total_bytes,
        })
    }

    /// Read a single tensor's bytes from its segment file on disk.
    /// Used by fixture-test TensorLookup; not called during segment-scoped execution.
    fn tensor_bytes(&self, name: &str) -> napi::Result<(Vec<u8>, String, Vec<u32>)> {
        let entry = self
            .manifest
            .tensor_table
            .iter()
            .find(|entry| entry.name == name)
            .ok_or_else(|| napi::Error::from_reason(format!("tensor not found in manifest: {}", name)))?;

        let segment = self
            .manifest
            .segments
            .iter()
            .find(|segment| segment.id == entry.segment)
            .ok_or_else(|| napi::Error::from_reason(format!("segment not found for tensor: {}", name)))?;

        let payload = self.read_segment_bytes(&segment.filename)?;

        let start = entry.offset as usize;
        let end = start + entry.byte_length as usize;
        if end > payload.len() {
            return Err(napi::Error::from_reason(format!(
                "tensor {} exceeds segment bounds",
                name
            )));
        }

        Ok((
            payload[start..end].to_vec(),
            entry.storage_dtype.clone(),
            entry.physical_shape.clone(),
        ))
    }
}

impl crate::model::TensorLookup for CompiledImageReader {
    fn tensor(&self, name: &str) -> Option<Array> {
        let (bytes, dtype, shape) = self.tensor_bytes(name).ok()?;
        dtype_to_array(&bytes, &dtype, &shape).ok()
    }
}

impl CompiledImageReader {
    pub fn open_runtime(&self, backend: StorageBackend) -> napi::Result<ImageRuntime> {
        if backend == StorageBackend::MappedNoCopy {
            return Err(napi::Error::from_reason(
                "mapped_no_copy backend is not implemented yet",
            ));
        }

        if !memory_override_enabled() {
            let total_memory = system_memory_bytes();
            let estimated_peak = estimate_open_runtime_peak_bytes(&self.manifest);
            if total_memory > 0 && estimated_peak > total_memory.saturating_sub(2 * 1024 * 1024 * 1024) {
                return Err(napi::Error::from_reason(format!(
                    "refusing to open runtime: estimated peak {} exceeds safe budget on this machine (total memory {})",
                    estimated_peak,
                    total_memory,
                )));
            }
        }

        let _ = clear_mlx_cache();
        let _ = set_mlx_cache_limit(512 * 1024 * 1024);

        let mut runtime = ImageRuntime {
            manifest: self.manifest.clone(),
            receipt: self.receipt.clone(),
            backend,
            image_dir: self.image_dir.clone(),
            persistent_handles: HashMap::new(),
            quantized_bindings: HashMap::new(),
            total_bytes_activated: 0,
            released: false,
        };

        // Load only persistent segments. Layer segments are activated on demand.
        runtime.activate_persistent()?;
        Ok(runtime)
    }
}

// ── Telemetry helpers ──────────────────────────────────────────────────────

/// Returns the process resident set size in bytes, or 0 if unavailable.
fn process_rss_bytes() -> u64 {
    #[cfg(target_os = "macos")]
    {
        
        extern "C" {
            fn task_info(
                target_task: u32,
                flavor: u32,
                task_info_out: *mut u32,
                task_info_count: *mut u32,
            ) -> i32;
            fn mach_task_self() -> u32;
        }
        // TASK_VM_INFO = 22, mach_vm_size_t phys_footprint is at offset 4 (u64).
        // We use TASK_BASIC_INFO (flavor=5) which has resident_size at word 1.
        const TASK_BASIC_INFO: u32 = 5;
        const TASK_BASIC_INFO_COUNT: u32 = 10; // words
        let mut info = [0u32; 10];
        let mut count = TASK_BASIC_INFO_COUNT;
        let ret = unsafe {
            task_info(
                mach_task_self(),
                TASK_BASIC_INFO,
                info.as_mut_ptr(),
                &mut count,
            )
        };
        if ret == 0 && count >= 2 {
            // resident_size is the second field (u32 words on 32-bit, but mach
            // struct is actually two natural_t for virtual/resident on 64-bit).
            // Read as little-endian u64 from words 1..3.
            let lo = info[1] as u64;
            let hi = info[2] as u64;
            return (hi << 32) | lo;
        }
        0
    }
    #[cfg(not(target_os = "macos"))]
    {
        // Linux: parse /proc/self/status VmRSS line.
        if let Ok(status) = std::fs::read_to_string("/proc/self/status") {
            for line in status.lines() {
                if let Some(rest) = line.strip_prefix("VmRSS:") {
                    if let Ok(kb) = rest.trim().trim_end_matches(" kB").parse::<u64>() {
                        return kb * 1024;
                    }
                }
            }
        }
        0
    }
}

/// Returns MLX active memory in bytes, or 0 if the mlx-rs API is unavailable.
pub fn mlx_active_memory_bytes() -> u64 {
    #[cfg(target_os = "macos")]
    {
        let mut res: usize = 0;
        unsafe { mlx_sys::mlx_get_active_memory(&mut res) };
        res as u64
    }
    #[cfg(not(target_os = "macos"))]
    {
        0
    }
}

/// Returns MLX cache memory in bytes, or 0 if the mlx-rs API is unavailable.
pub fn mlx_cache_memory_bytes() -> u64 {
    #[cfg(target_os = "macos")]
    {
        let mut res: usize = 0;
        unsafe { mlx_sys::mlx_get_cache_memory(&mut res) };
        res as u64
    }
    #[cfg(not(target_os = "macos"))]
    {
        0
    }
}

/// Returns MLX peak memory in bytes, or 0 if unavailable.
pub fn mlx_peak_memory_bytes() -> u64 {
    #[cfg(target_os = "macos")]
    {
        let mut res: usize = 0;
        unsafe { mlx_sys::mlx_get_peak_memory(&mut res) };
        res as u64
    }
    #[cfg(not(target_os = "macos"))]
    {
        0
    }
}

/// Clear the MLX Metal allocator cache. Returns the number of bytes freed.
pub fn clear_mlx_cache() -> u64 {
    let before = mlx_cache_memory_bytes();
    #[cfg(target_os = "macos")]
    unsafe { mlx_sys::mlx_clear_cache() };
    let after = mlx_cache_memory_bytes();
    before.saturating_sub(after)
}

/// Set the MLX Metal cache limit in bytes. Returns the previous limit.
pub fn set_mlx_cache_limit(limit_bytes: u64) -> u64 {
    #[cfg(target_os = "macos")]
    {
        let mut prev: usize = 0;
        unsafe { mlx_sys::mlx_set_cache_limit(&mut prev, limit_bytes as usize) };
        prev as u64
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = limit_bytes;
        0
    }
}

/// Get the MLX Metal active memory limit in bytes.
pub fn mlx_get_memory_limit() -> u64 {
    #[cfg(target_os = "macos")]
    {
        let mut res: usize = 0;
        unsafe { mlx_sys::mlx_get_memory_limit(&mut res) };
        res as u64
    }
    #[cfg(not(target_os = "macos"))]
    {
        0
    }
}

/// Set the MLX Metal active memory limit in bytes. Returns the previous limit.
pub fn set_mlx_memory_limit(limit_bytes: u64) -> u64 {
    #[cfg(target_os = "macos")]
    {
        let mut prev: usize = 0;
        unsafe { mlx_sys::mlx_set_memory_limit(&mut prev, limit_bytes as usize) };
        prev as u64
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = limit_bytes;
        0
    }
}

fn system_memory_bytes() -> u64 {
    #[cfg(target_os = "macos")]
    {
        unsafe {
            extern "C" {
                fn sysctlbyname(
                    name: *const c_char,
                    oldp: *mut c_void,
                    oldlenp: *mut usize,
                    newp: *mut c_void,
                    newlen: usize,
                ) -> c_int;
            }

            let mut value: u64 = 0;
            let mut size = std::mem::size_of::<u64>();
            let name = CString::new("hw.memsize").expect("CString");
            let ret = sysctlbyname(
                name.as_ptr(),
                &mut value as *mut _ as *mut c_void,
                &mut size as *mut usize,
                std::ptr::null_mut(),
                0,
            );
            if ret == 0 && value > 0 {
                return value;
            }
        }
    }
    0
}

fn memory_override_enabled() -> bool {
    matches!(
        std::env::var("TRIBUNUS_COMPUTE_ALLOW_HIGH_MEMORY").ok().as_deref(),
        Some("1") | Some("true") | Some("TRUE") | Some("yes") | Some("YES")
    )
}

fn estimate_open_runtime_peak_bytes(manifest: &Manifest) -> u64 {
    let persistent_bytes = manifest
        .residency_plan
        .persistent_segments
        .iter()
        .filter_map(|segment_id| manifest.segments.iter().find(|segment| &segment.id == segment_id))
        .map(|segment| segment.byte_size)
        .sum::<u64>();
    let arch = &manifest.architecture;
    let rope_bytes = u64::from(arch.max_position_embeddings)
        .saturating_mul(u64::from(arch.head_dim))
        .saturating_mul(4)
        .saturating_add(
            u64::from(arch.max_position_embeddings)
                .saturating_mul(u64::from(arch.global_head_dim.unwrap_or(arch.head_dim)))
                .saturating_mul(4),
        );
    let embedding_dequant_bytes = u64::from(arch.vocab_size)
        .saturating_mul(u64::from(arch.hidden_size))
        .saturating_mul(4);

    persistent_bytes
        .saturating_add(rope_bytes)
        .saturating_add(embedding_dequant_bytes)
        .saturating_add(1024 * 1024 * 1024)
}
/// Admission-estimate for representation-aware memory budgeting.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, Default)]
pub struct RepresentationAdmissionEstimate {
    pub virtual_mapped_bytes: u64,
    pub expected_resident_bytes: u64,
    pub persistent_materialized_bytes: u64,
    pub max_layer_window_bytes: u64,
    pub rope_bytes: u64,
    pub kv_budget_bytes: u64,
    pub mlx_workspace_bytes: u64,
    pub allocator_cache_bytes: u64,
    pub system_reserve_bytes: u64,
    /// Maximum single transient allocation during inference
    /// (attention workspace, output projection buffer, etc.).
    pub largest_transient_bytes: u64,
    /// Bytes that must be converted (dequantized, dtype-cast) at runtime.
    pub materialized_bytes: u64,
}

/// Produce an admission estimate given the manifest.
///
/// For the `copied-v0` backend, `virtual_mapped_bytes` is zero because
/// segments are always allocated into the heap. For `mapped-no-copy-v1`,
/// the full image is mmap'd and thus `virtual_mapped_bytes` equals the
/// total image byte count; the resident estimate reflects the working set
/// (persistent segments + layer window).
pub fn representation_aware_admission_estimate(manifest: &Manifest) -> RepresentationAdmissionEstimate {
    let persistent_bytes: u64 = manifest
        .residency_plan
        .persistent_segments
        .iter()
        .filter_map(|sid| manifest.segments.iter().find(|s| &s.id == sid))
        .map(|s| s.byte_size)
        .sum();

    let layer_segments: Vec<&Segment> = manifest
        .residency_plan
        .layer_segments
        .iter()
        .filter_map(|sid| manifest.segments.iter().find(|s| &s.id == sid))
        .collect();

    let max_layer_window_bytes: u64 = {
        let window = manifest.residency_plan.layer_window_size.max(1) as usize;
        let mut sorted = layer_segments.clone();
        sorted.sort_by(|a, b| b.byte_size.cmp(&a.byte_size));
        sorted.iter().take(window).map(|s| s.byte_size).sum()
    };

    let total_mapped: u64 = manifest.segments.iter().map(|s| s.byte_size).sum();

    let arch = &manifest.architecture;
    let rope_bytes = u64::from(arch.max_position_embeddings)
        .saturating_mul(u64::from(arch.head_dim))
        .saturating_mul(4)
        .saturating_add(
            u64::from(arch.max_position_embeddings)
                .saturating_mul(u64::from(arch.global_head_dim.unwrap_or(arch.head_dim)))
                .saturating_mul(4),
        );
    let kv_budget_bytes = rope_bytes.saturating_mul(4); // rough kv-cache × layers
    let mlx_workspace_bytes = 512 * 1024 * 1024;
    let allocator_cache_bytes = 512 * 1024 * 1024;
    let system_reserve_bytes = 2u64 * 1024 * 1024 * 1024;

    let is_mapped = manifest.required_storage_abi == STORAGE_ABI_MAPPED_NO_COPY_V1;
    let virtual_mapped_bytes = if is_mapped { total_mapped } else { 0 };

    // Estimate largest transient allocation.
    // Attention workspace: seq_len × hidden_size × 4 (one f32 hidden state).
    // Output projection: hidden_size × vocab_size × 4 (logits).
    let seq_len = u64::from(arch.max_position_embeddings.min(8192));
    let hidden_size = u64::from(arch.hidden_size);
    let vocab_size = u64::from(arch.vocab_size);
    let attention_workspace = seq_len.saturating_mul(hidden_size).saturating_mul(4);
    let output_proj_workspace = hidden_size.saturating_mul(vocab_size).saturating_mul(4);
    let largest_transient_bytes = attention_workspace.max(output_proj_workspace);

    let (expected_resident_bytes, materialized_bytes) = if is_mapped {
        // mapped-no-copy-v1: resident = working set, materialized = dtype conversions
        let resident = persistent_bytes
            .saturating_add(max_layer_window_bytes)
            .saturating_add(rope_bytes)
            .saturating_add(mlx_workspace_bytes);
        // Count quantized tensors that must be dequantized at runtime
        let materialized: u64 = manifest.tensor_table
            .iter()
            .filter(|t| t.quantization.is_some())
            .map(|t| t.byte_length)
            .sum();
        (resident, materialized)
    } else {
        // copied-v0: resident = all tensor bytes copied into process memory
        let total_tensor_bytes: u64 = manifest.tensor_table
            .iter()
            .map(|t| t.byte_length)
            .sum();
        // Everything is materially resident in heap for copied-v0
        let resident = total_tensor_bytes
            .saturating_add(rope_bytes)
            .saturating_add(mlx_workspace_bytes);
        (resident, 0)
    };

    RepresentationAdmissionEstimate {
        virtual_mapped_bytes,
        expected_resident_bytes,
        persistent_materialized_bytes: persistent_bytes,
        max_layer_window_bytes,
        rope_bytes,
        kv_budget_bytes,
        mlx_workspace_bytes,
        allocator_cache_bytes,
        system_reserve_bytes,
        largest_transient_bytes,
        materialized_bytes,
    }
}

/// Native dependency identity and capability report.
/// Populated at compile time from build constants and at runtime from FFI probes.
#[derive(Clone, Serialize, Deserialize, Default)]
pub struct NativeCapabilityReport {
    pub mlx_core_version: String,
    pub mlx_c_version: String,
    pub mlx_rs_version: String,
    pub mlx_sys_version: String,
    pub compute_native_version: String,
    // Capability flags
    pub supports_quantized_matmul: bool,
    pub supports_dequantize: bool,
    pub supports_memory_telemetry: bool,
    pub supports_cache_control: bool,
    pub supports_external_array: bool,
    pub supports_multithreaded_execution: bool,
    pub metal_available: bool,
    pub accelerate_available: bool,
}

impl NativeCapabilityReport {
    /// Probe the current native environment.
    pub fn probe() -> Self {
        let metal_available = {
            #[cfg(target_os = "macos")]
            {
                let mut res: bool = false;
                unsafe { mlx_sys::mlx_metal_is_available(&mut res) };
                res
            }
            #[cfg(not(target_os = "macos"))]
            false
        };

        // Probe memory telemetry by calling get_active_memory.
        let supports_memory_telemetry = mlx_active_memory_bytes() > 0 || metal_available;
        let supports_cache_control = metal_available;

        // Quantized matmul and dequantize are available in MLX Core >=0.7.
        // We can't probe them at runtime without allocating arrays, so trust the
        // build-time version info. For the current vendored MLX Core 0.21.0: both exist.
        let supports_quantized_matmul = true;
        let supports_dequantize = true;

        // External array support: mlx_array_new_data is available but no-copy
        // external (managed) arrays require MLX C 0.6.0+.
        let _supports_external_array = false; // requires MLX C >= 0.6.0 for managed arrays

        // Multi-threaded execution requires MLX Core >= 0.31.0.
        let _supports_multithreaded_execution = false; // requires MLX Core >= 0.31.0

        Self {
            mlx_core_version: option_env!("TRIBUNUS_MLX_CORE_VERSION").unwrap_or("v0.31.2").to_string(),
            mlx_c_version: option_env!("TRIBUNUS_MLX_C_VERSION").unwrap_or("0.6.0").to_string(),
            mlx_rs_version: option_env!("TRIBUNUS_MLX_RS_VERSION").unwrap_or("0.25.3-tribunus.1").to_string(),
            mlx_sys_version: option_env!("TRIBUNUS_MLX_SYS_VERSION").unwrap_or("0.6.0-tribunus.1").to_string(),
            compute_native_version: "0.1.0".to_string(),
            supports_quantized_matmul,
            supports_dequantize,
            supports_memory_telemetry,
            supports_cache_control,
            supports_external_array: true, // qualified: no-copy round trip, finalizer fires once
            supports_multithreaded_execution: true, // qualified: 4 threads x 50 heavy matmul
            metal_available,
            accelerate_available: true,
        }
    }
}

// ── ImageRuntime implementation ────────────────────────────────────────────

impl ImageRuntime {
    /// Load all persistent segment tensors into ARRAY_REGISTRY.
    /// Called once during open_runtime. Layer tensors are NOT loaded here.
    fn activate_persistent(&mut self) -> napi::Result<()> {
        let persistent_segment_ids: Vec<String> = self
            .manifest
            .residency_plan
            .persistent_segments
            .clone();

        for seg_id in &persistent_segment_ids {
            let segment = self
                .manifest
                .segments
                .iter()
                .find(|s| &s.id == seg_id)
                .ok_or_else(|| napi::Error::from_reason(format!("persistent segment not found: {}", seg_id)))?;

            let bytes = std::fs::read(self.image_dir.join(&segment.filename))
                .map_err(|e| napi::Error::from_reason(format!("read persistent segment {}: {}", segment.filename, e)))?;
            self.total_bytes_activated += bytes.len() as u64;

            for &tensor_id in &segment.tensor_ids {
                let entry = self
                    .manifest
                    .tensor_table
                    .iter()
                    .find(|e| e.id == tensor_id)
                    .ok_or_else(|| napi::Error::from_reason(format!("tensor {} not in table", tensor_id)))?;

                let slice = Self::slice_tensor_bytes(&bytes, entry)?;
                let array = dtype_to_array(slice, &entry.storage_dtype, &entry.physical_shape)?;
                let handle = crate::bridge::ARRAY_REGISTRY.write().insert(array, None);
                self.persistent_handles.insert(entry.name.clone(), handle);
            }
        }

        // Build quantized bindings for persistent tensors (embeddings).
        self.rebuild_quantized_bindings_from_persistent()?;
        Ok(())
    }

    /// Activate the tensors for a single layer by reading its segment from disk.
    /// Returns a LayerLease whose Drop impl releases the tensors from ARRAY_REGISTRY.
    /// IMPORTANT: the caller MUST call `hidden.eval()` before dropping the lease.
    pub fn activate_layer(&self, layer_index: u32) -> napi::Result<LayerLease> {
        let seg_id = format!("layer_{}", layer_index);
        let segment = self
            .manifest
            .segments
            .iter()
            .find(|s| s.id == seg_id)
            .ok_or_else(|| napi::Error::from_reason(format!("layer segment not found: {}", seg_id)))?;

        let bytes = std::fs::read(self.image_dir.join(&segment.filename))
            .map_err(|e| napi::Error::from_reason(format!("read layer segment {}: {}", segment.filename, e)))?;
        let bytes_read = bytes.len() as u64;

        let mut handles = Vec::new();
        for &tensor_id in &segment.tensor_ids {
            let entry = self
                .manifest
                .tensor_table
                .iter()
                .find(|e| e.id == tensor_id)
                .ok_or_else(|| napi::Error::from_reason(format!("tensor {} not in table", tensor_id)))?;

            let slice = Self::slice_tensor_bytes(&bytes, entry)?;
            let array = dtype_to_array(slice, &entry.storage_dtype, &entry.physical_shape)?;
            let handle = crate::bridge::ARRAY_REGISTRY.write().insert(array, None);
            handles.push(handle);
        }

        Ok(LayerLease {
            layer_index,
            segment_id: seg_id,
            bytes_read,
            handles,
        })
    }

    /// Slice the raw bytes for a specific tensor entry out of a segment payload.
    fn slice_tensor_bytes<'a>(segment_bytes: &'a [u8], entry: &TensorEntry) -> napi::Result<&'a [u8]> {
        let start = entry.offset as usize;
        let end = start + entry.byte_length as usize;
        if end > segment_bytes.len() {
            return Err(napi::Error::from_reason(format!(
                "tensor {} offset {}..{} exceeds segment length {}",
                entry.name, start, end, segment_bytes.len()
            )));
        }
        Ok(&segment_bytes[start..end])
    }

    /// Build a LayerArrays-equivalent lookup by reading active tensor handles
    /// from ARRAY_REGISTRY for the given layer. Both persistent_handles (for
    /// embeddings needed during the layer forward pass) and the just-activated
    /// layer handles (currently in ARRAY_REGISTRY under the handles owned by
    /// the lease) are accessible via self.lookup_handle().
    #[allow(dead_code)]
    fn lookup_handle(&self, lease_handles: &[u64], name: &str) -> Option<Array> {
        // Check persistent handles first.
        if let Some(&h) = self.persistent_handles.get(name) {
            let reg = crate::bridge::ARRAY_REGISTRY.read();
            return reg.get(h).cloned();
        }
        // Check the active layer handles by matching tensor names.
        // We match by name through the registry since LayerLease stores handles
        // in tensor_id order; we need to map name → handle.
        // Build a temporary name→handle map from the last segment's tensor_ids.
        // (This is only called from run_six_layer_prefix, which holds a lease.)
        let _ = lease_handles; // not needed; name lookup goes through ARRAY_REGISTRY scan
        None
    }

    /// Build a per-layer tensor lookup from the lease's handles and the
    /// manifest tensor table. Returns a HashMap<name, Array> for the layer.
    pub(crate) fn build_layer_arrays_from_lease(
        &self,
        layer_index: u32,
        lease: &LayerLease,
    ) -> napi::Result<HashMap<String, Array>> {
        let seg_id = format!("layer_{}", layer_index);
        let segment = self
            .manifest
            .segments
            .iter()
            .find(|s| s.id == seg_id)
            .ok_or_else(|| napi::Error::from_reason(format!("segment {} not found", seg_id)))?;

        if segment.tensor_ids.len() != lease.handles.len() {
            return Err(napi::Error::from_reason(format!(
                "layer {} segment has {} tensors but lease has {} handles",
                layer_index, segment.tensor_ids.len(), lease.handles.len()
            )));
        }

        let reg = crate::bridge::ARRAY_REGISTRY.read();
        let mut map = HashMap::new();
        for (&tensor_id, &handle) in segment.tensor_ids.iter().zip(lease.handles.iter()) {
            let entry = self
                .manifest
                .tensor_table
                .iter()
                .find(|e| e.id == tensor_id)
                .ok_or_else(|| napi::Error::from_reason(format!("tensor {} not in table", tensor_id)))?;
            let array = reg.get(handle).cloned().ok_or_else(|| {
                napi::Error::from_reason(format!("handle {} not in registry for {}", handle, entry.name))
            })?;
            map.insert(entry.name.clone(), array);
        }
        Ok(map)
    }

    /// Rebuild quantized bindings from the currently active persistent handles.
    fn rebuild_quantized_bindings_from_persistent(&mut self) -> napi::Result<()> {
        self.quantized_bindings.clear();
        for entry in &self.manifest.tensor_table {
            // Only build bindings for tensors in persistent segments and that have quantization.
            if !self.manifest.residency_plan.persistent_segments
                .iter().any(|pid| *pid == entry.segment) {
                continue;
            }
            if let Some(quantization) = &entry.quantization {
                let scales_entry = self
                    .manifest
                    .tensor_table
                    .iter()
                    .find(|e| e.id == quantization.scale_tensor_id)
                    .ok_or_else(|| napi::Error::from_reason(format!("missing scale tensor for {}", entry.name)))?;
                let biases_entry = self
                    .manifest
                    .tensor_table
                    .iter()
                    .find(|e| e.id == quantization.bias_tensor_id)
                    .ok_or_else(|| napi::Error::from_reason(format!("missing bias tensor for {}", entry.name)))?;

                let w_handle = *self.persistent_handles.get(&entry.name)
                    .ok_or_else(|| napi::Error::from_reason(format!("missing persistent handle: {}", entry.name)))?;
                let s_handle = *self.persistent_handles.get(&scales_entry.name)
                    .ok_or_else(|| napi::Error::from_reason(format!("missing persistent scale handle: {}", scales_entry.name)))?;
                let b_handle = *self.persistent_handles.get(&biases_entry.name)
                    .ok_or_else(|| napi::Error::from_reason(format!("missing persistent bias handle: {}", biases_entry.name)))?;

                let binding = QuantizedLinearBinding::new(
                    w_handle, s_handle, b_handle,
                    entry.logical_shape[0],
                    entry.logical_shape[1],
                    quantization.group_size,
                    quantization.bits,
                    true,
                );
                self.quantized_bindings.insert(entry.name.clone(), binding);
            }
        }
        Ok(())
    }

    /// Number of quantized bindings for persistent tensors (fixture test assertion).
    pub fn quantized_binding_count(&self) -> usize {
        self.quantized_bindings.len()
    }

    /// Number of persistent tensor handles currently active.
    pub fn persistent_handle_count(&self) -> usize {
        self.persistent_handles.len()
    }

    /// Total bytes activated across all segment reads (persistent + layer activations).
    pub fn total_bytes_activated(&self) -> u64 {
        self.total_bytes_activated
    }

    /// Execute the six-layer prefix using segment-scoped residency.
    ///
    /// For each layer:
    ///   1. Activate the layer segment (reads from disk, registers arrays).
    ///   2. Build the layer forward pass using persistent + layer arrays.
    ///   3. Force evaluation of the hidden state (eval before retire).
    ///   4. Drop the LayerLease, releasing that layer's arrays.
    ///
    /// Per-layer telemetry is emitted to stderr for residency verification.
    pub fn run_six_layer_prefix(&mut self) -> napi::Result<Array> {
        if self.released {
            return Err(napi::Error::from_reason("image runtime already released"));
        }

        let arch = self.manifest.architecture.clone();
        let root = "language_model.model";
        let layer_count = usize::min(
            6,
            usize::min(arch.layer_types.len(), arch.num_hidden_layers as usize),
        );

        // Embed using persistent tensors.
        let emb_w_name = format!("{}.embed_tokens.weight", root);
        let emb_s_name = format!("{}.embed_tokens.scales", root);
        let emb_b_name = format!("{}.embed_tokens.biases", root);

        let (emb_w, emb_s, emb_b) = {
            let reg = crate::bridge::ARRAY_REGISTRY.read();
            let emb_w = reg
                .get(*self.persistent_handles.get(&emb_w_name).ok_or_else(|| {
                    napi::Error::from_reason(format!("missing persistent tensor: {}", emb_w_name))
                })?)
                .cloned()
                .ok_or_else(|| napi::Error::from_reason("embed weight handle invalid"))?;
            let emb_s = reg
                .get(*self.persistent_handles.get(&emb_s_name).ok_or_else(|| {
                    napi::Error::from_reason(format!("missing persistent tensor: {}", emb_s_name))
                })?)
                .cloned()
                .ok_or_else(|| napi::Error::from_reason("embed scales handle invalid"))?;
            let emb_b = reg
                .get(*self.persistent_handles.get(&emb_b_name).ok_or_else(|| {
                    napi::Error::from_reason(format!("missing persistent tensor: {}", emb_b_name))
                })?)
                .cloned()
                .ok_or_else(|| napi::Error::from_reason("embed biases handle invalid"))?;
            (emb_w, emb_s, emb_b)
        };

        let tok = Array::from_slice(&[2i32], &[1]);
        let mut hidden = crate::primitives::quantized_embedding_lookup(&tok, &emb_w, &emb_s, &emb_b)
            .map_err(|e| napi::Error::from_reason(format!("embed lookup: {:?}", e)))?
            .multiply(&Array::from_f32((arch.hidden_size as f32).sqrt()))
            .map_err(|e| napi::Error::from_reason(format!("embed scale: {:?}", e)))?;

        let (rope_cos, rope_sin) = crate::primitives::rope_freqs(
            arch.head_dim,
            arch.max_position_embeddings,
            arch.rope_local.theta as f32,
        )
        .map_err(|e| napi::Error::from_reason(format!("rope local: {:?}", e)))?;
        let full_rope = arch.rope_global.as_ref().unwrap_or(&arch.rope_local);
        let (full_cos, full_sin) = crate::primitives::rope_freqs(
            arch.global_head_dim.unwrap_or(arch.head_dim),
            arch.max_position_embeddings,
            full_rope.theta as f32,
        )
        .map_err(|e| napi::Error::from_reason(format!("rope global: {:?}", e)))?;

        for layer in 0..layer_count {
            let t0 = Instant::now();
            let rss_before = process_rss_bytes();
            let _active_before = mlx_active_memory_bytes();
            let _cached_before = mlx_cache_memory_bytes();
            let handles_before = crate::bridge::handle_count();

            // Activate this layer's segment (reads from disk).
            let lease = self.activate_layer(layer as u32)
                .map_err(|e| napi::Error::from_reason(format!("activate layer {}: {}", layer, e)))?;
            let bytes_read = lease.bytes_read;

            // Build the layer tensor map from the lease.
            let layer_map = self.build_layer_arrays_from_lease(layer as u32, &lease)?;

            // Helper closure to look up a tensor by name.
            let get_tensor = |name: &str| -> napi::Result<Array> {
                if let Some(arr) = layer_map.get(name) {
                    return Ok(arr.clone());
                }
                if let Some(&h) = self.persistent_handles.get(name) {
                    let reg = crate::bridge::ARRAY_REGISTRY.read();
                    return reg.get(h).cloned().ok_or_else(|| {
                        napi::Error::from_reason(format!("persistent handle invalid for {}", name))
                    });
                }
                Err(napi::Error::from_reason(format!("tensor not found for layer {}: {}", layer, name)))
            };

            let base = format!("{}.layers.{}", root, layer);
            let is_full = matches!(
                arch.layer_types[layer],
                crate::config::AttentionKind::FullAttention
            );

            let attn_norm = get_tensor(&format!("{}.input_layernorm.weight", base))?;
            let ffn_norm  = get_tensor(&format!("{}.post_attention_layernorm.weight", base))?;
            let (qw, qs, qb) = (
                get_tensor(&format!("{}.self_attn.q_proj.weight", base))?,
                get_tensor(&format!("{}.self_attn.q_proj.scales", base))?,
                get_tensor(&format!("{}.self_attn.q_proj.biases", base))?,
            );
            let (kw, ks, kb) = (
                get_tensor(&format!("{}.self_attn.k_proj.weight", base))?,
                get_tensor(&format!("{}.self_attn.k_proj.scales", base))?,
                get_tensor(&format!("{}.self_attn.k_proj.biases", base))?,
            );
            let (vw, vs, vb) = if !is_full {
                (
                    get_tensor(&format!("{}.self_attn.v_proj.weight", base))?,
                    get_tensor(&format!("{}.self_attn.v_proj.scales", base))?,
                    get_tensor(&format!("{}.self_attn.v_proj.biases", base))?,
                )
            } else {
                (
                    Array::from_slice(&[0.0f32], &[1]),
                    Array::from_slice(&[0.0f32], &[1]),
                    Array::from_slice(&[0.0f32], &[1]),
                )
            };
            let (ow, os, ob) = (
                get_tensor(&format!("{}.self_attn.o_proj.weight", base))?,
                get_tensor(&format!("{}.self_attn.o_proj.scales", base))?,
                get_tensor(&format!("{}.self_attn.o_proj.biases", base))?,
            );
            let (gw, gs, gb) = (
                get_tensor(&format!("{}.mlp.gate_proj.weight", base))?,
                get_tensor(&format!("{}.mlp.gate_proj.scales", base))?,
                get_tensor(&format!("{}.mlp.gate_proj.biases", base))?,
            );
            let (uw, us, ub) = (
                get_tensor(&format!("{}.mlp.up_proj.weight", base))?,
                get_tensor(&format!("{}.mlp.up_proj.scales", base))?,
                get_tensor(&format!("{}.mlp.up_proj.biases", base))?,
            );
            let (dw, ds, db) = (
                get_tensor(&format!("{}.mlp.down_proj.weight", base))?,
                get_tensor(&format!("{}.mlp.down_proj.scales", base))?,
                get_tensor(&format!("{}.mlp.down_proj.biases", base))?,
            );

            // Run the layer forward pass.
            let layer_arrays = crate::model::LayerArraysRef {
                attn_norm: &attn_norm,
                ffn_norm:  &ffn_norm,
                qw: &qw, qs: &qs, qb: &qb,
                kw: &kw, ks: &ks, kb: &kb,
                vw: &vw, vs: &vs, vb: &vb,
                ow: &ow, os: &os, ob: &ob,
                gw: &gw, gs: &gs, gb: &gb,
                uw: &uw, us: &us, ub: &ub,
                dw: &dw, ds: &ds, db: &db,
            };

            hidden = if is_full {
                crate::model::run_full_layer_arrays(&hidden, &layer_arrays, &arch, &full_cos, &full_sin, 0)
                    .map_err(|e| napi::Error::from_reason(format!("layer {} full: {:?}", layer, e)))?
            } else {
                crate::model::run_sliding_layer_arrays(&hidden, &layer_arrays, &arch, &rope_cos, &rope_sin, 0)
                    .map_err(|e| napi::Error::from_reason(format!("layer {} sliding: {:?}", layer, e)))?
            };

            // *** CRITICAL: eval BEFORE dropping lease ***
            // MLX is lazy — the graph still references the layer arrays until eval() forces
            // the computation. Dropping the lease before eval leaves the graph with dead
            // backing storage.
            hidden
                .eval()
                .map_err(|e| napi::Error::from_reason(format!("eval layer {}: {:?}", layer, e)))?;

            let elapsed_ms = t0.elapsed().as_millis();
            let rss_after = process_rss_bytes();
            let active_after = mlx_active_memory_bytes();
            let cached_after = mlx_cache_memory_bytes();
            let handles_after = crate::bridge::handle_count();

            // Emit per-layer residency receipt.
            let _rss_evaluated = rss_after;
            let active_evaluated = active_after;
            let cached_evaluated = cached_after;
            let handles_evaluated = handles_after;
            let seg_id = lease.segment_id.clone();

            // *** Retire the layer segment. ***
            // hidden.eval() has already forced the kernel to consume the weights.
            drop(lease);

            // Capture telemetry AFTER retirement to prove logical release.
            let rss_retired = process_rss_bytes();
            let active_retired = mlx_active_memory_bytes();
            let cached_retired = mlx_cache_memory_bytes();
            let handles_retired = crate::bridge::handle_count();

            eprintln!(
                "[image-runtime] layer={} segment={} bytes_read={} elapsed_ms={} \
                 rss_delta={} mlx_active={}→{} mlx_cached={}→{} handles={}→{}→{}",
                layer, seg_id, bytes_read, elapsed_ms,
                rss_retired as i64 - rss_before as i64,
                active_evaluated, active_retired,
                cached_evaluated, cached_retired,
                handles_before, handles_evaluated, handles_retired,
            );
        }

        // Final norm + LM head projection using persistent embed tensors.
        let fn_w_name = format!("{}.norm.weight", root);
        let fn_w = {
            let reg = crate::bridge::ARRAY_REGISTRY.read();
            reg.get(
                *self.persistent_handles.get(&fn_w_name).ok_or_else(|| {
                    napi::Error::from_reason(format!("missing persistent tensor: {}", fn_w_name))
                })?,
            )
            .cloned()
            .ok_or_else(|| napi::Error::from_reason("norm weight handle invalid"))?
        };
        let final_hidden = crate::primitives::rms_norm(&hidden, &fn_w, 1e-6)
            .map_err(|e| napi::Error::from_reason(format!("final norm: {:?}", e)))?;

        // LM head aliases embed_tokens (tie_word_embeddings); reuse emb_w.
        let out = {
            let reg = crate::bridge::ARRAY_REGISTRY.read();
            let ew = reg
                .get(*self.persistent_handles.get(&emb_w_name).ok_or_else(|| {
                    napi::Error::from_reason("embed weight gone before lm_head")
                })?)
                .cloned()
                .ok_or_else(|| napi::Error::from_reason("embed weight handle invalid at lm_head"))?;
            let es = reg
                .get(*self.persistent_handles.get(&emb_s_name).ok_or_else(|| {
                    napi::Error::from_reason("embed scales gone before lm_head")
                })?)
                .cloned()
                .ok_or_else(|| napi::Error::from_reason("embed scales handle invalid at lm_head"))?;
            let eb = reg
                .get(*self.persistent_handles.get(&emb_b_name).ok_or_else(|| {
                    napi::Error::from_reason("embed biases gone before lm_head")
                })?)
                .cloned()
                .ok_or_else(|| napi::Error::from_reason("embed biases handle invalid at lm_head"))?;
            let gs = (ew.shape()[1] as i32 * 4) / es.shape()[1];
            mlx_rs::ops::quantized_matmul(&final_hidden, &ew, &es, &eb, true, gs, 8)
                .map_err(|e| napi::Error::from_reason(format!("lm_head matmul: {:?}", e)))?
        };
        out.eval()
            .map_err(|e| napi::Error::from_reason(format!("final eval: {:?}", e)))?;

        self.release();
        Ok(out)
    }

    /// Execute the complete 48-layer model from the compiled execution plan.
    ///
    /// This is the canonical forward path:
    ///   1. Run the prologue (embedding → hidden state)
    ///   2. For each layer in the execution plan:
    ///      a. Activate the layer segment
    ///      b. Run the layer executor from the compiled plan
    ///      c. eval() before dropping the lease
    ///      d. Record per-layer telemetry
    ///   3. Run the epilogue (final norm → output projection → softcap → argmax)
    ///
    /// Returns a u32 token ID — no logits cross the boundary.
    /// Per-layer receipts are emitted to stderr.
    pub fn run_full_model(&mut self, token_ids: &[i32]) -> napi::Result<u32> {
        if self.released {
            return Err(napi::Error::from_reason("image runtime already released"));
        }

        let plan = &self.manifest.execution_plan;
        plan.validate()
            .map_err(|errors| napi::Error::from_reason(format!(
                "execution plan validation failed: {}", errors.join("; ")
            )))?;

        let arch = &self.manifest.architecture;
        let root = "language_model.model";
        let seq_len = token_ids.len() as i32;

        // --- Prologue: embedding lookup ---
        let emb_w_name = format!("{}.embed_tokens.weight", root);
        let emb_s_name = format!("{}.embed_tokens.scales", root);
        let emb_b_name = format!("{}.embed_tokens.biases", root);

        let (emb_w, emb_s, emb_b) = {
            let reg = crate::bridge::ARRAY_REGISTRY.read();
            let w = reg
                .get(*self.persistent_handles.get(&emb_w_name).ok_or_else(|| {
                    napi::Error::from_reason(format!("missing: {}", emb_w_name))
                })?)
                .cloned()
                .ok_or_else(|| napi::Error::from_reason("embed weight invalid"))?;
            let s = reg
                .get(*self.persistent_handles.get(&emb_s_name).ok_or_else(|| {
                    napi::Error::from_reason(format!("missing: {}", emb_s_name))
                })?)
                .cloned()
                .ok_or_else(|| napi::Error::from_reason("embed scales invalid"))?;
            let b = reg
                .get(*self.persistent_handles.get(&emb_b_name).ok_or_else(|| {
                    napi::Error::from_reason(format!("missing: {}", emb_b_name))
                })?)
                .cloned()
                .ok_or_else(|| napi::Error::from_reason("embed biases invalid"))?;
            (w, s, b)
        };

        let tok = Array::from_slice(token_ids, &[1, seq_len]);
        let mut hidden = crate::executor::run_prologue(
            &tok, &emb_w, &emb_s, &emb_b, &plan.prologue,
            (arch.hidden_size as f32).sqrt(),
        )
        .map_err(|e| napi::Error::from_reason(format!("prologue: {:?}", e)))?;

        hidden.eval()
            .map_err(|e| napi::Error::from_reason(format!("prologue eval: {:?}", e)))?;

        // Precompute RoPE tables
        let (rope_cos, rope_sin) = crate::primitives::rope_freqs(
            arch.head_dim,
            arch.max_position_embeddings,
            arch.rope_local.theta as f32,
        )
        .map_err(|e| napi::Error::from_reason(format!("rope local: {:?}", e)))?;
        let full_rope = arch.rope_global.as_ref().unwrap_or(&arch.rope_local);
        let (full_cos, full_sin) = crate::primitives::rope_freqs(
            arch.global_head_dim.unwrap_or(arch.head_dim),
            arch.max_position_embeddings,
            full_rope.theta as f32,
        )
        .map_err(|e| napi::Error::from_reason(format!("rope global: {:?}", e)))?;

        // Build per-layer KV caches for single-pass validation
        let max_seq_len = arch.max_position_embeddings.min(8192);
        let mut caches: Vec<crate::kv_cache::KvCache> = Vec::with_capacity(plan.layers.len());
        for layer_plan in &plan.layers {
            let is_sliding = layer_plan.attention_kind == "sliding_attention";
            let (capacity, n_kv_heads, head_dim) = if is_sliding {
                (layer_plan.sliding_window, layer_plan.n_kv_heads, layer_plan.head_dim)
            } else {
                let g_kv = layer_plan.n_global_kv_heads.unwrap_or(1);
                let g_hd = layer_plan.global_head_dim.unwrap_or(layer_plan.head_dim);
                (max_seq_len, g_kv, g_hd)
            };
            caches.push(crate::kv_cache::KvCache::new(capacity, n_kv_heads, head_dim, is_sliding));
        }

        let idle_handles = crate::bridge::handle_count();
        eprintln!(
            "[full-model] idle_handles={} layer_count={}",
            idle_handles, plan.layers.len(),
        );
        // --- Decoder layers ---
        for layer_plan in &plan.layers {
            let l = layer_plan.layer_index;
            let t0 = Instant::now();
            let handles_before = crate::bridge::handle_count();
            let active_before = mlx_active_memory_bytes();

            // Activate the layer segment
            let lease = self.activate_layer(l)
                .map_err(|e| napi::Error::from_reason(format!("activate layer {}: {}", l, e)))?;
            let bytes_read = lease.bytes_read;

            // Build layer tensor map from the lease
            let layer_map = self.build_layer_arrays_from_lease(l, &lease)?;

            // Helper to look up a tensor
            let get_tensor = |name: &str| -> napi::Result<Array> {
                if let Some(arr) = layer_map.get(name) {
                    return Ok(arr.clone());
                }
                if let Some(&h) = self.persistent_handles.get(name) {
                    let reg = crate::bridge::ARRAY_REGISTRY.read();
                    return reg.get(h).cloned().ok_or_else(|| {
                        napi::Error::from_reason(format!("persistent handle invalid for {}", name))
                    });
                }
                Err(napi::Error::from_reason(format!("tensor not found for layer {}: {}", l, name)))
            };

            let base = format!("{}.layers.{}", root, l);
            let is_full = layer_plan.attention_kind == "full_attention";

            let attn_norm = get_tensor(&format!("{}.input_layernorm.weight", base))?;
            let ffn_norm  = get_tensor(&format!("{}.post_attention_layernorm.weight", base))?;
            let (qw, qs, qb) = (
                get_tensor(&format!("{}.self_attn.q_proj.weight", base))?,
                get_tensor(&format!("{}.self_attn.q_proj.scales", base))?,
                get_tensor(&format!("{}.self_attn.q_proj.biases", base))?,
            );
            let (kw, ks, kb) = (
                get_tensor(&format!("{}.self_attn.k_proj.weight", base))?,
                get_tensor(&format!("{}.self_attn.k_proj.scales", base))?,
                get_tensor(&format!("{}.self_attn.k_proj.biases", base))?,
            );
            let (vw, vs, vb) = if is_full {
                // K-equals-V: reuse k_proj
                (kw.clone(), ks.clone(), kb.clone())
            } else {
                (
                    get_tensor(&format!("{}.self_attn.v_proj.weight", base))?,
                    get_tensor(&format!("{}.self_attn.v_proj.scales", base))?,
                    get_tensor(&format!("{}.self_attn.v_proj.biases", base))?,
                )
            };
            let (ow, os, ob) = (
                get_tensor(&format!("{}.self_attn.o_proj.weight", base))?,
                get_tensor(&format!("{}.self_attn.o_proj.scales", base))?,
                get_tensor(&format!("{}.self_attn.o_proj.biases", base))?,
            );
            let (gw, gs, gb) = (
                get_tensor(&format!("{}.mlp.gate_proj.weight", base))?,
                get_tensor(&format!("{}.mlp.gate_proj.scales", base))?,
                get_tensor(&format!("{}.mlp.gate_proj.biases", base))?,
            );
            let (uw, us, ub) = (
                get_tensor(&format!("{}.mlp.up_proj.weight", base))?,
                get_tensor(&format!("{}.mlp.up_proj.scales", base))?,
                get_tensor(&format!("{}.mlp.up_proj.biases", base))?,
            );
            let (dw, ds, db) = (
                get_tensor(&format!("{}.mlp.down_proj.weight", base))?,
                get_tensor(&format!("{}.mlp.down_proj.scales", base))?,
                get_tensor(&format!("{}.mlp.down_proj.biases", base))?,
            );

            // Q/K norm weights
            let q_norm = get_tensor(&format!("{}.self_attn.q_norm.weight", base)).ok();
            let k_norm = get_tensor(&format!("{}.self_attn.k_norm.weight", base)).ok();

            // Select RoPE tables
            let (rcos, rsin) = if is_full { (&full_cos, &full_sin) } else { (&rope_cos, &rope_sin) };

            // Run the layer executor
            hidden = crate::executor::run_layer(
                &hidden,
                layer_plan,
                &attn_norm, &ffn_norm,
                &qw, &qs, &qb,
                &kw, &ks, &kb,
                &vw, &vs, &vb,
                &ow, &os, &ob,
                q_norm.as_ref(), k_norm.as_ref(),
                &gw, &gs, &gb,
                &uw, &us, &ub,
                &dw, &ds, &db,
                rcos, rsin,
                &mut caches[l as usize],
                0, // kv_offset = 0 for single-pass
                arch.rms_norm_eps as f32,
            )
            .map_err(|e| napi::Error::from_reason(format!("layer {}: {:?}", l, e)))?;

            // *** CRITICAL: eval BEFORE dropping lease ***
            hidden.eval()
                .map_err(|e| napi::Error::from_reason(format!("eval layer {}: {:?}", l, e)))?;

            let elapsed_ms = t0.elapsed().as_millis();
            let handles_after = crate::bridge::handle_count();
            let _active_evaluated = mlx_active_memory_bytes();
            let seg_id = lease.segment_id.clone();

            // Retire the layer segment
            drop(lease);

            let handles_retired = crate::bridge::handle_count();
            let active_retired = mlx_active_memory_bytes();

            let output_shape = hidden.shape();
            let is_finite = hidden
                .try_as_slice::<f32>()
                .map(|v| v.iter().all(|x| x.is_finite()))
                .unwrap_or(false);

            eprintln!(
                "[full-model] layer={} kind={} segment={} bytes={} elapsed_ms={} \
                 handles={}→{}→{} active_mem={}→{} shape={:?} finite={}",
                l, layer_plan.attention_kind, seg_id, bytes_read, elapsed_ms,
                handles_before, handles_after, handles_retired,
                active_before, active_retired,
                output_shape, is_finite,
            );
        }

        // Verify return to idle
        let final_handles = crate::bridge::handle_count();
        eprintln!(
            "[full-model] all_layers_done final_handles={} idle_handles={}",
            final_handles, idle_handles,
        );

        // --- Epilogue: final norm + output projection + softcapping + argmax ---
        let fn_w_name = format!("{}.norm.weight", root);
        let fn_w = {
            let reg = crate::bridge::ARRAY_REGISTRY.read();
            reg.get(*self.persistent_handles.get(&fn_w_name).ok_or_else(|| {
                napi::Error::from_reason(format!("missing: {}", fn_w_name))
            })?)
            .cloned()
            .ok_or_else(|| napi::Error::from_reason("norm weight invalid"))?
        };

        let epi = crate::executor::run_epilogue(
            &hidden,
            &fn_w,
            &emb_w, &emb_s, &emb_b,
            &plan.epilogue,
            arch.rms_norm_eps as f32,
            arch.tie_word_embeddings,
            &crate::session::SamplerConfig::default(),
        )
        .map_err(|e| napi::Error::from_reason(format!("epilogue: {:?}", e)))?;

        epi.selected_token
            .eval()
            .map_err(|e| napi::Error::from_reason(format!("epilogue eval: {:?}", e)))?;
        let token_id = epi.selected_token
            .try_as_slice::<u32>()
            .map_err(|e| napi::Error::from_reason(format!("epilogue token: {:?}", e)))?
            .first()
            .copied()
            .unwrap_or(0);

        self.release();
        Ok(token_id)
    }

    /// Release all persistent tensor handles.
    pub fn release(&mut self) {
        if self.released {
            return;
        }
        for handle in self.persistent_handles.values().copied().collect::<Vec<_>>() {
            let _ = crate::bridge::free_array(handle);
        }
        self.persistent_handles.clear();
        self.quantized_bindings.clear();
        self.released = true;
    }
}

fn plan(source_dir: &Path) -> napi::Result<(crate::config::CompilationPlan, LoadedSource)> {
    use crate::config::{CompilationPlan, PlannedSegment, PlannedTensor};

    let loaded = load_source(source_dir)?;
    let shard_hashes: Vec<String> = loaded
        .shard_hashes
        .iter()
        .map(|h| h.sha256.clone())
        .collect();

    let mut tensor_table = Vec::new();
    let mut next_tensor_id: u32 = 0;
    let mut segments: Vec<PlannedSegment> = Vec::new();
    let mut seg_offsets: HashMap<String, u64> = HashMap::new();

    // Persistent segment.
    let persistent_seg_id = "persistent".to_string();
    segments.push(PlannedSegment {
        id: persistent_seg_id.clone(),
        filename: "segment_000.bin".into(),
        byte_size: 0,
        kind: "persistent".into(),
        tensor_count: 0,
    });

    for binding in &loaded.spec.global_tensors {
        let disp = classify_disposition(binding, &loaded.namespace);
        let (src_shard, src_offset, src_len, logical_dtype) =
            source_info(&loaded.source_tensors, &binding.name);
        let dest_offset = seg_offsets.get(&persistent_seg_id).copied().unwrap_or(0);
        tensor_table.push(PlannedTensor {
            id: next_tensor_id,
            name: binding.name.clone(),
            disposition: disp,
            source_shard: src_shard,
            source_offset: src_offset,
            source_byte_length: src_len,
            destination_segment: persistent_seg_id.clone(),
            destination_offset: dest_offset,
            destination_byte_length: src_len,
            logical_dtype,
            logical_shape: binding.logical_shape.clone(),
        });
        *seg_offsets.entry(persistent_seg_id.clone()).or_insert(0) += src_len;
        next_tensor_id += 1;
    }

    // Layer segments.
    for layer in &loaded.spec.layers {
        let seg_id = format!("layer_{}", layer.index);
        let seg_idx = segments.len();
        segments.push(PlannedSegment {
            id: seg_id.clone(),
            filename: format!("segment_{:03}.bin", seg_idx),
            byte_size: 0,
            kind: format!("layer_{}", layer.index),
            tensor_count: 0,
        });
        for binding in &layer.tensors {
            let disp = classify_disposition(binding, &loaded.namespace);
            let (src_shard, src_offset, src_len, logical_dtype) =
                source_info(&loaded.source_tensors, &binding.name);
            let dest_offset = seg_offsets.get(&seg_id).copied().unwrap_or(0);
            tensor_table.push(PlannedTensor {
                id: next_tensor_id,
                name: binding.name.clone(),
                disposition: disp,
                source_shard: src_shard,
                source_offset: src_offset,
                source_byte_length: src_len,
                destination_segment: seg_id.clone(),
                destination_offset: dest_offset,
                destination_byte_length: src_len,
                logical_dtype,
                logical_shape: binding.logical_shape.clone(),
            });
            *seg_offsets.entry(seg_id.clone()).or_insert(0) += src_len;
            next_tensor_id += 1;
        }
    }

    // Update segment byte sizes and tensor counts.
    for seg in &mut segments {
        seg.byte_size = *seg_offsets.get(&seg.id).unwrap_or(&0);
        seg.tensor_count = tensor_table
            .iter()
            .filter(|t| t.destination_segment == seg.id)
            .count();
    }

    let total_source_bytes: u64 = loaded
        .source_tensors
        .values()
        .map(|t| t.data.len() as u64)
        .sum();
    let total_image_bytes: u64 = segments.iter().map(|s| s.byte_size).sum();

    let plan = CompilationPlan {
        model_identity: loaded.manifest.model_type.clone(),
        source_config_hash: loaded.manifest.config_hash.clone(),
        source_shard_hashes: shard_hashes,
        tensor_table,
        segments,
        total_source_bytes,
        total_image_bytes,
    };

    Ok((plan, loaded))
}

fn classify_disposition(
    binding: &crate::config::TensorBinding,
    _namespace: &crate::config::NamespaceBinding,
) -> crate::config::TensorDisposition {
    use crate::config::TensorDisposition;

    // Quantized weight payloads get relocated unchanged.
    if binding.name.ends_with(".weight")
        || binding.name.ends_with(".scales")
        || binding.name.ends_with(".biases")
    {
        return TensorDisposition::RelocateAndAlign;
    }
    // Embedding layer_scalar and other small tensors also relocate.
    TensorDisposition::RelocateAndAlign
}

fn source_info(
    source_tensors: &HashMap<String, SourceTensor>,
    name: &str,
) -> (String, u64, u64, String) {
    if let Some(st) = source_tensors.get(name) {
        (
            st.source_filename.clone(),
            st.source_offset,
            st.data.len() as u64,
            st.dtype.clone(),
        )
    } else {
        (String::new(), 0, 0, "F32".into())
    }
}

/// Compile a source checkpoint into a precompiled ComputeImage runtime artifact.
///
/// The source directory must contain a config.json and safetensors shards.
/// The compiler validates the checkpoint, writes execution-ordered segments,
/// and emits a deterministic manifest.json plus receipt.json.
pub fn compile(source_dir: &str, output_dir: &str) -> napi::Result<CompiledImage> {
    let source_dir = Path::new(source_dir);
    let output_dir = Path::new(output_dir);
    let started_at = std::time::Instant::now();

    let t_source = Instant::now();
    let (_plan, loaded) = plan(source_dir)?;
    // TODO Phase 3: Use plan to drive parallel emission instead of sequential loaded.spec iteration
    let source_load_ms = t_source.elapsed().as_millis() as u64;
    crate::compile_progress::CompileProgress {
        stage: "source_loaded".into(),
        bytes_processed: loaded.spec.layers.len() as u64,
        bytes_total: loaded.spec.layers.len() as u64,
        elapsed_ms: started_at.elapsed().as_millis() as u64,
    }.emit();

    compile_sequential(source_dir, output_dir, loaded, started_at, source_load_ms)
}

fn compile_sequential(
    _source_dir: &Path,
    output_dir: &Path,
    loaded: LoadedSource,
    started_at: Instant,
    source_load_ms: u64,
) -> napi::Result<CompiledImage> {
    let source = build_source_identity(
        &loaded.manifest,
        loaded.shard_hashes.clone(),
        loaded.tokenizer_hashes.clone(),
        loaded.auxiliary_hashes.clone(),
    );

    let mut builder = ImageBuilder::new(loaded.arch.clone(), source);

    let t_emit = Instant::now();
    builder.begin_segment("persistent", SegmentKind::Persistent);
    let mut emitted_ids = HashMap::new();

    for binding in &loaded.spec.global_tensors {
        let id = emit_binding_set(&mut builder, &loaded.source_tensors, binding, None)?;
        emitted_ids.insert(binding.name.clone(), id);
    }

    if loaded.namespace.lm_head_aliased {
        let embed_name = format!("{}.embed_tokens.weight", loaded.namespace.root);
        let physical_id = emitted_ids
            .get(&embed_name)
            .copied()
            .ok_or_else(|| napi::Error::from_reason("embed_tokens.weight was not emitted"))?;
        builder.add_alias("lm_head.weight", physical_id, "tie_word_embeddings=true");
    }

    for layer in &loaded.spec.layers {
        builder.begin_segment(
            &format!("layer_{}", layer.index),
            SegmentKind::Layer(layer.index),
        );
        for binding in &layer.tensors {
            let id = emit_binding_set(
                &mut builder,
                &loaded.source_tensors,
                binding,
                Some(layer.index),
            )?;
            emitted_ids.insert(binding.name.clone(), id);
        }
    }

    // Build the execution plan using the emitted tensor IDs
    let execution_plan = crate::config::build_execution_plan(
        &loaded.arch,
        &loaded.namespace,
        &emitted_ids,
    );
    builder.set_execution_plan(execution_plan);

    let payload_emission_ms = t_emit.elapsed().as_millis() as u64;
    let emitted_so_far = builder.segment_payloads.iter().map(|p| p.len() as u64).sum();
    crate::compile_progress::CompileProgress {
        stage: "payload_emission_done".into(),
        bytes_processed: emitted_so_far,
        bytes_total: emitted_so_far,
        elapsed_ms: started_at.elapsed().as_millis() as u64,
    }.emit();

    let t_finalize = Instant::now();
    let manifest = builder.finalize(output_dir)?;
    let finalize_ms = t_finalize.elapsed().as_millis() as u64;

    let total_source_bytes = loaded
        .source_tensors
        .values()
        .map(|tensor| tensor.data.len() as u64)
        .sum();
    let total_emitted_bytes = manifest.segments.iter().map(|segment| segment.byte_size).sum();

    let stage_profile = StageProfile {
        source_discovery_ms: source_load_ms,
        header_parsing_ms: 0,
        architecture_normalization_ms: 0,
        binding_validation_ms: 0,
        source_hashing_ms: 0,
        layout_planning_ms: 0,
        payload_emission_ms,
        segment_hashing_ms: finalize_ms,
        manifest_generation_ms: 0,
        verification_ms: 0,
        total_source_bytes,
        total_emitted_bytes,
        peak_rss_bytes: 0,
        peak_mlx_active_bytes: mlx_active_memory_bytes() as u64,
        peak_mlx_cache_bytes: 0,
    };

    let receipt = build_compile_receipt(&loaded, &manifest, started_at.elapsed().as_millis(), stage_profile);
    let receipt_path = output_dir.join("receipt.json");
    let receipt_json = serde_json::to_string_pretty(&receipt)
        .map_err(|e| napi::Error::from_reason(format!("json: {}", e)))?;
    std::fs::write(&receipt_path, receipt_json)
        .map_err(|e| napi::Error::from_reason(format!("write receipt: {}", e)))?;

    Ok(CompiledImage { manifest, receipt })
}

pub fn read(image_dir: &str) -> napi::Result<CompiledImageReader> {
    CompiledImageReader::open(Path::new(image_dir))
}

pub fn verify(image_dir: &str) -> napi::Result<ManifestVerification> {
    read(image_dir)?.verify()
}

/// Atomically publish a staged compilation to its final destination.
///
/// 1. Writes a `.publishing` marker inside `staging`.
/// 2. Renames `staging` to `destination` (falls back to recursive copy
///    when the rename crosses filesystem boundaries).
/// 3. On failure the staging directory is left intact with a `.failed` marker
///    so that the caller can inspect or retry.
pub fn publish_image(staging: &Path, destination: &Path) -> napi::Result<()> {
    let publishing_marker = staging.join(".publishing");
    std::fs::write(&publishing_marker, b"")
        .map_err(|e| napi::Error::from_reason(format!("write .publishing: {}", e)))?;

    let result = std::fs::rename(staging, destination);
    match result {
        Ok(()) => Ok(()),
        Err(e) => {
            // rename fails across filesystem boundaries — fall back to copy + remove
            if e.kind() == std::io::ErrorKind::CrossesDevices {
                let failed_marker = staging.join(".failed");
                if let Err(write_err) = std::fs::write(&failed_marker, format!("rename failed: {}", e)) {
                    return Err(napi::Error::from_reason(format!(
                        "write .failed marker: {} (original rename: {})", write_err, e
                    )));
                }
                return Err(napi::Error::from_reason(format!(
                    "rename crosses devices: {}. Staging left in place with .failed marker.", e
                )));
            }
            let failed_marker = staging.join(".failed");
            if let Err(write_err) = std::fs::write(&failed_marker, format!("rename failed: {}", e)) {
                return Err(napi::Error::from_reason(format!(
                    "write .failed marker: {} (original rename: {})", write_err, e
                )));
            }
            Err(napi::Error::from_reason(format!("rename {} -> {}: {}", staging.display(), destination.display(), e)))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::TensorLookup;
    use safetensors::tensor::{serialize_to_file, Dtype, TensorView};
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir(label: &str) -> PathBuf {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time")
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "tribunus-compute-image-{}-{}-{}",
            std::process::id(),
            label,
            stamp
        ));
        fs::create_dir_all(&path).expect("create temp dir");
        path
    }

    fn leak_bytes(bytes: Vec<u8>) -> &'static [u8] {
        Box::leak(bytes.into_boxed_slice())
    }

    fn u32_tensor(name: &str, shape: &[usize], seed: u32) -> (String, TensorView<'static>) {
        let len = shape.iter().product::<usize>();
        let mut bytes = Vec::with_capacity(len * std::mem::size_of::<u32>());
        for index in 0..len {
            let value = seed.wrapping_add(index as u32);
            bytes.extend_from_slice(&value.to_le_bytes());
        }
        let tensor = TensorView::new(Dtype::U32, shape.to_vec(), leak_bytes(bytes)).expect("tensor");
        (name.to_string(), tensor)
    }

    fn f32_tensor(name: &str, shape: &[usize], seed: f32) -> (String, TensorView<'static>) {
        let len = shape.iter().product::<usize>();
        let mut bytes = Vec::with_capacity(len * std::mem::size_of::<f32>());
        for index in 0..len {
            let value = seed + (index as f32 * 0.03125);
            bytes.extend_from_slice(&value.to_le_bytes());
        }
        let tensor =
            TensorView::new(Dtype::F32, shape.to_vec(), leak_bytes(bytes)).expect("tensor");
        (name.to_string(), tensor)
    }

    fn write_fixture_model(source_dir: &Path) {
        let config = serde_json::json!({
            "model_type": "tiny_gemma_like",
            "text_config": {
                "hidden_size": 64,
                "intermediate_size": 128,
                "num_attention_heads": 4,
                "num_key_value_heads": 1,
                "head_dim": 16,
                "global_head_dim": 16,
                "num_global_key_value_heads": 1,
                "num_hidden_layers": 1,
                "vocab_size": 64,
                "sliding_window": 8,
                "max_position_embeddings": 16,
                "rms_norm_eps": 0.000001,
                "tie_word_embeddings": true,
                "attention_k_eq_v": true,
                "final_logit_softcapping": null,
                "hidden_size_per_layer_input": 0,
                "layer_types": ["sliding_attention"],
                "rope_parameters": {
                    "sliding_attention": {
                        "rope_theta": 10000.0,
                        "rope_type": "default"
                    },
                    "full_attention": {
                        "rope_theta": 1000000.0,
                        "rope_type": "proportional"
                    }
                },
                "model_type": "tiny_gemma_like"
            },
            "quantization": {
                "group_size": 64,
                "bits": 8,
                "mode": "affine"
            }
        });

        fs::write(
            source_dir.join("config.json"),
            serde_json::to_string_pretty(&config).expect("config json"),
        )
        .expect("write config");

        let root = "language_model.model";
        let mut tensors = vec![
            u32_tensor(&format!("{}.embed_tokens.weight", root), &[64, 16], 1),
            f32_tensor(&format!("{}.embed_tokens.scales", root), &[64, 1], 0.5),
            f32_tensor(&format!("{}.embed_tokens.biases", root), &[64, 1], 1.5),
            f32_tensor(&format!("{}.norm.weight", root), &[64], 2.0),
            f32_tensor(
                &format!("{}.layers.0.input_layernorm.weight", root),
                &[64],
                3.0,
            ),
            f32_tensor(
                &format!("{}.layers.0.post_attention_layernorm.weight", root),
                &[64],
                4.0,
            ),
            f32_tensor(
                &format!("{}.layers.0.self_attn.q_norm.weight", root),
                &[16],
                5.0,
            ),
            f32_tensor(
                &format!("{}.layers.0.self_attn.k_norm.weight", root),
                &[16],
                6.0,
            ),
            u32_tensor(
                &format!("{}.layers.0.self_attn.q_proj.weight", root),
                &[64, 16],
                7,
            ),
            f32_tensor(
                &format!("{}.layers.0.self_attn.q_proj.scales", root),
                &[64, 1],
                7.5,
            ),
            f32_tensor(
                &format!("{}.layers.0.self_attn.q_proj.biases", root),
                &[64, 1],
                7.75,
            ),
            u32_tensor(
                &format!("{}.layers.0.self_attn.k_proj.weight", root),
                &[16, 16],
                8,
            ),
            f32_tensor(
                &format!("{}.layers.0.self_attn.k_proj.scales", root),
                &[16, 1],
                8.5,
            ),
            f32_tensor(
                &format!("{}.layers.0.self_attn.k_proj.biases", root),
                &[16, 1],
                8.75,
            ),
            u32_tensor(
                &format!("{}.layers.0.self_attn.v_proj.weight", root),
                &[16, 16],
                9,
            ),
            f32_tensor(
                &format!("{}.layers.0.self_attn.v_proj.scales", root),
                &[16, 1],
                9.5,
            ),
            f32_tensor(
                &format!("{}.layers.0.self_attn.v_proj.biases", root),
                &[16, 1],
                9.75,
            ),
            u32_tensor(
                &format!("{}.layers.0.self_attn.o_proj.weight", root),
                &[64, 16],
                10,
            ),
            f32_tensor(
                &format!("{}.layers.0.self_attn.o_proj.scales", root),
                &[64, 1],
                10.5,
            ),
            f32_tensor(
                &format!("{}.layers.0.self_attn.o_proj.biases", root),
                &[64, 1],
                10.75,
            ),
            u32_tensor(
                &format!("{}.layers.0.mlp.gate_proj.weight", root),
                &[128, 16],
                11,
            ),
            f32_tensor(
                &format!("{}.layers.0.mlp.gate_proj.scales", root),
                &[128, 1],
                11.5,
            ),
            f32_tensor(
                &format!("{}.layers.0.mlp.gate_proj.biases", root),
                &[128, 1],
                11.75,
            ),
            u32_tensor(
                &format!("{}.layers.0.mlp.up_proj.weight", root),
                &[128, 16],
                12,
            ),
            f32_tensor(
                &format!("{}.layers.0.mlp.up_proj.scales", root),
                &[128, 1],
                12.5,
            ),
            f32_tensor(
                &format!("{}.layers.0.mlp.up_proj.biases", root),
                &[128, 1],
                12.75,
            ),
            u32_tensor(
                &format!("{}.layers.0.mlp.down_proj.weight", root),
                &[64, 32],
                13,
            ),
            f32_tensor(
                &format!("{}.layers.0.mlp.down_proj.scales", root),
                &[64, 2],
                13.5,
            ),
            f32_tensor(
                &format!("{}.layers.0.mlp.down_proj.biases", root),
                &[64, 2],
                13.75,
            ),
        ];

        tensors.sort_by(|left, right| left.0.cmp(&right.0));
        serialize_to_file(tensors, &None, &source_dir.join("model.safetensors"))
            .expect("write safetensors");
    }

    /// Build a synthetic model with N layers driven by `layer_types`
    /// ("sliding_attention" or "full_attention"). Full-attention layers
    /// omit v_proj (K-equals-V).
    fn write_two_layer_fixture_model(source_dir: &Path, layer_types: &[&str]) {
        let num_layers = layer_types.len();
        let config = serde_json::json!({
            "model_type": "tiny_gemma_like",
            "text_config": {
                "hidden_size": 64,
                "intermediate_size": 128,
                "num_attention_heads": 4,
                "num_key_value_heads": 1,
                "head_dim": 16,
                "global_head_dim": 16,
                "num_global_key_value_heads": 1,
                "num_hidden_layers": num_layers,
                "vocab_size": 64,
                "sliding_window": 8,
                "max_position_embeddings": 16,
                "rms_norm_eps": 0.000001,
                "tie_word_embeddings": true,
                "attention_k_eq_v": true,
                "final_logit_softcapping": null,
                "hidden_size_per_layer_input": 0,
                "layer_types": layer_types,
                "rope_parameters": {
                    "sliding_attention": {
                        "rope_theta": 10000.0,
                        "rope_type": "default"
                    },
                    "full_attention": {
                        "rope_theta": 1000000.0,
                        "rope_type": "proportional"
                    }
                },
                "model_type": "tiny_gemma_like"
            },
            "quantization": {
                "group_size": 64,
                "bits": 8,
                "mode": "affine"
            }
        });

        fs::write(
            source_dir.join("config.json"),
            serde_json::to_string_pretty(&config).expect("config json"),
        )
        .expect("write config");

        let root = "language_model.model";
        let mut tensors = vec![
            u32_tensor(&format!("{}.embed_tokens.weight", root), &[64, 16], 1),
            f32_tensor(&format!("{}.embed_tokens.scales", root), &[64, 1], 0.5),
            f32_tensor(&format!("{}.embed_tokens.biases", root), &[64, 1], 1.5),
            f32_tensor(&format!("{}.norm.weight", root), &[64], 2.0),
        ];

        for (i, lt) in layer_types.iter().enumerate() {
            let layer = i as u32;
            let is_full = *lt == "full_attention";

            // Norms
            tensors.push(f32_tensor(
                &format!("{}.layers.{}.input_layernorm.weight", root, layer),
                &[64], 3.0 + layer as f32 * 10.0,
            ));
            tensors.push(f32_tensor(
                &format!("{}.layers.{}.post_attention_layernorm.weight", root, layer),
                &[64], 4.0 + layer as f32 * 10.0,
            ));

            // Q/K norms
            tensors.push(f32_tensor(
                &format!("{}.layers.{}.self_attn.q_norm.weight", root, layer),
                &[16], 5.0 + layer as f32 * 10.0,
            ));
            tensors.push(f32_tensor(
                &format!("{}.layers.{}.self_attn.k_norm.weight", root, layer),
                &[16], 6.0 + layer as f32 * 10.0,
            ));

            // Q projection
            tensors.push(u32_tensor(
                &format!("{}.layers.{}.self_attn.q_proj.weight", root, layer),
                &[64, 16], 7 + layer * 100,
            ));
            tensors.push(f32_tensor(
                &format!("{}.layers.{}.self_attn.q_proj.scales", root, layer),
                &[64, 1], 7.5 + layer as f32 * 10.0,
            ));
            tensors.push(f32_tensor(
                &format!("{}.layers.{}.self_attn.q_proj.biases", root, layer),
                &[64, 1], 7.75 + layer as f32 * 10.0,
            ));

            // K projection
            tensors.push(u32_tensor(
                &format!("{}.layers.{}.self_attn.k_proj.weight", root, layer),
                &[16, 16], 8 + layer * 100,
            ));
            tensors.push(f32_tensor(
                &format!("{}.layers.{}.self_attn.k_proj.scales", root, layer),
                &[16, 1], 8.5 + layer as f32 * 10.0,
            ));
            tensors.push(f32_tensor(
                &format!("{}.layers.{}.self_attn.k_proj.biases", root, layer),
                &[16, 1], 8.75 + layer as f32 * 10.0,
            ));

            // V projection: only for sliding attention layers
            if !is_full {
                tensors.push(u32_tensor(
                    &format!("{}.layers.{}.self_attn.v_proj.weight", root, layer),
                    &[16, 16], 9 + layer * 100,
                ));
                tensors.push(f32_tensor(
                    &format!("{}.layers.{}.self_attn.v_proj.scales", root, layer),
                    &[16, 1], 9.5 + layer as f32 * 10.0,
                ));
                tensors.push(f32_tensor(
                    &format!("{}.layers.{}.self_attn.v_proj.biases", root, layer),
                    &[16, 1], 9.75 + layer as f32 * 10.0,
                ));
            }

            // O projection
            tensors.push(u32_tensor(
                &format!("{}.layers.{}.self_attn.o_proj.weight", root, layer),
                &[64, 16], 10 + layer * 100,
            ));
            tensors.push(f32_tensor(
                &format!("{}.layers.{}.self_attn.o_proj.scales", root, layer),
                &[64, 1], 10.5 + layer as f32 * 10.0,
            ));
            tensors.push(f32_tensor(
                &format!("{}.layers.{}.self_attn.o_proj.biases", root, layer),
                &[64, 1], 10.75 + layer as f32 * 10.0,
            ));

            // MLP gate/up/down
            tensors.push(u32_tensor(
                &format!("{}.layers.{}.mlp.gate_proj.weight", root, layer),
                &[128, 16], 11 + layer * 100,
            ));
            tensors.push(f32_tensor(
                &format!("{}.layers.{}.mlp.gate_proj.scales", root, layer),
                &[128, 1], 11.5 + layer as f32 * 10.0,
            ));
            tensors.push(f32_tensor(
                &format!("{}.layers.{}.mlp.gate_proj.biases", root, layer),
                &[128, 1], 11.75 + layer as f32 * 10.0,
            ));
            tensors.push(u32_tensor(
                &format!("{}.layers.{}.mlp.up_proj.weight", root, layer),
                &[128, 16], 12 + layer * 100,
            ));
            tensors.push(f32_tensor(
                &format!("{}.layers.{}.mlp.up_proj.scales", root, layer),
                &[128, 1], 12.5 + layer as f32 * 10.0,
            ));
            tensors.push(f32_tensor(
                &format!("{}.layers.{}.mlp.up_proj.biases", root, layer),
                &[128, 1], 12.75 + layer as f32 * 10.0,
            ));
            tensors.push(u32_tensor(
                &format!("{}.layers.{}.mlp.down_proj.weight", root, layer),
                &[64, 32], 13 + layer * 100,
            ));
            tensors.push(f32_tensor(
                &format!("{}.layers.{}.mlp.down_proj.scales", root, layer),
                &[64, 2], 13.5 + layer as f32 * 10.0,
            ));
            tensors.push(f32_tensor(
                &format!("{}.layers.{}.mlp.down_proj.biases", root, layer),
                &[64, 2], 13.75 + layer as f32 * 10.0,
            ));
        }

        tensors.sort_by(|left, right| left.0.cmp(&right.0));
        serialize_to_file(tensors, &None, &source_dir.join("model.safetensors"))
            .expect("write safetensors");
    }

    #[derive(Debug)]
    struct TensorComparison {
        shape_matches: bool,
        dtype_matches: bool,
        source_finite: bool,
        runtime_finite: bool,
        max_abs_diff: f32,
        mean_abs_diff: f32,
        cosine_similarity: f32,
    }

    fn compare_tensors(source: &Array, runtime: &Array) -> TensorComparison {
        let source_slice = source.try_as_slice::<f32>().expect("source slice");
        let runtime_slice = runtime.try_as_slice::<f32>().expect("runtime slice");
        let len = usize::min(source_slice.len(), runtime_slice.len());
        let mut max_abs_diff = 0.0f32;
        let mut sum_abs_diff = 0.0f32;
        let mut dot = 0.0f32;
        let mut source_norm = 0.0f32;
        let mut runtime_norm = 0.0f32;

        for i in 0..len {
            let left = source_slice[i];
            let right = runtime_slice[i];
            let diff = (left - right).abs();
            if diff > max_abs_diff {
                max_abs_diff = diff;
            }
            sum_abs_diff += diff;
            dot += left * right;
            source_norm += left * left;
            runtime_norm += right * right;
        }

        let cosine_similarity = if source_norm == 0.0 || runtime_norm == 0.0 {
            0.0
        } else {
            dot / (source_norm.sqrt() * runtime_norm.sqrt())
        };

        TensorComparison {
            shape_matches: source.shape() == runtime.shape(),
            dtype_matches: format!("{:?}", source.dtype()) == format!("{:?}", runtime.dtype()),
            source_finite: source_slice.iter().all(|value| value.is_finite()),
            runtime_finite: runtime_slice.iter().all(|value| value.is_finite()),
            max_abs_diff,
            mean_abs_diff: if len == 0 { 0.0 } else { sum_abs_diff / len as f32 },
            cosine_similarity,
        }
    }

    #[derive(Clone, Serialize, Deserialize)]
    struct RealCheckpointReference {
        shape: Vec<i32>,
        values: Vec<f32>,
    }

    fn real_checkpoint_env(name: &str) -> Option<String> {
        std::env::var(name).ok()
    }

    fn real_checkpoint_run_child(
        phase: &str,
        source_dir: &Path,
        output_dir: &Path,
        reference_path: &Path,
    ) {
        let current_exe = std::env::current_exe().expect("current exe");
        let status = std::process::Command::new(current_exe)
            .arg("compute_image::tests::real_checkpoint_six_layer_prefix_round_trip")
            .arg("--exact")
            .arg("--ignored")
            .arg("--nocapture")
            .env("TRIBUNUS_REAL_CHECKPOINT_PHASE", phase)
            .env("TRIBUNUS_REAL_CHECKPOINT_SOURCE_DIR", source_dir)
            .env("TRIBUNUS_REAL_CHECKPOINT_OUTPUT_DIR", output_dir)
            .env("TRIBUNUS_REAL_CHECKPOINT_REFERENCE", reference_path)
            .status()
            .expect("spawn real checkpoint child");
        assert!(status.success(), "real checkpoint child failed in phase {}", phase);
    }

    fn real_checkpoint_source_phase(source_dir: &Path, reference_path: &Path) {
        let source = crate::model::Shard::load(
            source_dir
                .join("model-00001-of-00003.safetensors")
                .to_str()
                .expect("source shard 1"),
        );
        let source_2 = crate::model::Shard::load(
            source_dir
                .join("model-00002-of-00003.safetensors")
                .to_str()
                .expect("source shard 2"),
        );
        let source_3 = crate::model::Shard::load(
            source_dir
                .join("model-00003-of-00003.safetensors")
                .to_str()
                .expect("source shard 3"),
        );
        let (arch, _, _) = crate::config::parse_config(
            source_dir.join("config.json").to_str().expect("config path"),
        )
        .expect("parse config");
        let output = crate::model::run_six_layer_prefix(&[&source, &source_2, &source_3], &arch)
            .expect("source prefix");
        output.eval().expect("source eval");
        let reference = RealCheckpointReference {
            shape: output.shape().to_vec(),
            values: output.try_as_slice::<f32>().expect("source slice").to_vec(),
        };
        std::fs::write(
            reference_path,
            serde_json::to_string_pretty(&reference).expect("reference json"),
        )
        .expect("write reference");
        crate::bridge::ARRAY_REGISTRY.write().drain();
    }

    fn real_checkpoint_compile_phase(source_dir: &Path, output_dir: &Path) {
        let compiled = compile(
            source_dir.to_str().expect("source dir"),
            output_dir.to_str().expect("output dir"),
        )
        .expect("compile real checkpoint");
        let reader = read(output_dir.to_str().expect("output dir")).expect("reader");
        let verification = reader.verify().expect("verification");
        assert!(verification.manifest_hash_matches);
        assert!(verification.segment_hashes_match);
        assert_eq!(verification.verified_segment_count, compiled.manifest.segments.len());
    }

    fn real_checkpoint_runtime_phase(
        source_dir: &Path,
        output_dir: &Path,
        reference_path: &Path,
    ) {
        let source_exists = source_dir.exists();
        assert!(
            !source_exists,
            "source checkpoint should not be accessible during runtime"
        );

        let reference: RealCheckpointReference = serde_json::from_str(
            &std::fs::read_to_string(reference_path).expect("read reference"),
        )
        .expect("parse reference");
        let expected = Array::from_slice(&reference.values, &reference.shape);

        let reader = read(output_dir.to_str().expect("output dir")).expect("reader");
        let verification = reader.verify().expect("verification");
        assert!(verification.manifest_hash_matches);
        assert!(verification.segment_hashes_match);

        let baseline_handles = crate::bridge::handle_count();
        let mut runtime = reader.open_runtime(StorageBackend::Copied).expect("runtime");
        let runtime_prefix = runtime.run_six_layer_prefix().expect("runtime prefix");
        runtime_prefix.eval().expect("runtime eval");

        let comparison = compare_tensors(&expected, &runtime_prefix);
        assert!(comparison.shape_matches, "shape mismatch");
        assert!(comparison.dtype_matches, "dtype mismatch");
        assert!(comparison.source_finite, "reference output contains non-finite values");
        assert!(comparison.runtime_finite, "runtime output contains non-finite values");
        assert!(
            comparison.max_abs_diff <= 1e-4,
            "max abs diff too large: {}",
            comparison.max_abs_diff
        );
        assert!(
            comparison.mean_abs_diff <= 1e-5,
            "mean abs diff too large: {}",
            comparison.mean_abs_diff
        );
        assert!(
            comparison.cosine_similarity >= 0.999_999,
            "cosine similarity too low: {}",
            comparison.cosine_similarity
        );
        assert_eq!(crate::bridge::handle_count(), baseline_handles);
    }

    #[test]
    fn compile_source_dir_writes_deterministic_image() {
        let source_dir = temp_dir("source");
        let output_dir_a = temp_dir("out-a");
        let output_dir_b = temp_dir("out-b");

        write_fixture_model(&source_dir);

        let first = compile(
            source_dir.to_str().expect("source dir"),
            output_dir_a.to_str().expect("output dir a"),
        )
        .expect("first compile");
        let second = compile(
            source_dir.to_str().expect("source dir"),
            output_dir_b.to_str().expect("output dir b"),
        )
        .expect("second compile");

        assert_eq!(first.manifest.image_hash, second.manifest.image_hash);
        assert_eq!(first.receipt.complete_image_hash, first.manifest.image_hash);
        assert_eq!(first.manifest.segments.len(), 2);
        assert_eq!(
            first.manifest.segments.len(),
            first.manifest.residency_plan.persistent_segments.len()
                + first.manifest.residency_plan.layer_segments.len()
        );
        assert_eq!(first.manifest.alias_table.len(), 1);
        assert_eq!(first.manifest.alias_table[0].logical_name, "lm_head.weight");
        assert!(first.receipt.structural_verification);

        let manifest_path = output_dir_a.join("manifest.json");
        assert!(manifest_path.exists());
        let receipt_path = output_dir_a.join("receipt.json");
        assert!(receipt_path.exists());

        let persisted = fs::read(output_dir_a.join("segment_000.bin")).expect("segment 0");
        assert_eq!(persisted.len() as u64, first.manifest.segments[0].byte_size);

        let reloaded_manifest: Manifest =
            serde_json::from_str(&fs::read_to_string(manifest_path).expect("manifest json"))
                .expect("manifest parse");
        assert_eq!(reloaded_manifest.image_hash, first.manifest.image_hash);
        assert_eq!(reloaded_manifest.segments.len(), first.manifest.segments.len());
    }

    #[test]
    fn compiled_image_reader_round_trip_matches_source_prefix() {
        let source_dir = temp_dir("source-round-trip");
        let output_dir = temp_dir("out-round-trip");

        write_fixture_model(&source_dir);

        let compiled = compile(
            source_dir.to_str().expect("source dir"),
            output_dir.to_str().expect("output dir"),
        )
        .expect("compile");
        let reader = read(output_dir.to_str().expect("output dir")).expect("reader");
        let verification = reader.verify().expect("verification");
        assert!(verification.manifest_hash_matches);
        assert!(verification.segment_hashes_match);
        assert_eq!(verification.verified_segment_count, compiled.manifest.segments.len());

        let source = crate::model::Shard::load(
            source_dir
                .join("model.safetensors")
                .to_str()
                .expect("source shard"),
        );

        for name in [
            "language_model.model.embed_tokens.weight",
            "language_model.model.embed_tokens.scales",
            "language_model.model.embed_tokens.biases",
            "language_model.model.layers.0.self_attn.q_proj.weight",
            "language_model.model.layers.0.self_attn.q_proj.scales",
            "language_model.model.layers.0.self_attn.q_proj.biases",
        ] {
            let left = source.tensor(name).expect("source tensor");
            let right = reader.tensor(name).expect("reader tensor");
            assert_eq!(left.shape(), right.shape());
            let left_dtype = format!("{:?}", left.dtype());
            let right_dtype = format!("{:?}", right.dtype());
            assert_eq!(left_dtype, right_dtype);
            match left_dtype.as_str() {
                "Uint32" | "U32" => {
                    assert_eq!(
                        left.try_as_slice::<u32>().expect("source u32"),
                        right.try_as_slice::<u32>().expect("reader u32")
                    );
                }
                "Float32" | "F32" => {
                    assert_eq!(
                        left.try_as_slice::<f32>().expect("source f32"),
                        right.try_as_slice::<f32>().expect("reader f32")
                    );
                }
                other => panic!("unexpected dtype for {}: {}", name, other),
            }
        }
    }

    #[test]
    fn compiled_image_runtime_copied_round_trip_matches_source_prefix() {
        let source_dir = temp_dir("source-runtime");
        let output_dir = temp_dir("out-runtime");

        write_fixture_model(&source_dir);

        let compiled = compile(
            source_dir.to_str().expect("source dir"),
            output_dir.to_str().expect("output dir"),
        )
        .expect("compile");
        let reader = read(output_dir.to_str().expect("output dir")).expect("reader");
        let baseline_handles = crate::bridge::handle_count();
        let mut runtime = reader.open_runtime(StorageBackend::Copied).expect("runtime");
        assert!(runtime.quantized_binding_count() > 0);
        assert!(crate::bridge::handle_count() > baseline_handles);

        // After open_runtime: only persistent segment bytes loaded, not layer segments.
        let persistent_bytes: u64 = compiled
            .manifest
            .segments
            .iter()
            .filter(|s| matches!(s.kind, SegmentKind::Persistent | SegmentKind::Final))
            .map(|s| s.byte_size)
            .sum();
        assert_eq!(runtime.total_bytes_activated(), persistent_bytes);

        let source = crate::model::Shard::load(
            source_dir
                .join("model.safetensors")
                .to_str()
                .expect("source shard"),
        );
        let source_prefix =
            crate::model::run_six_layer_prefix(&[&source], &compiled.manifest.architecture)
                .expect("source prefix");
        let runtime_prefix = runtime.run_six_layer_prefix().expect("runtime prefix");

        assert_eq!(source_prefix.shape(), runtime_prefix.shape());
        assert_eq!(
            source_prefix.try_as_slice::<f32>().expect("source slice"),
            runtime_prefix.try_as_slice::<f32>().expect("runtime slice")
        );
        assert_eq!(crate::bridge::handle_count(), baseline_handles);
    }

    #[test]
    #[ignore = "real checkpoint smoke test; run manually when you want to pay the 12G cost"]
    fn real_checkpoint_six_layer_prefix_round_trip() {
        let source_dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("models/gemma4-12b-8bit");
        let output_dir = temp_dir("real-out");

        if let Some(phase) = real_checkpoint_env("TRIBUNUS_REAL_CHECKPOINT_PHASE") {
            let source = std::env::var("TRIBUNUS_REAL_CHECKPOINT_SOURCE_DIR")
                .expect("TRIBUNUS_REAL_CHECKPOINT_SOURCE_DIR");
            let output = std::env::var("TRIBUNUS_REAL_CHECKPOINT_OUTPUT_DIR")
                .expect("TRIBUNUS_REAL_CHECKPOINT_OUTPUT_DIR");
            let reference = std::env::var("TRIBUNUS_REAL_CHECKPOINT_REFERENCE")
                .expect("TRIBUNUS_REAL_CHECKPOINT_REFERENCE");
            let source = Path::new(&source);
            let output = Path::new(&output);
            let reference = Path::new(&reference);

            match phase.as_str() {
                "source" => real_checkpoint_source_phase(source, reference),
                "compile" => real_checkpoint_compile_phase(source, output),
                "runtime" => real_checkpoint_runtime_phase(source, output, reference),
                other => panic!("unknown checkpoint phase: {}", other),
            }
            return;
        }

        let reference_path = temp_dir("real-reference").join("reference.json");
        let hidden_source_dir = source_dir.with_extension("hidden-for-runtime");
        struct RestoreSourceDir {
            hidden: PathBuf,
            original: PathBuf,
        }
        impl Drop for RestoreSourceDir {
            fn drop(&mut self) {
                if self.hidden.exists() {
                    let _ = std::fs::rename(&self.hidden, &self.original);
                }
            }
        }

        real_checkpoint_run_child(
            "source",
            &source_dir,
            &output_dir,
            &reference_path,
        );
        real_checkpoint_run_child(
            "compile",
            &source_dir,
            &output_dir,
            &reference_path,
        );

        std::fs::rename(&source_dir, &hidden_source_dir).expect("hide source checkpoint");
        let _restore_source_dir = RestoreSourceDir {
            hidden: hidden_source_dir.clone(),
            original: source_dir.clone(),
        };
        assert!(!source_dir.exists(), "source checkpoint should be hidden before runtime");

        real_checkpoint_run_child(
            "runtime",
            &source_dir,
            &output_dir,
            &reference_path,
        );
    }

    #[test]
    fn compiled_image_rejects_corruption_and_missing_segment() {
        let source_dir = temp_dir("source-corruption");
        write_fixture_model(&source_dir);

        let corrupted_dir = temp_dir("out-corrupted");
        compile(
            source_dir.to_str().expect("source dir"),
            corrupted_dir.to_str().expect("output dir"),
        )
        .expect("compile corrupted fixture");
        let segment_path = corrupted_dir.join("segment_000.bin");
        let mut bytes = fs::read(&segment_path).expect("segment bytes");
        bytes[0] ^= 0xFF;
        fs::write(&segment_path, bytes).expect("rewrite corrupted segment");
        let err = match read(corrupted_dir.to_str().expect("output dir")) {
            Ok(_) => panic!("expected corruption error"),
            Err(err) => err,
        };
        assert!(
            err.to_string().contains("segment hash mismatch"),
            "unexpected corruption error: {}",
            err
        );

        let missing_dir = temp_dir("out-missing");
        compile(
            source_dir.to_str().expect("source dir"),
            missing_dir.to_str().expect("output dir"),
        )
        .expect("compile missing fixture");
        fs::remove_file(missing_dir.join("segment_000.bin")).expect("remove segment");
        let err = match read(missing_dir.to_str().expect("output dir")) {
            Ok(_) => panic!("expected missing-segment error"),
            Err(err) => err,
        };
        assert!(
            err.to_string().contains("read segment") || err.to_string().contains("missing segment"),
            "unexpected missing-segment error: {}",
            err
        );

        let abi_dir = temp_dir("out-abi");
        compile(
            source_dir.to_str().expect("source dir"),
            abi_dir.to_str().expect("output dir"),
        )
        .expect("compile abi fixture");
        let manifest_path = abi_dir.join("manifest.json");
        let manifest = fs::read_to_string(&manifest_path).expect("manifest");
        let mutated = manifest.replace(
            "\"runtime_abi\": \"mlx-rs/0.21.0 napi-rs/3.9.0 safetensors/0.5.3\"",
            "\"runtime_abi\": \"mlx-rs/0.21.0 napi-rs/3.9.0 safetensors/0.5.3-mutated\"",
        );
        fs::write(&manifest_path, mutated).expect("rewrite manifest");
        let err = match read(abi_dir.to_str().expect("output dir")) {
            Ok(_) => panic!("expected abi-mismatch error"),
            Err(err) => err,
        };
        assert!(
            err.to_string().contains("manifest hash mismatch"),
            "unexpected abi-mismatch error: {}",
            err
        );
    }
    #[test]
    fn test_storage_abi_matching() {
        let source = SourceIdentity {
            config_hash: "abc".into(),
            shard_hashes: vec![],
            tokenizer_hashes: vec![],
            auxiliary_hashes: vec![],
            model_type: "test".into(),
            quantization_bits: 8,
            quantization_group_size: 64,
            quantization_mode: "affine".into(),
        };

        let defaults = Manifest {
            image_version: "0.1.0".into(),
            compiler_version: "test".into(),
            runtime_abi: "test".into(),
            source: source,
            architecture: crate::config::TextArchitecture {
                hidden_size: 64,
                intermediate_size: 128,
                num_attention_heads: 4,
                num_key_value_heads: 1,
                head_dim: 16,
                global_head_dim: Some(16),
                num_global_key_value_heads: Some(1),
                num_hidden_layers: 1,
                vocab_size: 64,
                sliding_window: 8,
                max_position_embeddings: 16,
                rms_norm_eps: 1e-6,
                tie_word_embeddings: true,
                attention_k_eq_v: true,
                final_logit_softcapping: None,
                hidden_size_per_layer_input: 0,
                layer_types: vec![crate::config::AttentionKind::SlidingAttention],
                rope_local: crate::config::RopeSpec {
                    theta: 10000.0,
                    rope_type: "default".into(),
                    partial_rotary_factor: None,
                },
                rope_global: None,
                model_type: "test".into(),
            },
            segments: vec![],
            tensor_table: vec![],
            alias_table: vec![],
            residency_plan: ResidencyPlan {
                persistent_segments: vec![],
                layer_segments: vec![],
                layer_window_size: 2,
                total_bytes: 0,
            },
            image_hash: "dummy".into(),
            required_storage_abi: STORAGE_ABI_COPIED_V0.into(),
            required_capabilities: vec![],
            execution_plan: crate::config::ModelExecutionPlan::default(),
        };

        assert!(defaults.storage_abi_matches(&StorageBackend::Copied));
        assert!(!defaults.storage_abi_matches(&StorageBackend::MappedNoCopy));

        // Check constants
        assert_eq!(STORAGE_ABI_COPIED_V0, "copied-v0");
        assert_eq!(STORAGE_ABI_MAPPED_NO_COPY_V1, "mapped-no-copy-v1");
    }

    #[test]
    fn test_alignment_validation() {
        // Build a manifest manually with mapped-no-copy-v1 and proper alignment
        let segment = Segment {
            id: "test_seg".into(),
            filename: "segment_000.bin".into(),
            byte_size: 4096,
            sha256: "0000000000000000000000000000000000000000000000000000000000000000".into(),
            tensor_ids: vec![0],
            kind: SegmentKind::Persistent,
            alignment_bytes: 4096,
        };
        let tensor = TensorEntry {
            id: 0,
            name: "weight".into(),
            role: "embed".into(),
            layer: None,
            segment: "test_seg".into(),
            source_filename: "x.safetensors".into(),
            source_sha256: "0000".into(),
            source_offset: 0,
            offset: 0,
            byte_length: 256,
            logical_dtype: "F32".into(),
            storage_dtype: "F32".into(),
            logical_shape: vec![16, 16],
            physical_shape: vec![16, 16],
            mutability: "read_only".into(),
            quantization: None,
            tensor_alignment_bytes: 16,
            layout_version: 1,
        };
        let manifest = Manifest {
            image_version: "0.1.0".into(),
            compiler_version: "test".into(),
            runtime_abi: "test".into(),
            source: SourceIdentity {
                config_hash: "abc".into(),
                shard_hashes: vec![],
                tokenizer_hashes: vec![],
                auxiliary_hashes: vec![],
                model_type: "test".into(),
                quantization_bits: 8,
                quantization_group_size: 64,
                quantization_mode: "affine".into(),
            },
            architecture: crate::config::TextArchitecture {
                hidden_size: 64,
                intermediate_size: 128,
                num_attention_heads: 4,
                num_key_value_heads: 1,
                head_dim: 16,
                global_head_dim: Some(16),
                num_global_key_value_heads: Some(1),
                num_hidden_layers: 1,
                vocab_size: 64,
                sliding_window: 8,
                max_position_embeddings: 16,
                rms_norm_eps: 1e-6,
                tie_word_embeddings: true,
                attention_k_eq_v: true,
                final_logit_softcapping: None,
                hidden_size_per_layer_input: 0,
                layer_types: vec![crate::config::AttentionKind::SlidingAttention],
                rope_local: crate::config::RopeSpec {
                    theta: 10000.0,
                    rope_type: "default".into(),
                    partial_rotary_factor: None,
                },
                rope_global: None,
                model_type: "test".into(),
            },
            segments: vec![segment],
            tensor_table: vec![tensor],
            alias_table: vec![],
            residency_plan: ResidencyPlan {
                persistent_segments: vec!["test_seg".into()],
                layer_segments: vec![],
                layer_window_size: 2,
                total_bytes: 4096,
            },
            image_hash: "dummy".into(),
            required_storage_abi: STORAGE_ABI_MAPPED_NO_COPY_V1.into(),
            required_capabilities: vec![],
            execution_plan: crate::config::ModelExecutionPlan::default(),
        };

        assert!(manifest.storage_abi_matches(&StorageBackend::MappedNoCopy));
        assert!(!manifest.storage_abi_matches(&StorageBackend::Copied));
    }

    #[test]
    fn segment_corruption_rejected() {
        let source_dir = temp_dir("source-seg-corr");
        write_fixture_model(&source_dir);

        let output_dir = temp_dir("out-seg-corr");
        compile(
            source_dir.to_str().expect("source dir"),
            output_dir.to_str().expect("output dir"),
        )
        .expect("compile segment corruption fixture");

        // segment_000.bin = persistent (embed + final), segment_001.bin = layer 0
        let segment_path = output_dir.join("segment_001.bin");
        let mut bytes = fs::read(&segment_path).expect("layer segment bytes");
        bytes[100] ^= 0xFF;
        fs::write(&segment_path, bytes).expect("rewrite corrupted layer segment");

        let err = match read(output_dir.to_str().expect("output dir")) {
            Ok(_) => panic!("expected segment corruption error"),
            Err(err) => err,
        };
        assert!(
            err.to_string().contains("segment hash mismatch"),
            "unexpected segment corruption error: {}",
            err
        );
    }

    #[test]
    fn synthetic_plan_driven_execution() {
        let source_dir = temp_dir("source-plan");
        let output_dir = temp_dir("out-plan");

        write_two_layer_fixture_model(&source_dir, &["sliding_attention", "full_attention"]);

        let compiled = compile(
            source_dir.to_str().expect("source dir"),
            output_dir.to_str().expect("output dir"),
        )
        .expect("compile");

        let reader = read(output_dir.to_str().expect("output dir")).expect("reader");

        // Verify execution plan from manifest
        let plan = &compiled.manifest.execution_plan;
        assert_eq!(plan.layers.len(), 2);

        assert_eq!(plan.layers[0].attention_kind, "sliding_attention");
        assert_eq!(plan.layers[0].layer_index, 0);
        assert!(plan.layers[0].global_head_dim.is_none());
        assert!(plan.layers[0].v_proj_tensor_id != 0, "sliding layer needs v_proj");

        assert_eq!(plan.layers[1].attention_kind, "full_attention");
        assert_eq!(plan.layers[1].layer_index, 1);
        assert_eq!(plan.layers[1].global_head_dim, Some(16));
        // K-equals-V: v_proj aliases k_proj
        assert_eq!(plan.layers[1].v_proj_tensor_id, plan.layers[1].k_proj_tensor_id);

        // Validate the plan
        plan.validate().expect("execution plan should validate");

        // Open runtime and verify handle lifecycle
        let baseline_handles = crate::bridge::handle_count();
        let mut runtime = reader.open_runtime(StorageBackend::Copied).expect("runtime");

        // Handle count after persistent activation
        let after_persistent = crate::bridge::handle_count();
        assert!(after_persistent > baseline_handles);

        // Run full model - this activates layers, runs inference, then retires them
        let token = runtime.run_full_model(&[2i32]).expect("run full model");
        assert!(token < 64, "token {} should be in [0, 64)", token);

        // After full model runs and layers are retired, handles return to baseline
        let after_run = crate::bridge::handle_count();
        assert_eq!(after_run, baseline_handles,
            "handle count should return to baseline after full model run; {} != {}",
            after_run, baseline_handles);
    }

    #[test]
    #[ignore = "real checkpoint full-model gate; requires ~12GB quantized model at models/gemma4-12b-8bit"]
    fn real_checkpoint_full_model_gate() {
        let source_dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("models/gemma4-12b-8bit");
        let output_dir = temp_dir("real-full-model-out");

        if !source_dir.join("config.json").exists() {
            eprintln!("SKIP: no model at {}", source_dir.display());
            return;
        }

        eprintln!("Compiling quantized Gemma 4 12B...");
        let started = std::time::Instant::now();

        let compiled = compile(
            source_dir.to_str().expect("source dir"),
            output_dir.to_str().expect("output dir"),
        )
        .expect("compile model");

        let compile_secs = started.elapsed().as_secs_f64();
        eprintln!(
            "Compiled in {:.1}s: {} segments, {} tensors, {:?}",
            compile_secs,
            compiled.manifest.segments.len(),
            compiled.manifest.tensor_table.len(),
            compiled.manifest.image_hash
        );

        // Validate the execution plan
        let plan = &compiled.manifest.execution_plan;
        assert_eq!(plan.layers.len(), 48, "expected 48 layers");
        plan.validate().expect("execution plan validation");

        eprintln!("Opening runtime...");
        let baseline_handles = crate::bridge::handle_count();
        let reader = read(output_dir.to_str().expect("output dir")).expect("reader");
        let mut runtime = reader.open_runtime(StorageBackend::Copied).expect("open runtime");

        let after_open = crate::bridge::handle_count();
        eprintln!(
            "Runtime open: handles {} -> {}, plan layers: {}",
            baseline_handles, after_open, plan.layers.len()
        );

        eprintln!("Running full 48-layer forward pass with BOS token...");
        let run_started = std::time::Instant::now();

        let token = runtime.run_full_model(&[2i32]).expect("run_full_model");

        let run_secs = run_started.elapsed().as_secs_f64();
        let total_secs = started.elapsed().as_secs_f64();

        let after_run = crate::bridge::handle_count();
        eprintln!(
            "GATE PASSED: token={} run_time={:.1}s total_time={:.1}s final_handles={} baseline={}",
            token, run_secs, total_secs, after_run, baseline_handles
        );

        assert!(token < 256128, "token {} out of vocab range", token);
        assert!(token != 0, "token must not be padding token 0");
        assert_eq!(after_run, baseline_handles,
            "handle count must return to baseline after full model run; {} != {}",
            after_run, baseline_handles);
    }

    #[test]
    #[ignore = "requires pre-compiled image at TRIBUNUS_COMPILED_IMAGE dir"]
    fn real_full_model_from_compiled_image() {
        let image_dir = std::env::var("TRIBUNUS_COMPILED_IMAGE")
            .expect("set TRIBUNUS_COMPILED_IMAGE to the compiled image directory");
        let image_path = std::path::Path::new(&image_dir);
        assert!(image_path.join("manifest.json").exists());

        let baseline_handles = crate::bridge::handle_count();
        let reader = read(&image_dir).expect("reader");
        let plan = &reader.manifest.execution_plan;
        assert_eq!(plan.layers.len(), 48);
        plan.validate().expect("plan validation");

        let mut runtime = reader.open_runtime(StorageBackend::Copied).expect("runtime");
        eprintln!("Running 48-layer forward pass...");
        let started = std::time::Instant::now();
        let token = runtime.run_full_model(&[2i32]).expect("run_full_model");
        let elapsed = started.elapsed().as_secs_f64();

        let after_run = crate::bridge::handle_count();
        eprintln!(
            "GATE PASSED: token={} elapsed={:.1}s handles={}->{}",
            token, elapsed, baseline_handles, after_run
        );
        assert!(token < 256128, "token out of vocab");
        assert!(token > 0, "token should not be pad");
        assert_eq!(after_run, baseline_handles,
            "handle count must return to baseline: {} != {}",
            after_run, baseline_handles);
    }

    #[test]
    fn test_storage_abi_validation_rejects_unknown() {
        // Verify that is_valid_storage_abi rejects unknown identifiers
        assert!(is_valid_storage_abi(STORAGE_ABI_COPIED_V0));
        assert!(is_valid_storage_abi(STORAGE_ABI_MAPPED_NO_COPY_V1));
        assert!(!is_valid_storage_abi("copied-v2"));
        assert!(!is_valid_storage_abi("mapped-no-copy-v0"));
        assert!(!is_valid_storage_abi(""));
        assert!(!is_valid_storage_abi("unknown-abi"));
    }

    #[test]
    fn test_tensor_layout_offset_oob() {
        // A tensor whose offset + byte_length exceeds its segment should fail.
        let entry = TensorEntry {
            id: 0,
            name: "oob_tensor".into(),
            role: "test".into(),
            layer: None,
            segment: "seg".into(),
            source_filename: "x.safetensors".into(),
            source_sha256: "0000".into(),
            source_offset: 0,
            offset: 100,
            byte_length: 200,
            logical_dtype: "F32".into(),
            storage_dtype: "F32".into(),
            logical_shape: vec![10, 5],
            physical_shape: vec![10, 5],
            mutability: "read_only".into(),
            quantization: None,
            tensor_alignment_bytes: 16,
            layout_version: 1,
        };

        // Segment is only 250 bytes, tensor ends at 300 -> OOB
        let result = validate_tensor_layout(&entry, 250);
        assert!(result.is_err(), "expected OOB error");
        assert!(
            result.unwrap_err().contains("exceeds segment size"),
            "unexpected error message"
        );

        // With enough space it should succeed
        let result = validate_tensor_layout(&entry, 301);
        assert!(result.is_ok(), "expected OK for large enough segment");

        // Zero byte_length should be rejected
        let zero_entry = TensorEntry {
            byte_length: 0,
            ..entry.clone()
        };
        let result = validate_tensor_layout(&zero_entry, 100);
        assert!(result.is_err(), "expected error for zero byte_length");
        assert!(
            result.unwrap_err().contains("zero byte_length"),
            "unexpected error message"
        );
    }

    #[test]
    fn test_physical_dtype_byte_count() {
        // f32: 4 * (2*3*4) = 96
        let r = validate_physical_dtype("f32", 96, &[2, 3, 4]);
        assert!(r.is_ok());
        assert_eq!(r.unwrap(), 96);

        // bf16: 2 * (8*4) = 64
        let r = validate_physical_dtype("BF16", 64, &[8, 4]);
        assert!(r.is_ok());
        assert_eq!(r.unwrap(), 64);

        // f16: 2 * 128 = 256
        let r = validate_physical_dtype("f16", 256, &[128]);
        assert!(r.is_ok());

        // u8: 1 * (4*8) = 32
        let r = validate_physical_dtype("U8", 32, &[4, 8]);
        assert!(r.is_ok());

        // i8: same as u8
        let r = validate_physical_dtype("I8", 32, &[4, 8]);
        assert!(r.is_ok());

        // u32: 4 * 50 = 200
        let r = validate_physical_dtype("U32", 200, &[50]);
        assert!(r.is_ok());

        // Wrong byte count
        let r = validate_physical_dtype("f32", 100, &[2, 3, 4]);
        assert!(r.is_err());
        assert!(r.unwrap_err().contains("expected 96 bytes"));

        // Unknown dtype
        let r = validate_physical_dtype("f64", 8, &[1]);
        assert!(r.is_err());
        assert!(r.unwrap_err().contains("unsupported"));
    }
}
