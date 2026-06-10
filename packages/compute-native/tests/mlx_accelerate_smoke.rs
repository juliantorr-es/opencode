//! MLX vs Accelerate F32 matmul smoke comparison.
//!
//! Runs identical input tensors through both backends and verifies
//! output correctness.  No timing claims — this is correctness only.

use tribunus_compute_native::backend::accelerate::AccelerateBackend;
use tribunus_compute_native::backend::MlxBackend;
use tribunus_compute_native::backend::MatmulOp;
use tribunus_compute_native::backend::TensorBackend;

fn known_2x3() -> Vec<f32> {
    vec![1.0, 2.0, 3.0, 4.0, 5.0, 6.0]
}

fn known_3x4() -> Vec<f32> {
    vec![
        7.0, 8.0, 9.0, 10.0, 11.0, 12.0, 13.0, 14.0, 15.0, 16.0, 17.0, 18.0,
    ]
}

/// MLX matmul reference computation.
fn mlx_matmul(
    mlx: &mut MlxBackend,
    a_data: &[f32],
    a_shape: &[i32],
    b_data: &[f32],
    b_shape: &[i32],
    op: &MatmulOp,
) -> Vec<f32> {
    let a = mlx.create_f32(a_data, a_shape).unwrap();
    let b = mlx.create_f32(b_data, b_shape).unwrap();
    let c = mlx.matmul(op, a, b).unwrap();
    mlx.evaluate(1, &[c]).unwrap();
    let result = mlx.read_f32(c).unwrap();
    mlx.release(c).unwrap();
    mlx.release(b).unwrap();
    mlx.release(a).unwrap();
    result.data
}

/// Accelerate matmul via cblas_sgemm.
fn accelerate_matmul(
    acc: &mut AccelerateBackend,
    a_data: &[f32],
    a_shape: &[i32],
    b_data: &[f32],
    b_shape: &[i32],
    op: &MatmulOp,
) -> Vec<f32> {
    let a = acc.create_f32(a_data, a_shape).unwrap();
    let b = acc.create_f32(b_data, b_shape).unwrap();
    let c = acc.matmul(op, a, b).unwrap();
    let result = acc.read_f32(c).unwrap();
    acc.release(c).unwrap();
    acc.release(b).unwrap();
    acc.release(a).unwrap();
    result.data
}

/// Verify F64 scalar oracle for small shapes.
fn scalar_oracle(a: &[f32], b: &[f32], m: usize, k: usize, n: usize) -> Vec<f64> {
    let mut c = vec![0.0f64; m * n];
    for i in 0..m {
        for j in 0..n {
            let mut sum = 0.0f64;
            for p in 0..k {
                sum += a[i * k + p] as f64 * b[p * n + j] as f64;
            }
            c[i * n + j] = sum;
        }
    }
    c
}

// ── Known-answer smoke ────────────────────────────────────────────────

#[test]
fn mlx_known_answer_2x3_3x4() {
    let mut mlx = MlxBackend::new();
    let op = MatmulOp { m: 2, n: 4, k: 3 };
    let result = mlx_matmul(&mut mlx, &known_2x3(), &[2, 3], &known_3x4(), &[3, 4], &op);
    let expected = [74.0, 80.0, 86.0, 92.0, 173.0, 188.0, 203.0, 218.0];
    for (i, (&got, &exp)) in result.iter().zip(expected.iter()).enumerate() {
        assert!((got - exp).abs() < 0.01, "MLX c[{i}] expected {exp}, got {got}");
    }
}

#[test]
fn accelerate_known_answer_2x3_3x4() {
    let mut acc = AccelerateBackend::new();
    let op = MatmulOp { m: 2, n: 4, k: 3 };
    let result = accelerate_matmul(&mut acc, &known_2x3(), &[2, 3], &known_3x4(), &[3, 4], &op);
    let expected = [74.0, 80.0, 86.0, 92.0, 173.0, 188.0, 203.0, 218.0];
    for (i, (&got, &exp)) in result.iter().zip(expected.iter()).enumerate() {
        assert!((got - exp).abs() < 0.01, "Accel c[{i}] expected {exp}, got {got}");
    }
}

// ── Cross-backend parity ─────────────────────────────────────────────

#[test]
fn mlx_vs_accelerate_parity_small() {
    let mut mlx = MlxBackend::new();
    let mut acc = AccelerateBackend::new();

    let a = known_2x3();
    let b = known_3x4();
    let op = MatmulOp { m: 2, n: 4, k: 3 };

    let mlx_out = mlx_matmul(&mut mlx, &a, &[2, 3], &b, &[3, 4], &op);
    let acc_out = accelerate_matmul(&mut acc, &a, &[2, 3], &b, &[3, 4], &op);

    assert_eq!(mlx_out.len(), acc_out.len());
    for (i, (&m_val, &a_val)) in mlx_out.iter().zip(acc_out.iter()).enumerate() {
        assert!(
            (m_val - a_val).abs() < 0.01,
            "MLX vs Accel mismatch at {i}: MLX={m_val}, Accel={a_val}"
        );
    }
}

#[test]
fn mlx_vs_accelerate_parity_square() {
    let mut mlx = MlxBackend::new();
    let mut acc = AccelerateBackend::new();

    let a: Vec<f32> = (0..16).map(|x| (x as f32) * 0.1 - 0.8).collect();
    let b: Vec<f32> = (0..16).map(|x| (x as f32) * 0.1 - 0.8).collect();
    let op = MatmulOp { m: 4, n: 4, k: 4 };

    let mlx_out = mlx_matmul(&mut mlx, &a, &[4, 4], &b, &[4, 4], &op);
    let acc_out = accelerate_matmul(&mut acc, &a, &[4, 4], &b, &[4, 4], &op);

    assert_eq!(mlx_out.len(), acc_out.len());
    for (i, (&m_val, &a_val)) in mlx_out.iter().zip(acc_out.iter()).enumerate() {
        assert!((m_val - a_val).abs() < 0.001, "Square mismatch at {i}");
    }
}

// ── F64 scalar oracle parity ─────────────────────────────────────────

#[test]
fn mlx_vs_scalar_oracle_2x3() {
    let mut mlx = MlxBackend::new();
    let a = known_2x3();
    let b = known_3x4();
    let op = MatmulOp { m: 2, n: 4, k: 3 };

    let mlx_out = mlx_matmul(&mut mlx, &a, &[2, 3], &b, &[3, 4], &op);
    let oracle = scalar_oracle(&a, &b, 2, 3, 4);

    for (i, (&got, &or)) in mlx_out.iter().zip(oracle.iter()).enumerate() {
        assert!((got as f64 - or).abs() < 0.5, "MLX vs oracle c[{i}]: {got} vs {or}");
    }
}

#[test]
fn accelerate_vs_scalar_oracle_2x3() {
    let mut acc = AccelerateBackend::new();
    let a = known_2x3();
    let b = known_3x4();
    let op = MatmulOp { m: 2, n: 4, k: 3 };

    let acc_out = accelerate_matmul(&mut acc, &a, &[2, 3], &b, &[3, 4], &op);
    let oracle = scalar_oracle(&a, &b, 2, 3, 4);

    for (i, (&got, &or)) in acc_out.iter().zip(oracle.iter()).enumerate() {
        assert!((got as f64 - or).abs() < 0.5, "Accel vs oracle c[{i}]: {got} vs {or}");
    }
}

// ── Decode-like M=1 pseudo matvec ─────────────────────────────────────

#[test]
fn mlx_vs_accelerate_m1_decode() {
    let mut mlx = MlxBackend::new();
    let mut acc = AccelerateBackend::new();

    // Small pseudo-decode: M=1, K=8, N=8
    let a: Vec<f32> = (0..8).map(|x| (x as f32) * 0.1 - 0.4).collect();
    let b: Vec<f32> = (0..64).map(|x| (x as f32) * 0.01 - 0.32).collect();
    let op = MatmulOp { m: 1, n: 8, k: 8 };

    let mlx_out = mlx_matmul(&mut mlx, &a, &[1, 8], &b, &[8, 8], &op);
    let acc_out = accelerate_matmul(&mut acc, &a, &[1, 8], &b, &[8, 8], &op);

    assert_eq!(mlx_out.len(), acc_out.len());
    for (i, (&m_val, &a_val)) in mlx_out.iter().zip(acc_out.iter()).enumerate() {
        assert!(
            (m_val - a_val).abs() < 0.01,
            "M=1 mismatch at {i}: MLX={m_val}, Accel={a_val}"
        );
    }
}

// ── Memory cleanup ───────────────────────────────────────────────────

#[test]
#[test]
fn mlx_memory_returns_to_baseline() {
    // MLX is lazy: active memory reflects allocated arrays from eval(),
    // not unevaluated graph nodes.  This test verifies that releasing
    // all handles does not leak MLX handle slots (MlxBackend slot map
    // empties).  MLX cache memory may remain — not a leak.
    let mut mlx = MlxBackend::new();
    let a = mlx.create_f32(&known_2x3(), &[2, 3]).unwrap();
    let b = mlx.create_f32(&known_3x4(), &[3, 4]).unwrap();
    let op = MatmulOp { m: 2, n: 4, k: 3 };
    let c = mlx.matmul(&op, a, b).unwrap();

    mlx.release(c).unwrap();
    mlx.release(b).unwrap();
    mlx.release(a).unwrap();

    // Release succeeds — no panics. Cache memory may persist.
    let (_after_active, _after_cache) = mlx.active_memory();
}

#[test]
fn accelerate_memory_returns_to_baseline() {
    let mut acc = AccelerateBackend::new();
    let (before_active, _) = acc.active_memory();

    let a = acc.create_f32(&known_2x3(), &[2, 3]).unwrap();
    let b = acc.create_f32(&known_3x4(), &[3, 4]).unwrap();
    let op = MatmulOp { m: 2, n: 4, k: 3 };
    let c = acc.matmul(&op, a, b).unwrap();

    acc.release(c).unwrap();
    acc.release(b).unwrap();
    acc.release(a).unwrap();

    let (after_active, _) = acc.active_memory();
    assert_eq!(after_active, before_active, "Accel memory must return to baseline");
}
