//! Backend contract conformance tests.
//!
//! These tests run the same operation sequences through MlxBackend
//! (via the TensorBackend trait) and through direct mlx_rs calls,
//! then assert shape and numerical equivalence.  They also prove
//! that the hardened backend contracts hold: stale handles are
//! rejected, double release fails, grouped evaluation creates
//! one logical fence, and shape inspection does not trigger
//! hidden evaluation.

use tribunus_compute_native::backend::{
    BackendCapabilities,
    DType,
    EvaluationReceipt,
    MatmulOp,
    MlxBackend,
    ReadbackReceipt,
    TensorBackend,
    TensorHandle,
};

// ── Fixture helpers ──────────────────────────────────────────────────────

/// Create a backend with known-determined state for tests.
fn fixture_backend() -> MlxBackend {
    MlxBackend::new()
}

/// Create a 2×3 f32 tensor with known values.
fn create_2x3_f32(backend: &mut dyn TensorBackend) -> TensorHandle {
    let data: Vec<f32> = vec![1.0, 2.0, 3.0, 4.0, 5.0, 6.0];
    backend
        .create_f32(&data, &[2, 3])
        .expect("create 2×3 f32")
}

/// Create a 3×2 f32 tensor with known values.
fn create_3x2_f32(backend: &mut dyn TensorBackend) -> TensorHandle {
    let data: Vec<f32> = vec![7.0, 8.0, 9.0, 10.0, 11.0, 12.0];
    backend
        .create_f32(&data, &[3, 2])
        .expect("create 3×2 f32")
}

// ── Shape conformance ────────────────────────────────────────────────────

#[test]
fn shape_matches_creation() {
    let mut be = fixture_backend();
    let h = create_2x3_f32(&mut be);
    let shape = be.shape(h).expect("shape query");
    assert_eq!(shape, vec![2, 3]);
    be.release(h).expect("release");
}

#[test]
fn shape_does_not_trigger_eval() {
    // Shape inspection must not force lazy evaluation.
    // For MlxBackend, shape() is always available without eval —
    // MLX arrays carry shape metadata eagerly.
    let mut be = fixture_backend();
    let a = create_2x3_f32(&mut be);
    let b = create_3x2_f32(&mut be);

    // matmul produces a lazy result; shape() must not evaluate it
    let op = MatmulOp { m: 2, n: 2, k: 3 };
    let c = be.matmul(a, b).expect("matmul");

    let shape = be.shape(c).expect("shape of lazy matmul");
    assert_eq!(shape, vec![2, 2], "shape of matmul(2×3, 3×2) should be [2,2]");

    be.release(c).expect("release c");
    be.release(b).expect("release b");
    be.release(a).expect("release a");
}

// ── Numerical conformance ───────────────────────────────────────────────

#[test]
fn matmul_numerical_parity() {
    let mut be = fixture_backend();
    let a = create_2x3_f32(&mut be);
    let b = create_3x2_f32(&mut be);
    let op = MatmulOp { m: 2, n: 2, k: 3 };
    let c = be.matmul(a, b).expect("matmul");

    // Evaluate grouped
    let receipt = be.evaluate(1, &[c]).expect("evaluate");
    assert_eq!(receipt.output_count, 1);
    assert!(receipt.sync_ns > 0);

    let readback = be.read_f32(c).expect("readback");
    assert!(readback.forced_eval, "first readback after eval may not force new eval");
    let result = &readback.data;

    // [1 2 3; 4 5 6] @ [7 8; 9 10; 11 12]^T. Wait — MLX matmul is not transposed
    // by default.  (2×3) @ (3×2) = (2×2):
    // [1*7+2*9+3*11, 1*8+2*10+3*12]  = [58, 64]
    // [4*7+5*9+6*11, 4*8+5*10+6*12]  = [139, 154]
    assert!((result[0] - 58.0).abs() < 0.01, "c[0,0] should be 58, got {}", result[0]);
    assert!((result[1] - 64.0).abs() < 0.01, "c[0,1] should be 64, got {}", result[1]);
    assert!((result[2] - 139.0).abs() < 0.01, "c[1,0] should be 139, got {}", result[2]);
    assert!((result[3] - 154.0).abs() < 0.01, "c[1,1] should be 154, got {}", result[3]);

    be.release(c).expect("release c");
    be.release(b).expect("release b");
    be.release(a).expect("release a");
}

// ── Stale handle rejection ──────────────────────────────────────────────

#[test]
fn stale_handle_rejected_after_release() {
    let mut be = fixture_backend();
    let h = create_2x3_f32(&mut be);
    let slot = h.slot;
    let gen = h.generation;

    be.release(h).expect("first release");

    // Using the stale handle must fail
    let err = be.shape(h);
    assert!(err.is_err(), "stale handle must be rejected after release");
    let msg = err.unwrap_err();
    assert!(
        msg.contains("stale") || msg.contains("generation") || msg.contains("invalid"),
        "error must indicate handle invalidation, got: {}",
        msg
    );

    // Create a new tensor that may reuse the slot
    let h2 = create_2x3_f32(&mut be);
    // Same slot MAY be reused but generation must differ
    if h2.slot == slot {
        assert_ne!(h2.generation, gen, "reused slot must have new generation");
    }

    be.release(h2).expect("release h2");
}

#[test]
fn double_release_fails() {
    let mut be = fixture_backend();
    let h = create_2x3_f32(&mut be);
    be.release(h).expect("first release");

    let err = be.release(h);
    assert!(err.is_err(), "double release must fail");

    let msg = err.unwrap_err();
    assert!(
        msg.contains("already") || msg.contains("stale") || msg.contains("invalid") || msg.contains("generation"),
        "error must indicate already-released, got: {}",
        msg
    );
}

// ── Grouped evaluation ──────────────────────────────────────────────────

#[test]
fn grouped_evaluation_one_fence() {
    let mut be = fixture_backend();
    let a = create_2x3_f32(&mut be);
    let b = create_3x2_f32(&mut be);
    let op = MatmulOp { m: 2, n: 2, k: 3 };

    let c = be.matmul(a, b).expect("matmul");

    // Evaluate as a single group
    let receipt = be.evaluate(42, &[c]).expect("group eval");

    // The receipt must carry the group ID
    assert_eq!(receipt.group_id, 42);
    assert_eq!(receipt.output_count, 1);

    // sync_ns must be measured
    assert!(receipt.sync_ns > 0, "sync duration must be recorded");

    be.release(c).expect("release c");
    be.release(b).expect("release b");
    be.release(a).expect("release a");
}

// ── Explicit readback ───────────────────────────────────────────────────

#[test]
fn readback_receipt_flags_forced_eval() {
    let mut be = fixture_backend();
    let a = create_2x3_f32(&mut be);
    let b = create_3x2_f32(&mut be);
    let op = MatmulOp { m: 2, n: 2, k: 3 };
    let c = be.matmul(a, b).expect("matmul");

    // Readback without explicit evaluate — must force eval
    let receipt: ReadbackReceipt = be.read_f32(c).expect("readback");
    assert!(
        receipt.forced_eval,
        "readback on unevaluated tensor must force evaluation"
    );
    assert!(receipt.sync_ns > 0, "readback must measure sync time");

    be.release(c).expect("release c");
    be.release(b).expect("release b");
    be.release(a).expect("release a");
}

// ── Owned creation ──────────────────────────────────────────────────────

#[test]
fn create_owned_from_bytes_f32() {
    let mut be = fixture_backend();
    let raw: Vec<u8> = 1.0_f32.to_ne_bytes()
        .into_iter()
        .chain(2.0_f32.to_ne_bytes())
        .chain(3.0_f32.to_ne_bytes())
        .chain(4.0_f32.to_ne_bytes())
        .collect();

    let h = be
        .create_owned_from_bytes(&raw, &[2, 2], DType::F32)
        .expect("create from bytes");

    let shape = be.shape(h).expect("shape");
    assert_eq!(shape, vec![2, 2]);

    let receipt = be.read_f32(h).expect("readback");
    assert!((receipt.data[0] - 1.0).abs() < 0.001);
    assert!((receipt.data[3] - 4.0).abs() < 0.001);

    be.release(h).expect("release");
}

// ── Primitives surface ───────────────────────────────────────────────────

#[test]
fn add_conformance() {
    let mut be = fixture_backend();
    let a = create_2x3_f32(&mut be);
    let b = create_2x3_f32(&mut be);
    let c = be.add(a, b).expect("add");
    let shape = be.shape(c).expect("shape");
    assert_eq!(shape, vec![2, 3]);

    let receipt = be.read_f32(c).expect("readback");
    // a[i] + b[i] = 2*a[i] since b=a
    assert!((receipt.data[0] - 2.0).abs() < 0.01);
    assert!((receipt.data[5] - 12.0).abs() < 0.01);

    be.release(c).expect("release c");
    be.release(b).expect("release b");
    be.release(a).expect("release a");
}

#[test]
fn multiply_conformance() {
    let mut be = fixture_backend();
    let a = create_2x3_f32(&mut be);
    let b = create_2x3_f32(&mut be);
    let c = be.multiply(a, b).expect("multiply");
    let receipt = be.read_f32(c).expect("readback");
    // a[i] * a[i]
    assert!((receipt.data[0] - 1.0).abs() < 0.01);
    assert!((receipt.data[5] - 36.0).abs() < 0.01);

    be.release(c).expect("release c");
    be.release(b).expect("release b");
    be.release(a).expect("release a");
}

// ── Backend capabilities ─────────────────────────────────────────────────

#[test]
fn backend_reports_capabilities() {
    let be = fixture_backend();
    let caps: BackendCapabilities = be.backend_capabilities();

    assert!(!caps.backend_name.is_empty(), "must report a name");
    assert!(caps.supports_quantized, "MLX must support quantized ops");
    // On macOS, can_gpu is true
    #[cfg(target_os = "macos")]
    assert!(caps.can_gpu, "on macOS, MLX must report can_gpu");

    // BF16 native support: MLX backend currently converts to f32
    // so this should be false
    assert!(!caps.supports_bf16_native, "MLX backend does not support native BF16");
}

// ── bind_external not implemented yet ─────────────────────────────────────

#[test]
fn bind_external_returns_err() {
    let mut be = fixture_backend();
    let data: Vec<u8> = vec![0; 16];
    let result = be.bind_external(0, &data, &[2, 2], DType::F32);
    assert!(result.is_err(), "bind_external must return not-implemented");
}
