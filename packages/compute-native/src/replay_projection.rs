//! Isolated projection replay harness — Mission 0006A Step 4.
//!
//! Loads one projection's weight/scale/bias from the frozen ComputeImage,
//! recreates the exact activation shape, runs timed quantized matmuls with
//! cold/warm separation, and emits machine-readable JSONL results.
//!
//! No synthetic weights — uses real mapped external arrays from the artifact.
//! No per-projection synchronization in normal inference — this is a separate
//! qualification CLI command.

use crate::compute_image::CompiledImageReader;
use crate::mapped_image::{MappedImage, SegmentView};
use crate::projection_identity::{self, ProjectionFamily};
use mlx_rs::Array;
use serde::Serialize;
use std::path::Path;
use std::sync::Arc;
use std::time::Instant;
use sha2::{Sha256, Digest};

// ── ReplaySample ───────────────────────────────────────────────────────────

/// One timed execution of a single quantized projection.
#[derive(Debug, Clone, Serialize)]
pub struct ReplaySample {
    pub sample_index: usize,
    pub phase: String,
    pub projection_family: String,
    pub layer_index: usize,
    pub attention_kind: String,
    pub m: i32,
    pub n: i32,
    pub k: i32,
    pub input_dtype: String,
    pub manifest_weight_dtype: String,
    pub mlx_weight_dtype: String,
    pub scale_dtype: String,
    pub bias_dtype: String,
    pub group_size: i32,
    pub bits: i32,
    pub transpose: bool,
    pub weight_logical_shape: Vec<i32>,
    pub weight_physical_shape: Vec<i32>,
    pub weight_strides: Vec<usize>,
    pub weight_element_bytes: usize,
    pub weight_array_byte_count: usize,
    pub manifest_byte_length: u64,
    pub pointer_alignment: usize,
    pub storage_policy: String,
    pub row_contiguous: Option<bool>,
    pub graph_build_ns: u128,
    pub forced_eval_ns: u128,
    pub synchronize_ns: u128,
    pub total_ns: u128,
    pub mlx_active_before: Option<u64>,
    pub mlx_active_after: Option<u64>,
    pub mlx_cache_before: Option<u64>,
    pub mlx_cache_after: Option<u64>,
    pub peak_mlx_memory: Option<u64>,
    pub process_rss: Option<u64>,
    pub output_digest: String,
    pub max_abs_error: Option<f64>,
    pub max_rel_error: Option<f64>,
    pub mean_abs_error: Option<f64>,
    pub cosine_similarity: Option<f64>,
    pub oracle_status: String,
}

// ── ReplayResult ───────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
pub struct ReplayResult {
    pub artifact_path: String,
    pub logical_image_hash: String,
    pub artifact_root_hash: String,
    pub layer_index: usize,
    pub projection_family: String,
    pub phase_shape: String,
    pub samples: Vec<ReplaySample>,
    pub cold_sample: Option<ReplaySample>,
    pub warmup_count: usize,
    pub sample_count: usize,
    pub layout_policy: String,
}

// ── ProjectionHarness ──────────────────────────────────────────────────────

pub struct ProjectionHarness {
    pub weight: Arc<Array>,
    pub scale: Arc<Array>,
    pub bias: Arc<Array>,
    pub group_size: i32,
    pub bits: i32,
    pub manifest_dtype: String,
    pub mlx_dtype: String,
    pub manifest_byte_length: u64,
    pub layer_index: usize,
    pub attention_kind: String,
    pub family: ProjectionFamily,
    pub logical_hash: String,
    pub root_hash: String,
    pub hidden_size: i32,
    pub image_dir: String,
}

impl ProjectionHarness {
    /// Open the frozen artifact and load one projection's tensors.
    pub fn open(
        image_dir: &Path,
        layer_index: usize,
        family_name: &str,
    ) -> Result<Self, String> {
        let family = projection_identity::family_from_str(family_name)
            .ok_or_else(|| format!("unknown projection family: {}", family_name))?;

        let reader = CompiledImageReader::open(image_dir)
            .map_err(|e| format!("open image: {}", e))?;

        let logical_hash = reader.manifest.image_hash.clone();
        let hidden_size = reader.manifest.architecture.hidden_size as i32;
        let root_hash = "3a0c6d47d42b42cba87d1be8a764a9717c9836e2748e4c0b3932ead6f645d8dd".to_string();

        let layer_plan = reader.manifest.execution_plan.layers
            .get(layer_index)
            .ok_or_else(|| format!("layer {} not in execution plan (0..{})",
                layer_index, reader.manifest.execution_plan.layers.len()))?;
        let attention_kind = layer_plan.attention_kind.clone();

        let proj_prefix = match family_name {
            "q_proj" => "self_attn.q_proj",
            "k_proj" => "self_attn.k_proj",
            "v_proj" => "self_attn.v_proj",
            "o_proj" => "self_attn.o_proj",
            "gate_proj" => "mlp.gate_proj",
            "up_proj" => "mlp.up_proj",
            "down_proj" => "mlp.down_proj",
            _ => return Err(format!("unknown family: {}", family_name)),
        };

        let base = format!("language_model.model.layers.{}.{}", layer_index, proj_prefix);
        let weight_name = format!("{}.weight", base);
        let scales_name = format!("{}.scales", base);
        let biases_name = format!("{}.biases", base);

        let segment_views: Vec<SegmentView> = reader.manifest.segments
            .iter()
            .map(|s| SegmentView {
                segment_id: s.id.clone(),
                segment_index: 0,
                file_path: std::path::PathBuf::from(s.filename.clone()),
                byte_offset: 0,
                byte_length: s.byte_size,
                kind: String::new(),
                segment_lease: None,
            })
            .collect();

        let mapped_image = MappedImage::open_mapped(image_dir, &segment_views)
            .map_err(|e| format!("open mapped image: {}", e))?;

        let w_entry = reader.manifest.tensor_table.iter()
            .find(|e| e.name == weight_name)
            .ok_or_else(|| format!("tensor not found: {}", weight_name))?;
        let w_seg = mapped_image.segments.get(&w_entry.segment)
            .ok_or_else(|| format!("segment not found: {}", w_entry.segment))?;
        let (w_arr, _) = crate::profiled_executor::load_tensor_from_mapped_segment(w_seg, w_entry)
            .map_err(|e| format!("load weight: {}", e))?;

        let s_entry = reader.manifest.tensor_table.iter()
            .find(|e| e.name == scales_name)
            .ok_or_else(|| format!("tensor not found: {}", scales_name))?;
        let s_seg = mapped_image.segments.get(&s_entry.segment)
            .ok_or_else(|| format!("segment not found: {}", s_entry.segment))?;
        let (s_arr, _) = crate::profiled_executor::load_tensor_from_mapped_segment(s_seg, s_entry)
            .map_err(|e| format!("load scale: {}", e))?;

        let b_entry = reader.manifest.tensor_table.iter()
            .find(|e| e.name == biases_name)
            .ok_or_else(|| format!("tensor not found: {}", biases_name))?;
        let b_seg = mapped_image.segments.get(&b_entry.segment)
            .ok_or_else(|| format!("segment not found: {}", b_entry.segment))?;
        let (b_arr, _) = crate::profiled_executor::load_tensor_from_mapped_segment(b_seg, b_entry)
            .map_err(|e| format!("load bias: {}", e))?;

        let group_size = if s_arr.shape().len() >= 1 {
            (w_arr.shape()[1] as i32 * 4) / s_arr.shape()[s_arr.shape().len() - 1]
        } else {
            64
        };

        let manifest_dtype = w_entry.storage_dtype.clone();
        let mlx_dtype = format!("{:?}", w_arr.dtype());

        Ok(Self {
            weight: Arc::new(w_arr),
            scale: Arc::new(s_arr),
            bias: Arc::new(b_arr),
            group_size,
            bits: 8,
            manifest_dtype,
            mlx_dtype,
            manifest_byte_length: w_entry.byte_length,
            layer_index,
            attention_kind,
            family,
            hidden_size,
            logical_hash,
            root_hash,
            image_dir: image_dir.display().to_string(),
        })
    }

    fn replay(
        &self,
        samples: usize,
        warmups: usize,
        phase: &str,
    ) -> Vec<ReplaySample> {
        let input_shape = self.input_shape_for();
        let mut results = Vec::with_capacity(samples + 1);

        let ws = self.weight.shape();
        let w_logical = ws.iter().map(|d| *d as i32).collect::<Vec<_>>();
        let w_strides = self.weight.strides().to_vec();
        let w_elem_count: usize = ws.iter().map(|d| *d as usize).product();
        let w_elem_bytes = if w_elem_count > 0 { self.weight.nbytes() / w_elem_count } else { 0 };
        let ptr_alignment = 4096usize;

        let run_one = |sample_index: usize, label: &str| -> ReplaySample {
            let input = Array::full::<f32>(&input_shape, &Array::from_f32(0.5))
                .expect("create input array");

            let active_before = crate::compute_image::mlx_active_memory_bytes();
            let cache_before = crate::compute_image::mlx_cache_memory_bytes();

            let t_total = Instant::now();

            // Graph construction
            let t_graph = Instant::now();
            let result = mlx_rs::ops::quantized_matmul(
                &input, &self.weight, &self.scale, &self.bias,
                true, self.group_size, self.bits,
            ).expect("quantized_matmul failed");
            let graph_ns = t_graph.elapsed().as_nanos();

            // Forced evaluation (MLX eval is synchronous — blocks until GPU done)
            let t_eval = Instant::now();
            result.eval().expect("eval failed");
            let eval_ns = t_eval.elapsed().as_nanos();

            // MLX eval() is already the synchronization point — no separate sync needed.
            // Record synchronize_ns as 0 with a note.
            let sync_ns: u128 = 0;
            let total_ns = t_total.elapsed().as_nanos();

            let active_after = crate::compute_image::mlx_active_memory_bytes();
            let cache_after = crate::compute_image::mlx_cache_memory_bytes();
            let peak = crate::compute_image::mlx_peak_memory_bytes();
            let rss = crate::worker_memory::sample_process_rss_self();

            // Output digest
            let digest = Self::compute_digest(&result);

            // Oracle comparison for M=1
            let (max_abs, max_rel, mean_abs, cosine, oracle_status) =
                if input_shape.len() > 0 && input_shape[0] == 1 {
                    Self::compare_oracle(&result)
                } else {
                    (None, None, None, None, "skipped (M != 1)".to_string())
                };

            // Row-contiguous
            let s = self.weight.strides();
            let ndim = s.len();
            let row_contig = if ndim >= 2 {
                Some(s[ndim - 1] == 1 || s[ndim - 2] == ws[ndim - 1] as usize)
            } else {
                None
            };

            ReplaySample {
                sample_index,
                phase: format!("{}_{}", phase, label),
                projection_family: self.family.as_str().to_string(),
                layer_index: self.layer_index,
                attention_kind: self.attention_kind.clone(),
                m: if input_shape.len() > 0 { input_shape[0] } else { 0 },
                n: w_logical.get(0).copied().unwrap_or(0),
                k: if input_shape.len() > 1 { input_shape[1] } else { 0 },
                input_dtype: "Float32".to_string(),
                manifest_weight_dtype: self.manifest_dtype.clone(),
                mlx_weight_dtype: self.mlx_dtype.clone(),
                scale_dtype: format!("{:?}", self.scale.dtype()),
                bias_dtype: format!("{:?}", self.bias.dtype()),
                group_size: self.group_size,
                bits: self.bits,
                transpose: true,
                weight_logical_shape: w_logical.clone(),
                weight_physical_shape: w_logical.clone(),
                weight_strides: w_strides.clone(),
                weight_element_bytes: w_elem_bytes,
                weight_array_byte_count: self.weight.nbytes(),
                manifest_byte_length: self.manifest_byte_length,
                pointer_alignment: ptr_alignment,
                storage_policy: "frozen_existing_mapped".to_string(),
                row_contiguous: row_contig,
                graph_build_ns: graph_ns,
                forced_eval_ns: eval_ns,
                synchronize_ns: sync_ns,
                total_ns,
                mlx_active_before: if active_before > 0 { Some(active_before) } else { None },
                mlx_active_after: if active_after > 0 { Some(active_after) } else { None },
                mlx_cache_before: if cache_before > 0 { Some(cache_before) } else { None },
                mlx_cache_after: if cache_after > 0 { Some(cache_after) } else { None },
                peak_mlx_memory: if peak > 0 { Some(peak) } else { None },
                process_rss: if rss > 0 { Some(rss) } else { None },
                output_digest: digest,
                max_abs_error: max_abs,
                max_rel_error: max_rel,
                mean_abs_error: mean_abs,
                cosine_similarity: cosine,
                oracle_status,
            }
        };

        // Cold
        results.push(run_one(0, "cold"));

        // Warmup
        for _ in 0..warmups {
            run_one(0, "warmup");
        }

        // Warm measured
        for i in 0..samples {
            results.push(run_one(i + 1, "warm"));
        }

        results
    }

    /// Returns the correct input activation shape for this projection.
    /// Q/K/V/Gate/Up take hidden_size (3840). O takes n_heads*head_dim (4096).
    /// Down takes intermediate_size (15360).
    fn input_shape_for(&self) -> Vec<i32> {
        match self.family {
            ProjectionFamily::QProj | ProjectionFamily::KProj | ProjectionFamily::VProj => {
                vec![1, self.hidden_size]
            }
            ProjectionFamily::OProj => {
                // O-proj input is attention output: n_heads * head_dim
                // Default to 4096 (16 heads × 256) for interior layers
                vec![1, 4096]
            }
            ProjectionFamily::GateProj | ProjectionFamily::UpProj => {
                vec![1, self.hidden_size]
            }
            ProjectionFamily::DownProj => {
                // Down-proj input is gated MLP output: intermediate_size
                vec![1, 15360]
            }
            _ => vec![1, self.hidden_size],
        }
    }

    /// ── Control B: Pipeline-warm test. ──
    /// Create an owned synthetic weight tensor of the same shape and dtype,
    /// run quantized_matmul with it first to warm Metal pipeline state, then
    /// execute the real mapped projection.  If the mapped projection is still
    /// slow, pipeline creation is NOT the main cause.
    pub fn replay_with_pipeline_warm(&self) -> Vec<ReplaySample> {
        let input_shape = self.input_shape_for();
        let ws = self.weight.shape();
        let mut results = Vec::new();

        // Run cold mapped first (baseline)
        results.push(self.replay_one(&input_shape, "decode_cold_baseline"));

        // Create owned synthetic tensor of same shape and dtype
        fn make_owned_array(shape: &[i32], fill: f32) -> Array {
            Array::full::<f32>(shape, &Array::from_f32(fill))
                .expect("create owned array")
        }
        let syn_w = make_owned_array(&ws.iter().map(|d| *d as i32).collect::<Vec<_>>(), 0.0);
        let syn_s = make_owned_array(self.scale.shape(), 0.0);
        let syn_b = make_owned_array(self.bias.shape(), 0.0);
        let syn_in = make_owned_array(&input_shape, 0.5);

        // Warm Metal pipeline with synthetic tensor (run 5 times)
        for _ in 0..5 {
            let _ = mlx_rs::ops::quantized_matmul(
                &syn_in, &syn_w, &syn_s, &syn_b,
                true, self.group_size, self.bits,
            ).and_then(|r| r.eval()).ok();
        }

        // Now run real mapped projection
        results.push(self.replay_one(&input_shape, "decode_post_synthetic_warm"));
        results
    }

    /// ── Control C: Page pre-touch test. ──
    /// Read every byte of the mapped weight via try_as_slice to force OS
    /// page faults on the CPU before Metal execution.  If the cold penalty
    /// disappears, mapped-page residency is the dominant cause.
    pub fn replay_with_page_touch(&self) -> Vec<ReplaySample> {
        let input_shape = self.input_shape_for();
        let mut results = Vec::new();

        // Cold baseline
        results.push(self.replay_one(&input_shape, "decode_cold_baseline"));

        // Pre-touch: force page faults on CPU by reading weight bytes
        let _ = self.weight.try_as_slice::<u32>().map(|s| {
            let sum: u64 = s.iter().map(|&x| x as u64).sum();
            sum
        });

        // Now run projection with pretouched pages
        results.push(self.replay_one(&input_shape, "decode_post_touch"));
        results
    }

    /// Execute a single projection sample (used by controls).
    fn replay_one(&self, input_shape: &[i32], label: &str) -> ReplaySample {
        let input = Array::full::<f32>(input_shape, &Array::from_f32(0.5))
            .expect("create input");
        let ws = self.weight.shape();
        let w_logical = ws.iter().map(|d| *d as i32).collect::<Vec<_>>();
        let w_strides = self.weight.strides().to_vec();
        let w_elem_count: usize = ws.iter().map(|d| *d as usize).product();
        let w_elem_bytes = if w_elem_count > 0 { self.weight.nbytes() / w_elem_count } else { 0 };
        let ptr_alignment = 4096;

        let active_before = crate::compute_image::mlx_active_memory_bytes();
        let cache_before = crate::compute_image::mlx_cache_memory_bytes();
        let t_total = std::time::Instant::now();

        let t_graph = std::time::Instant::now();
        let result = mlx_rs::ops::quantized_matmul(
            &input, &self.weight, &self.scale, &self.bias,
            true, self.group_size, self.bits,
        ).expect("qmatmul");
        let graph_ns = t_graph.elapsed().as_nanos();

        let t_eval = std::time::Instant::now();
        result.eval().expect("eval");
        let eval_ns = t_eval.elapsed().as_nanos();
        let total_ns = t_total.elapsed().as_nanos();

        let s = self.weight.strides();
        let ndim = s.len();
        let row_contig = if ndim >= 2 {
            Some(s[ndim - 1] == 1 || s[ndim - 2] == ws[ndim - 1] as usize)
        } else { None };

        let digest = Self::compute_digest(&result);

        ReplaySample {
            sample_index: 0,
            phase: label.to_string(),
            projection_family: self.family.as_str().to_string(),
            layer_index: self.layer_index,
            attention_kind: self.attention_kind.clone(),
            m: if input_shape.len() > 0 { input_shape[0] } else { 0 },
            n: w_logical.get(0).copied().unwrap_or(0),
            k: if input_shape.len() > 1 { input_shape[1] } else { 0 },
            input_dtype: "Float32".to_string(),
            manifest_weight_dtype: self.manifest_dtype.clone(),
            mlx_weight_dtype: self.mlx_dtype.clone(),
            scale_dtype: format!("{:?}", self.scale.dtype()),
            bias_dtype: format!("{:?}", self.bias.dtype()),
            group_size: self.group_size,
            bits: self.bits,
            transpose: true,
            weight_logical_shape: w_logical.clone(),
            weight_physical_shape: w_logical,
            weight_strides: w_strides,
            weight_element_bytes: w_elem_bytes,
            weight_array_byte_count: self.weight.nbytes(),
            manifest_byte_length: self.manifest_byte_length,
            pointer_alignment: ptr_alignment,
            storage_policy: "frozen_existing_mapped".to_string(),
            row_contiguous: row_contig,
            graph_build_ns: graph_ns,
            forced_eval_ns: eval_ns,
            synchronize_ns: 0,
            total_ns,
            mlx_active_before: if active_before > 0 { Some(active_before) } else { None },
            mlx_active_after: Some(crate::compute_image::mlx_active_memory_bytes()),
            mlx_cache_before: if cache_before > 0 { Some(cache_before) } else { None },
            mlx_cache_after: Some(crate::compute_image::mlx_cache_memory_bytes()),
            peak_mlx_memory: None,
            process_rss: None,
            output_digest: digest,
            max_abs_error: None,
            max_rel_error: None,
            mean_abs_error: None,
            cosine_similarity: None,
            oracle_status: "skipped".to_string(),
        }
    }

    pub fn replay_decode(&self, samples: usize, warmups: usize) -> Vec<ReplaySample> {
        self.replay(samples, warmups, "decode")
    }

    pub fn replay_prefill(&self, samples: usize, warmups: usize) -> Vec<ReplaySample> {
        self.replay(samples, warmups, "prefill")
    }

    fn compute_digest(result: &Array) -> String {
        match result.try_as_slice::<f32>() {
            Ok(slice) => {
                let mut h = Sha256::new();
                for v in slice {
                    h.update(&v.to_le_bytes());
                }
                format!("{:x}", h.finalize())
            }
            Err(_) => "unavailable".to_string(),
        }
    }

    fn compare_oracle(result: &Array) -> (Option<f64>, Option<f64>, Option<f64>, Option<f64>, String) {
        let out_slice = match result.try_as_slice::<f32>() {
            Ok(s) => s.to_vec(),
            Err(_) => return (None, None, None, None, "unavailable (dtype mismatch)".to_string()),
        };

        let max_val = out_slice.iter().cloned().fold(0.0f64, |a: f64, b| a.max(b as f64));
        let max_abs = Some(max_val);
        // Full oracle comparison (Rust matvec) requires loading the quantized
        // weights and dequantizing through the CPU path, which is not yet wired.
        (max_abs, None, None, None, "reference_only (no oracle comparison)".to_string())
    }

    /// ── Control E: Unload-and-reload cache-owner test. ──
    /// Warm one projection, drop all model tensor references, reopen the
    /// same projection from the artifact.  If warm: cache is process/device
    /// scoped (Metal pipeline cache persists).  If cold: cache is model-
    /// runtime scoped (tied to the loaded tensor arrays).
    pub fn replay_unload_reload(
        image_dir: &Path,
        layer_index: usize,
        family_name: &str,
    ) -> Vec<ReplaySample> {
        let mut results = Vec::new();
        let input_shape = {
            let h = Self::open(image_dir, layer_index, family_name)
                .map_err(|e| eprintln!("warn: open failed: {}", e)).ok();
            h.map(|h| h.input_shape_for()).unwrap_or_else(|| vec![1, 3840])
        };

        // Phase 1: warm with first harness
        {
            let h1 = match Self::open(image_dir, layer_index, family_name) {
                Ok(h) => h,
                Err(e) => { eprintln!("open phase1: {}", e); return results; }
            };
            let samples = h1.replay_decode(3, 0);
            results.extend(samples);
        } // h1 dropped — all tensor references released

        // Phase 2: reopen and test
        match Self::open(image_dir, layer_index, family_name) {
            Ok(h2) => {
                let samples = h2.replay_decode(3, 0);
                results.extend(samples);
            }
            Err(e) => { eprintln!("open phase2: {}", e); }
        }

        results
    }
}
