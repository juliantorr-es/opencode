//! Profiled heterogeneous executor — GPU-canary-gated execution with explicit receipts.
//!
//! Uses MappedImage-based segment file access via seek + read_exact.

use crate::compute_image::{CompiledImageReader, TensorEntry};
use crate::kv_cache::KvCache;
use crate::mapped_image::{MappedImage, SegmentState, SegmentView};
use crate::mlx_executor::{run_gpu_canary, MlxExecutor};
use crate::placement_profile::ExecutionPlacementProfile;
use crate::receipts::CopyClassification;
use crate::residency::ResidencyManager;
use crate::runtime_trace::{RuntimeTimeline, TimedRegion, SyncMarker, TimelineEvent, TimelineEventType};
use mlx_rs::Array;
use std::io::{Read, Seek, SeekFrom};
use std::sync::atomic::{AtomicBool, Ordering};
use std::path::{Path, PathBuf};
use std::collections::HashMap;
use std::time::Instant;
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

/// Load tensor data from a MappedImage segment file using seek + read_exact.
fn load_tensor_from_segment_file(
    segment_file: &std::fs::File,
    entry: &TensorEntry,
    byte_counter: &mut u64,
) -> napi::Result<mlx_rs::Array> {
    let mut file = segment_file
        .try_clone()
        .map_err(|e| napi::Error::from_reason(format!("clone file handle: {}", e)))?;
    file.seek(SeekFrom::Start(entry.offset))
        .map_err(|e| napi::Error::from_reason(format!(
            "seek tensor {} at offset {}: {}", entry.name, entry.offset, e
        )))?;
    let mut buf = vec![0u8; entry.byte_length as usize];
    file.read_exact(&mut buf)
        .map_err(|e| napi::Error::from_reason(format!("read tensor {}: {}", entry.name, e)))?;
    *byte_counter += entry.byte_length;
    let dims: Vec<i32> = entry.physical_shape.iter().map(|&d| d as i32).collect();
    match entry.storage_dtype.as_str() {
        "U8" | "Uint8" => Ok(mlx_rs::Array::from_slice(&buf, &dims)),
        "F32" | "Float32" => {
            if buf.len() % 4 != 0 {
                return Err(napi::Error::from_reason(format!(
                    "f32 payload length {} not multiple of 4", buf.len()
                )));
            }
            let data: Vec<f32> = buf
                .chunks_exact(4)
                .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
                .collect();
            Ok(mlx_rs::Array::from_slice(&data, &dims))
        }
        "BF16" | "BFloat16" => {
            if buf.len() % 2 != 0 {
                return Err(napi::Error::from_reason(format!(
                    "bf16 payload length {} not multiple of 2", buf.len()
                )));
            }
            let data: Vec<f32> = buf
                .chunks_exact(2)
                .map(|c| {
                    let bf = u16::from_le_bytes([c[0], c[1]]);
                    f32::from_bits((bf as u32) << 16)
                })
                .collect();
            Ok(mlx_rs::Array::from_slice(&data, &dims))
        }
        "I8" | "Int8" => {
            let data: Vec<i8> = buf.iter().map(|&b| b as i8).collect();
            Ok(mlx_rs::Array::from_slice(&data, &dims))
        }
        "U32" | "Uint32" => {
            let data: Vec<u32> = buf
                .chunks_exact(4)
                .map(|c| u32::from_le_bytes([c[0], c[1], c[2], c[3]]))
                .collect();
            Ok(mlx_rs::Array::from_slice(&data, &dims))
        }
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
    pub handle_baseline: usize,
}

impl LoadedProfiledModel {
    pub fn new(
        image_dir: &Path,
        ) -> napi::Result<Self> {
        let handle_baseline = crate::bridge::handle_count();
        let reader = CompiledImageReader::open(image_dir)?;
        let segment_views: Vec<crate::mapped_image::SegmentView> = reader.manifest.segments.iter().map(|s| crate::mapped_image::SegmentView {
            segment_id: s.id.clone(),
            byte_size: s.byte_size,
            filename: s.filename.clone(),
            state: crate::mapped_image::SegmentState::Unmapped,
        }).collect();
        let mapped_image = crate::mapped_image::MappedImage::open(image_dir, &segment_views)?;
        
        let mut mapped_weight_bytes = 0;
        let mut tensor_cache: HashMap<String, Arc<Array>> = HashMap::new();

        let mut load_tensor = |name: &str| -> napi::Result<Arc<Array>> {
            if let Some(arr) = tensor_cache.get(name) {
                return Ok(arr.clone());
            }
            let entry = reader.manifest.tensor_table.iter().find(|e| e.name == name)
                .ok_or_else(|| napi::Error::from_reason(format!("tensor not found: {}", name)))?;
            let seg_id = &entry.segment;
            let file = mapped_image.segment_files.get(seg_id)
                .ok_or_else(|| napi::Error::from_reason(format!("segment file not found: {}", seg_id)))?;
            
            let arr = load_tensor_from_segment_file(file, entry, &mut mapped_weight_bytes)?;
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

        Ok(Self {
            image_dir: image_dir.to_path_buf(),
            reader,
            mapped_image,
            layers,
            emb_w, emb_s, emb_b, fn_w,
            rope_cos, rope_sin, full_cos, full_sin,
            mapped_weight_bytes,
            handle_baseline,
        })
    }
}

pub struct ProfiledSession<'a> {
    pub model: &'a LoadedProfiledModel,
    pub profile: ExecutionPlacementProfile,
    pub mode: ExecutionMode,
    pub caches: Vec<KvCache>,
    pub timeline: RuntimeTimeline,
    pub manager: ResidencyManager,
    pub executor: MlxExecutor,
    pub device_kind: String,
    pub stream_id: String,
    pub gpu_us: u64,
    pub canary_ratio: f64,
    pub total_elapsed_ms: u64,
    /// Absolute sequence position (llama.cpp n_pos). Updated after each step.
    pub position: u32,
}

impl<'a> ProfiledSession<'a> {
    pub fn new(model: &'a LoadedProfiledModel, profile: ExecutionPlacementProfile, mode: ExecutionMode) -> napi::Result<Self> {
        let (device_kind, stream_id, explicit_gpu_stream) = match mode {
            ExecutionMode::SemanticOracle => ("cpu".to_string(), "default".to_string(), false),
            ExecutionMode::Profiled => ("gpu".to_string(), "worker_0".to_string(), true),
        };

        let (gpu_us, canary_ratio) = if mode == ExecutionMode::Profiled {
            let (us, _peak, ratio) = run_gpu_canary();
            (us, ratio)
        } else {
            (0, 0.0)
        };

        let executor = if explicit_gpu_stream { MlxExecutor::spawn_gpu() } else { MlxExecutor::spawn_cpu() };
        let plan = &model.reader.manifest.execution_plan;

        let mut manager = ResidencyManager::new(12 * 1024 * 1024 * 1024, 2 * 1024 * 1024 * 1024);
        
        // Caches
        let mut caches = Vec::with_capacity(plan.layers.len());
        for layer in &plan.layers {
            let capacity = if layer.attention_kind == "sliding_attention" {
                layer.sliding_window
            } else {
                32768
            };
            let n_kv_heads = layer.n_global_kv_heads.unwrap_or(layer.n_kv_heads);
            let head_dim = layer.global_head_dim.unwrap_or(layer.head_dim);
            caches.push(KvCache::new(capacity, n_kv_heads, head_dim, layer.attention_kind == "sliding_attention"));
        }

        let mut timeline = RuntimeTimeline::new();
        timeline.push_event(TimelineEvent::new(
            0,
            TimelineEventType::EvalComplete, // Initial event
            format!("session created for model {}", model.reader.manifest.image_hash),
        ));

        Ok(Self {
            model,
            profile,
            mode,
            caches,
            timeline,
            manager,
            executor,
            device_kind,
            stream_id,
            gpu_us,
            canary_ratio,
            total_elapsed_ms: 0,
            position: 0,
        })
    }

    pub fn step(
        &mut self,
        token_ids: &[i32],
        is_prefill: bool,
        sampler: &crate::session::SamplerConfig,
        cancel_flag: Option<&AtomicBool>,
    ) -> napi::Result<(u32, ProfiledReceipt)> {
        let kv_offset = self.position;
        let event_type = if is_prefill {
            TimelineEventType::Prefill
        } else {
            TimelineEventType::DecodeStep
        };

        let step_start = Instant::now();

        let plan = &self.model.reader.manifest.execution_plan;

        let seq_len = token_ids.len() as u32;
        let positions: Vec<i32> = (kv_offset..kv_offset + seq_len).map(|p| p as i32).collect();
        let tok_arr = Array::from_slice(token_ids, &[1, seq_len as i32]);
        let _pos_arr = Array::from_slice(&positions, &[1, seq_len as i32]);

        let mut hidden = crate::executor::run_prologue(
            &tok_arr,
            &self.model.emb_w,
            &self.model.emb_s,
            &self.model.emb_b,
            &plan.prologue,
            1.0,
        ).map_err(|e| napi::Error::from_reason(format!("prologue: {:?}", e)))?;

        let mut layer_records: Vec<crate::mlx_executor::ExecutionRecord> = plan.layers.iter().map(|_| {
            crate::mlx_executor::ExecutionRecord {
                device: self.device_kind.clone(),
                stream_id: self.stream_id.clone(),
                graph_build_us: 0,
                eval_us: 0,
                sync_us: 0,
                peak_active_mem: 0,
                peak_cache_mem: 0,
                error: None,
            }
        }).collect();

        for (l, layer_plan) in plan.layers.iter().enumerate() {
            if cancel_flag.map_or(false, |f| f.load(Ordering::Relaxed)) {
                return Err(napi::Error::from_reason("cancelled during execution"));
            }

            let lw = &self.model.layers[l];
            let is_full = layer_plan.attention_kind == "full_attention";

            let (rcos, rsin) = if is_full { (&self.model.full_cos, &self.model.full_sin) } else { (&self.model.rope_cos, &self.model.rope_sin) };

            hidden = crate::executor::run_layer(
                &hidden,
                layer_plan,
                &lw.input_layernorm,
                &lw.post_attention_layernorm,
                &lw.q_proj_w, &lw.q_proj_s, &lw.q_proj_b,
                &lw.k_proj_w, &lw.k_proj_s, &lw.k_proj_b,
                &lw.v_proj_w, &lw.v_proj_s, &lw.v_proj_b,
                &lw.o_proj_w, &lw.o_proj_s, &lw.o_proj_b,
                lw.q_norm.as_ref().map(|v| &**v), lw.k_norm.as_ref().map(|v| &**v),
                &lw.gate_proj_w, &lw.gate_proj_s, &lw.gate_proj_b,
                &lw.up_proj_w, &lw.up_proj_s, &lw.up_proj_b,
                &lw.down_proj_w, &lw.down_proj_s, &lw.down_proj_b,
                rcos, rsin,
                &mut self.caches[l],
                kv_offset,
                plan.rms_norm_eps as f32,
            ).map_err(|e| napi::Error::from_reason(format!("layer {}: {}", l, e)))?;
        }

        let out_token = crate::executor::run_epilogue(
            &hidden,
            &self.model.fn_w,
            &self.model.emb_w,
            &self.model.emb_s,
            &self.model.emb_b,
            &plan.epilogue,
            plan.rms_norm_eps as f32,
            plan.tie_word_embeddings,
            sampler,
        ).map_err(|e| napi::Error::from_reason(format!("epilogue: {:?}", e)))?;

        hidden.eval().map_err(|e| napi::Error::from_reason(format!("epilogue eval: {:?}", e)))?;

        // Advance absolute position (llama.cpp n_pos pattern).
        self.position += token_ids.len() as u32;

        let step_elapsed_ms = step_start.elapsed().as_millis() as u64;
        self.total_elapsed_ms += step_elapsed_ms;

        let end_us = step_start.elapsed().as_micros() as u64;
        self.timeline.push_event(TimelineEvent::new(
            end_us,
            event_type,
            format!("generated token {}", out_token),
        ));

        let cache_hit_tokens = kv_offset as u64;

        let receipt = ProfiledReceipt {
            executor: "mlx_rs".into(),
            execution_profile: self.model.reader.manifest.image_hash.clone(),
            storage_backend: "copied".into(),
            explicit_gpu_stream: self.mode == ExecutionMode::Profiled,
            oracle_fallback: false,
            compiler_invocations: 0,
            source_checkpoint_accesses: 0,
            copied_weight_bytes: self.model.mapped_weight_bytes,
            mapped_weight_bytes: self.model.mapped_weight_bytes,
            token: out_token,
            layer_count: plan.layers.len() as u32,
            elapsed_ms: step_elapsed_ms,
            profile_validation: true,
            gpu_canary_us: self.gpu_us,
            gpu_canary_ratio: self.canary_ratio,
            image_hash: self.model.reader.manifest.image_hash.clone(),
            handle_baseline: self.model.handle_baseline as u64,
            handle_final: crate::bridge::handle_count() as u64,
            layer_records,
            active_window_bytes: self.model.mapped_weight_bytes,
            prefetched_count: 0,
            total_kv_cache_bytes: self.caches.iter().map(|c| c.total_bytes()).sum(),
            cache_hit_tokens,
            wall_clock_total_us: end_us,
            unaccounted_us: 0,
            timeline: self.timeline.clone(),
        };

        Ok((out_token, receipt))
    }
}

/// Cold one-shot wrapper for testing. Re-loads the entire model!
pub fn execute_profiled_cold_once(
    image_dir: &Path,
    profile: &ExecutionPlacementProfile,
    token_ids: &[i32],
    mode: ExecutionMode,
    cancel_flag: Option<&AtomicBool>,
    sampler: &crate::session::SamplerConfig,
    mut kv_offset: u32,
) -> napi::Result<(u32, ProfiledReceipt)> {
    let model = LoadedProfiledModel::new(image_dir)?;
    let mut session = ProfiledSession::new(&model, profile.clone(), mode)?;
    session.position = kv_offset;
    let is_prefill = token_ids.len() > 1;
    session.step(token_ids, is_prefill, sampler, cancel_flag)
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
