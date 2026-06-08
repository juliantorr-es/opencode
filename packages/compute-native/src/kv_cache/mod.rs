//! Compressed KV cache using TurboQuant polar quantization.
//!
//! This module implements a mixed-precision KV cache following the
//! TurboQuant paper (ICLR 2026, arXiv:2504.19874):
//!
//! - K cache: 8-bit quantized via Apple's native mx.quantized_matmul
//!   (preserves attention quality — K is softmax-sensitive).
//! - V cache: 3-bit polar quantized (PolarQuant: WHT rotation + Lloyd-Max)
//!   with fused Metal kernels for encode/decode.
//!
//! Key architectural insight from arozanov/turboquant-mlx:
//! K quantization at ≤4 bits destroys greedy decode. Mixed precision
//! is the right approach: K at 8-bit + V at 3-bit or 4-bit.
//!
//! Metal shaders vendored from arozanov/turboquant-mlx (Apache 2.0).
//! Lloyd-Max centroids are precomputed mathematical constants.

pub mod metal;
pub mod packing;
pub mod polar_quant;

use mlx_rs::error::Result as MlxResult;
use mlx_rs::Array;

/// Mixed-precision KV cache: K at 8-bit, V at 3-bit polar quant.
///
/// Stores one layer's KV cache. During prefill, K and V are projected
/// and stored compressed. During decode, new single-position K/V are
/// appended to the cache.
pub struct MixedPrecisionKvCache {
    /// Number of query heads (e.g. 32 for Gemma 4 12B).
    n_q_heads: u32,
    /// Number of KV heads (e.g. 8 for Gemma 4 12B GQA).
    n_kv_heads: u32,
    /// Head dimension (e.g. 120 for Gemma 4 12B).
    head_dim: u32,
    /// Current sequence length (number of positions stored).
    seq_len: u32,

    /// K cache: stored in fp16 (8-bit via mlx quantized_matmul at attention time).
    k_fp16: Option<Array>,
    /// V cache: stored as packed 3-bit indices.
    v_packed: Option<Array>,
    /// V norms: per-position float32 L2 norms.
    v_norms: Option<Array>,

    /// Precomputed rotation signs shared across all layers.
    /// Shape: (head_dim,)
    signs: Array,
    /// Precomputed Lloyd-Max 3-bit centroids. Shape: (8,)
    centroids: Array,
    /// Precomputed decision boundaries. Shape: (7,)
    boundaries: Array,

    /// Pre-rotated query for the current decode step (computed once per step).
    q_rot: Option<Array>,
}

impl MixedPrecisionKvCache {
    /// Create a new empty mixed-precision KV cache.
    ///
    /// Args:
    /// - n_q_heads: number of query heads
    /// - n_kv_heads: number of KV heads (for GQA, n_q_heads / n_kv_heads = group size)
    /// - head_dim: head dimension (must be power of 2 for WHT; pad if needed)
    /// - seed: random seed for rotation signs
    pub fn new(n_q_heads: u32, n_kv_heads: u32, head_dim: u32, seed: u64) -> Self {
        let signs = Array::from_slice(
            &polar_quant::random_signs(head_dim as usize, seed),
            &[head_dim as i32],
        );
        let centroids = Array::from_slice(&polar_quant::CENTROIDS_3BIT, &[8]);
        let boundaries = Array::from_slice(&polar_quant::boundaries_3bit(), &[7]);

        Self {
            n_q_heads,
            n_kv_heads,
            head_dim,
            seq_len: 0,
            k_fp16: None,
            v_packed: None,
            v_norms: None,
            signs,
            centroids,
            boundaries,
            q_rot: None,
        }
    }

    /// Store K and V vectors for a new position (decode step).
    ///
    /// K is stored in fp16 (quantized to 8-bit via mlx at attention time).
    /// V is polar-quantized to 3-bit using the fused Metal kernel.
    pub fn append(&mut self, k: &Array, v: &Array) -> MlxResult<()> {
        // K: store as fp16
        self.k_fp16 = match self.k_fp16.take() {
            Some(existing) => {
                let k_flat = k.reshape(&[1, self.head_dim as i32])?;
                Some(mlx_rs::ops::concatenate(&[&existing, &k_flat])?)
            }
            None => Some(k.reshape(&[1, self.head_dim as i32])?),
        };

        // V: quantize to 3-bit packed
        let (v_packed, v_norms) = metal::fused_quantize(
            &v.reshape(&[1, self.head_dim as i32])?,
            &self.signs,
            &self.boundaries,
            self.head_dim as usize,
            3,
        )?;

        self.v_packed = match self.v_packed.take() {
            Some(existing) => Some(mlx_rs::ops::concatenate(&[&existing, &v_packed])?),
            None => Some(v_packed),
        };
        self.v_norms = match self.v_norms.take() {
            Some(existing) => Some(mlx_rs::ops::concatenate(&[&existing, &v_norms])?),
            None => Some(v_norms),
        };

        self.seq_len += 1;
        self.q_rot = None; // invalidate cached pre-rotation
        Ok(())
    }

    /// Store full K and V for a prefill (batch of positions).
    pub fn store_prefill(&mut self, k: &Array, v: &Array) -> MlxResult<()> {
        // K: store full batch as fp16
        self.k_fp16 = Some(k.clone());

        // V: quantize full batch
        let n_positions = k.shape()[0] as usize;
        let (v_packed, v_norms) = metal::fused_quantize(
            &v.reshape(&[n_positions as i32, self.head_dim as i32])?,
            &self.signs,
            &self.boundaries,
            self.head_dim as usize,
            3,
        )?;
        self.v_packed = Some(v_packed);
        self.v_norms = Some(v_norms);
        self.seq_len = n_positions as u32;
        self.q_rot = None;
        Ok(())
    }

    /// Dequantize V cache into fp16 vectors for attention computation.
    pub fn dequant_v(&self) -> MlxResult<Array> {
        let packed = self
            .v_packed
            .as_ref()
            .ok_or_else(|| mlx_rs::error::Exception::custom("V cache is empty"))?;
        let norms = self
            .v_norms
            .as_ref()
            .ok_or_else(|| mlx_rs::error::Exception::custom("V cache is empty"))?;

        metal::dequant_fp16(
            packed,
            norms,
            &self.centroids,
            &self.signs,
            self.head_dim as usize,
            3,
        )
    }

    /// Get the K cache (fp16). For production, use mlx's native
    /// quantized_matmul with K8 for the actual attention computation.
    pub fn k_fp16(&self) -> Option<&Array> {
        self.k_fp16.as_ref()
    }

    pub fn n_q_heads(&self) -> u32 {
        self.n_q_heads
    }
    pub fn n_kv_heads(&self) -> u32 {
        self.n_kv_heads
    }
    pub fn head_dim(&self) -> u32 {
        self.head_dim
    }
    pub fn seq_len(&self) -> u32 {
        self.seq_len
    }
    pub fn n_rep(&self) -> u32 {
        self.n_q_heads / self.n_kv_heads
    }
}
