//! Executor: storage-neutral Gemma 4 decoder execution from compiled plans.
//!
//! Three executors (prologue, layer, epilogue) that consume Plan + resolved
//! MLX Array references. They do not know whether tensors came from copied
//! segments, mapped storage, or test fixtures. The caller is responsible for
//! calling `eval()` on the result before dropping the weight leases.

use crate::config::{EpiloguePlan, LayerPlan, ProloguePlan};
use crate::kv_cache::KvCache;
use crate::primitives;
use crate::session::SamplerConfig;
use mlx_rs::error::Result as MlxResult;
use mlx_rs::ops::indexing::IndexOp;
use mlx_rs::Array;

// ── Prologue ───────────────────────────────────────────────────────────────

/// Embedding lookup: token_ids → initial hidden state.
/// Uses dequantized embedding weights (Gather → dequantize → scale).
pub fn run_prologue(
    token_ids: &Array,
    emb_weight: &Array,
    emb_scales: &Array,
    emb_biases: &Array,
    _plan: &ProloguePlan,
    hidden_scale: f32,
) -> MlxResult<Array> {
    let group_size = if emb_scales.shape().len() >= 1 {
        (emb_weight.shape()[1] as i32 * 4) / emb_scales.shape()[emb_scales.shape().len() - 1]
    } else {
        64
    };
    let wf = mlx_rs::ops::dequantize(emb_weight, emb_scales, emb_biases, group_size, 8)?;
    let emb = mlx_rs::ops::indexing::take_axis(&wf, token_ids, 0)?;
    emb.multiply(&Array::from_f32(hidden_scale))
}

// ── Decoder Layer ──────────────────────────────────────────────────────────

/// Execute one decoder layer from a compiled LayerPlan and resolved tensors.
///
/// The plan determines whether sliding or global attention is used — no
/// branching on layer index. All weights are passed as resolved MLX Arrays.
/// The caller MUST eval the result before dropping weight leases.
pub fn run_layer(
    hidden: &Array,
    plan: &LayerPlan,
    // Attention norm weights
    attn_norm: &Array,
    ffn_norm: &Array,
    // QKV projections (weight, scales, biases triplets)
    qw: &Array, qs: &Array, qb: &Array,
    kw: &Array, ks: &Array, kb: &Array,
    vw: &Array, vs: &Array, vb: &Array,
    ow: &Array, os: &Array, ob: &Array,
    // Q/K norm weights
    q_norm_weight: Option<&Array>,
    k_norm_weight: Option<&Array>,
    // MLP projections
    gw: &Array, gs: &Array, gb: &Array,
    uw: &Array, us: &Array, ub: &Array,
    dw: &Array, ds: &Array, db: &Array,
    // RoPE tables
    rope_cos: &Array,
    rope_sin: &Array,
    // KV cache for this layer
    cache: &mut KvCache,
    kv_offset: u32,
    rms_norm_eps: f32,
) -> MlxResult<Array> {
    let _n_tokens = hidden.shape()[0];

    // --- Attention norm ---
    let residual = hidden;
    let normed = primitives::rms_norm(hidden, attn_norm, rms_norm_eps)?;

    // --- Attention ---
    let attn_out = match plan.attention_kind.as_str() {
        "sliding_attention" => sliding_attention_layer(
            &normed, plan, qw, qs, qb, kw, ks, kb, vw, vs, vb, ow, os, ob,
            q_norm_weight, k_norm_weight, rope_cos, rope_sin, kv_offset, cache,
        )?,
        "full_attention" => full_attention_layer(
            &normed, plan, qw, qs, qb, kw, ks, kb, ow, os, ob,
            q_norm_weight, k_norm_weight, rope_cos, rope_sin, kv_offset, cache,
        )?,
        other => {
            return Err(mlx_rs::error::Exception::custom(format!(
                "unknown attention_kind: {}", other
            )));
        }
    };

    let hidden = residual.add(&attn_out)?;

    // --- FFN norm ---
    let residual = &hidden;
    let normed = primitives::rms_norm(&hidden, ffn_norm, rms_norm_eps)?;

    // --- SwiGLU MLP ---
    let gate = qmatmul(&normed, gw, gs, gb)?;
    let up = qmatmul(&normed, uw, us, ub)?;
    let gated = mlx_rs::nn::silu(&gate)?.multiply(&up)?;
    let ffn_out = qmatmul(&gated, dw, ds, db)?;

    residual.add(&ffn_out)
}

// ── Attention implementations ──────────────────────────────────────────────

fn qmatmul(x: &Array, w: &Array, s: &Array, b: &Array) -> MlxResult<Array> {
    let group_size = if s.shape().len() >= 1 {
        (w.shape()[1] as i32 * 4) / s.shape()[s.shape().len() - 1]
    } else {
        64
    };
    mlx_rs::ops::quantized_matmul(x, w, s, b, true, group_size, 8)
}

fn sliding_attention_layer(
    x: &Array,
    plan: &LayerPlan,
    qw: &Array, qs: &Array, qb: &Array,
    kw: &Array, ks: &Array, kb: &Array,
    vw: &Array, vs: &Array, vb: &Array,
    ow: &Array, os: &Array, ob: &Array,
    q_norm_weight: Option<&Array>,
    k_norm_weight: Option<&Array>,
    rope_cos: &Array,
    rope_sin: &Array,
    kv_offset: u32,
    cache: &mut KvCache,
) -> MlxResult<Array> {
    let n_tokens = x.shape()[0];
    let n_heads = plan.n_heads;
    let n_kv_heads = plan.n_kv_heads;
    let head_dim = plan.head_dim;
    let n_rep = n_heads / n_kv_heads;

    let q = qmatmul(x, qw, qs, qb)?
        .reshape(&[n_tokens, n_heads as i32, head_dim as i32])?;
    let k = qmatmul(x, kw, ks, kb)?
        .reshape(&[n_tokens, n_kv_heads as i32, head_dim as i32])?;
    let v = qmatmul(x, vw, vs, vb)?
        .reshape(&[n_tokens, n_kv_heads as i32, head_dim as i32])?;

    // Append raw (pre-norm, pre-RoPE) K,V to cache, then read full window.
    cache.append(k, v)?;
    let (k_cached, v_cached) = cache.read_window().expect("cache must be non-empty after append");
    let cached_seq = k_cached.shape()[0];

    // Q projection: norm + RoPE on current tokens only.
    let q = if let Some(wn) = q_norm_weight {
        primitives::rms_norm(&q.reshape(&[-1, head_dim as i32])?, wn, 1e-6)?
    } else {
        primitives::rms_norm_scale_free(&q.reshape(&[-1, head_dim as i32])?, 1e-6)?
    }.reshape(&[n_tokens, n_heads as i32, head_dim as i32])?;

    // Apply norm + RoPE to the full cached K.
    let k_cached = if let Some(wn) = k_norm_weight {
        primitives::rms_norm(&k_cached.reshape(&[-1, head_dim as i32])?, wn, 1e-6)?
    } else {
        primitives::rms_norm_scale_free(&k_cached.reshape(&[-1, head_dim as i32])?, 1e-6)?
    }.reshape(&[cached_seq as i32, n_kv_heads as i32, head_dim as i32])?;

    // RoPE on Q (current tokens)
    let q4d = q.reshape(&[1, n_heads as i32, n_tokens, head_dim as i32])?;
    let q4d = primitives::rope_apply(&q4d, rope_cos, rope_sin, kv_offset, plan.partial_rotary_factor)?;
    let q = q4d.reshape(&[n_tokens, n_heads as i32, head_dim as i32])?;

    // RoPE on cached K (all positions, starting at offset 0)
    let k4d = k_cached.reshape(&[1, n_kv_heads as i32, cached_seq as i32, head_dim as i32])?;
    let k4d = primitives::rope_apply(&k4d, rope_cos, rope_sin, 0, plan.partial_rotary_factor)?;
    let k = k4d.reshape(&[cached_seq as i32, n_kv_heads as i32, head_dim as i32])?;

    // GQA repeat KV
    let k_exp = repeat_kv(&k, n_rep)?;
    let v_exp = repeat_kv(&v_cached, n_rep)?;

    // Attention scores: Q [heads, n_tokens, hd] @ K^T [heads, hd, cached_seq]
    let qt = q.reshape(&[n_heads as i32, n_tokens, head_dim as i32])?;
    let kt = k_exp.reshape(&[n_heads as i32, cached_seq as i32, head_dim as i32])?;
    let vt = v_exp.reshape(&[n_heads as i32, cached_seq as i32, head_dim as i32])?;

    let scale = (head_dim as f32).sqrt();
    let scores = qt
        .matmul(&mlx_rs::ops::transpose_axes(&kt, &[0, 2, 1])?)?
        .divide(&Array::from_f32(scale))?;

    // Causal mask sized [n_tokens, cached_seq] with sliding window
    let mask = causal_mask(cached_seq as u32)?
        .add(&sliding_mask(cached_seq as u32, plan.sliding_window, n_heads)?)?;
    eprintln!("[mask] cached_seq={} n_tokens={} n_heads={}", cached_seq, n_tokens, n_heads);
    // Subset to only the last n_tokens rows along the sequence axis.
    let mask = if cached_seq > n_tokens {
        let rows_from = (cached_seq - n_tokens) as i32;
        eprintln!("[mask] subset rows_from={}..cached_seq", rows_from);
        mask.index((.., .., rows_from.., ..))
    } else {
        mask
    };
    let scores = scores.add(&mask)?;

    let attn = mlx_rs::ops::softmax_axes(&scores, &[-1], None)?;
    let out = attn.matmul(&vt)?
        .reshape(&[n_tokens, (n_heads * head_dim) as i32])?;
    qmatmul(&out, ow, os, ob)?.reshape(&[n_tokens, -1])
}

fn full_attention_layer(
    x: &Array,
    plan: &LayerPlan,
    qw: &Array, qs: &Array, qb: &Array,
    kw: &Array, ks: &Array, kb: &Array,
    ow: &Array, os: &Array, ob: &Array,
    q_norm_weight: Option<&Array>,
    k_norm_weight: Option<&Array>,
    rope_cos: &Array,
    rope_sin: &Array,
    kv_offset: u32,
    cache: &mut KvCache,
) -> MlxResult<Array> {
    let n_tokens = x.shape()[0];
    let n_heads = plan.n_heads;
    let head_dim = plan.global_head_dim.unwrap_or(plan.head_dim);
    let n_kv_heads = plan.n_global_kv_heads.unwrap_or(plan.n_kv_heads);
    let n_rep = n_heads / n_kv_heads;

    let q = qmatmul(x, qw, qs, qb)?
        .reshape(&[n_tokens, n_heads as i32, head_dim as i32])?;
    let k = qmatmul(x, kw, ks, kb)?
        .reshape(&[n_tokens, n_kv_heads as i32, head_dim as i32])?;

    // K-equals-V: store K in both K and V cache slots.
    let v = k.clone();
    // Append raw (pre-norm, pre-RoPE) K and V (=K) to cache, then read full window.
    cache.append(k, v)?;
    let (k_cached, v_cached) = cache.read_window().expect("cache must be non-empty after append");
    let cached_seq = k_cached.shape()[0];

    // Q projection: norm + RoPE on current tokens only.
    let q = if let Some(wn) = q_norm_weight {
        primitives::rms_norm(&q.reshape(&[-1, head_dim as i32])?, wn, 1e-6)?
    } else {
        primitives::rms_norm_scale_free(&q.reshape(&[-1, head_dim as i32])?, 1e-6)?
    }.reshape(&[n_tokens, n_heads as i32, head_dim as i32])?;

    // Apply norm + RoPE to the full cached K.
    let k_cached = if let Some(wn) = k_norm_weight {
        primitives::rms_norm(&k_cached.reshape(&[-1, head_dim as i32])?, wn, 1e-6)?
    } else {
        primitives::rms_norm_scale_free(&k_cached.reshape(&[-1, head_dim as i32])?, 1e-6)?
    }.reshape(&[cached_seq as i32, n_kv_heads as i32, head_dim as i32])?;

    // RoPE on Q (current tokens)
    let q4d = q.reshape(&[1, n_heads as i32, n_tokens, head_dim as i32])?;
    let q4d = primitives::rope_apply(&q4d, rope_cos, rope_sin, kv_offset, plan.partial_rotary_factor)?;
    let q = q4d.reshape(&[n_tokens, n_heads as i32, head_dim as i32])?;

    // RoPE on cached K (all positions, starting at offset 0)
    let k4d = k_cached.reshape(&[1, n_kv_heads as i32, cached_seq as i32, head_dim as i32])?;
    let k4d = primitives::rope_apply(&k4d, rope_cos, rope_sin, 0, plan.partial_rotary_factor)?;
    let k = k4d.reshape(&[cached_seq as i32, n_kv_heads as i32, head_dim as i32])?;
    let v = v_cached; // V stays pre-RoPE (same as current non-cached behavior)

    // GQA repeat KV
    let k_exp = repeat_kv(&k, n_rep)?;
    let v_exp = repeat_kv(&v, n_rep)?;

    let qt = q.reshape(&[n_heads as i32, n_tokens, head_dim as i32])?;
    let kt = k_exp.reshape(&[n_heads as i32, cached_seq as i32, head_dim as i32])?;
    let vt = v_exp.reshape(&[n_heads as i32, cached_seq as i32, head_dim as i32])?;

    let scale = (head_dim as f32).sqrt();
    let scores = qt
        .matmul(&mlx_rs::ops::transpose_axes(&kt, &[0, 2, 1])?)?
        .divide(&Array::from_f32(scale))?;

    // Full causal mask sized [cached_seq, cached_seq], subset to last n_tokens rows
    let mask = causal_mask(cached_seq as u32)?;
    let mask = if cached_seq > n_tokens {
        let rows_from = (cached_seq - n_tokens) as i32;
        mask.index((.., .., rows_from.., ..))
    } else {
        mask
    };
    let scores = scores.add(&mask)?;

    let attn = mlx_rs::ops::softmax_axes(&scores, &[-1], None)?;
    let out = attn.matmul(&vt)?
        .reshape(&[n_tokens, (n_heads * head_dim) as i32])?;
    qmatmul(&out, ow, os, ob)?.reshape(&[n_tokens, -1])
}

// ── Epilogue ───────────────────────────────────────────────────────────────

/// Final normalization, tied output projection, softcapping, and native greedy argmax.
///
/// Returns the selected token ID as a u32 scalar — no logits cross the boundary.
/// The caller is responsible for calling `eval()` before reading the result.
pub fn run_epilogue(
    hidden: &Array,
    final_norm: &Array,
    output_weight: &Array,
    output_scales: &Array,
    output_biases: &Array,
    plan: &EpiloguePlan,
    rms_norm_eps: f32,
    tie_word_embeddings: bool,
    sampler: &SamplerConfig,
) -> MlxResult<u32> {
    // Final RMSNorm
    let normed = primitives::rms_norm(hidden, final_norm, rms_norm_eps)?;

    // Tied output projection: quantized matmul with embedding weights
    let group_size = if output_scales.shape().len() >= 1 {
        (output_weight.shape()[1] as i32 * 4) / output_scales.shape()[output_scales.shape().len() - 1]
    } else {
        64
    };
    let logits = if tie_word_embeddings {
        mlx_rs::ops::quantized_matmul(
            &normed,
            output_weight,
            output_scales,
            output_biases,
            true, // transpose weight
            group_size,
            8,
        )?
    } else {
        // Non-tied: use dedicated lm_head tensor if available
        mlx_rs::ops::quantized_matmul(
            &normed,
            output_weight,
            output_scales,
            output_biases,
            true,
            group_size,
            8,
        )?
    };

    // Final logit softcapping
    let logits = if let Some(cap) = plan.final_logit_softcapping {
        let cap_f32 = cap as f32;
        let scaled = logits.divide(&Array::from_f32(cap_f32))?;
        let tanh = mlx_rs::ops::tanh(&scaled)?;
        tanh.multiply(&Array::from_f32(cap_f32))?
    } else {
        logits
    };

    // Extract last token position logits: shape [1, 1, vocab_size]
    let last_logits = logits.index((
        0..1,
        (logits.shape()[1] - 1)..logits.shape()[1],
        ..,
    ));

    // Greedy path: fast argmax (no sampling overhead)
    if sampler.is_greedy() {
        let token_arr = mlx_rs::ops::indexing::argmax_axis(&last_logits, -1, None)
            .map_err(|e| mlx_rs::error::Exception::custom(format!("argmax: {:?}", e)))?;
        let values = token_arr
            .try_as_slice::<u32>()
            .map_err(|e| mlx_rs::error::Exception::custom(format!("read token: {:?}", e)))?;
        return Ok(values.first().copied().unwrap_or(0));
    }

    // Non-greedy path: temperature scaling, top-k, top-p, then categorical sample.
    last_logits.eval()?;

    // Flatten to 1D for contiguous extraction
    let flat = last_logits.reshape(&[-1])?;
    let vocab_size = flat.shape()[0] as usize;
    let mut logits_vec: Vec<f32> = flat
        .try_as_slice::<f32>()
        .map_err(|e| mlx_rs::error::Exception::custom(format!("read logits: {:?}", e)))?
        .to_vec();

    // 1. Temperature scaling
    if let Some(temp) = sampler.temperature {
        if temp > 0.0 && (temp - 1.0).abs() > f32::EPSILON {
            let scale = 1.0 / temp;
            for v in &mut logits_vec {
                *v *= scale;
            }
        }
    }

    // 2. Top-k filtering
    if let Some(k) = sampler.top_k {
        let k = (k as usize).min(vocab_size);
        if k > 0 && k < vocab_size {
            let mut sorted = logits_vec.clone();
            sorted.sort_by(|a, b| b.partial_cmp(a).unwrap_or(std::cmp::Ordering::Equal));
            let threshold = sorted[k - 1];
            for v in &mut logits_vec {
                if *v < threshold {
                    *v = f32::NEG_INFINITY;
                }
            }
        }
    }

    // 3. Top-p (nucleus) filtering
    if let Some(p) = sampler.top_p {
        if p > 0.0 && p < 1.0 {
            // Compute softmax probabilities for sorting
            let max_l = logits_vec
                .iter()
                .cloned()
                .fold(f32::NEG_INFINITY, f32::max);
            let mut probs = vec![0.0f32; vocab_size];
            let mut prob_sum = 0.0f32;
            for (i, &v) in logits_vec.iter().enumerate() {
                let e = (v - max_l).exp();
                probs[i] = e;
                prob_sum += e;
            }
            if prob_sum > 0.0 {
                for v in &mut probs {
                    *v /= prob_sum;
                }
            }

            // Sort indices by probability descending
            let mut indices: Vec<usize> = (0..vocab_size).collect();
            indices.sort_by(|&a, &b| {
                probs[b]
                    .partial_cmp(&probs[a])
                    .unwrap_or(std::cmp::Ordering::Equal)
            });

            // Find cumulative cutoff; zero out logits beyond it
            let mut cumsum = 0.0f32;
            for (rank, &idx) in indices.iter().enumerate() {
                cumsum += probs[idx];
                if cumsum > p {
                    for &i in &indices[rank..] {
                        logits_vec[i] = f32::NEG_INFINITY;
                    }
                    break;
                }
            }
        }
    }

    // 4. Check if everything was filtered — fall back to argmax
    let all_inf = logits_vec
        .iter()
        .all(|v| !v.is_finite() || v.is_nan());
    if all_inf {
        let token = logits_vec
            .iter()
            .enumerate()
            .max_by(|(_, a), (_, b)| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal))
            .map(|(i, _)| i as u32)
            .unwrap_or(0);
        return Ok(token);
    }

    // 5. Categorical sample via MLX
    let shape = [1i32, 1, vocab_size as i32];
    let filtered_arr = Array::from_slice(&logits_vec, &shape);
    let key = match sampler.seed {
        Some(s) => Some(mlx_rs::random::key(s)?),
        None => None,
    };
    let token_arr = mlx_rs::random::categorical(&filtered_arr, None, None, key.as_ref())?;
    let values = token_arr
        .try_as_slice::<u32>()
        .map_err(|e| mlx_rs::error::Exception::custom(format!("read sampled token: {:?}", e)))?;
    Ok(values.first().copied().unwrap_or(0))
}

// ── Mask helpers ───────────────────────────────────────────────────────────

fn causal_mask(seq_len: u32) -> MlxResult<Array> {
    let n = seq_len as usize;
    let mut d = vec![0.0f32; n * n];
    for i in 0..n {
        for j in 0..n {
            if j > i {
                d[i * n + j] = f32::NEG_INFINITY;
            }
        }
    }
    Ok(Array::from_slice(&d, &[1, 1, seq_len as i32, seq_len as i32]))
}

fn sliding_mask(seq_len: u32, window: u32, _n_heads: u32) -> MlxResult<Array> {
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
    Ok(Array::from_slice(&d, &[1, 1, seq_len as i32, seq_len as i32]))
}

fn repeat_kv(x: &Array, n_rep: u32) -> MlxResult<Array> {
    if n_rep <= 1 {
        return Ok(x.clone());
    }
    // x: [N, n_kv, hd] → insert dim at axis 1 → [N, 1, n_kv, hd] → tile → [N, n_rep, n_kv, hd] → [N, n_rep*n_kv, hd]
    let s = x.shape();
    let r = x.reshape(&[s[0], 1, s[1], s[2]])?;
    let r = mlx_rs::ops::tile(&r, &[1, n_rep as i32, 1, 1])?;
    r.reshape(&[s[0], s[1] * n_rep as i32, s[2]])
}
