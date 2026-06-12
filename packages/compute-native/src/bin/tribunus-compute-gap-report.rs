use std::fs;
use std::path::{Path, PathBuf};

use tribunus_compute_native::decode_attribution::gap_report::{
    build_backend_gap_matrix, load_cargo_build_log, load_cargo_clippy_log, load_cargo_test_log,
    load_kv_contracts, load_python_reference, load_support_matrix, load_tier1_defects,
    load_tier2_manifest, normalize_gaps, write_gap_report_artifacts, ComputeGap, GapReportAccounting, GapStatus,
};
use serde_json::Value;

fn parse_flag_value(args: &[String], name: &str, default: bool) -> bool {
    args.iter()
        .find_map(|arg| {
            arg.strip_prefix(&format!("{name}=")).map(|value| matches!(value, "1" | "true" | "yes" | "on"))
        })
        .unwrap_or(default)
}

fn latest_child_dir(path: &Path) -> Option<PathBuf> {
    let mut entries: Vec<PathBuf> = fs::read_dir(path)
        .ok()?
        .filter_map(|entry| entry.ok().map(|entry| entry.path()))
        .filter(|entry| entry.is_dir())
        .collect();
    entries.sort();
    entries.pop()
}

fn discover_tier1_run_dir(decode_runs_dir: &Path) -> PathBuf {
    let tier1_root = decode_runs_dir.join("TIER1-GATE");
    latest_child_dir(&tier1_root).unwrap_or_else(|| tier1_root.join("DA-0001-193461"))
}

fn count_json_rows(path: &Path) -> u32 {
    let Ok(text) = fs::read_to_string(path) else {
        return 0;
    };
    let Ok(value) = serde_json::from_str::<Value>(&text) else {
        return 0;
    };
    match value {
        Value::Array(items) => items.len() as u32,
        Value::Object(map) => map
            .values()
            .map(|value| value.as_array().map(|items| items.len() as u32).unwrap_or(0))
            .sum(),
        _ => 0,
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let mut workspace_root = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let mut decode_runs_dir = workspace_root.join("decode_attribution_runs");
    let mut output_dir = decode_runs_dir.join("COMPUTE-GAP-REPORT");
    let mut cargo_build_log = Some(decode_runs_dir.join("cargo-build.log"));
    let mut cargo_test_log = Some(decode_runs_dir.join("cargo-test.log"));
    let mut cargo_clippy_log = Some(decode_runs_dir.join("cargo-clippy.log"));
    let mut tier1_run_dir = discover_tier1_run_dir(&decode_runs_dir);
    let mut tier2_output_dir = decode_runs_dir.join("DECODE-BATCH1");
    let mut python_ref_dir: Option<PathBuf> = None;
    let mut include_cargo = true;
    let mut include_generated = true;
    let mut fail_on_critical = false;

    let mut i = 1;
    while i < args.len() {
        match args[i].as_str() {
            "--workspace-root" => {
                i += 1;
                workspace_root = PathBuf::from(&args[i]);
                decode_runs_dir = workspace_root.join("decode_attribution_runs");
                output_dir = decode_runs_dir.join("COMPUTE-GAP-REPORT");
                tier1_run_dir = discover_tier1_run_dir(&decode_runs_dir);
                tier2_output_dir = decode_runs_dir.join("DECODE-BATCH1");
                cargo_build_log = Some(decode_runs_dir.join("cargo-build.log"));
                cargo_test_log = Some(decode_runs_dir.join("cargo-test.log"));
                cargo_clippy_log = Some(decode_runs_dir.join("cargo-clippy.log"));
            }
            "--decode-runs-dir" => {
                i += 1;
                decode_runs_dir = PathBuf::from(&args[i]);
                output_dir = decode_runs_dir.join("COMPUTE-GAP-REPORT");
                tier1_run_dir = discover_tier1_run_dir(&decode_runs_dir);
                tier2_output_dir = decode_runs_dir.join("DECODE-BATCH1");
                cargo_build_log = Some(decode_runs_dir.join("cargo-build.log"));
                cargo_test_log = Some(decode_runs_dir.join("cargo-test.log"));
                cargo_clippy_log = Some(decode_runs_dir.join("cargo-clippy.log"));
            }
            "--output-dir" => {
                i += 1;
                output_dir = PathBuf::from(&args[i]);
            }
            "--cargo-build-log" => {
                i += 1;
                cargo_build_log = Some(PathBuf::from(&args[i]));
            }
            "--cargo-test-log" => {
                i += 1;
                cargo_test_log = Some(PathBuf::from(&args[i]));
            }
            "--cargo-clippy-log" => {
                i += 1;
                cargo_clippy_log = Some(PathBuf::from(&args[i]));
            }
            "--tier1-run-dir" => {
                i += 1;
                tier1_run_dir = PathBuf::from(&args[i]);
            }
            "--tier2-output-dir" => {
                i += 1;
                tier2_output_dir = PathBuf::from(&args[i]);
            }
            "--python-ref-dir" => {
                i += 1;
                python_ref_dir = Some(PathBuf::from(&args[i]));
            }
            "--include-cargo" => {
                include_cargo = true;
            }
            "--include-generated" => {
                include_generated = true;
            }
            "--no-include-cargo" => {
                include_cargo = false;
            }
            "--no-include-generated" => {
                include_generated = false;
            }
            "--fail-on-critical" => {
                fail_on_critical = true;
            }
            "--help" | "-h" => {
                eprintln!("Usage: tribunus-compute-gap-report [options]");
                eprintln!("  --workspace-root <path>");
                eprintln!("  --decode-runs-dir <path>");
                eprintln!("  --output-dir <path>");
                eprintln!("  --cargo-build-log <path>");
                eprintln!("  --cargo-test-log <path>");
                eprintln!("  --cargo-clippy-log <path>");
                eprintln!("  --tier1-run-dir <path>");
                eprintln!("  --tier2-output-dir <path>");
                eprintln!("  --python-ref-dir <path>");
                eprintln!("  --fail-on-critical");
                return;
            }
            other if other.starts_with("--include-cargo=") => {
                include_cargo = parse_flag_value(&args, "--include-cargo", true);
            }
            other if other.starts_with("--include-generated=") => {
                include_generated = parse_flag_value(&args, "--include-generated", true);
            }
            other => {
                eprintln!("Unknown argument: {other}");
                std::process::exit(1);
            }
        }
        i += 1;
    }

    let mut gaps: Vec<ComputeGap> = Vec::new();

    if include_cargo {
        if let Some(path) = cargo_build_log.as_ref() {
            match load_cargo_build_log(path) {
                Ok(items) => gaps.extend(items),
                Err(err) => eprintln!("cargo build log error: {err}"),
            }
        }
        if let Some(path) = cargo_test_log.as_ref() {
            match load_cargo_test_log(path) {
                Ok(items) => gaps.extend(items),
                Err(err) => eprintln!("cargo test log error: {err}"),
            }
        }
        if let Some(path) = cargo_clippy_log.as_ref() {
            match load_cargo_clippy_log(path) {
                Ok(items) => gaps.extend(items),
                Err(err) => eprintln!("cargo clippy log error: {err}"),
            }
        }
    }

    if include_generated {
        match load_tier1_defects(&tier1_run_dir) {
            Ok(items) => gaps.extend(items),
            Err(err) => eprintln!("tier1 defects error: {err}"),
        }
        match load_tier2_manifest(&tier2_output_dir) {
            Ok(items) => gaps.extend(items),
            Err(err) => eprintln!("tier2 manifest error: {err}"),
        }
        match load_support_matrix(&tier2_output_dir) {
            Ok(items) => gaps.extend(items),
            Err(err) => eprintln!("support matrix error: {err}"),
        }
        match load_kv_contracts(&tier2_output_dir) {
            Ok(items) => gaps.extend(items),
            Err(err) => eprintln!("kv contracts error: {err}"),
        }
    }

    if let Some(path) = python_ref_dir.as_ref() {
        match load_python_reference(std::slice::from_ref(path)) {
            Ok(items) => gaps.extend(items),
            Err(err) => eprintln!("python reference error: {err}"),
        }
    }

    let accounting = GapReportAccounting {
        observed_tier1_total: count_json_rows(&tier1_run_dir.join("clustering").join("tier1_defect_clusters.json")),
        tier1_pass_count: gaps.iter().filter(|gap| matches!(gap.source, tribunus_compute_native::decode_attribution::gap_report::GapSource::Tier1DefectCluster) && !gap.blocks_promotion).count() as u32,
        tier1_nonpass_count: gaps.iter().filter(|gap| matches!(gap.source, tribunus_compute_native::decode_attribution::gap_report::GapSource::Tier1DefectCluster) && gap.blocks_promotion).count() as u32,
        tier1_gap_rows: gaps.iter().filter(|gap| matches!(gap.source, tribunus_compute_native::decode_attribution::gap_report::GapSource::Tier1DefectCluster)).count() as u32,
        observed_tier2_manifest_rows: count_json_rows(&tier2_output_dir.join("decode_microphase_support_matrix.json")),
        tier2_gap_rows: gaps.iter().filter(|gap| matches!(gap.source, tribunus_compute_native::decode_attribution::gap_report::GapSource::Tier2Manifest)).count() as u32,
        observed_kv_contract_rows: count_json_rows(&tier2_output_dir.join("kv_contracts.json")),
        kv_contract_gap_rows: gaps.iter().filter(|gap| matches!(gap.source, tribunus_compute_native::decode_attribution::gap_report::GapSource::KvContract)).count() as u32,
    };
    let (gaps, receipt) = normalize_gaps(&gaps, accounting);
    let backend_matrix = build_backend_gap_matrix();

    if let Err(err) = write_gap_report_artifacts(&output_dir, &gaps, &receipt, &backend_matrix) {
        eprintln!("gap report error: {err}");
        std::process::exit(1);
    }

    let critical = gaps.iter().any(|gap| gap.severity.as_numeric() >= 3 || gap.status == GapStatus::BlockedUpstream);
    eprintln!(
        "Total gaps: {} (S0: {}, S1: {}, S2: {}, S3: {}, S4: {}) | Tier1 observed/pass/nonpass/gaps: {}/{}/{}/{} | Tier2 observed/gaps: {}/{} | KV observed/gaps: {}/{} | False qualification risks: {} | Artifacts: {}",
        gaps.len(),
        gaps.iter().filter(|gap| gap.severity == tribunus_compute_native::decode_attribution::gap_report::GapSeverity::S0).count(),
        gaps.iter().filter(|gap| gap.severity == tribunus_compute_native::decode_attribution::gap_report::GapSeverity::S1).count(),
        gaps.iter().filter(|gap| gap.severity == tribunus_compute_native::decode_attribution::gap_report::GapSeverity::S2).count(),
        gaps.iter().filter(|gap| gap.severity == tribunus_compute_native::decode_attribution::gap_report::GapSeverity::S3).count(),
        gaps.iter().filter(|gap| gap.severity == tribunus_compute_native::decode_attribution::gap_report::GapSeverity::S4).count(),
        receipt.observed_tier1_total,
        receipt.tier1_pass_count,
        receipt.tier1_nonpass_count,
        receipt.tier1_gap_rows,
        receipt.observed_tier2_manifest_rows,
        receipt.tier2_gap_rows,
        receipt.observed_kv_contract_rows,
        receipt.kv_contract_gap_rows,
        receipt.false_qualification_risks_detected,
        receipt.artifact_count,
    );

    if fail_on_critical && critical {
        std::process::exit(1);
    }
}
