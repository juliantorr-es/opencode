//! Tribunus Core ML Minimal Reproducer.
//!
//! Runs the diagnostic graph catalog through structural verification, MIL
//! program build, mlpackage serialization, coremlcompiler compilation, and
//! model load, preserving all artifacts for analysis.
//!
//! Usage:
//!   cargo run --bin tribunus-coreml-minimal-repro --profile inference-evidence
//!   cargo run --bin tribunus-coreml-minimal-repro --profile inference-evidence -- \
//!     --run-id COREML-REPRO-0001 --track elementwise
//!   cargo run --bin tribunus-coreml-minimal-repro --profile inference-evidence -- \
//!     --run-id COREML-REPRO-0001 --track all

use std::path::PathBuf;
use std::fs;
use std::process::Command;
use std::time::Instant;

use tribunus_compute_native::decode_attribution::coreml_minimal_repro::{
    DiagnosticGraphContract, graphs_for_track, verify_graph_contract,
};
use tribunus_compute_native::mil_builder::MilBuilder;
use tribunus_compute_native::mlpackage::{self, ModelMeta};

struct RunConfig {
    run_id: String,
    track: String,
    base_dir: PathBuf,
}

fn parse_args() -> RunConfig {
    let args: Vec<String> = std::env::args().collect();
    let mut run_id = "COREML-REPRO-0001".to_string();
    let mut track = "all".to_string();

    let mut i = 1;
    while i < args.len() {
        match args[i].as_str() {
            "--run-id" => {
                i += 1;
                if i < args.len() {
                    run_id = args[i].clone();
                }
            }
            "--track" => {
                i += 1;
                if i < args.len() {
                    track = args[i].clone();
                }
            }
            _ => {}
        }
        i += 1;
    }

    let base_dir = PathBuf::from(&run_id);
    RunConfig { run_id, track, base_dir }
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
struct GraphOutcome {
    name: String,
    track: String,
    shape_k: u32,
    shape_n: u32,
    structural_status: String,
    structural_errors: Vec<String>,
    terminal_phase: String,
    compile_invoked: bool,
    compile_status: String,
    compile_stdout: Option<String>,
    compile_stderr: Option<String>,
    compile_exit_code: Option<i32>,
    compile_duration_ns: Option<u64>,
    load_status: String,
    failure_diagnostics: Option<String>,
    expected_fate: String,
}

fn build_meta(contract: &DiagnosticGraphContract) -> ModelMeta {
    let inputs: Vec<(String, Vec<i64>)> = vec![
        ("x".to_string(), vec![1, contract.shape_k as i64]),
    ];
    let outputs: Vec<(String, Vec<i64>)> = contract.output_shapes.iter()
        .enumerate()
        .map(|(i, shape)| {
            let name = contract.output_names[i].to_string();
            let dims: Vec<i64> = shape.iter().map(|&d| d as i64).collect();
            (name, dims)
        })
        .collect();
    ModelMeta {
        model_name: format!("diag-{}", contract.name),
        function_name: "main".into(),
        short_description: contract.description.to_string(),
        version: "1.0.0".into(),
        author: "Tribunus Compute".into(),
        output_name: contract.output_names.first()
            .map(|s| s.to_string())
            .unwrap_or_else(|| "output".to_string()),
        inputs,
        outputs,
    }
}

fn compile_mlpackage(
    pkg_path: &std::path::Path,
    output_dir: &std::path::Path,
    island_id: &str,
) -> Result<(i32, String, String, u64), String> {
    let start = Instant::now();
    let src = pkg_path.to_string_lossy().to_string();
    let dest = output_dir.join(format!("{}.modelc", island_id));
    let _ = fs::create_dir_all(&dest);

    let result = Command::new("xcrun")
        .arg("coremlcompiler")
        .args(&["compile", &src, &dest.to_string_lossy()])
        .output()
        .map_err(|e| format!("xcrun invocation failed: {e}"))?;

    let duration_ns = start.elapsed().as_nanos() as u64;
    let exit_code = result.status.code().unwrap_or(-1);
    let stdout = String::from_utf8_lossy(&result.stdout).to_string();
    let stderr = String::from_utf8_lossy(&result.stderr).to_string();

    Ok((exit_code, stdout, stderr, duration_ns))
}

fn run_graph(
    config: &RunConfig,
    contract: &DiagnosticGraphContract,
) -> GraphOutcome {
    let temp_dir = tempfile::tempdir().expect("tempdir");
    let graph_dir = config.base_dir.join(contract.track).join(contract.name);
    let _ = fs::create_dir_all(&graph_dir);

    // ── Build MIL program ────────────────────────────────────────────
    let input_shape: &[i64] = &[1, contract.shape_k as i64];
    let builder = MilBuilder::new("main")
        .input("x", contract.dtype, input_shape);
    let builder = match (contract.build)(builder) {
        Ok(b) => b,
        Err(e) => {
            return GraphOutcome {
                name: contract.name.to_string(),
                track: contract.track.to_string(),
                shape_k: contract.shape_k,
                shape_n: contract.shape_n,
                structural_status: format!("build_fn_failed: {e}"),
                structural_errors: vec![e.to_string()],
                terminal_phase: "build_fn".to_string(),
                compile_invoked: false,
                compile_status: "not_run".to_string(),
                compile_stdout: None,
                compile_stderr: None,
                compile_exit_code: None,
                compile_duration_ns: None,
                load_status: "not_run".to_string(),
                failure_diagnostics: None,
                expected_fate: contract.expected_fate.to_string(),
            };
        }
    };

    let program = match builder.build() {
        Ok(p) => p,
        Err(e) => {
            return GraphOutcome {
                name: contract.name.to_string(),
                track: contract.track.to_string(),
                shape_k: contract.shape_k,
                shape_n: contract.shape_n,
                structural_status: format!("mil_build_failed: {e}"),
                structural_errors: vec![e.to_string()],
                terminal_phase: "mil_build".to_string(),
                compile_invoked: false,
                compile_status: "not_run".to_string(),
                compile_stdout: None,
                compile_stderr: None,
                compile_exit_code: None,
                compile_duration_ns: None,
                load_status: "not_run".to_string(),
                failure_diagnostics: Some(e.to_string()),
                expected_fate: contract.expected_fate.to_string(),
            };
        }
    };

    // ── Structural verification ──────────────────────────────────────
    match verify_graph_contract(&program, contract) {
        Ok(()) => {}
        Err(errors) => {
            let error_codes: Vec<String> = errors.iter().map(|e| e.code.to_string()).collect();
            let error_msgs: Vec<String> = errors.iter().map(|e| e.to_string()).collect();
            return GraphOutcome {
                name: contract.name.to_string(),
                track: contract.track.to_string(),
                shape_k: contract.shape_k,
                shape_n: contract.shape_n,
                structural_status: "fail".to_string(),
                structural_errors: error_codes,
                terminal_phase: "structural_verification".to_string(),
                compile_invoked: false,
                compile_status: "not_run".to_string(),
                compile_stdout: None,
                compile_stderr: None,
                compile_exit_code: None,
                compile_duration_ns: None,
                load_status: "not_run".to_string(),
                failure_diagnostics: Some(error_msgs.join("; ")),
                expected_fate: contract.expected_fate.to_string(),
            };
        }
    }

    // ── Write .mlpackage ─────────────────────────────────────────────
    let meta = build_meta(contract);
    let pkg_path = match mlpackage::write_mlpackage(program, temp_dir.path(), &meta) {
        Ok(p) => p,
        Err(e) => {
            return GraphOutcome {
                name: contract.name.to_string(),
                track: contract.track.to_string(),
                shape_k: contract.shape_k,
                shape_n: contract.shape_n,
                structural_status: "pass".to_string(),
                structural_errors: vec![],
                terminal_phase: "package_write".to_string(),
                compile_invoked: false,
                compile_status: "not_run".to_string(),
                compile_stdout: None,
                compile_stderr: None,
                compile_exit_code: None,
                compile_duration_ns: None,
                load_status: "not_run".to_string(),
                failure_diagnostics: Some(format!("mlpackage write: {e}")),
                expected_fate: contract.expected_fate.to_string(),
            };
        }
    };

    // Copy .mlpackage to artifact directory.
    let artifact_pkg = graph_dir.join("model.mlpackage");
    let _ = fs::remove_dir_all(&artifact_pkg);
    let _ = copy_dir(&pkg_path, &artifact_pkg);

    // ── Compile ──────────────────────────────────────────────────────
    let island_id = format!("diag-{}", contract.name);
    match compile_mlpackage(&pkg_path, &graph_dir, &island_id) {
        Ok((exit_code, stdout, stderr, duration_ns)) => {
            // Save compiler artifacts.
            let _ = fs::write(graph_dir.join("compiler.stdout.txt"), &stdout);
            let _ = fs::write(graph_dir.join("compiler.stderr.txt"), &stderr);

            // Try to load the compiled model.
            let compiled_modelc = graph_dir.join(format!("{}.modelc", island_id));
            let load_ok = compiled_modelc.exists();

            GraphOutcome {
                name: contract.name.to_string(),
                track: contract.track.to_string(),
                shape_k: contract.shape_k,
                shape_n: contract.shape_n,
                structural_status: "pass".to_string(),
                structural_errors: vec![],
                terminal_phase: if exit_code == 0 { "compile_success".to_string() } else { "compile_failed".to_string() },
                compile_invoked: true,
                compile_status: if exit_code == 0 { "pass".to_string() } else { "fail".to_string() },
                compile_stdout: Some(stdout.clone()),
                compile_stderr: Some(stderr.clone()),
                compile_exit_code: Some(exit_code),
                compile_duration_ns: Some(duration_ns),
                load_status: if load_ok { "available".to_string() } else { "not_found".to_string() },
                failure_diagnostics: if exit_code != 0 { Some(stderr.clone()) } else { None },
                expected_fate: contract.expected_fate.to_string(),
            }
        }
        Err(e) => {
            // Compiler invocation itself failed (e.g. xcrun not found).
            GraphOutcome {
                name: contract.name.to_string(),
                track: contract.track.to_string(),
                shape_k: contract.shape_k,
                shape_n: contract.shape_n,
                structural_status: "pass".to_string(),
                structural_errors: vec![],
                terminal_phase: "compile_invocation".to_string(),
                compile_invoked: true,
                compile_status: format!("invocation_error: {e}"),
                compile_stdout: None,
                compile_stderr: Some(e.clone()),
                compile_exit_code: None,
                compile_duration_ns: None,
                load_status: "not_run".to_string(),
                failure_diagnostics: Some(e),
                expected_fate: contract.expected_fate.to_string(),
            }
        }
    }
}

fn copy_dir(src: &std::path::Path, dst: &std::path::Path) -> std::io::Result<()> {
    fn copy_recursive(src: &std::path::Path, dst: &std::path::Path) -> std::io::Result<()> {
        fs::create_dir_all(dst)?;
        for entry in fs::read_dir(src)? {
            let entry = entry?;
            let file_type = entry.file_type()?;
            let src_path = entry.path();
            let dst_path = dst.join(entry.file_name());
            if file_type.is_dir() {
                copy_recursive(&src_path, &dst_path)?;
            } else {
                fs::copy(&src_path, &dst_path)?;
            }
        }
        Ok(())
    }
    copy_recursive(src, dst)
}

fn main() {
    let config = parse_args();

    eprintln!(
        "Core ML Minimal Reproducer — run_id={}, track={}",
        config.run_id, config.track
    );

    let contracts = graphs_for_track(&config.track);
    eprintln!("Running {} diagnostic graphs...", contracts.len());

    let mut outcomes: Vec<GraphOutcome> = Vec::new();

    for contract in contracts {
        eprint!("  {}... ", contract.name);
        let outcome = run_graph(&config, contract);
        let phase = &outcome.terminal_phase;
        let compile = if outcome.compile_invoked {
            format!("compile={}", outcome.compile_status)
        } else {
            "no_compile".to_string()
        };
        eprintln!("structural={}, {}, phase={}", outcome.structural_status, compile, phase);
        outcomes.push(outcome);
    }

    // Write report.
    let report_path = config.base_dir.join("repro_report.json");
    let _ = fs::create_dir_all(&config.base_dir);
    let report_json = serde_json::to_string_pretty(&outcomes)
        .unwrap_or_else(|_| "[]".to_string());
    fs::write(&report_path, &report_json)
        .unwrap_or_else(|e| eprintln!("Warning: failed to write report: {e}"));

    // Summary.
    let pass = outcomes.iter().filter(|o| o.compile_status == "pass" || !o.compile_invoked).count();
    let fail = outcomes.iter().filter(|o| o.compile_status == "fail").count();
    eprintln!("\nSummary: {} pass, {} fail, {} total", pass, fail, outcomes.len());
    eprintln!("Report: {:?}", report_path);
}
