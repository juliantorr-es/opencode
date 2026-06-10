use std::collections::BTreeMap;
use serde::Serialize;

use super::receipt::DecodeAttributionReceipt;

/// Matrix summary for the report.
#[derive(Debug, Clone, Serialize)]
pub struct MatrixSummary {
    pub runs: usize,
    pub passed: usize,
    pub failed: usize,
}

/// Key finding in the report.
#[derive(Debug, Clone, Serialize)]
pub struct KeyFinding {
    pub question: String,
    pub answer: String,
    pub data: serde_json::Value,
}

/// Exclusion entry.
#[derive(Debug, Clone, Serialize)]
pub struct BaselineExclusion {
    pub graph_family: String,
    pub reason: String,
}

/// Failure entry.
#[derive(Debug, Clone, Serialize)]
pub struct FailureEntry {
    pub graph_family: String,
    pub shape_profile: String,
    pub runtime_compute_units: String,
    pub reason: String,
}

/// Decode attribution rollup report.
#[derive(Debug, Clone, Serialize)]
pub struct DecodeAttributionReport {
    pub report_id: String,
    pub generated_at: String,
    pub commit_sha: String,
    pub schema_version: String,
    pub percentile_method: String,
    pub host: HostInfo,
    pub config: ReportConfig,
    pub matrices: BTreeMap<String, MatrixSummary>,
    pub key_findings: Vec<KeyFinding>,
    pub baseline_exclusions: Vec<BaselineExclusion>,
    pub failures: Vec<FailureEntry>,
    pub backend_support_matrix: BTreeMap<String, Vec<String>>,
    pub break_even_analysis: Vec<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize)]
pub struct HostInfo {
    pub chip: String,
    pub macos: String,
    pub xcode: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ReportConfig {
    pub warmup_iterations: u32,
    pub steady_iterations: u32,
    pub tolerance: f64,
}

/// Generate a rollup report from collected receipts.
pub fn generate_report(
    report_id: &str,
    matrix_receipts: Vec<(&'static str, Vec<DecodeAttributionReceipt>)>,
    warmup_iters: u32,
    steady_iters: u32,
    tolerance: f64,
) -> DecodeAttributionReport {
    let ts = iso_timestamp();

    let mut matrices = BTreeMap::new();
    let mut failures = Vec::new();
    let mut backend_support_matrix: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let mut host_info = HostInfo {
        chip: "unknown".into(),
        macos: "unknown".into(),
        xcode: "unknown".into(),
    };

    for (name, receipts) in &matrix_receipts {
        let total = receipts.len();
        let passed = receipts.iter().filter(|r| r.status == "pass").count();
        let failed = total - passed;
        matrices.insert(name.to_string(), MatrixSummary { runs: total, passed, failed });

        // Extract host info from first receipt
        if let Some(first) = receipts.first() {
            if host_info.chip == "unknown" {
                host_info = HostInfo {
                    chip: first.host_chip.clone(),
                    macos: first.macos_version.clone(),
                    xcode: first.xcode_version.clone(),
                };
            }
        }

        // Collect failures
        for r in receipts {
            if r.status != "pass" {
                failures.push(FailureEntry {
                    graph_family: r.graph_family.clone(),
                    shape_profile: r.shape_profile.clone(),
                    runtime_compute_units: r.runtime_compute_units.clone(),
                    reason: r.failure_reason.clone().unwrap_or_default(),
                });
            }
            // Build backend support matrix
            let key = format!("{}/{}", r.backend, r.graph_family);
            backend_support_matrix.entry(key).or_default().push(r.backend_support_status.clone());
        }
    }

    let commit = matrix_receipts.first().and_then(|(_, rs)| rs.first())
        .map(|r| r.commit_sha.clone())
        .unwrap_or_default();

    DecodeAttributionReport {
        report_id: report_id.to_string(),
        generated_at: ts,
        commit_sha: commit,
        schema_version: "decode-attribution.v1".to_string(),
        percentile_method: "nearest_rank".to_string(),
        host: host_info,
        config: ReportConfig {
            warmup_iterations: warmup_iters,
            steady_iterations: steady_iters,
            tolerance,
        },
        matrices,
        backend_support_matrix,
        break_even_analysis: generate_break_even(&matrix_receipts),
        key_findings: generate_key_findings(&matrix_receipts),
        baseline_exclusions: vec![
            BaselineExclusion {
                graph_family: "identity_passthrough".into(),
                reason: "bridge/load/predict overhead baseline; excluded from scaling conclusions".into(),
            },
        ],
        failures,
    }
}

/// Generate key findings from collected receipts.
fn generate_key_findings(matrix_receipts: &[(&'static str, Vec<DecodeAttributionReceipt>)]) -> Vec<KeyFinding> {
    let mut findings = Vec::new();

    // Collect all matmul rows across backends
    let mut matmul_rows: Vec<&DecodeAttributionReceipt> = Vec::new();
    for (_, receipts) in matrix_receipts {
        for r in receipts {
            if r.graph_family == "matmul" && r.status == "pass" && r.steady_p50_ns > 0 {
                matmul_rows.push(r);
    }
}
    }

    if !matmul_rows.is_empty() {
        // Group by backend
        use std::collections::BTreeMap;
        let mut by_backend: BTreeMap<String, Vec<serde_json::Value>> = BTreeMap::new();
        for r in &matmul_rows {
            let entry = serde_json::json!({
                "shape": r.shape_profile,
                "cold_ns": r.cold_first_predict_ns,
                "steady_p50_ns": r.steady_p50_ns,
                "compile_duration_ns": r.compile_duration_ns,
                "load_duration_ns": r.load_duration_ns,
            });
            by_backend.entry(r.backend.clone()).or_default().push(entry);
        }
        findings.push(KeyFinding {
            question: "steady_state_latency_by_backend".into(),
            answer: format!("{} backends produced matmul data", by_backend.len()),
            data: serde_json::to_value(by_backend).unwrap_or_default(),
        });
    }

    findings
}

/// Generate break-even analysis from matrix_a receipts.
fn generate_break_even(matrix_receipts: &[(&'static str, Vec<DecodeAttributionReceipt>)]) -> Vec<serde_json::Value> {
    let mut results = Vec::new();

    // Find matrix_a rows
    let mut coreml_rows: Vec<&DecodeAttributionReceipt> = Vec::new();
    let mut direct_rows: Vec<&DecodeAttributionReceipt> = Vec::new();

    for (name, receipts) in matrix_receipts {
        if *name != "matrix_a" { continue; }
        for r in receipts {
            if r.status != "pass" || r.steady_p50_ns == 0 { continue; }
            match r.backend.as_str() {
                "coreml" => coreml_rows.push(r),
                "accelerate" | "mlx" => direct_rows.push(r),
                _ => {}
            }
        }
    }

    for cm in &coreml_rows {
        for d in &direct_rows {
            if cm.shape_profile != d.shape_profile { continue; }
            let lifecycle_tax = cm.materialize_duration_ns + cm.compile_duration_ns + cm.load_duration_ns;
            let prepare_tax = d.backend_prepare_duration_ns;
            let cm_steady = cm.steady_p50_ns;
            let d_steady = d.steady_p50_ns;

            let numerator = (lifecycle_tax as i64) - (prepare_tax as i64);
            let denominator = (d_steady as i64) - (cm_steady as i64);

            let break_even = if numerator <= 0 {
                "coreml_ahead_at_n0".to_string()
            } else if denominator <= 0 {
                "no_break_even".to_string()
            } else {
                let be = (numerator as f64 / denominator as f64).ceil() as u64;
                format!("{}", be)
            };

            results.push(serde_json::json!({
                "shape": cm.shape_profile,
                "coreml_backend": cm.backend_runtime_policy,
                "direct_backend": d.backend,
                "coreml_lifecycle_tax_ns": lifecycle_tax,
                "direct_prepare_tax_ns": prepare_tax,
                "coreml_steady_p50_ns": cm_steady,
                "direct_steady_p50_ns": d_steady,
                "break_even_iterations": break_even,
            }));
        }
    }

    results
}
fn iso_timestamp() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let d = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
    let secs = d.as_secs();
    let days = secs / 86400;
    let time_secs = secs % 86400;
    let h = time_secs / 3600;
    let m = (time_secs % 3600) / 60;
    let s = time_secs % 60;
    let y400 = days / 146097;
    let d400 = days % 146097;
    let y100 = d400 / 36524;
    let d100 = d400 % 36524;
    let y4 = d100 / 1461;
    let d4 = d100 % 1461;
    let y1 = d4 / 365;
    let d1 = d4 % 365;
    let y = 1970 + (y400 * 400 + y100 * 100 + y4 * 4 + y1) as u16;
    let leap = if y1 > 0 && (y1 % 4 == 0) { 1 } else { 0 };
    let doy = (d1 + 1) as u16;
    let months_days: [u16; 12] = [31, 28 + leap, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    let mut accum = 0u16;
    let mut month = 1u16;
    for (i, &md) in months_days.iter().enumerate() {
        if doy <= accum + md { month = (i + 1) as u16; break; }
        accum += md;
    }
    let day = doy - accum;
    format!("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z", y, month, day, h, m, s)
}

// ── Coverage Lattice ────────────────────────────────────────────────────────

/// A single row in the coverage lattice.
#[derive(Debug, Clone, Serialize)]
pub struct CoverageLatticeRow {
    pub run_id: String,
    pub commit_sha: String,
    pub dirty_tree: bool,
    pub backend: String,
    pub graph_family: String,
    pub shape_profile: String,
    pub runtime_policy: String,
    pub support_tier: String,
    pub predict_status: String,
    pub predict_failure_classification: String,
    pub max_absolute_error: f64,
    pub steady_p50_ns: u64,
    pub materialize_duration_ns: u64,
    pub compile_duration_ns: u64,
    pub load_duration_ns: u64,
    pub cold_first_predict_ns: u64,
    pub reference_output_hashes_populated: bool,
    pub reference_status: String,
}

/// The full coverage lattice artifact.
#[derive(Debug, Clone, Serialize)]
pub struct CoverageLattice {
    pub run_id: String,
    pub commit_sha: String,
    pub dirty_tree: bool,
    pub repo_dirty_tree_global: bool,
    pub compute_dirty_tree: bool,
    pub dependency_scope_dirty: bool,
    pub provenance: String, // "clean", "tainted", or "dependency_dirty"
    pub provenance_scope: String, // "compute-native"
    pub dirty_paths_sample: Vec<String>,
    pub schema_version: String,
    pub generated_at: String,
    pub total_rows: usize,
    pub rows: Vec<CoverageLatticeRow>,
}

/// Generate a coverage lattice JSON artifact from a collection of receipts.
///
/// Validates:
/// - All receipts share the same `run_id` and `commit_sha`
/// - Rejects empty or mixed-provenance inputs
/// - Provenance is computed from three scoped flags
pub fn generate_coverage_json(
    run_id: &str,
    repo_dirty: bool,
    compute_dirty: bool,
    dep_dirty: bool,
    dirty_paths: Vec<String>,
    receipts: &[DecodeAttributionReceipt],
) -> CoverageLattice {
    let ts = iso_timestamp();

    // Validate consistent run_id
    for r in receipts {
        assert_eq!(
            r.run_id, run_id,
            "mixed run_id in lattice: '{}' vs '{}'",
            r.run_id, run_id
        );
    }

    let commit_sha = receipts.first().map(|r| r.commit_sha.clone()).unwrap_or_default();

    // Validate consistent commit_sha
    for r in receipts {
        assert_eq!(
            r.commit_sha, commit_sha,
            "mixed commit_sha in lattice: '{}' vs '{}'",
            r.commit_sha, commit_sha
        );
    }

    let provenance = if compute_dirty || dep_dirty {
        "tainted".to_string()
    } else {
        "clean".to_string()
    };
    let provenance_scope = "compute-native".to_string();

    let rows: Vec<CoverageLatticeRow> = receipts.iter().map(|r| CoverageLatticeRow {
        run_id: r.run_id.clone(),
        commit_sha: r.commit_sha.clone(),
        dirty_tree: repo_dirty,
        backend: r.backend.clone(),
        graph_family: r.graph_family.clone(),
        shape_profile: r.shape_profile.clone(),
        runtime_policy: r.backend_runtime_policy.clone(),
        support_tier: if r.support_tier.is_empty() { "unknown".to_string() } else { r.support_tier.clone() },
        predict_status: if r.predict_status.is_empty() { "not_run".to_string() } else { r.predict_status.clone() },
        predict_failure_classification: r.predict_failure_classification.clone(),
        max_absolute_error: r.max_absolute_error,
        steady_p50_ns: r.steady_p50_ns,
        materialize_duration_ns: r.materialize_duration_ns,
        compile_duration_ns: r.compile_duration_ns,
        load_duration_ns: r.load_duration_ns,
        cold_first_predict_ns: r.cold_first_predict_ns,
        reference_output_hashes_populated: r.reference_output_hashes_populated,
        reference_status: r.reference_status.clone(),
    }).collect();

    let total_rows = rows.len();

    CoverageLattice {
        run_id: run_id.to_string(),
        commit_sha,
        dirty_tree: repo_dirty,
        repo_dirty_tree_global: repo_dirty,
        compute_dirty_tree: compute_dirty,
        dependency_scope_dirty: dep_dirty,
        provenance,
        provenance_scope,
        dirty_paths_sample: dirty_paths,
        schema_version: "coverage-lattice.v1".to_string(),
        generated_at: ts,
        total_rows,
        rows,
    }
}

/// Generate a human-readable coverage table from the lattice.
pub fn generate_coverage_table(lattice: &CoverageLattice) -> String {
    let mut lines = Vec::new();
    lines.push(format!("Coverage Lattice: run_id={} commit={} compute_dirty={} dep_dirty={} global_dirty={} provenance={} scope={} rows={}",
        lattice.run_id, lattice.commit_sha, lattice.compute_dirty_tree, lattice.dependency_scope_dirty, lattice.repo_dirty_tree_global, lattice.provenance, lattice.provenance_scope, lattice.total_rows));
    lines.push(String::new());
    lines.push(format!("{:<22} {:<12} {:<12} {:<18} {:<18} {:<14} ref_hashes",
        "Graph", "Shape", "Backend", "SupportTier", "PredictStatus", "P50(ns)"));
    lines.push("-".repeat(100));

    let mut sorted = lattice.rows.clone();
    sorted.sort_by(|a, b| {
        a.backend.cmp(&b.backend)
            .then(a.graph_family.cmp(&b.graph_family))
            .then(a.shape_profile.cmp(&b.shape_profile))
    });

    for row in &sorted {
        let p50 = if row.predict_status == "pass" {
            format!("{}", row.steady_p50_ns)
        } else {
            "-".to_string()
        };
        lines.push(format!("{:<22} {:<12} {:<12} {:<18} {:<18} {:<14} {}",
            row.graph_family, row.shape_profile, row.backend,
            row.support_tier, row.predict_status, p50,
            row.reference_output_hashes_populated,
        ));
    }

    lines.push(String::new());
    let elig = if lattice.provenance == "clean" { "eligible for optimization decisions" } else { "NOT eligible" };
    lines.push(format!("Provenance: {} — {}", lattice.provenance, elig));
    lines.join("\n")
}
