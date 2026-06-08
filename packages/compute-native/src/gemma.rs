//! Gemma-architecture text decoder core.
//!
//! Config-driven Gemma-architecture text decoder with config-based attention
//! scheduling. (RMSNorm, RoPE, GQA, SwiGLU, causal masking) configured to
//! Gemma 4 12B dimensions. It exercises the full compute path but does NOT
//! yet implement:
//!
//!   - Proportional RoPE scaling for 256K context
//!   - Multimodal projections (image, audio)
//!   - Gemma 4's specific conversation formatting and thinking controls
//!   - Numerical parity verification against Google's official reference
//!

use crate::bridge::ARRAY_REGISTRY;
use crate::config::AttentionKind::{self, FullAttention, SlidingAttention};
use mlx_rs::ops::indexing::IndexOp;
use mlx_rs::Array;
use mlx_rs::{error::Result as MlxResult, ops};

// ── Configuration ───────────────────────────────────────────────────────────

/// Gemma 4 model variant configuration.
#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GemmaConfig {
    pub n_layers: u32,
    pub n_heads: u32,
    pub n_kv_heads: u32,
    pub hidden_size: u32,
    pub intermediate_size: u32,
    pub head_dim: u32,
    pub vocab_size: u32,
    pub rope_theta: f32,
    pub max_seq_len: u32,
    pub rms_norm_eps: f32,
    pub sliding_window: u32,
    pub layer_types: Vec<AttentionKind>,
    pub global_head_dim: Option<u32>,
    pub n_global_kv_heads: Option<u32>,
}

impl GemmaConfig {
    pub fn gemma4_12b() -> Self {
        let hidden_size = 3840;
        let n_heads = 32;

        // Gemma 4 12B schedule: [sliding×5, full×1] × 8 = 48 layers
        let mut layer_types = Vec::with_capacity(48);
        for _ in 0..8 {
            for _ in 0..5 {
                layer_types.push(SlidingAttention);
            }
            layer_types.push(FullAttention);
        }

        Self {
            n_layers: 48,
            n_heads,
            n_kv_heads: 8,
            hidden_size,
            intermediate_size: 15360,
            head_dim: hidden_size / n_heads,
            vocab_size: 256128,
            rope_theta: 500_000.0,
            max_seq_len: 131072,
            rms_norm_eps: 1e-6,
            sliding_window: 1024,
            layer_types,
            global_head_dim: Some(512),
            n_global_kv_heads: Some(1),
        }
    }

    /// Returns `true` for sliding (local) attention layers.
    /// Falls back to sliding when the layer index is out of range.
    pub fn layer_is_sliding(&self, layer: u32) -> bool {
        match self.layer_types.get(layer as usize) {
            Some(SlidingAttention) => true,
            Some(FullAttention) => false,
            None => true, // default sliding for unknown
        }
    }

    /// Returns `true` for global (full) attention layers.
    pub fn layer_is_global(&self, layer: u32) -> bool {
        !self.layer_is_sliding(layer)
    }

    /// Build sliding window attention mask.
    pub fn sliding_mask(&self, seq_len: u32) -> MlxResult<Array> {
        let window = self.sliding_window;
        if seq_len <= window {
            return Ok(Array::from_slice(&[0.0f32], &[1, 1, 1, 1]));
        }
        let n = seq_len as usize;
        let mut d = vec![0.0f32; n * n];
        for i in 0..n {
            for j in 0..n {
                if (j as i32) < (i as i32 - window as i32) {
                    d[i * n + j] = f32::NEG_INFINITY;
                }
            }
        }
        Ok(Array::from_slice(
            &d,
            &[1, 1, seq_len as i32, seq_len as i32],
        ))
    }
}

// ── Weight reference ────────────────────────────────────────────────────────

pub struct WeightMap {
    config: GemmaConfig,
    tensors: std::collections::HashMap<String, u64>,
}

fn napi_to_mlx(e: napi::Error) -> mlx_rs::error::Exception {
    mlx_rs::error::Exception::custom(format!("{}", e))
}

impl WeightMap {
    pub fn new(config: GemmaConfig, tensors: Vec<(String, u64)>) -> Self {
        let map = tensors.into_iter().collect();
        Self {
            config,
            tensors: map,
        }
    }

    fn get(&self, name: &str) -> napi::Result<Array> {
        let handle = self
            .tensors
            .get(name)
            .ok_or_else(|| napi::Error::from_reason(format!("Weight not found: {}", name)))?;
        let registry = ARRAY_REGISTRY.read();
        registry
            .get(*handle)
            .cloned()
            .ok_or_else(|| napi::Error::from_reason(format!("Handle not in registry: {}", handle)))
    }

    fn layer_weight(&self, layer: u32, component: &str) -> napi::Result<Array> {
        let name = format!("model.layers.{}.{}", layer, component);
        self.get(&name)
    }
}

// ── RMSNorm ─────────────────────────────────────────────────────────────────

fn rms_norm(x: &Array, weight: &Array, eps: f32) -> MlxResult<Array> {
    let x_f32 = x.as_dtype(mlx_rs::Dtype::Float32)?;
    let mean_sq = ops::mean_axes(&x_f32.multiply(&x_f32)?, &[-1], Some(true))?;
    let rsqrt = ops::rsqrt(&mean_sq.add(&Array::from_f32(eps))?)?;
    let normed = x.multiply(&rsqrt.as_dtype(mlx_rs::Dtype::Float32)?)?;
    normed.multiply(weight)
}

// ── Rotary Position Embedding (RoPE) ────────────────────────────────────────

fn precompute_rope_freqs(head_dim: u32, max_seq_len: u32, theta: f32) -> MlxResult<(Array, Array)> {
    let half_dim = head_dim / 2;
    let mut freqs = Vec::with_capacity(half_dim as usize);
    for i in 0..half_dim {
        let exponent = (2 * i) as f32 / head_dim as f32;
        freqs.push(1.0 / theta.powf(exponent));
    }

    let positions: Vec<f32> = (0..max_seq_len).map(|p| p as f32).collect();
    let freq_array = Array::from_slice(&freqs, &[1, half_dim as i32]);
    let pos_array = Array::from_slice(&positions, &[max_seq_len as i32, 1]);
    let angles = pos_array.multiply(&freq_array)?;

    Ok((ops::cos(&angles)?, ops::sin(&angles)?))
}

fn apply_rope(q_or_k: &Array, cos: &Array, sin: &Array, offset: u32) -> MlxResult<Array> {
    let seq_len = q_or_k.shape()[2] as u32;
    let start = offset as i32;
    let end = (offset + seq_len) as i32;

    let cos_slice = cos.index((start..end, 0..cos.shape()[1]));
    let sin_slice = sin.index((start..end, 0..sin.shape()[1]));

    let cos_bc = cos_slice.reshape(&[1, 1, seq_len as i32, cos_slice.shape()[1]])?;
    let sin_bc = sin_slice.reshape(&[1, 1, seq_len as i32, sin_slice.shape()[1]])?;

    let half = q_or_k.shape()[3] / 2;
    let x_even = q_or_k.index((.., .., .., 0..half));
    let x_odd = q_or_k.index((.., .., .., half..));

    let rotated_even = x_even
        .multiply(&cos_bc)?
        .subtract(&x_odd.multiply(&sin_bc)?)?;
    let rotated_odd = x_even.multiply(&sin_bc)?.add(&x_odd.multiply(&cos_bc)?)?;

    ops::concatenate(&[&rotated_even, &rotated_odd])
}

// ── Attention ───────────────────────────────────────────────────────────────

fn gemma_attention(
    x: &Array,
    weights: &WeightMap,
    layer: u32,
    rope_cos: &Array,
    rope_sin: &Array,
    kv_offset: u32,
    mask: Option<&Array>,
) -> MlxResult<Array> {
    let cfg = &weights.config;
    let is_global = cfg.layer_is_global(layer);
    let h_dim = if is_global {
        cfg.global_head_dim.unwrap_or(cfg.head_dim)
    } else {
        cfg.head_dim
    };
    let n_kv = if is_global {
        cfg.n_global_kv_heads.unwrap_or(cfg.n_kv_heads)
    } else {
        cfg.n_kv_heads
    };

    let batch_size = x.shape()[0];
    let seq_len = x.shape()[1];

    let q_w = weights
        .layer_weight(layer, "self_attn.q_proj.weight")
        .map_err(napi_to_mlx)?;
    let k_w = weights
        .layer_weight(layer, "self_attn.k_proj.weight")
        .map_err(napi_to_mlx)?;
    let v_w = if is_global {
        // Global layers alias v_proj → k_proj (k_eq_v)
        k_w.clone()
    } else {
        weights
            .layer_weight(layer, "self_attn.v_proj.weight")
            .map_err(napi_to_mlx)?
    };
    let o_w = weights
        .layer_weight(layer, "self_attn.o_proj.weight")
        .map_err(napi_to_mlx)?;

    let q = x.matmul(&ops::transpose_axes(&q_w, &[1, 0])?)?.reshape(&[
        batch_size,
        seq_len,
        cfg.n_heads as i32,  // n_heads stays the same; head_dim changes
        h_dim as i32,
    ])?;
    let k = x.matmul(&ops::transpose_axes(&k_w, &[1, 0])?)?.reshape(&[
        batch_size,
        seq_len,
        n_kv as i32,
        h_dim as i32,
    ])?;
    let v = x.matmul(&ops::transpose_axes(&v_w, &[1, 0])?)?.reshape(&[
        batch_size,
        seq_len,
        n_kv as i32,
        h_dim as i32,
    ])?;

    let q_roped = apply_rope(&q, rope_cos, rope_sin, kv_offset)?;
    let k_roped = apply_rope(&k, rope_cos, rope_sin, kv_offset)?;

    let group_size = cfg.n_heads / cfg.n_kv_heads;
    let k_expanded = repeat_kv(&k_roped, group_size)?;
    let v_expanded = repeat_kv(&v, group_size)?;

    let scale = (cfg.head_dim as f32).sqrt();
    let scores = q_roped
        .matmul(&ops::transpose_axes(&k_expanded, &[0, 1, 3, 2])?)?
        .divide(&Array::from_f32(scale))?;

    let scores = if let Some(m) = mask {
        scores.add(m)?
    } else {
        scores
    };
    let attn_weights = ops::softmax_axes(&scores, &[3], None)?;
    let attn_out = attn_weights.matmul(&v_expanded)?.reshape(&[
        batch_size,
        seq_len,
        cfg.hidden_size as i32,
    ])?;

    attn_out.matmul(&ops::transpose_axes(&o_w, &[1, 0])?)
}

fn repeat_kv(x: &Array, n_rep: u32) -> MlxResult<Array> {
    if n_rep == 1 {
        return Ok(x.clone());
    }
    let shape = x.shape();
    let batch = shape[0];
    let n_kv = shape[1];
    let seq = shape[2];
    let head = shape[3];

    let x_bc = x.reshape(&[batch, n_kv, 1, seq, head])?;
    let x_bc = ops::tile(&x_bc, &[1, 1, n_rep as i32, 1, 1])?;
    x_bc.reshape(&[batch, n_kv * n_rep as i32, seq, head])
}

// ── SwiGLU Feed-Forward ─────────────────────────────────────────────────────

fn gemma_mlp(x: &Array, weights: &WeightMap, layer: u32) -> MlxResult<Array> {
    let gate_w = weights
        .layer_weight(layer, "mlp.gate_proj.weight")
        .map_err(napi_to_mlx)?;
    let up_w = weights
        .layer_weight(layer, "mlp.up_proj.weight")
        .map_err(napi_to_mlx)?;
    let down_w = weights
        .layer_weight(layer, "mlp.down_proj.weight")
        .map_err(napi_to_mlx)?;

    let gate = x.matmul(&ops::transpose_axes(&gate_w, &[1, 0])?)?;
    let up = x.matmul(&ops::transpose_axes(&up_w, &[1, 0])?)?;
    let gated = mlx_rs::nn::silu(&gate)?.multiply(&up)?;
    gated.matmul(&ops::transpose_axes(&down_w, &[1, 0])?)
}

// ── Transformer Decoder Layer ───────────────────────────────────────────────

fn gemma_decoder_layer(
    x: &Array,
    weights: &WeightMap,
    layer: u32,
    rope_cos: &Array,
    rope_sin: &Array,
    kv_offset: u32,
    mask: Option<&Array>,
) -> MlxResult<Array> {
    let attn_norm = weights
        .layer_weight(layer, "input_layernorm.weight")
        .map_err(napi_to_mlx)?;
    let residual = x;
    let normed = rms_norm(x, &attn_norm, weights.config.rms_norm_eps)?;
    let attn_out = gemma_attention(&normed, weights, layer, rope_cos, rope_sin, kv_offset, mask)?;
    let x = residual.add(&attn_out)?;

    let ffn_norm = weights
        .layer_weight(layer, "post_attention_layernorm.weight")
        .map_err(napi_to_mlx)?;
    let residual = &x;
    let normed = rms_norm(&x, &ffn_norm, weights.config.rms_norm_eps)?;
    let ffn_out = gemma_mlp(&normed, weights, layer)?;
    residual.add(&ffn_out)
}

// ── Causal Mask ─────────────────────────────────────────────────────────────

fn create_causal_mask(seq_len: u32) -> MlxResult<Array> {
    let mut mask_data = Vec::with_capacity((seq_len * seq_len) as usize);
    for i in 0..seq_len {
        for j in 0..seq_len {
            mask_data.push(if j <= i { 0.0f32 } else { f32::NEG_INFINITY });
        }
    }
    Ok(Array::from_slice(
        &mask_data,
        &[1, 1, seq_len as i32, seq_len as i32],
    ))
}

// ── Full Model ──────────────────────────────────────────────────────────────

pub struct GemmaModel {
    config: GemmaConfig,
    weights: WeightMap,
    rope_cos: Array,
    rope_sin: Array,
}

impl GemmaModel {
    pub fn new(config: GemmaConfig, weight_tensors: Vec<(String, u64)>) -> napi::Result<Self> {
        let (cos, sin) =
            precompute_rope_freqs(config.head_dim, config.max_seq_len, config.rope_theta)
                .map_err(|e| napi::Error::from_reason(format!("RoPE precompute: {:?}", e)))?;

        Ok(Self {
            config: config.clone(),
            weights: WeightMap::new(config.clone(), weight_tensors),
            rope_cos: cos,
            rope_sin: sin,
        })
    }

    pub fn forward(&self, input_ids: &Array, kv_offset: u32) -> MlxResult<Array> {
        let _batch_size = input_ids.shape()[0];
        let seq_len = input_ids.shape()[1] as u32;

        let embed_weight = self
            .weights
            .get("model.embed_tokens.weight")
            .map_err(napi_to_mlx)?;
        let scale = (self.config.hidden_size as f32).sqrt();
        let mut hidden = ops::indexing::take_axis(&embed_weight, input_ids, 0)?
            .multiply(&Array::from_f32(scale))?;

        for layer in 0..self.config.n_layers {
            let mask: Option<Array> = if seq_len > 1 {
                if self.config.layer_is_sliding(layer) {
                    let causal = create_causal_mask(seq_len)?;
                    let sliding = self.config.sliding_mask(seq_len)?;
                    Some(causal.add(&sliding)?)
                } else {
                    Some(create_causal_mask(seq_len)?)
                }
            } else {
                None
            };

            hidden = gemma_decoder_layer(
                &hidden,
                &self.weights,
                layer,
                &self.rope_cos,
                &self.rope_sin,
                kv_offset,
                mask.as_ref(),
            )?;
        }

        let final_norm = self.weights.get("model.norm.weight").map_err(napi_to_mlx)?;
        hidden = rms_norm(&hidden, &final_norm, self.config.rms_norm_eps)?;

        let lm_head = self.weights.get("lm_head.weight").map_err(napi_to_mlx)?;
        hidden.matmul(&ops::transpose_axes(&lm_head, &[1, 0])?)
    }

    #[allow(dead_code)]
    /// Run forward pass and sample the next token ID via argmax.
    /// Returns the token ID directly — no logits cross the FFI boundary.
    pub fn sample_token(&self, input_ids: &Array, kv_offset: u32) -> napi::Result<u32> {
        let logits = self
            .forward(input_ids, kv_offset)
            .map_err(|e| napi::Error::from_reason(format!("Forward error: {:?}", e)))?;
        let last_logits = logits.index((0..1, (logits.shape()[1] - 1)..logits.shape()[1], ..));
        let token_arr = ops::indexing::argmax_axis(&last_logits, -1, None)
            .map_err(|e| napi::Error::from_reason(format!("Argmax error: {:?}", e)))?;
        let values = token_arr
            .try_as_slice::<i32>()
            .map_err(|e| napi::Error::from_reason(format!("Read error: {:?}", e)))?;
        Ok(values.first().copied().unwrap_or(0) as u32)
    }
}
