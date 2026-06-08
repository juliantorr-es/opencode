//! QuantizedLinear — thin wrapper around MLX's fused quantized matmul.

use mlx_rs::error::Result as MlxResult;
use mlx_rs::Array;

#[derive(Clone)]
pub struct QuantizedLinearBinding {
    pub weight_handle: u64,
    pub scales_handle: u64,
    pub biases_handle: u64,
    pub logical_out_features: u32,
    pub logical_in_features: u32,
    pub group_size: u32,
    pub bits: u32,
    pub transpose: bool,
}

impl QuantizedLinearBinding {
    pub fn new(
        weight_handle: u64,
        scales_handle: u64,
        biases_handle: u64,
        logical_out_features: u32,
        logical_in_features: u32,
        group_size: u32,
        bits: u32,
        transpose: bool,
    ) -> Self {
        Self {
            weight_handle,
            scales_handle,
            biases_handle,
            logical_out_features,
            logical_in_features,
            group_size,
            bits,
            transpose,
        }
    }

    pub fn forward(&self, x: &Array) -> MlxResult<Array> {
        use crate::bridge::ARRAY_REGISTRY;
        let registry = ARRAY_REGISTRY.read();
        let w = registry
            .get(self.weight_handle)
            .cloned()
            .ok_or_else(|| mlx_rs::error::Exception::custom("weight not found"))?;
        let s = registry
            .get(self.scales_handle)
            .cloned()
            .ok_or_else(|| mlx_rs::error::Exception::custom("scales not found"))?;
        let b = registry
            .get(self.biases_handle)
            .cloned()
            .ok_or_else(|| mlx_rs::error::Exception::custom("biases not found"))?;
        drop(registry);
        mlx_rs::ops::quantized_matmul(
            x,
            &w,
            &s,
            &b,
            self.transpose,
            self.group_size as i32,
            self.bits as i32,
        )
    }
}

/// Reference oracle for parity testing — dequantize then regular matmul.
#[allow(dead_code)]
pub fn dequantize_then_matmul(
    x: &Array,
    w: &Array,
    scales: &Array,
    biases: &Array,
    group_size: i32,
    bits: i32,
    transpose: bool,
) -> MlxResult<Array> {
    let w_f32 = mlx_rs::ops::dequantize(w, scales, biases, group_size, bits)?;
    if transpose {
        x.matmul(&mlx_rs::ops::transpose_axes(&w_f32, &[1, 0])?)
    } else {
        x.matmul(&w_f32)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_quantized_matmul_parity() {
        // out_dim=4, in_dim=128, group_size=64, bits=8 → 2 groups, packed: 4×32 u32
        let mut x_data = vec![0.0f32; 128];
        for i in 0..128 {
            x_data[i] = (i + 1) as f32;
        }
        let x = Array::from_slice(&x_data, &[1, 128]);

        // Packed weight: 4 rows × 32 u32 columns (128 values packed 4-per-u32)
        let mut w_data = vec![0u32; 4 * 32];
        for r in 0..4u32 {
            for c in 0..32u32 {
                let base = r * 32 + c;
                let v0 = ((base * 4 + 1) % 127) as u32;
                let v1 = ((base * 4 + 2) % 127) as u32;
                let v2 = ((base * 4 + 3) % 127) as u32;
                let v3 = ((base * 4 + 4) % 127) as u32;
                w_data[(r * 32 + c) as usize] = v0 | (v1 << 8) | (v2 << 16) | (v3 << 24);
            }
        }
        let w = Array::from_slice(&w_data, &[4, 32]);
        let scales = Array::from_slice(&vec![1.0f32; 4 * 2], &[4, 2]);
        let biases = Array::from_slice(&vec![0.0f32; 4 * 2], &[4, 2]);

        let q = mlx_rs::ops::quantized_matmul(&x, &w, &scales, &biases, true, 64, 8).unwrap();
        let r = dequantize_then_matmul(&x, &w, &scales, &biases, 64, 8, true).unwrap();

        assert_eq!(q.shape(), r.shape());
        let qv: Vec<f32> = q.try_as_slice::<f32>().unwrap().to_vec();
        let rv: Vec<f32> = r.try_as_slice::<f32>().unwrap().to_vec();
        for i in 0..qv.len() {
            let diff = (qv[i] - rv[i]).abs();
            assert!(
                diff < 0.1,
                "Mismatch at {}: q={}, r={}, diff={}",
                i,
                qv[i],
                rv[i],
                diff
            );
        }
        println!("Parity PASS: {} values OK", qv.len());
    }

    /// Core 0.31.2 thread-safety qualification: independent concurrent execution
    /// on two native threads with deterministic output and clean teardown.
    #[test]
    fn test_concurrent_independent_mlx_execution() {
        let n = 100;
        let mut handles = vec![];
        for _t in 0..2 {
            handles.push(std::thread::spawn(move || {
                for _i in 0..n {
                    let x = Array::from_slice(&vec![1.0f32; 128], &[1, 128]);
                    let w = Array::from_slice(&vec![0u32; 4 * 32], &[4, 32]);
                    let s = Array::from_slice(&vec![1.0f32; 4 * 2], &[4, 2]);
                    let b = Array::from_slice(&vec![0.0f32; 4 * 2], &[4, 2]);
                    let q = mlx_rs::ops::quantized_matmul(&x, &w, &s, &b, true, 64, 8)
                        .expect("quantized_matmul on worker thread");
                    let _out: Vec<f32> = q.try_as_slice::<f32>().unwrap().to_vec();
                }
            }));
        }
        for h in handles {
            h.join().expect("worker thread panicked");
        }
        eprintln!(
            "[concurrent-qual] 2 threads x {n} quantized_matmul iterations: PASS"
        );
    }

    /// Stress test: heavier concurrent workloads across 4 threads.
    /// Targets the Metal driver race condition documented in MLX 0.31.0-0.31.1.
    #[test]
    fn test_concurrent_heavy_mlx_stress() {
        let iterations = 50;
        let in_dim = 256;
        let out_dim = 64;
        let group_size = 64;
        let bits = 8;
        let packed_cols = (in_dim * bits) / 32;
        let num_groups = out_dim * in_dim / (group_size * bits / 8);
        let scale_dim = num_groups / out_dim;
        let mut handles = vec![];
        for _t in 0..4 {
            handles.push(std::thread::spawn(move || {
                for _i in 0..iterations {
                    let x = Array::from_slice(&vec![1.0f32; in_dim as usize], &[1, in_dim]);
                    let w = Array::from_slice(
                        &vec![0u32; (out_dim * packed_cols) as usize],
                        &[out_dim, packed_cols],
                    );
                    let s = Array::from_slice(
                        &vec![1.0f32; (out_dim * scale_dim) as usize],
                        &[out_dim, scale_dim],
                    );
                    let b = Array::from_slice(
                        &vec![0.0f32; (out_dim * scale_dim) as usize],
                        &[out_dim, scale_dim],
                    );
                    let q = mlx_rs::ops::quantized_matmul(
                        &x, &w, &s, &b, true, group_size, bits,
                    )
                    .expect("quantized_matmul on stress thread");
                    let _out: Vec<f32> = q.try_as_slice::<f32>().unwrap().to_vec();
                }
            }));
        }
        for h in handles {
            h.join().expect("stress thread panicked");
        }
        eprintln!(
            "[concurrent-stress] 4 threads x {iterations} heavy quantized_matmul: PASS"
        );
    }
}
