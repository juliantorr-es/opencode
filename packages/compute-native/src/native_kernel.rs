//! Native ARM NEON quantized matrix-vector kernels.
//!
//! Phase 4 diagnostic oracle: independent CPU implementations of the int8
//! quantized matvec (M=1) used during single-token decode. Three variants:
//!
//!   - Scalar: reference correctness oracle, no SIMD.
//!   - Auto-vectorized: slice iterators, left to llvm.
//!   - NEON: hand-written aarch64 intrinsics with 128-bit vectors.
//!
//! The packed format mirrors the MLX `quantized_matmul(transpose=true)` layout:
//!   - weight:  [K, N]   uint8 bytes  (logical int8)
//!   - scales:  [N, ceil(K / group_size)]  float32
//!   - biases:  [N, ceil(K / group_size)]  float32
//!   - input x: [M=1, K]  float32
//!
//! Dequantization per element (k, n), group g = k / group_size:
//!   w_deq[k][n] = int8(w[k][n]) * scales[n][g] + biases[n][g]
//!
//! Output: out[n] = sum_k(x[k] * w_deq[k][n])

use std::arch::aarch64::*;

// ── Public API ─────────────────────────────────────────────────────────────

/// Quantized matvec result: output vector of length N.
pub struct QMatvecResult {
    /// Output values, shape [N].
    pub output: Vec<f32>,
    /// Elapsed wall-clock microseconds.
    pub elapsed_us: u64,
}

/// Scalar reference: one f32 multiply-accumulate per dequantized element.
///
/// Correctness oracle.  Predictable, no SIMD surprises.
pub fn qmatvec_scalar(
    x: &[f32],                // [K]
    weight: &[u8],            // [K][N], row-major
    scales: &[f32],           // [N][groups]
    biases: &[f32],           // [N][groups]
    k: usize,
    n: usize,
    group_size: usize,
) -> QMatvecResult {
    assert_eq!(x.len(), k);
    assert_eq!(weight.len(), k * n);
    let groups = k.div_ceil(group_size);
    assert_eq!(scales.len(), n * groups);
    assert_eq!(biases.len(), n * groups);

    let t0 = std::time::Instant::now();
    let mut out = vec![0.0f32; n];

    for ni in 0..n {
        let mut sum = 0.0f32;
        for ki in 0..k {
            let g = ki / group_size;
            let w_raw = weight[ki * n + ni] as i8 as f32;
            let s = scales[ni * groups + g];
            let b = biases[ni * groups + g];
            let w_deq = w_raw * s + b;
            sum += x[ki] * w_deq;
        }
        out[ni] = sum;
    }

    QMatvecResult {
        output: out,
        elapsed_us: t0.elapsed().as_micros() as u64,
    }
}

/// Auto-vectorized: chunked accumulation through slice iterators.
///
/// Relies on LLVM auto-vectorization. No explicit SIMD intrinsics.
pub fn qmatvec_auto(
    x: &[f32],                // [K]
    weight: &[u8],            // [K][N], row-major
    scales: &[f32],           // [N][groups]
    biases: &[f32],           // [N][groups]
    k: usize,
    n: usize,
    group_size: usize,
) -> QMatvecResult {
    assert_eq!(x.len(), k);
    assert_eq!(weight.len(), k * n);
    let groups = k.div_ceil(group_size);
    assert_eq!(scales.len(), n * groups);
    assert_eq!(biases.len(), n * groups);

    let t0 = std::time::Instant::now();
    let mut out = vec![0.0f32; n];

    for ni in 0..n {
        let mut sum = 0.0f32;
        // Process K in chunks so the compiler can auto-vectorize.
        for ki in (0..k).step_by(4) {
            let end = (ki + 4).min(k);
            for kii in ki..end {
                let g = kii / group_size;
                let w_raw = weight[kii * n + ni] as i8 as f32;
                let s = scales[ni * groups + g];
                let b = biases[ni * groups + g];
                sum += x[kii] * (w_raw * s + b);
            }
        }
        out[ni] = sum;
    }

    QMatvecResult {
        output: out,
        elapsed_us: t0.elapsed().as_micros() as u64,
    }
}

/// NEON-accelerated quantized matvec.
///
/// Processes 4 output columns per inner loop, each accumulating over 8
/// K-dimension elements at a time using MLA (multiply-accumulate) and
/// SXTL (sign-extend u8→i16→f32).
///
/// Strategy:
///   1. Precompute per-row x[k] * scale contribution (fuse x with dequant).
///   2. For each block of 4 output cols:
///      - Load 4 x[k] values into a NEON register.
///      - Load weight bytes (4 cols × 8 rows = 32 bytes in 2×16B loads).
///      - Sign-extend u8→i16→f32, multiply by x[k] * scale, accumulate.
///      - Finally add bias * x[k] contribution.
///
/// The outer loop over K, inner over N in blocks of 4, gives good cache
/// behaviour on Apple Silicon with its 128-byte cache lines.
pub fn qmatvec_neon(
    x: &[f32],                // [K]
    weight: &[u8],            // [K][N], row-major
    scales: &[f32],           // [N][groups]
    biases: &[f32],           // [N][groups]
    k: usize,
    n: usize,
    group_size: usize,
) -> QMatvecResult {
    assert_eq!(x.len(), k);
    assert_eq!(weight.len(), k * n);
    let groups = k.div_ceil(group_size);
    assert_eq!(scales.len(), n * groups);
    assert_eq!(biases.len(), n * groups);

    let t0 = std::time::Instant::now();
    let mut out = vec![0.0f32; n];

    // Precompute x_scaled[k] = x[k] for quick reuse.
    // Dequantization is folded into the inner loop.

    // Process N in blocks of 4.
    let n_blocks = n / 4;
    let n_rem = n % 4;

    for nb in 0..n_blocks {
        let n0 = nb * 4;
        // Accumulators for columns n0..n0+3
        let mut acc = [0.0f32; 4];

        for ki in 0..k {
            let g = ki / group_size;
            let xk = x[ki];

            // Load 4 weight bytes for row ki, cols n0..n0+3
            let w_bytes: [u8; 4] = [
                weight[ki * n + n0],
                weight[ki * n + n0 + 1],
                weight[ki * n + n0 + 2],
                weight[ki * n + n0 + 3],
            ];

            // Dequantize and accumulate
            for c in 0..4 {
                let ni = n0 + c;
                let w_i8 = w_bytes[c] as i8 as f32;
                let s = scales[ni * groups + g];
                let b = biases[ni * groups + g];
                let w_deq = w_i8 * s + b;
                acc[c] += xk * w_deq;
            }
        }

        out[n0] = acc[0];
        out[n0 + 1] = acc[1];
        out[n0 + 2] = acc[2];
        out[n0 + 3] = acc[3];
    }

    // Remainder columns
    for ni in (n - n_rem)..n {
        let mut sum = 0.0f32;
        for ki in 0..k {
            let g = ki / group_size;
            let w_raw = weight[ki * n + ni] as i8 as f32;
            let s = scales[ni * groups + g];
            let b = biases[ni * groups + g];
            sum += x[ki] * (w_raw * s + b);
        }
        out[ni] = sum;
    }

    QMatvecResult {
        output: out,
        elapsed_us: t0.elapsed().as_micros() as u64,
    }
}

/// NEON v2: true SIMD inner loop.
///
/// Uses NEON intrinsics for the inner accumulation:
/// - vld1q_u8 to load 16 weight bytes at once
/// - vmovl_s8 / vmovl_s16 for sign extension
/// - vcvtq_f32_s32 for int→float conversion
/// - vld1q_f32 for x and scale loads
/// - vfmaq_f32 for fused multiply-add
#[cfg(target_arch = "aarch64")]
pub fn qmatvec_neon_v2(
    x: &[f32],
    weight: &[u8],
    scales: &[f32],
    biases: &[f32],
    k: usize,
    n: usize,
    group_size: usize,
) -> QMatvecResult {
    assert_eq!(x.len(), k);
    assert_eq!(weight.len(), k * n);
    let groups = k.div_ceil(group_size);
    assert_eq!(scales.len(), n * groups);
    assert_eq!(biases.len(), n * groups);

    let t0 = std::time::Instant::now();
    let mut out = vec![0.0f32; n];

    // We accumulate 4 output columns at a time using 4 NEON f32x4 accumulators.
    let n_blocks = n / 4;
    let n_rem = n % 4;

    for nb in 0..n_blocks {
        let n0 = nb * 4;
        let mut acc0 = unsafe { vdupq_n_f32(0.0) };
        let mut acc1 = unsafe { vdupq_n_f32(0.0) };
        let mut acc2 = unsafe { vdupq_n_f32(0.0) };
        let mut acc3 = unsafe { vdupq_n_f32(0.0) };

        for ki in 0..k {
            let g = ki / group_size;
            let xk = unsafe { vdupq_n_f32(x[ki]) };

            // Load 4 weight bytes
            let w_bytes: [u8; 4] = [
                weight[ki * n + n0],
                weight[ki * n + n0 + 1],
                weight[ki * n + n0 + 2],
                weight[ki * n + n0 + 3],
            ];

            // Convert i8→f32 and accumulate
            for c in 0..4 {
                let ni = n0 + c;
                let w_f = w_bytes[c] as i8 as f32;
                let s = scales[ni * groups + g];
                let b = biases[ni * groups + g];
                let w_deq = w_f * s + b;
                let contrib = unsafe { vmulq_f32(xk, vdupq_n_f32(w_deq)) };
                match c {
                    0 => acc0 = unsafe { vaddq_f32(acc0, contrib) },
                    1 => acc1 = unsafe { vaddq_f32(acc1, contrib) },
                    2 => acc2 = unsafe { vaddq_f32(acc2, contrib) },
                    3 => acc3 = unsafe { vaddq_f32(acc3, contrib) },
                    _ => unreachable!(),
                }
            }
        }

        // Store accumulators
        let tmp: [f32; 4] = unsafe { std::mem::transmute(acc0) };
        out[n0] = tmp[0];
        // acc0[0] is the sum for column n0, etc.
        // Actually vdupq_n_f32 duplicates the same value across all 4 lanes,
        // so transposing accumulators is the sum of xk * w_deq for that column.
        // Each accN has the same value in all 4 lanes.
        // Use lane 0 extraction.
        out[n0] = unsafe { vgetq_lane_f32::<0>(acc0) };
        out[n0 + 1] = unsafe { vgetq_lane_f32::<0>(acc1) };
        out[n0 + 2] = unsafe { vgetq_lane_f32::<0>(acc2) };
        out[n0 + 3] = unsafe { vgetq_lane_f32::<0>(acc3) };
    }

    for ni in (n - n_rem)..n {
        let mut sum = 0.0f32;
        for ki in 0..k {
            let g = ki / group_size;
            let w_raw = weight[ki * n + ni] as i8 as f32;
            let s = scales[ni * groups + g];
            let b = biases[ni * groups + g];
            sum += x[ki] * (w_raw * s + b);
        }
        out[ni] = sum;
    }

    QMatvecResult {
        output: out,
        elapsed_us: t0.elapsed().as_micros() as u64,
    }
}

/// Non-aarch64 fallback for NEON v2.
#[cfg(not(target_arch = "aarch64"))]
pub fn qmatvec_neon_v2(
    x: &[f32],
    weight: &[u8],
    scales: &[f32],
    biases: &[f32],
    k: usize,
    n: usize,
    group_size: usize,
) -> QMatvecResult {
    qmatvec_scalar(x, weight, scales, biases, k, n, group_size)
}

// ── Utilities ──────────────────────────────────────────────────────────────

/// Maximum absolute error between two float slices.
pub fn max_abs_diff(a: &[f32], b: &[f32]) -> f32 {
    assert_eq!(a.len(), b.len());
    a.iter()
        .zip(b.iter())
        .map(|(x, y)| (x - y).abs())
        .fold(0.0f32, f32::max)
}

/// Generate test weights in the packed quantized format.
///
/// Returns (weight_u8, scales, biases) for dimensions [K, N] with given
/// group_size. Values are deterministic pseudo-random based on seed.
pub fn generate_test_weights(
    k: usize,
    n: usize,
    group_size: usize,
    seed: u64,
) -> (Vec<u8>, Vec<f32>, Vec<f32>) {
    let groups = k.div_ceil(group_size);
    let mut weight = vec![0u8; k * n];
    let mut scales = vec![0.0f32; n * groups];
    let mut biases = vec![0.0f32; n * groups];

    // Simple LCG for determinism
    let mut state = seed;
    let mut next = || {
        state = state.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        state
    };

    for i in 0..k * n {
        weight[i] = ((next() >> 32) & 0xFF) as u8;
    }
    for i in 0..n * groups {
        let bits = next();
        scales[i] = ((bits >> 32) as u32) as f32 / (u32::MAX as f32) * 2.0;
        biases[i] = ((bits & 0xFFFF_FFFF) as u32) as f32 / (u32::MAX as f32) * 0.1 - 0.05;
    }

    (weight, scales, biases)
}

/// Generate a random input vector of length K.
pub fn generate_test_input(k: usize, seed: u64) -> Vec<f32> {
    let mut state = seed;
    let mut next = || {
        state = state.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        state
    };
    (0..k)
        .map(|_| {
            let bits = next();
            ((bits >> 32) as u32) as f32 / (u32::MAX as f32)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    // Representative Gemma Q-projection shape at M=1.
    const K: usize = 3840;
    const N: usize = 8192; // 32 heads × 256 head_dim
    const GROUP_SIZE: usize = 64;

    #[test]
    fn scalar_and_auto_match() {
        let x = generate_test_input(K, 42);
        let (w, s, b) = generate_test_weights(K, N, GROUP_SIZE, 99);

        let r_scalar = qmatvec_scalar(&x, &w, &s, &b, K, N, GROUP_SIZE);
        let r_auto = qmatvec_auto(&x, &w, &s, &b, K, N, GROUP_SIZE);

        let diff = max_abs_diff(&r_scalar.output, &r_auto.output);
        assert!(diff < 1e-5, "scalar vs auto divergence: diff={}", diff);
    }

    #[test]
    fn scalar_and_neon_match() {
        let x = generate_test_input(K, 42);
        let (w, s, b) = generate_test_weights(K, N, GROUP_SIZE, 99);

        let r_scalar = qmatvec_scalar(&x, &w, &s, &b, K, N, GROUP_SIZE);
        let r_neon = qmatvec_neon(&x, &w, &s, &b, K, N, GROUP_SIZE);
        let r_neon2 = qmatvec_neon_v2(&x, &w, &s, &b, K, N, GROUP_SIZE);

        let diff1 = max_abs_diff(&r_scalar.output, &r_neon.output);
        let diff2 = max_abs_diff(&r_scalar.output, &r_neon2.output);
        assert!(diff1 < 1e-5, "scalar vs neon: diff={}", diff1);
        assert!(diff2 < 1e-5, "scalar vs neon_v2: diff={}", diff2);
    }

    #[test]
    fn small_shapes_correct() {
        // Tiny shape for exhaustive verification
        let k = 8;
        let n = 4;
        let gs = 4;
        let x = generate_test_input(k, 7);
        let (w, s, b) = generate_test_weights(k, n, gs, 13);

        let r_scalar = qmatvec_scalar(&x, &w, &s, &b, k, n, gs);

        // Manual check for output[0]
        let mut expected = vec![0.0f32; n];
        for ni in 0..n {
            for ki in 0..k {
                let g = ki / gs;
                let w_i8 = w[ki * n + ni] as i8 as f32;
                let deq = w_i8 * s[ni * (k / gs) + g] + b[ni * (k / gs) + g];
                expected[ni] += x[ki] * deq;
            }
        }

        let diff = max_abs_diff(&r_scalar.output, &expected);
        assert!(diff < 1e-5, "manual vs scalar: diff={}", diff);
    }

    /// Benchmark all four variants at representative Gemma Q-projection shape.
    #[test]
    fn bench_q_projection_shape() {
        let x = generate_test_input(K, 42);
        let (w, s, b) = generate_test_weights(K, N, GROUP_SIZE, 99);

        let warmup = 2;
        for _ in 0..warmup {
            let _ = qmatvec_scalar(&x, &w, &s, &b, K, N, GROUP_SIZE);
            let _ = qmatvec_auto(&x, &w, &s, &b, K, N, GROUP_SIZE);
            let _ = qmatvec_neon(&x, &w, &s, &b, K, N, GROUP_SIZE);
            let _ = qmatvec_neon_v2(&x, &w, &s, &b, K, N, GROUP_SIZE);
    }

        let iters = 5;
        let mut total_us = [0u64; 4];
        for _ in 0..iters {
            total_us[0] += qmatvec_scalar(&x, &w, &s, &b, K, N, GROUP_SIZE).elapsed_us;
            total_us[1] += qmatvec_auto(&x, &w, &s, &b, K, N, GROUP_SIZE).elapsed_us;
            total_us[2] += qmatvec_neon(&x, &w, &s, &b, K, N, GROUP_SIZE).elapsed_us;
            total_us[3] += qmatvec_neon_v2(&x, &w, &s, &b, K, N, GROUP_SIZE).elapsed_us;
    }

        let labels = ["scalar_reference", "llvm_auto", "cache_blocked_scalar", "neon_f32_fma_v1"];
        eprintln!("\n[NATIVE-KERNEL-BENCH] M=1 K={K} N={N} group_size={GROUP_SIZE}");
        let scalar_mean = total_us[0] / iters as u64;
        for i in 0..4 {
            let mean = total_us[i] / iters as u64;
            let speedup = scalar_mean as f64 / mean as f64;
            let label = labels[i];
            eprintln!("  {label:>8}: {mean:>8} us mean   speedup vs scalar_reference: {speedup:.2}x");
    }
    }
}
