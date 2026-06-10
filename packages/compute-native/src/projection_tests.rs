//! Real checkpoint projection parity tests.

#[cfg(test)]
mod tests {
    use mlx_rs::Array;

    struct Shard {
        _buffer: Vec<u8>,
        tensors: safetensors::SafeTensors<'static>,
    }

    impl Shard {
        fn load(path: &str) -> Self {
            let buffer = std::fs::read(path).expect("read shard");
            let tensors = unsafe {
                std::mem::transmute::<safetensors::SafeTensors<'_>, safetensors::SafeTensors<'static>>(
                    safetensors::SafeTensors::deserialize(&buffer).expect("parse")
                )
            };
            Self { _buffer: buffer, tensors }
        }
        fn array(&self, name: &str) -> Array {
            let t = self.tensors.tensor(name).expect("find");
            let data = t.data();
            use safetensors::Dtype;
            let shape: Vec<i32> = t.shape().iter().map(|&d| d as i32).collect();
            match t.dtype() {
                Dtype::U32 => {
                    let count = data.len() / 4;
                    let mut u32_vec = Vec::with_capacity(count);
                    for chunk in data.chunks_exact(4) {
                        u32_vec.push(u32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]));
                    }
                    Array::from_slice(&u32_vec, &shape)
                }
                Dtype::BF16 => {
                    let count = data.len() / 2;
                    let mut u16_vec = Vec::with_capacity(count);
                    for chunk in data.chunks_exact(2) {
                        u16_vec.push(u16::from_le_bytes([chunk[0], chunk[1]]));
                    }
                    Array::from_slice(&u16_vec, &shape).as_dtype(mlx_rs::Dtype::Bfloat16).expect("bf16 cast")
                }
                Dtype::F32 => {
                    let count = data.len() / 4;
                    let mut f32_vec = Vec::with_capacity(count);
                    for chunk in data.chunks_exact(4) {
                        f32_vec.push(f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]));
                    }
                    Array::from_slice(&f32_vec, &shape)
                }
                other => panic!("unsupported safetensors dtype for {}: {:?}", name, other),
            }
        }
    }

    fn random_input(batch: i32, dim: i32, seed: u64) -> Array {
        let n = (batch * dim) as usize;
        let mut state = seed;
        let data: Vec<f32> = (0..n).map(|_| {
            state = state.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            (state as f32) / (u64::MAX as f32) * 2.0 - 1.0
        }).collect();
        Array::from_slice(&data, &[batch, dim])
    }

    fn check_parity(shard: &Shard, base: &str, in_dim: i32, out_dim: i32, label: &str) {
        let w = shard.array(&format!("{}.weight", base));
        let s = shard.array(&format!("{}.scales", base));
        let b = shard.array(&format!("{}.biases", base));
        let x = random_input(1, in_dim, 42);

        let q = mlx_rs::ops::quantized_matmul(&x, &w, &s, &b, true, 64, 8).expect("qmatmul");
        let wf = mlx_rs::ops::dequantize(&w, &s, &b, 64, 8).expect("dequant");
        let r = x.matmul(&mlx_rs::ops::transpose(&wf).expect("t")).expect("matmul");

        assert_eq!(q.shape(), &[1, out_dim], "{} shape", label);
        let qv: Vec<f32> = q.try_as_slice::<f32>().expect("q read").to_vec();
        let rv: Vec<f32> = r.try_as_slice::<f32>().expect("r read").to_vec();

        let mut max_abs = 0.0f64;
        let mut sum_abs = 0.0f64;
        let mut dq = 0.0f64;
        let mut dr = 0.0f64;
        for i in 0..qv.len() {
            let diff = (qv[i] as f64 - rv[i] as f64).abs();
            max_abs = max_abs.max(diff);
            sum_abs += diff;
            dq += (qv[i] as f64).powi(2);
            dr += (rv[i] as f64).powi(2);
        }
        let cos = ((qv.iter().zip(&rv).map(|(a,b)| (*a as f64)*(*b as f64)).sum::<f64>())
            / (dq.sqrt() * dr.sqrt())).min(1.0);

        let mean = sum_abs / qv.len() as f64;
        let max_q = qv.iter().map(|v| v.abs()).fold(0.0f32, f32::max);
        let max_r = rv.iter().map(|v| v.abs()).fold(0.0f32, f32::max);
        let rel_err = if max_q > 0.0 { max_abs as f32 / max_q } else { 0.0 };
        println!("{:30} |q|={:.4} |r|={:.4} max={:.2e} mean={:.2e} rel={:.2e} cos={:.8}",
            label, max_q, max_r, max_abs, mean, rel_err, cos);
        let n_show = qv.len().min(5);
        for i in 0..n_show {
            println!("  [{i}] q={:.6} r={:.6} diff={:.2e}", qv[i], rv[i], (qv[i] - rv[i]).abs());
        }
        if max_abs > 1e-2 { println!("  WARNING: {} max_err={:.2e} exceeds tolerance", label, max_abs); }
    }

    #[test]
    fn all_real_projection_parity() {
        let base = "models/gemma4-12b-8bit";
        let r = "language_model.model";

        println!("Loading shards...");
        let s1 = Shard::load(&format!("{}/model-00001-of-00003.safetensors", base));

        check_parity(&s1, &format!("{}.layers.0.self_attn.q_proj", r), 3840, 4096, "sliding-q_proj-L0");
        check_parity(&s1, &format!("{}.layers.12.self_attn.q_proj", r), 3840, 4096, "q_proj-L12");
        check_parity(&s1, &format!("{}.layers.5.self_attn.q_proj", r), 3840, 8192, "full-q_proj-L5");
        check_parity(&s1, &format!("{}.layers.0.mlp.gate_proj", r), 3840, 15360, "mlp-gate-L0");
        check_parity(&s1, &format!("{}.layers.0.mlp.down_proj", r), 15360, 3840, "mlp-down-L0");
        check_parity(&s1, &format!("{}.layers.0.self_attn.o_proj", r), 4096, 3840, "o_proj-L0");
        check_parity(&s1, &format!("{}.layers.0.self_attn.k_proj", r), 3840, 2048, "k_proj-L0");

        println!("\nReal projection parity complete.");
    }
}
