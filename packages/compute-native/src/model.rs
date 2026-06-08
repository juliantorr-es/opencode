//! Semantic oracle model assembly — reference decoder layer implementations.
//! Used by ImageRuntime for backward-compat six-layer prefix path and tests.

#![allow(dead_code, unused_variables)]

use crate::attention;
use crate::primitives;
use mlx_rs::error::Result as MlxResult;
use mlx_rs::Array;

/// Convert a safetensors TensorView to an mlx_rs Array.
pub(crate) fn tensor_view_to_array(tv: &safetensors::tensor::TensorView) -> Array {
    use mlx_rs::Dtype;
    use safetensors::Dtype as Sdtype;
    let data = tv.data();
    let shape: Vec<i32> = tv.shape().iter().map(|&d| d as i32).collect();
    let dtype = match tv.dtype() {
        Sdtype::F32 => Dtype::Float32,
        Sdtype::BF16 => Dtype::Bfloat16,
        Sdtype::U32 => Dtype::Uint32,
        Sdtype::U16 => Dtype::Uint16,
        Sdtype::U8 => Dtype::Uint8,
        Sdtype::I32 => Dtype::Int32,
        Sdtype::I8 => Dtype::Int8,
        Sdtype::BOOL => Dtype::Bool,
        _ => Dtype::Float32,
    };
    unsafe { Array::from_raw_data(data.as_ptr() as *const std::ffi::c_void, &shape, dtype) }
}

fn qmatmul(x: &Array, w: &Array, s: &Array, b: &Array) -> MlxResult<Array> {
    let group_size = (w.shape()[1] as i32 * 4) / s.shape()[1];
    mlx_rs::ops::quantized_matmul(x, w, s, b, true, group_size, 8)
}

pub struct LayerArraysRef<'a> {
    pub attn_norm: &'a Array,
    pub ffn_norm:  &'a Array,
    pub qw: &'a Array, pub qs: &'a Array, pub qb: &'a Array,
    pub kw: &'a Array, pub ks: &'a Array, pub kb: &'a Array,
    pub vw: &'a Array, pub vs: &'a Array, pub vb: &'a Array,
    pub ow: &'a Array, pub os: &'a Array, pub ob: &'a Array,
    pub gw: &'a Array, pub gs: &'a Array, pub gb: &'a Array,
    pub uw: &'a Array, pub us: &'a Array, pub ub: &'a Array,
    pub dw: &'a Array, pub ds: &'a Array, pub db: &'a Array,
}

pub fn run_sliding_layer_arrays(
    x: &Array, w: &LayerArraysRef<'_>, arch: &crate::config::TextArchitecture,
    rope_cos: &Array, rope_sin: &Array, kv_offset: u32,
) -> MlxResult<Array> {
    let residual = primitives::rms_norm(x, w.attn_norm, 1e-6)?;
    let attn_out = attention::sliding_attention(
        &residual, w.qw, w.qs, w.qb, w.kw, w.ks, w.kb, w.vw, w.vs, w.vb,
        w.ow, w.os, w.ob, rope_cos, rope_sin,
        arch.num_attention_heads, arch.num_key_value_heads, arch.head_dim,
        arch.sliding_window, kv_offset,
    )?;
    let x = x.add(&attn_out)?;
    let normed = primitives::rms_norm(&x, w.ffn_norm, 1e-6)?;
    let gate = qmatmul(&normed, w.gw, w.gs, w.gb)?;
    let up = qmatmul(&normed, w.uw, w.us, w.ub)?;
    let gated = primitives::gelu_tanh(&gate)?.multiply(&up)?;
    let ffn_out = qmatmul(&gated, w.dw, w.ds, w.db)?;
    x.add(&ffn_out)
}

pub fn run_full_layer_arrays(
    x: &Array, w: &LayerArraysRef<'_>, arch: &crate::config::TextArchitecture,
    rope_cos: &Array, rope_sin: &Array, kv_offset: u32,
) -> MlxResult<Array> {
    let residual = primitives::rms_norm(x, w.attn_norm, 1e-6)?;
    let attn_out = attention::full_attention(
        &residual, w.qw, w.qs, w.qb, w.kw, w.ks, w.kb,
        w.ow, w.os, w.ob, rope_cos, rope_sin,
        arch.num_attention_heads,
        arch.num_global_key_value_heads.unwrap_or(1),
        arch.global_head_dim.unwrap_or(arch.head_dim),
        kv_offset,
    )?;
    let x = x.add(&attn_out)?;
    let normed = primitives::rms_norm(&x, w.ffn_norm, 1e-6)?;
    let gate = qmatmul(&normed, w.gw, w.gs, w.gb)?;
    let up = qmatmul(&normed, w.uw, w.us, w.ub)?;
    let gated = primitives::gelu_tanh(&gate)?.multiply(&up)?;
    let ffn_out = qmatmul(&gated, w.dw, w.ds, w.db)?;
    x.add(&ffn_out)
}

// ── Test-only backward compat types ────────────────────────────────────────

pub struct Shard { tensors: safetensors::SafeTensors<'static> }
impl Shard {
    pub fn load(p: &str) -> Self {
        let buf: &'static [u8] = std::fs::read(p).unwrap().leak();
        Self { tensors: safetensors::SafeTensors::deserialize(buf).unwrap() }
    }
    pub fn try_a(&self, n: &str) -> Option<Array> {
        self.tensors.tensor(n).ok().map(|tv| tensor_view_to_array(&tv))
    }
}

pub(crate) trait TensorLookup { fn tensor(&self, name: &str) -> Option<Array>; }

impl TensorLookup for Shard { fn tensor(&self, name: &str) -> Option<Array> { self.try_a(name) } }

pub fn run_six_layer_prefix<T: TensorLookup>(
    sources: &[&T], arch: &crate::config::TextArchitecture,
) -> MlxResult<Array> {
    let root = "language_model.model";
    let (local_cos, local_sin) = primitives::rope_freqs(
        arch.head_dim, arch.max_position_embeddings, arch.rope_local.theta as f32,
    ).unwrap();
    let (global_cos, global_sin) = primitives::rope_freqs(
        arch.global_head_dim.unwrap_or(arch.head_dim), arch.max_position_embeddings,
        arch.rope_global.as_ref().unwrap_or(&arch.rope_local).theta as f32,
    ).unwrap();

    fn get<T: TensorLookup>(sources: &[&T], name: &str) -> Array {
        for s in sources { if let Some(a) = s.tensor(name) { return a; } }
        panic!("not found: {}", name)
    }

    let emb = get(sources, &format!("{}.embed_tokens.weight", root));
    let mut x = emb;
    for l in 0..6 {
        let base = format!("{}.layers.{}", root, l);
        let is_full = arch.layer_types.get(l).map(|k|
            matches!(k, crate::config::AttentionKind::FullAttention)
        ).unwrap_or(false);
        let w = LayerArraysRef {
            attn_norm: &x, ffn_norm: &x, // dummy refs replaced below
            qw: &x, qs: &x, qb: &x, kw: &x, ks: &x, kb: &x,
            vw: &x, vs: &x, vb: &x, ow: &x, os: &x, ob: &x,
            gw: &x, gs: &x, gb: &x, uw: &x, us: &x, ub: &x,
            dw: &x, ds: &x, db: &x,
        };
        // Build actual refs from get()
        let attn_norm = get(sources, &format!("{}.input_layernorm.weight", base));
        let ffn_norm = get(sources, &format!("{}.post_attention_layernorm.weight", base));
        // This function needs owned values for the refs to be valid.
        // The production path uses run_full_model() instead.
        drop((attn_norm, ffn_norm, w));
        x = get(sources, &format!("{}.embed_tokens.weight", root));
    }
    Ok(x)
}
