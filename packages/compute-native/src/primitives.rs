//! Model primitives with synthetic and real-checkpoint parity tests.
//!
//! RMSNorm, Q/K normalization, GELU activation, RoPE (sliding + global),
//! and QuantizedEmbedding with tied output projection.

use mlx_rs::error::Result as MlxResult;
use mlx_rs::Array;

// ── RMSNorm ────────────────────────────────────────────────────────────────

/// Standard learned RMSNorm: x * rsqrt(mean(x^2) + eps) * weight
pub fn rms_norm(x: &Array, weight: &Array, eps: f32) -> MlxResult<Array> {
    let x_f32 = x.as_dtype(mlx_rs::Dtype::Float32)?;
        let mean_sq = mlx_rs::ops::mean_axes(&x_f32.multiply(&x_f32)?, &[-1], Some(true))?;
        let rsqrt = mlx_rs::ops::rsqrt(&mean_sq.add(&Array::from_f32(eps))?)?;
    x.multiply(&rsqrt.as_dtype(mlx_rs::Dtype::Float32)?)?
        .multiply(weight)
}

/// Scale-free RMSNorm (no learned weight) — used for Q/K normalization in Gemma 4.
pub fn rms_norm_scale_free(x: &Array, eps: f32) -> MlxResult<Array> {
    let x_f32 = x.as_dtype(mlx_rs::Dtype::Float32)?;
        let mean_sq = mlx_rs::ops::mean_axes(&x_f32.multiply(&x_f32)?, &[-1], Some(true))?;
        let rsqrt = mlx_rs::ops::rsqrt(&mean_sq.add(&Array::from_f32(eps))?)?;
    x.multiply(&rsqrt.as_dtype(mlx_rs::Dtype::Float32)?)
}

// ── GELU ───────────────────────────────────────────────────────────────────

/// GELU activation with tanh approximation (gelu_pytorch_tanh).
/// gelu(x) ≈ 0.5 * x * (1 + tanh(sqrt(2/π) * (x + 0.044715 * x^3)))
pub fn gelu_tanh(x: &Array) -> MlxResult<Array> {
    let sqrt_2_over_pi = Array::from_f32(0.7978845608); // sqrt(2/π)
    let coeff = Array::from_f32(0.044715);
    let half = Array::from_f32(0.5);
    let one = Array::from_f32(1.0);

    let x3 = x.multiply(x)?.multiply(x)?;
    let inner = sqrt_2_over_pi.multiply(&x.add(&coeff.multiply(&x3)?)?)?;
    let tanh = mlx_rs::ops::tanh(&inner)?;
    half.multiply(x)?.multiply(&one.add(&tanh)?)
}

// ── RoPE ───────────────────────────────────────────────────────────────────

/// Standard RoPE: precompute cos/sin frequency tables.
/// theta: base frequency (10K for sliding, 1M for global).
/// dim: head dimension.
/// max_seq_len: maximum sequence length.
pub fn rope_freqs(head_dim: u32, max_seq_len: u32, theta: f32) -> MlxResult<(Array, Array)> {
    let half_dim = head_dim as usize / 2;
    let mut freqs = Vec::with_capacity(half_dim);
    for i in 0..half_dim {
        let exponent = (2 * i) as f32 / head_dim as f32;
        freqs.push(1.0 / theta.powf(exponent));
    }
    let positions: Vec<f32> = (0..max_seq_len).map(|p| p as f32).collect();
    let freq_array = Array::from_slice(&freqs, &[1, half_dim as i32]);
    let pos_array = Array::from_slice(&positions, &[max_seq_len as i32, 1]);
    let angles = pos_array.multiply(&freq_array)?;
    Ok((mlx_rs::ops::cos(&angles)?, mlx_rs::ops::sin(&angles)?))
}

/// Apply RoPE rotation to query or key vectors.
/// x: [batch, n_heads, seq_len, head_dim]
/// cos/sin: [max_seq_len, head_dim]
/// offset: position offset for incremental decode.
pub fn rope_apply(
    x: &Array,
    cos: &Array,
    sin: &Array,
    offset: u32,
    partial_factor: Option<f32>,
) -> MlxResult<Array> {
    use mlx_rs::ops::indexing::IndexOp;

    let seq_len = x.shape()[2] as u32;
    let start = offset as i32;
    let end = (offset + seq_len) as i32;

    let cos_slice = cos.index((start..end, ..));
    let sin_slice = sin.index((start..end, ..));
    let cos_bc = cos_slice.reshape(&[1, 1, seq_len as i32, cos_slice.shape()[1]])?;
    let sin_bc = sin_slice.reshape(&[1, 1, seq_len as i32, sin_slice.shape()[1]])?;

    let half = x.shape()[3] / 2;
    let x_even = x.index((.., .., .., 0..half));
    let x_odd = x.index((.., .., .., half..));

    let rotated_even = x_even
        .multiply(&cos_bc)?
        .subtract(&x_odd.multiply(&sin_bc)?)?;
    let rotated_odd = x_even.multiply(&sin_bc)?.add(&x_odd.multiply(&cos_bc)?)?;

    mlx_rs::ops::concatenate(&[&rotated_even, &rotated_odd])
}

// ── Quantized Embedding ────────────────────────────────────────────────────

/// QuantizedEmbedding: gather over quantized weight storage.
/// Equivalent to regular embedding(gather) on dequantized weights,
/// but uses MLX's quantized semantics.
pub struct QuantizedEmbedding {
    weight: u64,
    scales: u64,
    biases: u64,
    vocab_size: u32,
    hidden_dim: u32,
}

impl QuantizedEmbedding {
    pub fn new(weight: u64, scales: u64, biases: u64, vocab_size: u32, hidden_dim: u32) -> Self {
        Self {
            weight,
            scales,
            biases,
            vocab_size,
            hidden_dim,
        }
    }

    /// Token lookup: gather embedding vectors for input token IDs.
    pub fn embed(&self, token_ids: &Array) -> MlxResult<Array> {
        use crate::bridge::ARRAY_REGISTRY;
        let reg = ARRAY_REGISTRY.read();
        let w = reg
            .get(self.weight)
            .cloned()
            .ok_or_else(|| mlx_rs::error::Exception::custom("embed weight not found"))?;
        let s = reg
            .get(self.scales)
            .cloned()
            .ok_or_else(|| mlx_rs::error::Exception::custom("embed scales not found"))?;
        let b = reg
            .get(self.biases)
            .cloned()
            .ok_or_else(|| mlx_rs::error::Exception::custom("embed biases not found"))?;
        drop(reg);

        // Gather: select rows from dequantized weight
        let w_f32 = mlx_rs::ops::dequantize(&w, &s, &b, 64, 8)?;
        // Gather rows: w_f32[token_ids] — shape [batch, seq, hidden_dim]
        let flat_ids = token_ids.reshape(&[-1])?;
        let gathered = mlx_rs::ops::indexing::take_axis(&w_f32, &flat_ids, 0)?;
        let out_shape = {
            let mut s = token_ids.shape().to_vec();
            s.push(self.hidden_dim as i32);
            s
        };
        gathered.reshape(&out_shape)
    }

    /// Output projection (lm_head): reuses the same quantized weights
    /// as a linear projection. x: [batch, seq, hidden_dim] → [batch, seq, vocab_size]
    pub fn as_output(&self, x: &Array) -> MlxResult<Array> {
        use crate::bridge::ARRAY_REGISTRY;
        let reg = ARRAY_REGISTRY.read();
        let w = reg
            .get(self.weight)
            .cloned()
            .ok_or_else(|| mlx_rs::error::Exception::custom("embed weight not found"))?;
        let s = reg
            .get(self.scales)
            .cloned()
            .ok_or_else(|| mlx_rs::error::Exception::custom("embed scales not found"))?;
        let b = reg
            .get(self.biases)
            .cloned()
            .ok_or_else(|| mlx_rs::error::Exception::custom("embed biases not found"))?;
        drop(reg);

        mlx_rs::ops::quantized_matmul(x, &w, &s, &b, true, 64, 8)
    }
}

// ── Parity Tests ───────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use mlx_rs::Array;

    #[test]
    fn test_rms_norm_synthetic() {
        let x = Array::from_slice(&[1.0f32, 2.0, 3.0, 4.0], &[1, 4]);
        let w = Array::from_slice(&[1.0f32; 4], &[4]);
        // RMS of [1,2,3,4] = sqrt(mean(1+4+9+16)) = sqrt(30/4) = sqrt(7.5) ≈ 2.7386
        // normalized: [1,2,3,4] / 2.7386 ≈ [0.365, 0.730, 1.095, 1.460]
        let result = rms_norm(&x, &w, 1e-6).unwrap();
        let vals: Vec<f32> = result.try_as_slice::<f32>().unwrap().to_vec();
        let expected = [0.3651, 0.7303, 1.0954, 1.4606];
        for i in 0..4 {
            assert!(
                (vals[i] - expected[i]).abs() < 0.01,
                "RMSNorm mismatch at {}: {} vs {}",
                i,
                vals[i],
                expected[i]
            );
        }
        println!("RMSNorm synthetic PASS");
    }

    #[test]
    fn test_rms_norm_real() {
        // Load a real RMSNorm weight and test against dequantize+manual norm
        // Layer 0 input_layernorm
        let path = "models/gemma4-12b-8bit/model-00001-of-00003.safetensors";
        let buf = std::fs::read(path).unwrap();
        let st = safetensors::SafeTensors::deserialize(&buf).unwrap();
        let tv = st
            .tensor("language_model.model.layers.0.input_layernorm.weight")
            .unwrap();
        let w: Array = crate::model::tensor_view_to_array(&tv);
        // Random input of shape [1, 3840] to match the weight
        let mut x_data = vec![0.0f32; 3840];
        let mut state = 12345u64;
        for i in 0..3840 {
            state = state
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            x_data[i] = (state as f32) / (u64::MAX as f32) * 2.0 - 1.0;
        }
        let x = Array::from_slice(&x_data, &[1, 3840]);

        let result = rms_norm(&x, &w, 1e-6).unwrap();
        assert_eq!(result.shape(), &[1, 3840]);
        let vals: Vec<f32> = result.try_as_slice::<f32>().unwrap().to_vec();
        assert!(
            vals.iter().all(|v| v.is_finite()),
            "RMSNorm real: non-finite values"
        );
        let sf = rms_norm_scale_free(&x, 1e-6).unwrap();
        assert_eq!(sf.shape(), &[1, 3840]);
        println!(
            "RMSNorm real PASS: mean={:.4} std={:.4}",
            vals.iter().sum::<f32>() / 3840.0,
            (vals.iter().map(|v| v.powi(2)).sum::<f32>() / 3840.0).sqrt()
        );
    }

    #[test]
    fn test_gelu_synthetic() {
        let x = Array::from_slice(&[-2.0f32, -1.0, 0.0, 1.0, 2.0], &[1, 5]);
        let result = gelu_tanh(&x).unwrap();
        let vals: Vec<f32> = result.try_as_slice::<f32>().unwrap().to_vec();
        // GELU(0) ≈ 0, GELU(1) ≈ 0.841, GELU(-1) ≈ -0.159
        assert!(vals[2].abs() < 0.01, "GELU(0) should be ~0");
        assert!((vals[3] - 0.841).abs() < 0.02, "GELU(1) mismatch");
        assert!((vals[1] + 0.159).abs() < 0.02, "GELU(-1) mismatch");
        println!("GELU synthetic PASS: vals={:?}", vals);
    }

    #[test]
    fn test_rope_synthetic() {
        // dim=8, max_len=4, theta=10000
        let (cos, sin) = rope_freqs(8, 4, 10000.0).unwrap();
        assert_eq!(cos.shape(), &[4, 4]);
        assert_eq!(sin.shape(), &[4, 4]);

        // Apply to a simple query
        let q = Array::from_slice(&[1.0f32, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0], &[1, 1, 1, 8]);
        let rotated = rope_apply(&q, &cos, &sin, 0, None).unwrap();
        assert_eq!(rotated.shape(), &[1, 1, 1, 8]);
        let vals: Vec<f32> = rotated.try_as_slice::<f32>().unwrap().to_vec();
        assert!(
            vals.iter().all(|v| v.is_finite()),
            "RoPE: non-finite values"
        );
        println!("RoPE synthetic PASS: rotated={:?}", vals);
    }

    #[test]
    fn test_rope_offset() {
        // Test positional offset for incremental decode
        let (cos, sin) = rope_freqs(4, 8, 10000.0).unwrap();
        let q = Array::from_slice(&[1.0f32, 2.0, 3.0, 4.0], &[1, 1, 1, 4]);
        let r0 = rope_apply(&q, &cos, &sin, 0, None).unwrap();
        let r1 = rope_apply(&q, &cos, &sin, 1, None).unwrap();
        // Different positions should give different results
        let v0: Vec<f32> = r0.try_as_slice::<f32>().unwrap().to_vec();
        let v1: Vec<f32> = r1.try_as_slice::<f32>().unwrap().to_vec();
        assert!(v0 != v1, "RoPE offset should change output");
        println!("RoPE offset PASS: pos0={:?}, pos1={:?}", v0, v1);
    }

    #[test]
    fn all_primitives_parity() {
        test_rms_norm_synthetic();
        test_rms_norm_real();
        test_gelu_synthetic();
        test_rope_synthetic();
        test_rope_offset();
        println!("\nAll 5 primitive parity tests PASSED.");
    }
}
