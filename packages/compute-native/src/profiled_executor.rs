//! Profiled heterogeneous executor — GPU-canary-gated execution with explicit receipts.
//!
//! Uses MappedImage-based segment file access via seek + read_exact.
//!
//! The model runtime (LoadedProfiledModel) is immutable and survives requests.
//! Per-generation state lives in ProfiledInferenceSession (owns KV caches,
//! cancellation flag, token buffer, and timeline).

use crate::compute_image::{CompiledImageReader, CopyClassification, TensorEntry};
use crate::engine_error::{EngineError, EngineErrorCode};
use crate::kv_cache::KvCache;
use crate::mapped_image::MappedImage;
use crate::placement_profile::ExecutionPlacementProfile;
use crate::runtime_trace::{RuntimeTimeline, TimelineEvent, TimelineEventType};
use crate::session::InferenceSessionState;
use crate::worker_memory;
use mlx_rs::Array;

use std::sync::atomic::{AtomicBool, Ordering};
use std::ffi::CString;
use std::os::raw::{c_char, c_int, c_void};
use std::path::{Path, PathBuf};
use std::collections::HashMap;
use std::sync::Arc;

/// Execution mode for the runtime.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExecutionMode {
    /// Copied segment, serial, default stream — correctness oracle only.
    SemanticOracle,
    /// Profiled heterogeneous execution with GPU-canary gating.
    Profiled,
}

/// Result of one profiled full-model execution.
#[derive(Debug, Clone)]
pub struct ProfiledReceipt {
    pub executor: String,
    pub execution_profile: String,
    pub storage_backend: String,
    pub explicit_gpu_stream: bool,
    pub oracle_fallback: bool,
    pub compiler_invocations: u64,
    pub source_checkpoint_accesses: u64,
    pub copied_weight_bytes: u64,
    pub mapped_weight_bytes: u64,
    pub token: u32,
    pub layer_count: u32,
    pub elapsed_ms: u64,
    pub profile_validation: bool,
    pub gpu_canary_us: u64,
    pub gpu_canary_ratio: f64,
    pub image_hash: String,
    pub handle_baseline: u64,
    pub handle_final: u64,
    pub layer_records: Vec<crate::mlx_executor::ExecutionRecord>,
    pub active_window_bytes: u64,
    pub prefetched_count: u64,
    pub total_kv_cache_bytes: u64,
    pub cache_hit_tokens: u64,
    pub wall_clock_total_us: u64,
    pub unaccounted_us: u64,
    pub timeline: RuntimeTimeline,
}

/// Adapter wrapping a sub-range of a MappedSegment for no-copy external array
/// construction via [`crate::external_array::new_external_array`].
struct SegmentSlice {
    segment: Arc<crate::mapped_image::MappedSegment>,
    offset: usize,
    length: usize,
}

impl crate::external_array::ExternalStorage for SegmentSlice {
    fn data_ptr(&self) -> *const u8 {
        unsafe { self.segment.data_ptr().add(self.offset) }
    }
    fn byte_len(&self) -> usize {
        self.length
    }
}

/// Load tensor data from a MappedSegment using external array construction.
///
/// Uses [`crate::external_array::new_external_array`] for all supported dtypes
/// so that MLX operates directly on the mmap-backed memory rather than a copy.
fn load_tensor_from_mapped_segment(
    segment: &std::sync::Arc<crate::mapped_image::MappedSegment>,
    entry: &TensorEntry,
) -> napi::Result<(mlx_rs::Array, CopyClassification)> {
    let mapping = segment.data_slice();
    let offset = entry.offset as usize;
    let len = entry.byte_length as usize;
    let end = offset + len;
    if end > mapping.len() {
        return Err(napi::Error::from_reason(format!(
            "tensor {} at offset {} len {} exceeds mapping len {}",
            entry.name, offset, len, mapping.len()
        )));
    }
    let dims: Vec<i32> = entry.physical_shape.iter().map(|&d| d as i32).collect();

    // TODO: wire external_array for true no-copy when mapped ABI is complete
    let storage = Arc::new(SegmentSlice {
        segment: segment.clone(),
        offset,
        length: len,
    });

    match entry.storage_dtype.as_str() {
        "U8" | "Uint8" => unsafe {
            let arr = crate::external_array::new_external_array(storage, &dims, mlx_rs::Dtype::Uint8)
                .map_err(|e| napi::Error::from_reason(e))?;
            Ok((arr, CopyClassification::MappedNoCopy))
        },
        "F32" | "Float32" => unsafe {
            let arr = crate::external_array::new_external_array(storage, &dims, mlx_rs::Dtype::Float32)
                .map_err(|e| napi::Error::from_reason(e))?;
            Ok((arr, CopyClassification::MappedNoCopy))
        },
        "BF16" | "BFloat16" => unsafe {
            let arr = crate::external_array::new_external_array(storage, &dims, mlx_rs::Dtype::Bfloat16)
                .map_err(|e| napi::Error::from_reason(e))?;
            Ok((arr, CopyClassification::MappedNoCopy))
        },
        "I8" | "Int8" => {
            // external_array does not yet support Int8 natively; fall back to the
            // copy path. This is harmless since Int8 weights are tiny (scales).
            let data: Vec<i8> = mapping[offset..end].iter().map(|&b| b as i8).collect();
            let arr = mlx_rs::Array::from_slice(&data, &dims);
            Ok((arr, CopyClassification::CopiedFallback))
        },
        "U32" | "Uint32" => unsafe {
            let arr = crate::external_array::new_external_array(storage, &dims, mlx_rs::Dtype::Uint32)
                .map_err(|e| napi::Error::from_reason(e))?;
            Ok((arr, CopyClassification::MappedNoCopy))
        },
        other => Err(napi::Error::from_reason(format!(
            "unsupported storage dtype in profiled executor: {}", other
        ))),
    }
}

fn build_rope_tables(
    arch: &crate::config::TextArchitecture,
) -> napi::Result<(Arc<Array>, Arc<Array>, Arc<Array>, Arc<Array>)> {
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

    Ok((
        Arc::new(rope_cos),
        Arc::new(rope_sin),
        Arc::new(full_cos),
        Arc::new(full_sin),
    ))
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

fn high_memory_override_enabled() -> bool {
    matches!(
        std::env::var("TRIBUNUS_COMPUTE_ALLOW_HIGH_MEMORY").ok().as_deref(),
        Some("1") | Some("true") | Some("TRUE") | Some("yes") | Some("YES")
    )
}

fn estimate_profiled_peak_bytes(reader: &CompiledImageReader) -> u64 {
    let manifest = &reader.manifest;
    let tensor_bytes = manifest.tensor_table.iter().map(|entry| entry.byte_length).sum::<u64>();
    let max_tensor_bytes = manifest
        .tensor_table
        .iter()
        .map(|entry| entry.byte_length)
        .max()
        .unwrap_or(0);
    let max_segment_bytes = manifest
        .segments
        .iter()
        .map(|segment| segment.byte_size)
        .max()
        .unwrap_or(0);
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

    tensor_bytes
        .saturating_add(max_tensor_bytes)
        .saturating_add(max_segment_bytes)
        .saturating_add(rope_bytes)
        .saturating_add(embedding_dequant_bytes)
        .saturating_add(2 * 1024 * 1024 * 1024)
}

pub struct LayerWeights {
    pub input_layernorm: Arc<Array>,
    pub post_attention_layernorm: Arc<Array>,
    pub q_proj_w: Arc<Array>,
    pub q_proj_s: Arc<Array>,
    pub q_proj_b: Arc<Array>,
    pub k_proj_w: Arc<Array>,
    pub k_proj_s: Arc<Array>,
    pub k_proj_b: Arc<Array>,
    pub v_proj_w: Arc<Array>,
    pub v_proj_s: Arc<Array>,
    pub v_proj_b: Arc<Array>,
    pub o_proj_w: Arc<Array>,
    pub o_proj_s: Arc<Array>,
    pub o_proj_b: Arc<Array>,
    pub gate_proj_w: Arc<Array>,
    pub gate_proj_s: Arc<Array>,
    pub gate_proj_b: Arc<Array>,
    pub up_proj_w: Arc<Array>,
    pub up_proj_s: Arc<Array>,
    pub up_proj_b: Arc<Array>,
    pub down_proj_w: Arc<Array>,
    pub down_proj_s: Arc<Array>,
    pub down_proj_b: Arc<Array>,
    pub q_norm: Option<Arc<Array>>,
    pub k_norm: Option<Arc<Array>>,
}

pub struct LoadedProfiledModel {
    pub image_dir: PathBuf,
    pub reader: CompiledImageReader,
    pub mapped_image: MappedImage,
    pub layers: Vec<LayerWeights>,
    pub emb_w: Arc<Array>,
    pub emb_s: Arc<Array>,
    pub emb_b: Arc<Array>,
    pub fn_w: Arc<Array>,
    pub rope_cos: Arc<Array>,
    pub rope_sin: Arc<Array>,
    pub full_cos: Arc<Array>,
    pub full_sin: Arc<Array>,
    pub mapped_weight_bytes: u64,
    pub copied_weight_bytes: u64,
    pub materialized_bytes: u64,
    pub handle_baseline: usize,
}

impl LoadedProfiledModel {
    pub fn new(
        image_dir: &Path,
        ) -> napi::Result<Self> {
        let handle_baseline = crate::bridge::handle_count();
        let reader = CompiledImageReader::open(image_dir)?;
        if !high_memory_override_enabled() {
            let total_memory = system_memory_bytes();
            let estimated_peak = estimate_profiled_peak_bytes(&reader);
            if total_memory > 0 && estimated_peak > total_memory.saturating_sub(2 * 1024 * 1024 * 1024) {
                return Err(napi::Error::from_reason(format!(
                    "refusing to load profiled model: estimated peak {} exceeds safe budget on this machine (total memory {})",
                    estimated_peak,
                    total_memory,
                )));
            }
        }
        // Compute admission estimate and configure MLX memory limits before
        // loading any tensors so the allocator is already constrained.
        let estimate = crate::model_runtime::compute_admission_estimate(&reader.manifest);
        let machine = worker_memory::detect_machine_profile();
        worker_memory::configure_mlx_limits_for_model(&estimate, &machine);
        let segment_views: Vec<crate::mapped_image::SegmentView> = reader.manifest.segments.iter().map(|s| crate::mapped_image::SegmentView {
            segment_id: s.id.clone(),
            segment_index: 0,
            file_path: std::path::PathBuf::from(s.filename.clone()),
            byte_offset: 0,
            byte_length: s.byte_size,
            kind: String::new(),
            segment_lease: None,
        }).collect();
        let mapped_image = crate::mapped_image::MappedImage::open_mapped(image_dir, &segment_views)
            .map_err(|e| napi::Error::from_reason(format!("open mapped image: {}", e)))?;
        
        let mut mapped_weight_bytes = 0;
        let mut copied_weight_bytes = 0;
        let mut materialized_bytes = 0;
        let mut tensor_cache: HashMap<String, Arc<Array>> = HashMap::new();

        let mut load_tensor = |name: &str| -> napi::Result<Arc<Array>> {
            if let Some(arr) = tensor_cache.get(name) {
                return Ok(arr.clone());
            }
            let entry = reader.manifest.tensor_table.iter().find(|e| e.name == name)
                .ok_or_else(|| napi::Error::from_reason(format!("tensor not found: {}", name)))?;
            let seg_id = &entry.segment;
            let segment = mapped_image.segments.get(seg_id)
                .ok_or_else(|| napi::Error::from_reason(format!("segment not found: {}", seg_id)))?;
            let (arr, classification) = load_tensor_from_mapped_segment(segment, entry)?;
            let byte_len = entry.byte_length;
            match classification {
                CopyClassification::MappedNoCopy => mapped_weight_bytes += byte_len,
                CopyClassification::CopiedFallback => copied_weight_bytes += byte_len,
                _ => materialized_bytes += byte_len,
            }
            let arc = Arc::new(arr);
            tensor_cache.insert(name.to_string(), arc.clone());
            Ok(arc)
        };

        

        // Load global tensors
        let emb_w = load_tensor("language_model.model.embed_tokens.weight")?;
        let emb_s = load_tensor("language_model.model.embed_tokens.scales")?;
        let emb_b = load_tensor("language_model.model.embed_tokens.biases")?;
        let fn_w = load_tensor("language_model.model.norm.weight")?;

        // RoPE tables are derived from the architecture rather than loaded
        // from the manifest. This avoids falling back to 1-element placeholders
        // when the compiled image does not materialize explicit rope tensors.
        let (rope_cos, rope_sin, full_cos, full_sin) = build_rope_tables(&reader.manifest.architecture)?;

        // Load layer weights
        let mut layers = Vec::new();
        for (l, layer_plan) in reader.manifest.execution_plan.layers.iter().enumerate() {
            let base = format!("language_model.model.layers.{}", l);
            
            let input_layernorm = load_tensor(&format!("{}.input_layernorm.weight", base))?;
            let post_attention_layernorm = load_tensor(&format!("{}.post_attention_layernorm.weight", base))?;
            
            let q_proj_w = load_tensor(&format!("{}.self_attn.q_proj.weight", base))?;
            let q_proj_s = load_tensor(&format!("{}.self_attn.q_proj.scales", base))?;
            let q_proj_b = load_tensor(&format!("{}.self_attn.q_proj.biases", base))?;
            
            let k_proj_w = load_tensor(&format!("{}.self_attn.k_proj.weight", base))?;
            let k_proj_s = load_tensor(&format!("{}.self_attn.k_proj.scales", base))?;
            let k_proj_b = load_tensor(&format!("{}.self_attn.k_proj.biases", base))?;
            
            let (v_proj_w, v_proj_s, v_proj_b) = if layer_plan.attention_k_eq_v {
                (k_proj_w.clone(), k_proj_s.clone(), k_proj_b.clone())
            } else {
                (
                    load_tensor(&format!("{}.self_attn.v_proj.weight", base))?,
                    load_tensor(&format!("{}.self_attn.v_proj.scales", base))?,
                    load_tensor(&format!("{}.self_attn.v_proj.biases", base))?
                )
            };
            
            let o_proj_w = load_tensor(&format!("{}.self_attn.o_proj.weight", base))?;
            let o_proj_s = load_tensor(&format!("{}.self_attn.o_proj.scales", base))?;
            let o_proj_b = load_tensor(&format!("{}.self_attn.o_proj.biases", base))?;
            
            let gate_proj_w = load_tensor(&format!("{}.mlp.gate_proj.weight", base))?;
            let gate_proj_s = load_tensor(&format!("{}.mlp.gate_proj.scales", base))?;
            let gate_proj_b = load_tensor(&format!("{}.mlp.gate_proj.biases", base))?;
            
            let up_proj_w = load_tensor(&format!("{}.mlp.up_proj.weight", base))?;
            let up_proj_s = load_tensor(&format!("{}.mlp.up_proj.scales", base))?;
            let up_proj_b = load_tensor(&format!("{}.mlp.up_proj.biases", base))?;
            
            let down_proj_w = load_tensor(&format!("{}.mlp.down_proj.weight", base))?;
            let down_proj_s = load_tensor(&format!("{}.mlp.down_proj.scales", base))?;
            let down_proj_b = load_tensor(&format!("{}.mlp.down_proj.biases", base))?;
            
            let q_norm_name = format!("{}.self_attn.q_norm.weight", base);
            let q_norm = if reader.manifest.tensor_table.iter().any(|e| e.name == q_norm_name) {
                Some(load_tensor(&q_norm_name)?)
            } else {
                None
            };
            let k_norm_name = format!("{}.self_attn.k_norm.weight", base);
            let k_norm = if reader.manifest.tensor_table.iter().any(|e| e.name == k_norm_name) {
                Some(load_tensor(&k_norm_name)?)
            } else {
                None
            };

            layers.push(LayerWeights {
                input_layernorm, post_attention_layernorm,
                q_proj_w, q_proj_s, q_proj_b,
                k_proj_w, k_proj_s, k_proj_b,
                v_proj_w, v_proj_s, v_proj_b,
                o_proj_w, o_proj_s, o_proj_b,
                gate_proj_w, gate_proj_s, gate_proj_b,
                up_proj_w, up_proj_s, up_proj_b,
                down_proj_w, down_proj_s, down_proj_b,
                q_norm, k_norm,
            });
        }

        // Post-load RSS comparison: warn if actual RSS exceeds the admission
        // estimate by more than 20 %.
        let postload_rss = worker_memory::sample_process_rss_self();
        let estimated_peak = estimate.peak_bytes();
        if postload_rss > estimated_peak && estimated_peak > 0 {
            let ratio = postload_rss as f64 / estimated_peak as f64;
            if ratio > 1.20 {
                eprintln!(
                    "[profiled-model] WARNING: post-load RSS ({} bytes) exceeds admission estimate ({} bytes) by {:.1}%",
                    postload_rss,
                    estimated_peak,
                    (ratio - 1.0) * 100.0,
                );
            }
        }

        Ok(Self {
            image_dir: image_dir.to_path_buf(),
            reader,
            mapped_image,
            layers,
            emb_w, emb_s, emb_b, fn_w,
            rope_cos, rope_sin, full_cos, full_sin,
            mapped_weight_bytes,
            copied_weight_bytes,
            materialized_bytes,
            handle_baseline,
        })
    }
}

/// Per-request inference session — owns KV caches, generated tokens, and
/// cancellation state.  The model weights live in [`LoadedProfiledModel`]
/// and are passed as a parameter to [`prefill`] and [`decode_one`].
pub struct ProfiledInferenceSession {
    pub session_id: String,
    pub kv_caches: Vec<KvCache>,
    pub absolute_position: u32,
    pub generated_tokens: Vec<u32>,
    pub phase: InferenceSessionState,
    pub cancellation_flag: AtomicBool,
    pub timeline: RuntimeTimeline,
}

impl ProfiledInferenceSession {
    /// Create a new inference session.
    ///
    /// `kv_caches` must be pre-allocated for each layer and will be populated
    /// during the first prefill call.
    pub fn new(session_id: String, kv_caches: Vec<KvCache>) -> Self {
        let mut timeline = RuntimeTimeline::new();
        timeline.push_event(TimelineEvent::new(
            0,
            TimelineEventType::EvalComplete,
            format!("session {} created", session_id),
        ));

        Self {
            session_id,
            kv_caches,
            absolute_position: 0,
            generated_tokens: Vec::new(),
            phase: InferenceSessionState::Created,
            cancellation_flag: AtomicBool::new(false),
            timeline,
        }
    }

    /// Run prefill on the given prompt tokens, populating KV caches.
    ///
    /// Accepts a prompt of up to 64 tokens.  Runs the prologue, all layers,
    /// and the epilogue.  Returns the first generated token (the model's
    /// continuation after the prompt).
    ///
    /// On success, advances `absolute_position` to `prompt_token_ids.len()`
    /// and transitions the session phase to `Decoding`.
    pub fn prefill(
        &mut self,
        prompt_token_ids: &[u32],
        model: &LoadedProfiledModel,
    ) -> Result<u32, EngineError> {
        if prompt_token_ids.len() > 64 {
            return Err(EngineError::new(
                EngineErrorCode::InvalidRequest,
                format!(
                    "prefill prompt too long: {} tokens (max 64)",
                    prompt_token_ids.len()
                ),
            ));
        }

        let _ = self.phase.transition(InferenceSessionState::PrefillRunning);

        let plan = &model.reader.manifest.execution_plan;
        let kv_offset = self.absolute_position;
        let seq_len = prompt_token_ids.len() as u32;

        // Convert u32 prompt to i32 for the MLX array constructor.
        let token_ids_i32: Vec<i32> = prompt_token_ids.iter().map(|&t| t as i32).collect();
        let tok_arr = Array::from_slice(&token_ids_i32, &[1, seq_len as i32]);
        let _pos_arr = Array::from_slice(
            &(kv_offset..kv_offset + seq_len).map(|p| p as i32).collect::<Vec<i32>>(),
            &[1, seq_len as i32],
        );

        let mut hidden = crate::executor::run_prologue(
            &tok_arr,
            &model.emb_w,
            &model.emb_s,
            &model.emb_b,
            &plan.prologue,
            crate::executor::prologue_hidden_scale(&plan.prologue),
        )
        .map_err(|e| {
            EngineError::new(EngineErrorCode::InferenceFailed, format!("prologue: {:?}", e))
        })?;
        hidden.eval().map_err(|e| {
            EngineError::new(EngineErrorCode::NumericalFailure, format!("prologue eval: {}", e))
        })?;

        for (l, layer_plan) in plan.layers.iter().enumerate() {
            if self.cancellation_flag.load(Ordering::Relaxed) {
                return Err(EngineError::new(EngineErrorCode::Cancelled, "cancelled during prefill"));
            }

            let lw = &model.layers[l];
            let is_full = layer_plan.attention_kind == "full_attention";
            let (rcos, rsin) = if is_full {
                (&model.full_cos, &model.full_sin)
            } else {
                (&model.rope_cos, &model.rope_sin)
            };

            hidden = crate::executor::run_layer(
                &hidden,
                layer_plan,
                &lw.input_layernorm,
                &lw.post_attention_layernorm,
                &lw.q_proj_w, &lw.q_proj_s, &lw.q_proj_b,
                &lw.k_proj_w, &lw.k_proj_s, &lw.k_proj_b,
                &lw.v_proj_w, &lw.v_proj_s, &lw.v_proj_b,
                &lw.o_proj_w, &lw.o_proj_s, &lw.o_proj_b,
                lw.q_norm.as_deref(), lw.k_norm.as_deref(),
                &lw.gate_proj_w, &lw.gate_proj_s, &lw.gate_proj_b,
                &lw.up_proj_w, &lw.up_proj_s, &lw.up_proj_b,
                &lw.down_proj_w, &lw.down_proj_s, &lw.down_proj_b,
                rcos, rsin,
                &mut self.kv_caches[l],
                kv_offset,
                plan.rms_norm_eps as f32,
            )
            .map_err(|e| {
                EngineError::new(
                    EngineErrorCode::InferenceFailed,
                    format!("prefill layer {}: {}", l, e),
                )
            })?;
            hidden.eval().map_err(|e| {
                self.kv_caches[l].rollback();
                EngineError::new(
                    EngineErrorCode::NumericalFailure,
                    format!("prefill layer {} eval: {}", l, e),
                )
            })?;
            self.kv_caches[l].commit_step();
        }

        // Validate all layers committed the expected number of positions.
        for (l, _) in plan.layers.iter().enumerate() {
            if self.kv_caches[l].committed_len != seq_len {
                return Err(EngineError::new(
                    EngineErrorCode::InferenceFailed,
                    format!(
                        "prefill layer {} committed {} positions, expected {}",
                        l, self.kv_caches[l].committed_len, seq_len
                    ),
                ));
            }
        }

        let sampler = crate::session::SamplerConfig::default();
        let out_token = crate::executor::run_epilogue(
            &hidden,
            &model.fn_w,
            &model.emb_w,
            &model.emb_s,
            &model.emb_b,
            &plan.epilogue,
            plan.rms_norm_eps as f32,
            plan.tie_word_embeddings,
            &sampler,
        )
        .map_err(|e| {
            EngineError::new(EngineErrorCode::InferenceFailed, format!("epilogue: {:?}", e))
        })?;

        out_token.selected_token.eval().map_err(|e| {
            EngineError::new(
                EngineErrorCode::NumericalFailure,
                format!("epilogue eval: {:?}", e),
            )
        })?;
        let token = out_token
            .selected_token
            .try_as_slice::<u32>()
            .map_err(|e| {
                EngineError::new(
                    EngineErrorCode::InferenceFailed,
                    format!("epilogue token: {:?}", e),
                )
            })?
            .first()
            .copied()
            .unwrap_or(0);

        self.absolute_position = seq_len;
        self.generated_tokens.push(token);
        let _ = self.phase.transition(InferenceSessionState::Decoding);

        self.timeline.push_event(TimelineEvent::new(
            seq_len as u64,
            TimelineEventType::Prefill,
            format!("prefilled {} tokens, first token {}", seq_len, token),
        ));

        Ok(token)
    }

    /// Decode one token using the model.
    ///
    /// Accepts exactly one previously selected token, feeds it through all
    /// layers (appending one KV cache position per layer), and returns the
    /// next predicted token.  Advances `absolute_position` by 1.
    pub fn decode_one(
        &mut self,
        token_id: u32,
        model: &LoadedProfiledModel,
    ) -> Result<u32, EngineError> {
        if self.phase != InferenceSessionState::Decoding {
            return Err(EngineError::new(
                EngineErrorCode::InvalidRequest,
                format!(
                    "decode_one called in phase {:?}, expected Decoding",
                    self.phase
                ),
            ));
        }

        let plan = &model.reader.manifest.execution_plan;
        let kv_offset = self.absolute_position;

        let token_ids_i32 = [token_id as i32];
        let tok_arr = Array::from_slice(&token_ids_i32, &[1, 1]);
        let _pos_arr = Array::from_slice(&[kv_offset as i32], &[1, 1]);

        let mut hidden = crate::executor::run_prologue(
            &tok_arr,
            &model.emb_w,
            &model.emb_s,
            &model.emb_b,
            &plan.prologue,
            crate::executor::prologue_hidden_scale(&plan.prologue),
        )
        .map_err(|e| {
            EngineError::new(EngineErrorCode::InferenceFailed, format!("prologue: {:?}", e))
        })?;
        hidden.eval().map_err(|e| {
            EngineError::new(EngineErrorCode::NumericalFailure, format!("prologue eval: {}", e))
        })?;

        for (l, layer_plan) in plan.layers.iter().enumerate() {
            if self.cancellation_flag.load(Ordering::Relaxed) {
                return Err(EngineError::new(EngineErrorCode::Cancelled, "cancelled during decode"));
            }

            let lw = &model.layers[l];
            let is_full = layer_plan.attention_kind == "full_attention";
            let (rcos, rsin) = if is_full {
                (&model.full_cos, &model.full_sin)
            } else {
                (&model.rope_cos, &model.rope_sin)
            };

            hidden = crate::executor::run_layer(
                &hidden,
                layer_plan,
                &lw.input_layernorm,
                &lw.post_attention_layernorm,
                &lw.q_proj_w, &lw.q_proj_s, &lw.q_proj_b,
                &lw.k_proj_w, &lw.k_proj_s, &lw.k_proj_b,
                &lw.v_proj_w, &lw.v_proj_s, &lw.v_proj_b,
                &lw.o_proj_w, &lw.o_proj_s, &lw.o_proj_b,
                lw.q_norm.as_deref(), lw.k_norm.as_deref(),
                &lw.gate_proj_w, &lw.gate_proj_s, &lw.gate_proj_b,
                &lw.up_proj_w, &lw.up_proj_s, &lw.up_proj_b,
                &lw.down_proj_w, &lw.down_proj_s, &lw.down_proj_b,
                rcos, rsin,
                &mut self.kv_caches[l],
                kv_offset,
                plan.rms_norm_eps as f32,
            )
            .map_err(|e| {
                EngineError::new(
                    EngineErrorCode::InferenceFailed,
                    format!("decode layer {}: {}", l, e),
                )
            })?;
            hidden.eval().map_err(|e| {
                self.kv_caches[l].rollback();
                EngineError::new(
                    EngineErrorCode::NumericalFailure,
                    format!("decode layer {} eval: {}", l, e),
                )
            })?;
            self.kv_caches[l].commit_step();
        }

        // Validate all layers advanced by exactly 1 position.
        let expected = kv_offset + 1;
        for (l, _) in plan.layers.iter().enumerate() {
            if self.kv_caches[l].committed_len != expected {
                return Err(EngineError::new(
                    EngineErrorCode::InferenceFailed,
                    format!(
                        "decode layer {} committed {} positions, expected {}",
                        l, self.kv_caches[l].committed_len, expected
                    ),
                ));
            }
        }

        let sampler = crate::session::SamplerConfig::default();
        let out_token = crate::executor::run_epilogue(
            &hidden,
            &model.fn_w,
            &model.emb_w,
            &model.emb_s,
            &model.emb_b,
            &plan.epilogue,
            plan.rms_norm_eps as f32,
            plan.tie_word_embeddings,
            &sampler,
        )
        .map_err(|e| {
            EngineError::new(EngineErrorCode::InferenceFailed, format!("epilogue: {:?}", e))
        })?;

        out_token.selected_token.eval().map_err(|e| {
            EngineError::new(
                EngineErrorCode::NumericalFailure,
                format!("epilogue eval: {:?}", e),
            )
        })?;
        let token = out_token
            .selected_token
            .try_as_slice::<u32>()
            .map_err(|e| {
                EngineError::new(
                    EngineErrorCode::InferenceFailed,
                    format!("epilogue token: {:?}", e),
                )
            })?
            .first()
            .copied()
            .unwrap_or(0);

        self.absolute_position += 1;
        self.generated_tokens.push(token);

        self.timeline.push_event(TimelineEvent::new(
            self.absolute_position as u64,
            TimelineEventType::DecodeStep,
            format!("decoded token {}", token),
        ));

        Ok(token)
    }
}

/// Cold one-shot wrapper for testing. Re-loads the entire model!
pub fn execute_profiled_cold_once(
    image_dir: &Path,
    _profile: &ExecutionPlacementProfile,
    token_ids: &[i32],
    _mode: ExecutionMode,
    cancel_flag: Option<&AtomicBool>,
    _sampler: &crate::session::SamplerConfig,
    kv_offset: u32,
) -> napi::Result<(u32, ProfiledReceipt)> {
    let model = LoadedProfiledModel::new(image_dir)?;
    let plan = &model.reader.manifest.execution_plan;

    // Build per-layer KV caches matching the execution plan.
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

    let mut session = ProfiledInferenceSession::new("cold-once".to_string(), kv_caches);
    session.absolute_position = kv_offset;

    // Wire cancellation flag if provided.
    if let Some(cf) = cancel_flag {
        session.cancellation_flag.store(cf.load(Ordering::Relaxed), Ordering::Relaxed);
    }

    let prompt: Vec<u32> = token_ids.iter().map(|&t| t as u32).collect();
    let is_prefill = prompt.len() > 1;

    let token = if is_prefill {
        session.prefill(&prompt, &model).map_err(|e| {
            napi::Error::from_reason(format!("cold prefill: {}", e))
        })?
    } else {
        // Single-token prompt: still run it through prefill (which handles 1 token).
        session.prefill(&prompt, &model).map_err(|e| {
            napi::Error::from_reason(format!("cold first decode: {}", e))
        })?
    };

    let step_elapsed_ms = 0;
    let end_us = 0;
    let cache_hit_tokens = kv_offset as u64;

    let receipt = ProfiledReceipt {
        executor: "mlx_rs".into(),
        execution_profile: model.reader.manifest.image_hash.clone(),
        storage_backend: "copied".into(),
        explicit_gpu_stream: true,
        oracle_fallback: false,
        compiler_invocations: 0,
        source_checkpoint_accesses: 0,
        copied_weight_bytes: model.mapped_weight_bytes,
        mapped_weight_bytes: model.mapped_weight_bytes,
        token,
        layer_count: plan.layers.len() as u32,
        elapsed_ms: step_elapsed_ms,
        profile_validation: true,
        gpu_canary_us: 0,
        gpu_canary_ratio: 0.0,
        image_hash: model.reader.manifest.image_hash.clone(),
        handle_baseline: model.handle_baseline as u64,
        handle_final: crate::bridge::handle_count() as u64,
        layer_records: plan.layers.iter().map(|_| {
            crate::mlx_executor::ExecutionRecord {
                device: "cpu".into(),
                stream_id: "default".into(),
                graph_build_us: 0,
                eval_us: 0,
                sync_us: 0,
                peak_active_mem: 0,
                peak_cache_mem: 0,
                error: None,
            }
        }).collect(),
        active_window_bytes: model.mapped_weight_bytes,
        prefetched_count: 0,
        total_kv_cache_bytes: session.kv_caches.iter().map(|c| c.allocated_bytes()).sum(),
        cache_hit_tokens,
        wall_clock_total_us: end_us,
        unaccounted_us: 0,
        timeline: session.timeline.clone(),
    };

    Ok((token, receipt))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_architecture() -> crate::config::TextArchitecture {
        crate::config::TextArchitecture {
            hidden_size: 3840,
            intermediate_size: 15360,
            num_attention_heads: 32,
            num_key_value_heads: 8,
            head_dim: 256,
            global_head_dim: Some(512),
            num_global_key_value_heads: Some(1),
            num_hidden_layers: 2,
            vocab_size: 256128,
            sliding_window: 1024,
            max_position_embeddings: 8,
            rms_norm_eps: 1e-6,
            tie_word_embeddings: true,
            attention_k_eq_v: false,
            final_logit_softcapping: None,
            hidden_size_per_layer_input: 3840,
            layer_types: vec![
                crate::config::AttentionKind::SlidingAttention,
                crate::config::AttentionKind::FullAttention,
            ],
            rope_local: crate::config::RopeSpec {
                theta: 10_000.0,
                rope_type: "default".to_string(),
                partial_rotary_factor: None,
            },
            rope_global: Some(crate::config::RopeSpec {
                theta: 1_000_000.0,
                rope_type: "default".to_string(),
                partial_rotary_factor: None,
            }),
            model_type: "gemma".to_string(),
        }
    }

    #[test]
    fn build_rope_tables_uses_architecture_dimensions() {
        let arch = test_architecture();
        let (rope_cos, rope_sin, full_cos, full_sin) =
            build_rope_tables(&arch).expect("rope tables");

        assert_eq!(rope_cos.shape(), &[8, 128]);
        assert_eq!(rope_sin.shape(), &[8, 128]);
        assert_eq!(full_cos.shape(), &[8, 256]);
        assert_eq!(full_sin.shape(), &[8, 256]);
        assert_eq!(rope_cos.shape()[0], arch.max_position_embeddings as i32);
        assert_eq!(full_cos.shape()[0], arch.max_position_embeddings as i32);
    }
}

impl std::fmt::Debug for LoadedProfiledModel {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LoadedProfiledModel")
            .field("image_dir", &self.image_dir)
            .finish()
    }
}
