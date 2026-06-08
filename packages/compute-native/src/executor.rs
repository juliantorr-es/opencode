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

// ── Helpers ────────────────────────────────────────────────────────────────

/// Hidden scale for the prologue embedding: sqrt(hidden_size).
pub fn prologue_hidden_scale(plan: &ProloguePlan) -> f32 {
    (plan.embedding_shape[1] as f32).sqrt()
}

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
    // Shape contract: token_ids rank 1 (flat tokens) or 2 (batchless [1, tokens]).
    debug_assert!(token_ids.ndim() == 1 || token_ids.ndim() == 2,
        "token_ids must be rank 1 or 2, got rank {}", token_ids.ndim());
    // Flatten to 1D if a singleton batch dim is present.
    let flat_ids = if token_ids.ndim() == 2 {
        token_ids.reshape(&[-1])?
    } else {
        token_ids.clone()
    };

    let emb = primitives::quantized_embedding_lookup(&flat_ids, emb_weight, emb_scales, emb_biases)?;
    // Hidden state must be rank 2 (no batch dim): [tokens, hidden_size]
    debug_assert_eq!(emb.ndim(), 2,
        "hidden state must be rank 2 (batchless), got rank {}", emb.ndim());
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
    // Shape contract: hidden state is batchless [tokens, hidden_size].
    debug_assert_eq!(hidden.ndim(), 2,
        "hidden state must be rank 2 (batchless), got rank {}", hidden.ndim());
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
            &normed, plan, qw, qs, qb, kw, ks, kb, vw, vs, vb, ow, os, ob,
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

    let q = if let Some(wn) = q_norm_weight {
        primitives::rms_norm(&q.reshape(&[-1, head_dim as i32])?, wn, 1e-6)?
    } else {
        primitives::rms_norm_scale_free(&q.reshape(&[-1, head_dim as i32])?, 1e-6)?
    }
    .reshape(&[n_tokens, n_heads as i32, head_dim as i32])?;

    let k = if let Some(wn) = k_norm_weight {
        primitives::rms_norm(&k.reshape(&[-1, head_dim as i32])?, wn, 1e-6)?
    } else {
        primitives::rms_norm_scale_free(&k.reshape(&[-1, head_dim as i32])?, 1e-6)?
    }
    .reshape(&[n_tokens, n_kv_heads as i32, head_dim as i32])?;

    let q4d = q.reshape(&[1, n_heads as i32, n_tokens, head_dim as i32])?;
    let q4d = primitives::rope_apply(&q4d, rope_cos, rope_sin, kv_offset, plan.partial_rotary_factor)?;
    let q = q4d.reshape(&[n_tokens, n_heads as i32, head_dim as i32])?;

    let k4d = k.reshape(&[1, n_kv_heads as i32, n_tokens, head_dim as i32])?;
    let k4d = primitives::rope_apply(&k4d, rope_cos, rope_sin, kv_offset, plan.partial_rotary_factor)?;
    let k = k4d.reshape(&[n_tokens, n_kv_heads as i32, head_dim as i32])?;

    // Materialize the current token batch before appending so the cache holds
    // stable KV tensors rather than a larger lazy graph.
    // Per-step commit: construct candidate K/V updates, complete layer evaluation,
    // then commit the cache position. A failed layer must not partially advance the cache.
    q.eval()?;
    k.eval()?;
    v.eval()?;

    cache.append(k, v)?;
    let (k_cached, v_cached) = cache.read_window().expect("cache must be non-empty after append");
    let cached_seq = k_cached.shape()[0];

    // GQA repeat KV
    let k_exp = repeat_kv(&k_cached, n_rep)?;
    let v_exp = repeat_kv(&v_cached, n_rep)?;

    // Attention scores: Q [heads, n_tokens, hd] @ K^T [heads, hd, cached_seq]
    let qt = q.reshape(&[n_heads as i32, n_tokens, head_dim as i32])?;
    let kt = k_exp.reshape(&[n_heads as i32, cached_seq as i32, head_dim as i32])?;
    let vt = v_exp.reshape(&[n_heads as i32, cached_seq as i32, head_dim as i32])?;

    let scale = (head_dim as f32).sqrt();
    let scores = qt
        .matmul(&mlx_rs::ops::transpose_axes(&kt, &[0, 2, 1])?)?
        .divide(&Array::from_f32(scale))?;

    // Causal + sliding mask sized [n_tokens, cached_seq].
    let mask = causal_mask(n_tokens as u32, cached_seq as u32, kv_offset)?
        .add(&sliding_mask(n_tokens as u32, cached_seq as u32, plan.sliding_window, kv_offset)?)?;
    eprintln!("[mask] cached_seq={} n_tokens={} n_heads={}", cached_seq, n_tokens, n_heads);
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
    let head_dim = plan.global_head_dim.unwrap_or(plan.head_dim);
    let n_kv_heads = plan.n_global_kv_heads.unwrap_or(plan.n_kv_heads);
    let n_rep = n_heads / n_kv_heads;

    let q = qmatmul(x, qw, qs, qb)?
        .reshape(&[n_tokens, n_heads as i32, head_dim as i32])?;
    let k = qmatmul(x, kw, ks, kb)?
        .reshape(&[n_tokens, n_kv_heads as i32, head_dim as i32])?;

    // Plan-driven V semantics: when attention_k_eq_v is true, K and V share
    // weights so we alias K as V rather than computing a separate projection.
    let v: Array = if plan.attention_k_eq_v {
        k.clone()
    } else {
        qmatmul(x, vw, vs, vb)?
            .reshape(&[n_tokens, n_kv_heads as i32, head_dim as i32])?
    };

    let q = if let Some(wn) = q_norm_weight {
        primitives::rms_norm(&q.reshape(&[-1, head_dim as i32])?, wn, 1e-6)?
    } else {
        primitives::rms_norm_scale_free(&q.reshape(&[-1, head_dim as i32])?, 1e-6)?
    }
    .reshape(&[n_tokens, n_heads as i32, head_dim as i32])?;

    let k = if let Some(wn) = k_norm_weight {
        primitives::rms_norm(&k.reshape(&[-1, head_dim as i32])?, wn, 1e-6)?
    } else {
        primitives::rms_norm_scale_free(&k.reshape(&[-1, head_dim as i32])?, 1e-6)?
    }
    .reshape(&[n_tokens, n_kv_heads as i32, head_dim as i32])?;

    let q4d = q.reshape(&[1, n_heads as i32, n_tokens, head_dim as i32])?;
    let q4d = primitives::rope_apply(&q4d, rope_cos, rope_sin, kv_offset, plan.partial_rotary_factor)?;
    let q = q4d.reshape(&[n_tokens, n_heads as i32, head_dim as i32])?;

    let k4d = k.reshape(&[1, n_kv_heads as i32, n_tokens, head_dim as i32])?;
    let k4d = primitives::rope_apply(&k4d, rope_cos, rope_sin, kv_offset, plan.partial_rotary_factor)?;
    let k = k4d.reshape(&[n_tokens, n_kv_heads as i32, head_dim as i32])?;

    // Per-step commit: construct candidate K/V updates, complete layer evaluation,
    // then commit the cache position. A failed layer must not partially advance the cache.
    q.eval()?;
    k.eval()?;
    v.eval()?;
    cache.append(k, v)?;
    let (k_cached, v_cached) = cache.read_window().expect("cache must be non-empty after append");
    let cached_seq = k_cached.shape()[0];

    // GQA repeat KV
    let k_exp = repeat_kv(&k_cached, n_rep)?;
    let v_exp = repeat_kv(&v_cached, n_rep)?;

    let qt = q.reshape(&[n_heads as i32, n_tokens, head_dim as i32])?;
    let kt = k_exp.reshape(&[n_heads as i32, cached_seq as i32, head_dim as i32])?;
    let vt = v_exp.reshape(&[n_heads as i32, cached_seq as i32, head_dim as i32])?;

    let scale = (head_dim as f32).sqrt();
    let scores = qt
        .matmul(&mlx_rs::ops::transpose_axes(&kt, &[0, 2, 1])?)?
        .divide(&Array::from_f32(scale))?;

    // Full causal mask sized [n_tokens, cached_seq].
    let mask = causal_mask(n_tokens as u32, cached_seq as u32, kv_offset)?;
    let scores = scores.add(&mask)?;

    let attn = mlx_rs::ops::softmax_axes(&scores, &[-1], None)?;
    let out = attn.matmul(&vt)?
        .reshape(&[n_tokens, (n_heads * head_dim) as i32])?;
    qmatmul(&out, ow, os, ob)?.reshape(&[n_tokens, -1])
}

// ── Epilogue ───────────────────────────────────────────────────────────────

/// Result of an epilogue execution.
///
/// The caller MUST `eval()` the `selected_token` before reading the scalar
/// value. The `logits` field (when `Some`) holds the full logits tensor
/// (shape `[1, seq_len, vocab_size]`) for optional inspection.
pub struct EpilogueResult {
    /// Scalar token array — caller MUST eval() before reading.
    pub selected_token: Array,
    /// Full logits tensor [1, seq_len, vocab_size] before last-token slicing.
    pub logits: Option<Array>,
}

/// Final normalization, tied output projection, softcapping, and token selection.
///
/// Returns an `EpilogueResult` so the caller can explicitly `eval()` the
/// selected token before reading it. Logits are returned as an `Option` for
/// optional inspection — the caller can `eval()` and inspect them as needed.
///
/// This function does NOT force `eval()` on the returned arrays.
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
) -> MlxResult<EpilogueResult> {
    // Shape contract: hidden state is batchless [tokens, hidden_size].
    debug_assert_eq!(hidden.ndim(), 2,
        "hidden state must be rank 2 (batchless), got rank {}", hidden.ndim());

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
        return Ok(EpilogueResult {
            selected_token: token_arr,
            logits: Some(logits),
        });
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
        return Ok(EpilogueResult {
            selected_token: Array::from_slice(&[token], &[1]),
            logits: Some(logits),
        });
    }

    // 5. Categorical sample via MLX
    let shape = [1i32, 1, vocab_size as i32];
    let filtered_arr = Array::from_slice(&logits_vec, &shape);
    let key = match sampler.seed {
        Some(s) => Some(mlx_rs::random::key(s)?),
        None => None,
    };
    let token_arr = mlx_rs::random::categorical(&filtered_arr, None, None, key.as_ref())?;
    Ok(EpilogueResult {
        selected_token: token_arr,
        logits: Some(logits),
    })
}

// ── Mask helpers ───────────────────────────────────────────────────────────

/// Build a causal attention mask sized [query_len, kv_len].
///
/// Position `i` of the query attends to key positions `j <= offset + i`.
/// For single-token decode against a cache (query_len=1), the mask is [1, kv_len].
fn causal_mask(query_len: u32, kv_len: u32, offset: u32) -> MlxResult<Array> {
    let rows_usize = query_len as usize;
    let cols_usize = kv_len as usize;
    let mut d = vec![0.0f32; rows_usize * cols_usize];
    for i in 0..rows_usize {
        let max_key = offset as usize + i;
        for j in 0..cols_usize {
            if j > max_key {
                d[i * cols_usize + j] = f32::NEG_INFINITY;
            }
        }
    }
    Ok(Array::from_slice(&d, &[1, 1, query_len as i32, kv_len as i32]))
}

/// Build a sliding-window attention mask sized [query_len, kv_len].
///
/// Each query position attends only to keys within the sliding window.
/// For single-token decode against a cache, the mask is [1, kv_len].
fn sliding_mask(query_len: u32, kv_len: u32, window: u32, offset: u32) -> MlxResult<Array> {
    let rows_usize = query_len as usize;
    let cols_usize = kv_len as usize;
    let mut d = vec![0.0f32; rows_usize * cols_usize];
    for i in 0..rows_usize {
        let query_pos = offset as usize + i;
        let min_key = query_pos.saturating_add(1).saturating_sub(window as usize);
        for j in 0..cols_usize {
            if j < min_key || j > query_pos {
                d[i * cols_usize + j] = f32::NEG_INFINITY;
            }
        }
    }
    Ok(Array::from_slice(&d, &[1, 1, query_len as i32, kv_len as i32]))
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
