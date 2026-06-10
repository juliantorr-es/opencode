use std::path::Path;

use crate::decode_attribution::receipt::DecodeAttributionReceipt;
use crate::decode_attribution::harness::run_one;
use crate::decode_attribution::harness::run_backend;
use crate::decode_attribution::graph_catalog::{NORMAL_FAMILIES, all_families};
use crate::decode_attribution::shape_profiles::{SMALL, MEDIUM, LARGE};
use crate::decode_attribution::negative_evidence::run_negative_evidence;

/// Configuration for a decode attribution run.
pub struct RunConfig {
    pub run_id: String,
    pub output_dir: String,
    pub warmup_iterations: u32,
    pub steady_iterations: u32,
    pub tolerance: f64,
}

/// Run Matrix 1: Compute Unit × Graph Family.
/// Fixed medium shape, 8 graphs × 2 compute units = 16 runs.
pub fn run_matrix1(config: &RunConfig) -> Vec<DecodeAttributionReceipt> {
    let mut receipts = Vec::with_capacity(16);
    let families = all_families();
    let units = ["cpuOnly", "cpuAndGPU"];
    let mut seq: u32 = 0;

    for family in &families {
        for &cu in &units {
            seq += 1;
            let run_id = format!("{}-M1-{:04}", config.run_id, seq);
            let r = run_one(
                &run_id,
                family,
                &MEDIUM,
                cu,
                "matrix1_compute_units",
                true,
                config.warmup_iterations,
                config.steady_iterations,
                config.tolerance,
                Path::new(&config.output_dir),
            );
            receipts.push(r);
        }
    }
    receipts
}

/// Run Matrix Lattice: Full catalog coverage across all backends.
///
/// Produces exactly 96 rows:
/// - Core ML: 8 families × 3 shapes × 2 policies = 48
/// - MLX: 8 families × 3 shapes = 24
/// - Accelerate: 8 families × 3 shapes = 24
///
/// Reference hashes are embedded per row via `run_backend` (Phase 5 wiring).
pub fn run_matrix_lattice(config: &RunConfig) -> Vec<DecodeAttributionReceipt> {
    let total = 48 + 24 + 24;
    let mut receipts = Vec::with_capacity(total);
    let families = all_families();
    let shapes = [&SMALL, &MEDIUM, &LARGE];

    // ── Core ML: 8 families × 3 shapes × 2 policies = 48 ──────────────
    let coreml_policies = ["cpuOnly", "cpuAndGPU"];
    for family in &families {
        for shape in &shapes {
            for policy in &coreml_policies {
                let r = run_backend(
                    &config.run_id,
                    "coreml",
                    family,
                    shape,
                    policy,
                    "matrix_lattice",
                    true,
                    config.warmup_iterations,
                    config.steady_iterations,
                    config.tolerance,
                    Path::new(&config.output_dir),
                );
                receipts.push(r);
            }
        }
    }

    // ── MLX: 8 families × 3 shapes = 24 ───────────────────────────────
    for family in &families {
        for shape in &shapes {
            let r = run_backend(
                &config.run_id,
                "mlx",
                family,
                shape,
                "mlx_default",
                "matrix_lattice",
                true,
                config.warmup_iterations,
                config.steady_iterations,
                config.tolerance,
                Path::new(&config.output_dir),
            );
            receipts.push(r);
        }
    }

    // ── Accelerate: 8 families × 3 shapes = 24 ────────────────────────
    for family in &families {
        for shape in &shapes {
            let r = run_backend(
                &config.run_id,
                "accelerate",
                family,
                shape,
                "accelerate_cpu",
                "matrix_lattice",
                true,
                config.warmup_iterations,
                config.steady_iterations,
                config.tolerance,
                Path::new(&config.output_dir),
            );
            receipts.push(r);
        }
    }

    receipts
}

/// Run Matrix 2: Shape × Graph Family (CPU-only).
/// Canonical shape-scaling baseline. 5 graphs × 3 shapes = 15 runs.
pub fn run_matrix2(config: &RunConfig) -> Vec<DecodeAttributionReceipt> {
    let mut receipts = Vec::with_capacity(15);
    // Use the 5 families that differ meaningfully by shape
    let families = [&NORMAL_FAMILIES[0], &NORMAL_FAMILIES[1], &NORMAL_FAMILIES[2], &NORMAL_FAMILIES[4], &NORMAL_FAMILIES[5]];
    let shapes = [&SMALL, &MEDIUM, &LARGE];
    let mut seq: u32 = 0;

    for family in &families {
        for shape in &shapes {
            seq += 1;
            let run_id = format!("{}-M2-{:04}", config.run_id, seq);
            let r = run_backend(
                &run_id,
                "coreml",
                family,
                shape,
                "cpuOnly",
                "matrix2_shape_scaling_cpu",
                true,
                config.warmup_iterations,
                config.steady_iterations,
                config.tolerance,
                Path::new(&config.output_dir),
            );
            receipts.push(r);
        }
    }
    receipts
}

/// Run Matrix 2b: Shape × Graph Family (GPU variant, optional).
/// Gated behind --include-gpu-shape-matrix flag.
pub fn run_matrix2b(config: &RunConfig) -> Vec<DecodeAttributionReceipt> {
    let mut receipts = Vec::with_capacity(15);
    let families = [&NORMAL_FAMILIES[0], &NORMAL_FAMILIES[1], &NORMAL_FAMILIES[2], &NORMAL_FAMILIES[4], &NORMAL_FAMILIES[5]];
    let shapes = [&SMALL, &MEDIUM, &LARGE];
    let mut seq: u32 = 0;

    for family in &families {
        for shape in &shapes {
            seq += 1;
            let run_id = format!("{}-M2b-{:04}", config.run_id, seq);
            let r = run_backend(
                &run_id,
                "coreml",
                family,
                shape,
                "cpuAndGPU",
                "matrix2b_shape_scaling_gpu",
                false,
                config.warmup_iterations,
                config.steady_iterations,
                config.tolerance,
                Path::new(&config.output_dir),
            );
            receipts.push(r);
        }
    }
    receipts
}

/// Run negative evidence fixture.
pub fn run_negative_evidence_fixture(config: &RunConfig) -> DecodeAttributionReceipt {
    run_negative_evidence(&format!("{}-NEG-0001", config.run_id), Path::new(&config.output_dir))
}

/// Run Matrix A: Cross-backend matmul baseline.
/// Matmul graph at small/medium/large shapes across 5 backend/policy combos.
/// Dimensions: 1 graph × 3 shapes × 5 backends = 15 rows.
pub fn run_matrix_a(config: &RunConfig) -> Vec<DecodeAttributionReceipt> {
    let mut receipts = Vec::with_capacity(15);
    let family = &NORMAL_FAMILIES[0]; // matmul
    let shapes = [&SMALL, &MEDIUM, &LARGE];
    let backends: &[(&str, &str)] = &[
        ("coreml", "cpuOnly"),
        ("coreml", "cpuAndGPU"),
        ("accelerate", "accelerate_cpu"),
        ("mlx", "mlx_default"),
        ("reference", ""),
    ];
    let mut seq: u32 = 0;

    for (backend, policy) in backends {
        for shape in &shapes {
            seq += 1;
            let run_id = format!("{}-MA-{:04}", config.run_id, seq);
            let r = run_backend(
                &run_id,
                backend,
                family,
                shape,
                policy,
                "matrix_a",
                true,
                config.warmup_iterations,
                config.steady_iterations,
                config.tolerance,
                Path::new(&config.output_dir),
            );
            receipts.push(r);
        }
    }
    receipts
}
