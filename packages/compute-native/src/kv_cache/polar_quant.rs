//! PolarQuant: randomized Hadamard rotation + Lloyd-Max quantization.
//!
//! Algorithm from TurboQuant (ICLR 2026). After Walsh-Hadamard Transform
//! rotation, coordinate distributions become approximately N(0, 1/sqrt(d)).
//! The precomputed Lloyd-Max codebook provides optimal 3-bit quantization
//! for this known distribution.
//!
//! Attribution: codebook constants derived from arozanov/turboquant-mlx
//! (Apache 2.0). The algorithm is from the TurboQuant paper (arXiv:2504.19874).

use mlx_rs::error::Result as MlxResult;
use mlx_rs::Array;

// ── Lloyd-Max Codebook for N(0,1) ──────────────────────────────────────────

/// Optimal Lloyd-Max centroids for standard normal distribution at 3 bits.
/// These are well-known precomputed values. 8 levels = 3-bit quantization.
pub const CENTROIDS_3BIT: [f32; 8] = [
    -2.1520, -1.3440, -0.7560, -0.2451, 0.2451, 0.7560, 1.3440, 2.1520,
];

/// Decision boundaries: midpoints between adjacent centroids.
pub fn boundaries_3bit() -> [f32; 7] {
    let mut boundaries = [0.0f32; 7];
    for i in 0..7 {
        boundaries[i] = (CENTROIDS_3BIT[i] + CENTROIDS_3BIT[i + 1]) / 2.0;
    }
    boundaries
}

/// Number of uint32 words needed to pack `dim` values at `bits` each.
pub fn packed_dim(dim: usize, bits: u32) -> usize {
    let vpw = match bits {
        1 => 32,
        2 => 16,
        3 => 10,
        4 => 8,
        _ => panic!("Unsupported bits: {}", bits),
    };
    (dim + vpw - 1) / vpw
}

// ── Random Rotation Signs ──────────────────────────────────────────────────

/// Generate deterministic ±1 signs for Walsh-Hadamard randomization.
pub fn random_signs(dim: usize, seed: u64) -> Vec<f32> {
    let mut state = seed;
    let mut signs = Vec::with_capacity(dim);
    for _ in 0..dim {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        signs.push(if (state & 1) == 0 { 1.0 } else { -1.0 });
    }
    signs
}

// ── MLX-based Quantize/Dequantize (stub — real path uses Metal kernels) ─────

/// Stub quantize — real path uses fused Metal kernel via FFI.
pub fn quantize_mlx(
    x: &Array,
    dim: usize,
    bits: u32,
    _signs: &Array,
    _boundaries: &Array,
) -> MlxResult<(Array, Array)> {
    let _ = dim;
    let _ = bits;
    let p_dim = super::packing::packed_dim(dim, bits);
    let n_vecs = x.shape()[0] as usize;
    let indices = Array::from_slice(&vec![0u32; n_vecs * p_dim], &[x.shape()[0], p_dim as i32]);
    let norms = Array::from_slice(&vec![0.0f32; n_vecs], &[x.shape()[0]]);
    Ok((indices, norms))
}

/// Stub dequantize — real path uses fused Metal kernel via FFI.
pub fn dequantize_mlx(
    packed: &Array,
    _norms: &Array,
    dim: usize,
    _bits: u32,
    _centroids: &Array,
    _signs: &Array,
) -> MlxResult<Array> {
    let n_vecs = packed.shape()[0] as usize;
    Ok(Array::from_slice(
        &vec![0.0f32; n_vecs * dim],
        &[packed.shape()[0], dim as i32],
    ))
}
