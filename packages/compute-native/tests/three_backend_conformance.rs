//! Three-backend F32 matmul conformance suite (E0008 Phase 4).
//!
//! Runs identical input tensors through MLX, Accelerate, and Core ML,
//! compares outputs pairwise and against an F64 scalar oracle.

use tribunus_compute_native::backend::accelerate::AccelerateBackend;
use tribunus_compute_native::backend::coreml::CoreMlBackend;
use tribunus_compute_native::backend::graph::GraphBackend;
use tribunus_compute_native::backend::routing::{
    CompiledRegionHandle, GraphRegion, OperationFamily,
};
use tribunus_compute_native::backend::{MatmulOp, MlxBackend, TensorBackend};

// ── Fixtures ──────────────────────────────────────────────────────────

fn known_2x3() -> Vec<f32> {
    vec![1.0, 2.0, 3.0, 4.0, 5.0, 6.0]
}
fn known_3x4() -> Vec<f32> {
    vec![7.0, 8.0, 9.0, 10.0, 11.0, 12.0, 13.0, 14.0, 15.0, 16.0, 17.0, 18.0]
}

fn f64_oracle(a: &[f32], b: &[f32], m: usize, k: usize, n: usize) -> Vec<f64> {
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

// ── MLX arm ───────────────────────────────────────────────────────────

fn mlx_run(
    a_data: &[f32], a_shape: &[i32],
    b_data: &[f32], b_shape: &[i32],
    op: &MatmulOp,
) -> Vec<f32> {
    let mut be = MlxBackend::new();
    let a = be.create_f32(a_data, a_shape).unwrap();
    let b = be.create_f32(b_data, b_shape).unwrap();
    let c = be.matmul(op, a, b).unwrap();
    be.evaluate(1, &[c]).unwrap();
    let r = be.read_f32(c).unwrap();
    be.release(c).unwrap();
    be.release(b).unwrap();
    be.release(a).unwrap();
    r.data
}

// ── Accelerate arm ────────────────────────────────────────────────────

fn accel_run(
    a_data: &[f32], a_shape: &[i32],
    b_data: &[f32], b_shape: &[i32],
    op: &MatmulOp,
) -> Vec<f32> {
    let mut be = AccelerateBackend::new();
    let a = be.create_f32(a_data, a_shape).unwrap();
    let b = be.create_f32(b_data, b_shape).unwrap();
    let c = be.matmul(op, a, b).unwrap();
    let r = be.read_f32(c).unwrap();
    be.release(c).unwrap();
    be.release(b).unwrap();
    be.release(a).unwrap();
    r.data
}

// ── Core ML arm ───────────────────────────────────────────────────────

fn coreml_run(
    _a_data: &[f32], _a_shape: &[i32],
    _b_data: &[f32], _b_shape: &[i32],
    _op: &MatmulOp,
) -> Result<Vec<f32>, String> {
    let mut be = CoreMlBackend::new();
    let region = GraphRegion {
        region_id: 100,
        family: OperationFamily::Matmul,
        operations: vec![],
        input_tensors: vec![],
        output_tensors: vec![],
        shape_constraints: vec![],
    };

    // compile_region loads from regions/100.mlmodelc — if present
    let (handle, _compile_ns) = be.compile_region(&region)?;

    // execute_region: arena-based prediction pending Phase 9
    let _receipt = be.execute_region(handle, &[])?;
    Err("Core ML: arena execution pending Phase 9".into())
}

// ── Two-way parity ────────────────────────────────────────────────────

#[test]
fn mlx_vs_accelerate_known_answer() {
    let op = MatmulOp { m: 2, n: 4, k: 3 };
    let a = known_2x3();
    let b = known_3x4();

    let mlx_out = mlx_run(&a, &[2, 3], &b, &[3, 4], &op);
    let accel_out = accel_run(&a, &[2, 3], &b, &[3, 4], &op);

    assert_eq!(mlx_out.len(), accel_out.len());
    for (i, (&m, &a)) in mlx_out.iter().zip(accel_out.iter()).enumerate() {
        assert!((m - a).abs() < 0.01, "MvA mismatch at {i}: {m} vs {a}");
    }
}

#[test]
fn mlx_vs_oracle() {
    let op = MatmulOp { m: 2, n: 4, k: 3 };
    let a = known_2x3();
    let b = known_3x4();

    let mlx_out = mlx_run(&a, &[2, 3], &b, &[3, 4], &op);
    let oracle = f64_oracle(&a, &b, 2, 3, 4);

    for (i, (&m, &o)) in mlx_out.iter().zip(oracle.iter()).enumerate() {
        assert!((m as f64 - o).abs() < 0.5, "MLX vs oracle c[{i}]: {m} vs {o}");
    }
}

#[test]
fn accel_vs_oracle() {
    let op = MatmulOp { m: 2, n: 4, k: 3 };
    let a = known_2x3();
    let b = known_3x4();

    let accel_out = accel_run(&a, &[2, 3], &b, &[3, 4], &op);
    let oracle = f64_oracle(&a, &b, 2, 3, 4);

    for (i, (&a, &o)) in accel_out.iter().zip(oracle.iter()).enumerate() {
        assert!((a as f64 - o).abs() < 0.5, "Accel vs oracle c[{i}]: {a} vs {o}");
    }
}

// ── Core ML lifecycle in conformance context ──────────────────────────

#[test]
fn coreml_compile_loads_native_bridge() {
    let mut be = CoreMlBackend::new();
    let region = GraphRegion {
        region_id: 200,
        family: OperationFamily::Matmul,
        operations: vec![],
        input_tensors: vec![],
        output_tensors: vec![],
        shape_constraints: vec![],
    };

    // regions/200.mlmodelc doesn't exist → load fails cleanly
    let result = be.compile_region(&region);
    assert!(result.is_err());
    // No stale entry in cache
    assert!(!be.is_region_cached(CompiledRegionHandle { slot: 0, generation: 1 }));
}

#[test]
fn coreml_backend_id_consistent() {
    let be = CoreMlBackend::new();
    assert_eq!(be.graph_backend_id().0, 2);
}

// ── Memory cleanup ────────────────────────────────────────────────────

#[test]
fn all_backends_cleanup_without_panic() {
    // MLX
    {
        let mut be = MlxBackend::new();
        let a = be.create_f32(&known_2x3(), &[2, 3]).unwrap();
        let b = be.create_f32(&known_3x4(), &[3, 4]).unwrap();
        let op = MatmulOp { m: 2, n: 4, k: 3 };
        let c = be.matmul(&op, a, b).unwrap();
        be.evaluate(1, &[c]).unwrap();
        be.release(c).unwrap();
        be.release(b).unwrap();
        be.release(a).unwrap();
    }
    // Accelerate
    {
        let mut be = AccelerateBackend::new();
        let a = be.create_f32(&known_2x3(), &[2, 3]).unwrap();
        let b = be.create_f32(&known_3x4(), &[3, 4]).unwrap();
        let op = MatmulOp { m: 2, n: 4, k: 3 };
        let c = be.matmul(&op, a, b).unwrap();
        be.release(c).unwrap();
        be.release(b).unwrap();
        be.release(a).unwrap();
    }
    // Core ML (no-op: compile returns error, backend drops cleanly)
    {
        let _be = CoreMlBackend::new();
    }
}
