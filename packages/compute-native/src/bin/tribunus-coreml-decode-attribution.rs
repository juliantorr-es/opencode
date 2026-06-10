//! Tribunus Core ML Decode Attribution Harness.
//!
//! Measures materialization, compilation, load, warmup, and prediction
//! timing across two primary matrices and one optional matrix.
//!
//! Usage:
//!   cargo run --bin tribunus-coreml-decode-attribution --profile inference-evidence
//!   cargo run --bin tribunus-coreml-decode-attribution --profile inference-evidence -- --include-gpu-shape-matrix
//!   cargo run --bin tribunus-coreml-decode-attribution --profile inference-evidence -- --full-catalog --run-id LATTICE-0001
//!
//! Output: JSONL receipts in decode_attribution_runs/ plus rollup report.

use std::fs;
use std::io::Write;

use tribunus_compute_native::decode_attribution::matrices::{
    RunConfig, run_matrix_a, run_matrix1, run_matrix2, run_matrix2b, run_matrix_lattice,
    run_negative_evidence_fixture,
};
use tribunus_compute_native::decode_attribution::report::{
    generate_report, generate_coverage_json, generate_coverage_table,
};

const DEFAULT_WARMUP: u32 = 10;
const DEFAULT_STEADY: u32 = 100;
const DEFAULT_TOLERANCE: f64 = 1e-4;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let include_gpu = args.contains(&"--include-gpu-shape-matrix".to_string());
    let full_catalog = args.contains(&"--full-catalog".to_string());

    // Parse --run-id if provided.
    let custom_run_id = args
        .iter()
        .position(|a| a == "--run-id")
        .and_then(|i| args.get(i + 1))
        .cloned();

    // Check dirty-tree state.
    let (repo_dirty, compute_dirty, dep_dirty, sample_paths) = check_provenance();

    let run_id = custom_run_id.unwrap_or_else(|| {
        format!(
            "DA-{:04}-{:06}",
            1,
            {
                use std::time::{SystemTime, UNIX_EPOCH};
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs()
                    % 1_000_000
            }
        )
    });

    let output_dir = format!("decode_attribution_runs/{}", run_id);
    fs::create_dir_all(&output_dir).expect("create output dir");

    let config = RunConfig {
        run_id: run_id.clone(),
        output_dir: output_dir.clone(),
        warmup_iterations: DEFAULT_WARMUP,
        steady_iterations: DEFAULT_STEADY,
        tolerance: DEFAULT_TOLERANCE,
    };

    eprintln!("=== Decode Attribution Data Collection Gate ===");
    eprintln!("Run ID: {}", run_id);
    eprintln!("Output: {}", output_dir);
    eprintln!("Dirty tree: global={} compute={} dep={}", repo_dirty, compute_dirty, dep_dirty);
    eprintln!("Warmup: {} iters, Steady: {} iters", DEFAULT_WARMUP, DEFAULT_STEADY);
    eprintln!("");

    // ── Full Catalog Lattice Run (if requested) ──
    if full_catalog {
        eprintln!("=== Full Catalog Lattice Run ===");
        let lattice = run_matrix_lattice(&config);
        eprintln!("  {} total rows", lattice.len());

        // Validate row count expectation: 48 Core ML + 24 MLX + 24 Accelerate = 96
        let coreml_count = lattice.iter().filter(|r| r.backend == "coreml").count();
        let mlx_count = lattice.iter().filter(|r| r.backend == "mlx").count();
        let accel_count = lattice.iter().filter(|r| r.backend == "accelerate").count();
        eprintln!("  Core ML: {} rows", coreml_count);
        eprintln!("  MLX: {} rows", mlx_count);
        eprintln!("  Accelerate: {} rows", accel_count);

        // Write lattice rows as JSONL
        write_jsonl(&output_dir, "matrix_lattice", &lattice);

        // Generate coverage lattice JSON artifact
        let coverage = generate_coverage_json(&run_id, repo_dirty, compute_dirty, dep_dirty, sample_paths, &lattice);
        let coverage_path = format!("{}/coverage_lattice.json", output_dir);
        let coverage_json = serde_json::to_string_pretty(&coverage).expect("serialize coverage");
        let mut cf = fs::File::create(&coverage_path).expect("create coverage file");
        cf.write_all(coverage_json.as_bytes()).expect("write coverage");
        eprintln!("  Coverage JSON: {}", coverage_path);

        // Print human-readable coverage table
        eprintln!("");
        eprintln!("Coverage Table:");
        let table = generate_coverage_table(&coverage);
        eprintln!("{}", table);

        // Do not run standard matrices when --full-catalog is specified.
        eprintln!("");
        eprintln!("=== Coverage Lattice Gate Complete ===");
        eprintln!("Rows: {}", lattice.len());
        eprintln!("Coverage: {}", coverage_path);
        return;
    }

    // ── Matrix 1: Compute Unit × Graph Family ──
    eprintln!("--- Matrix 1: Compute Unit × Graph Family ---");
    let m1 = run_matrix1(&config);
    eprintln!("  {} runs ({} pass, {} fail)", m1.len(),
        m1.iter().filter(|r| r.status == "pass").count(),
        m1.iter().filter(|r| r.status != "pass").count());
    write_jsonl(&output_dir, "matrix1", &m1);

    // ── Matrix 2: Shape × Graph Family (CPU-only) ──
    eprintln!("--- Matrix 2: Shape × Graph Family (CPU-only) ---");
    let m2 = run_matrix2(&config);
    eprintln!("  {} runs ({} pass, {} fail)", m2.len(),
        m2.iter().filter(|r| r.status == "pass").count(),
        m2.iter().filter(|r| r.status != "pass").count());
    write_jsonl(&output_dir, "matrix2", &m2);

    // ── Negative evidence ──
    eprintln!("--- Negative Evidence Fixture ---");
    let neg = run_negative_evidence_fixture(&config);
    eprintln!("  status: {}", neg.status);
    write_jsonl(&output_dir, "negative_evidence", &[neg.clone()]);

    // ── Matrix A: Three-way matmul baseline ──
    eprintln!("--- Matrix A: Three-way matmul baseline ---");
    let ma = run_matrix_a(&config);
    eprintln!("  {} runs ({} pass, {} fail)", ma.len(),
        ma.iter().filter(|r| r.status == "pass").count(),
        ma.iter().filter(|r| r.status != "pass").count());
    write_jsonl(&output_dir, "matrix_a", &ma);

    // ── Matrix 2b: Shape × Graph Family (GPU, optional) ──
    let mut m2b = Vec::new();
    if include_gpu {
        eprintln!("--- Matrix 2b: Shape × Graph Family (GPU) ---");
        m2b = run_matrix2b(&config);
        eprintln!("  {} runs ({} pass, {} fail)", m2b.len(),
            m2b.iter().filter(|r| r.status == "pass").count(),
            m2b.iter().filter(|r| r.status != "pass").count());
        write_jsonl(&output_dir, "matrix2b", &m2b);
    } else {
        eprintln!("--- Matrix 2b: SKIPPED (pass --include-gpu-shape-matrix to enable) ---");
    }

    // ── Report ──
    eprintln!("--- Generating Report ---");
    let mut all_matrices = vec![
        ("matrix_a", ma),
        ("matrix1_compute_units", m1),
        ("matrix2_shape_scaling_cpu", m2),
    ];

    if include_gpu {
        all_matrices.push(("matrix2b_shape_scaling_gpu", m2b));
    }
    all_matrices.push(("negative_evidence", vec![neg]));

    let report = generate_report(
        &run_id,
        all_matrices.iter().map(|(n, r)| (*n, r.clone())).collect(),
        DEFAULT_WARMUP,
        DEFAULT_STEADY,
        DEFAULT_TOLERANCE,
    );

    let report_path = format!("{}/decode_attribution_report.json", output_dir);
    let report_json = serde_json::to_string_pretty(&report).expect("serialize report");
    let mut f = fs::File::create(&report_path).expect("create report file");
    f.write_all(report_json.as_bytes()).expect("write report");
    eprintln!("  Report: {}", report_path);

    eprintln!("");
    eprintln!("=== Decode Attribution Gate Complete ===");
    eprintln!("Receipts: {}/", output_dir);
    eprintln!("Report:  {}", report_path);
}

fn write_jsonl(dir: &str, name: &str, receipts: &[tribunus_compute_native::decode_attribution::receipt::DecodeAttributionReceipt]) {
    let path = format!("{}/{}.jsonl", dir, name);
    let mut f = fs::File::create(&path).expect("create jsonl file");
    for r in receipts {
        let line = serde_json::to_string(r).expect("serialize receipt");
        writeln!(f, "{}", line).expect("write jsonl line");
    }
    eprintln!("  JSONL: {}", path);
}

/// Check provenance across three scopes.
/// Returns (global_dirty, compute_dirty, dep_dirty, dirty_paths_sample).
fn check_provenance() -> (bool, bool, bool, Vec<String>) {
    use std::process::Command;

    fn run_git(args: &[&str]) -> (String, bool) {
        match Command::new("git").args(args).output() {
            Ok(out) => (String::from_utf8_lossy(&out.stdout).trim().to_string(), false),
            Err(_) => (String::new(), true),
        }
    }

    let (global_out, _) = run_git(&["status", "--porcelain"]);
    let (compute_out, compute_err) = run_git(&["status", "--porcelain", "--", "packages/compute-native/"]);
    let (dep_out, dep_err) = run_git(&["status", "--porcelain", "--", "Cargo.toml", "Cargo.lock", ".cargo/", "rust-toolchain", "rust-toolchain.toml", "build.rs"]);

    let repo_dirty = !global_out.is_empty();
    let compute_dirty = !compute_out.is_empty();
    let dep_dirty = !dep_out.is_empty();

    let mut sample: Vec<String> = Vec::new();
    for line in global_out.lines().take(10) {
        sample.push(line.to_string());
    }

    if compute_err || dep_err {
        eprintln!("  [warn] could not check scoped git status; assuming dirty");
        return (true, true, true, sample);
    }

    (repo_dirty, compute_dirty, dep_dirty, sample)
}
