//! Accelerate native qualification tests.
//!
//! Proves cblas_sgemm correctness, shape validation, handle lifecycle,
//! and memory accounting.  Must run under inference-research profile
//! for native FFI behavior.

use tribunus_compute_native::backend::MatmulOp;
use tribunus_compute_native::backend::accelerate::AccelerateBackend;
use tribunus_compute_native::backend::{TensorBackend, TensorHandle};

fn accel() -> AccelerateBackend {
    AccelerateBackend::new()
}

// ── Known-answer 2×3 @ 3×4 ────────────────────────────────────────────

#[test]
fn known_answer_2x3_times_3x4() {
    let mut be = accel();
    let a = be.create_f32(&[1.0, 2.0, 3.0, 4.0, 5.0, 6.0], &[2, 3]).unwrap();
    let b = be.create_f32(&[7.0, 8.0, 9.0, 10.0, 11.0, 12.0, 13.0, 14.0, 15.0, 16.0, 17.0, 18.0], &[3, 4]).unwrap();

    let op = MatmulOp { m: 2, n: 4, k: 3 };
    let c = be.matmul(&op, a, b).unwrap();
    let shape = be.shape(c).unwrap();
    assert_eq!(shape, vec![2, 4]);

    let result = be.read_f32(c).unwrap();
    // [1 2 3; 4 5 6] @ [7 8 9 10; 11 12 13 14; 15 16 17 18]
    // row0: [1*7+2*11+3*15, 1*8+2*12+3*16, 1*9+2*13+3*17, 1*10+2*14+3*18]
    //     = [74, 80, 86, 92]
    // row1: [4*7+5*11+6*15, 4*8+5*12+6*16, 4*9+5*13+6*17, 4*10+5*14+6*18]
    //     = [173, 188, 203, 218]
    let expected = [74.0, 80.0, 86.0, 92.0, 173.0, 188.0, 203.0, 218.0];
    for (i, (&got, &exp)) in result.data.iter().zip(expected.iter()).enumerate() {
        assert!((got - exp).abs() < 0.001, "c[{i}] expected {exp}, got {got}");
    }

    be.release(c).unwrap();
    be.release(b).unwrap();
    be.release(a).unwrap();
}

// ── Shape validation ──────────────────────────────────────────────────

#[test]
fn matmul_rejects_3d_tensor() {
    let mut be = accel();
    let a = be.create_f32(&[1.0; 24], &[2, 3, 4]).unwrap();
    let b = be.create_f32(&[1.0; 24], &[2, 3, 4]).unwrap();
    let op = MatmulOp { m: 2, n: 4, k: 3 };
    let err = be.matmul(&op, a, b);
    assert!(err.is_err());
    assert!(err.unwrap_err().contains("exactly 2D"));
    be.release(b).unwrap();
    be.release(a).unwrap();
}

#[test]
fn create_f32_rejects_negative_dim() {
    let mut be = accel();
    assert!(be.create_f32(&[1.0; 6], &[-2, 3]).is_err());
}

#[test]
fn create_f32_rejects_zero_dim() {
    let mut be = accel();
    assert!(be.create_f32(&[1.0; 0], &[0, 3]).is_err());
}

#[test]
fn create_f32_rejects_shape_product_mismatch() {
    let mut be = accel();
    assert!(be.create_f32(&[1.0; 5], &[2, 3]).is_err());
}

#[test]
fn matmul_rejects_dimension_mismatch() {
    let mut be = accel();
    let a = be.create_f32(&[1.0; 6], &[2, 3]).unwrap();
    let b = be.create_f32(&[1.0; 8], &[4, 2]).unwrap();
    let op = MatmulOp { m: 2, n: 2, k: 3 };
    assert!(be.matmul(&op, a, b).is_err());
    be.release(b).unwrap();
    be.release(a).unwrap();
}

// ── Stale handle rejection ────────────────────────────────────────────

#[test]
fn stale_handle_rejected_on_matmul() {
    let mut be = accel();
    let a = be.create_f32(&[1.0; 6], &[2, 3]).unwrap();
    let b = be.create_f32(&[1.0; 12], &[3, 4]).unwrap();
    be.release(a).unwrap(); // now stale
    let op = MatmulOp { m: 2, n: 4, k: 3 };
    assert!(be.matmul(&op, a, b).is_err());
    be.release(b).unwrap();
}

#[test]
fn double_release_rejected() {
    let mut be = accel();
    let a = be.create_f32(&[1.0; 6], &[2, 3]).unwrap();
    be.release(a).unwrap();
    assert!(be.release(a).is_err());
}

#[test]
fn stale_evaluate_output_rejected() {
    let mut be = accel();
    let a = be.create_f32(&[1.0; 6], &[2, 3]).unwrap();
    be.release(a).unwrap();
    let receipt = be.evaluate(0, &[a]);
    assert!(receipt.is_err());
}

// ── Memory accounting ─────────────────────────────────────────────────

#[test]
fn memory_returns_to_zero_after_release() {
    let mut be = accel();
    let a = be.create_f32(&[1.0; 600], &[20, 30]).unwrap();
    let b = be.create_f32(&[1.0; 1200], &[30, 40]).unwrap();
    let (active, _) = be.active_memory();
    assert!(active > 0);

    be.release(b).unwrap();
    be.release(a).unwrap();
    let (active, _) = be.active_memory();
    assert_eq!(active, 0, "memory must return to zero after all releases");
}

// ── Repeated execution ────────────────────────────────────────────────

#[test]
fn repeated_matmul_consistent_output() {
    let mut be = accel();
    let a = be.create_f32(&[1.0, 2.0, 3.0, 4.0, 5.0, 6.0], &[2, 3]).unwrap();
    let b = be.create_f32(&[7.0, 8.0, 9.0, 10.0, 11.0, 12.0, 13.0, 14.0, 15.0, 16.0, 17.0, 18.0], &[3, 4]).unwrap();
    let op = MatmulOp { m: 2, n: 4, k: 3 };

    let c1 = be.matmul(&op, a, b).unwrap();
    let r1 = be.read_f32(c1).unwrap();
    let c2 = be.matmul(&op, a, b).unwrap();
    let r2 = be.read_f32(c2).unwrap();

    assert_eq!(r1.data.len(), r2.data.len());
    for (i, (&x, &y)) in r1.data.iter().zip(r2.data.iter()).enumerate() {
        assert!((x - y).abs() < 0.001, "mismatch at {i}: {x} vs {y}");
    }
}

// ── Generation reuse ──────────────────────────────────────────────────

#[test]
fn generation_increment_on_reuse() {
    let mut be = accel();
    let a = be.create_f32(&[1.0; 6], &[2, 3]).unwrap();
    let gen1 = a.generation;
    be.release(a).unwrap();

    let b = be.create_f32(&[1.0; 6], &[2, 3]).unwrap();
    // Slot may be reused; generation must differ
    if b.slot == a.slot {
        assert_ne!(b.generation, gen1, "reused slot must have new generation");
    }
    be.release(b).unwrap();
}
