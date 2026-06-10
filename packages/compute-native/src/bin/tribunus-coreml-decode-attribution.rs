//! Tribunus Core ML Decode Attribution Harness.
//!
//! Measures materialization, compilation, load, warmup, and prediction
//! timing across two primary matrices and one optional matrix.
//!
//! Usage:
//!   cargo run --bin tribunus-coreml-decode-attribution --profile inference-evidence
//!   cargo run --bin tribunus-coreml-decode-attribution --profile inference-evidence -- --include-gpu-shape-matrix
//!
//! Output: JSONL receipts in decode_attribution_runs/ plus rollup report.

use std::fs;
use std::io::Write;

use tribunus_compute_native::decode_attribution::matrices::{
    RunConfig, run_matrix_a, run_matrix1, run_matrix2, run_matrix2b, run_negative_evidence_fixture,
};
use tribunus_compute_native::decode_attribution::report::generate_report;

const DEFAULT_WARMUP: u32 = 10;
const DEFAULT_STEADY: u32 = 100;
const DEFAULT_TOLERANCE: f64 = 1e-4;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let include_gpu = args.contains(&"--include-gpu-shape-matrix".to_string());

    let run_id = format!("DA-{:04}-{:06}", 1, {
        use std::time::{SystemTime, UNIX_EPOCH};
        SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs() % 1_000_000
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
    eprintln!("Warmup: {} iters, Steady: {} iters", DEFAULT_WARMUP, DEFAULT_STEADY);
    eprintln!("");

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
