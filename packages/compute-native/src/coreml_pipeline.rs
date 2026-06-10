//! Core ML profile compilation pipeline — MIL program generation, compilation
//! via `tools/coreml-compiler/compile_region.py`, and receipt tracking.

use std::path::{Path, PathBuf};
use std::process::Command;
use sha2::{Sha256, Digest};

use crate::backend::routing::*;
use crate::experiment::F32MatmulContract;

/// Deployment profile for Core ML integration.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CompileProfile {
    MlXOnly,
    MlXPlusCoreMlOptional,
    HybridRequired,
}

/// Receipt for a compiled Core ML island.
#[derive(Debug, Clone)]
pub struct CoreMlIslandReceipt {
    pub island_id: String,
    /// SHA-256 of the source MIL program text.
    pub model_hash: String,
    /// SHA-256 of the compiled .mlmodelc metadata.
    pub compiled_hash: String,
    /// Compute units assigned.
    pub compute_units: String,
    /// Whether parity checking passed against the MLX reference.
    pub parity_passed: bool,
    /// Path to the compiled .modelc bundle.
    pub compiled_modelc_path: String,
    /// Version of the compilation tools.
    pub tools_version: String,
    /// Compile duration in nanoseconds.
    pub compile_ns: u64,
}

/// Path to the Python compiler script.
fn compiler_script() -> PathBuf {
    // Resolve relative to the compute-native package root.
    let manifest_dir = std::env::var("CARGO_MANIFEST_DIR")
        .unwrap_or_else(|_| ".".into());
    Path::new(&manifest_dir)
        .join("tools/coreml-compiler/compile_region.py")
}

/// Generate a Core ML MIL program for F32 matrix multiplication:
///   C[M,N] = A[M,K] @ B[K,N]
///
/// The MIL program uses the MIL Builder API to construct:
/// - Two float32 input tensors (A, B)
/// - A matmul operation
/// - One float32 output tensor (C)
///
/// This is NOT the actual MIL program — it's a Python script that
/// builds the MIL program and calls compile_mlprogram().
/// The compiler script accepts this Python source on stdin.
fn generate_mil_script(contract: &F32MatmulContract, compute_units: &str) -> String {
    format!(
        r#"import coremltools as ct
from coremltools.converters.mil import Builder as mb
from coremltools.converters.mil.mil import types

# F32 matmul: C[M,N] = A[M,K] @ B[K,N]
# Contract: M={m}, K={k}, N={n}
prog = mb.program()

# Input A: shape (M, K)
prog.set_input("A", types.TensorType(types.float32, [{m}, {k}]))
# Input B: shape (K, N)
prog.set_input("B", types.TensorType(types.float32, [{k}, {n}]))

# Matmul: C = A @ B (no transpose)
with mb.Function("main") as builder:
    a = builder.add_input("A")
    b = builder.add_input("B")
    c = builder.matmul(x=a, y=b, transpose_x=False, transpose_y=False, name="C")
    builder.set_output([c])
    builder.set_output_names(["C"])

prog.set_main_function("main")

# Compile with xcrun
import sys, os, json, subprocess

def _find_model_dir(mlmodelc_path):
    for root, dirs, files in os.walk(mlmodelc_path):
        if "metadata.json" in files and "model.mil" in files:
            return root
    return None

mlmodel = ct.convert(
    prog,
    convert_to="mlprogram",
    minimum_deployment_target=ct.target.macOS15,
    compute_precision=ct.precision.FLOAT32,
    compute_units=getattr(ct.ComputeUnit, "{cu}"),
)
name = "tribunus-e0008-matmul-{m}x{k}x{n}"
mlpackage_path = f"/tmp/{{name}}.mlpackage"
mlmodel.save(mlpackage_path)
mlmodelc_path = f"/tmp/{{name}}.mlmodelc"
result = subprocess.run(
    ["xcrun", "coremlcompiler", "compile", mlpackage_path, mlmodelc_path],
    capture_output=True, text=True,
)
if result.returncode != 0:
    print(f"COMPILE FAIL: {{result.stderr}}", file=sys.stderr)
    sys.exit(1)
inner = _find_model_dir(mlmodelc_path)
if inner is None:
    print(f"COMPILE FAIL: no metadata.json", file=sys.stderr)
    sys.exit(1)
print(f"COMPILED: {{inner}}")
"#,
        m=contract.m, k=contract.k, n=contract.n, cu=compute_units,
    )
}

/// Compile a Core ML island from an F32 matmul contract.
///
/// Calls the Python compiler toolchain to generate a MIL program,
/// build an .mlpackage, and compile it via `xcrun coremlcompiler`.
/// Returns a receipt with real hashes and the compiled .mlmodelc path.
pub fn compile_f32_matmul(
    contract: &F32MatmulContract,
    compute_units: &str,
    output_dir: &Path,
) -> Result<CoreMlIslandReceipt, String> {
    let start = std::time::Instant::now();
    let mil_source = generate_mil_script(contract, compute_units);

    // Compute source hash before compilation
    let source_hash = format!("{:x}", Sha256::digest(mil_source.as_bytes()));

    let island_id = format!("e0008-matmul-{}x{}x{}", contract.m, contract.k, contract.n);
    let script = compiler_script();

    if !script.exists() {
        return Err(format!(
            "Core ML compiler script not found at {:?} — run preflight first",
            script,
        ));
    }

    let venv_python = find_venv_python();

    let output = Command::new(&venv_python)
        .arg(script.to_string_lossy().as_ref())
        .arg(&island_id)
        .arg(compute_units)
        .env("TRIBUNUS_COREML_MIL_SOURCE", &mil_source)
        .output()
        .map_err(|e| format!("Failed to spawn compiler: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Core ML compilation failed: {}", stderr));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let compiled_path = stdout
        .lines()
        .find(|l| l.starts_with("COMPILED:"))
        .map(|l| l.trim_start_matches("COMPILED: ").trim().to_string())
        .ok_or_else(|| "Compiler output missing COMPILED: line".to_string())?;

    // Compute compiled artifact hash from metadata.json
    let compiled_hash = compute_modelc_hash(&compiled_path);

    let compile_ns = start.elapsed().as_nanos() as u64;

    let dest_path = output_dir.join(format!("{}.modelc", island_id));
    // Copy to output directory if different
    if compiled_path != dest_path.to_string_lossy() {
        let _ = std::fs::create_dir_all(output_dir);
        let _ = copy_dir(&compiled_path, &dest_path);
    }

    Ok(CoreMlIslandReceipt {
        island_id,
        model_hash: source_hash,
        compiled_hash,
        compute_units: compute_units.to_string(),
        parity_passed: false, // validated separately
        compiled_modelc_path: dest_path.to_string_lossy().to_string(),
        tools_version: "coremltools-9.0".into(),
        compile_ns,
    })
}

/// Find the venv Python for Core ML compilation.
fn find_venv_python() -> String {
    // Check environment.json for the venv path
    let manifest_dir = std::env::var("CARGO_MANIFEST_DIR")
        .unwrap_or_else(|_| ".".into());
    let env_json = Path::new(&manifest_dir).join("environment.json");
    if env_json.exists() {
        if let Ok(contents) = std::fs::read_to_string(&env_json) {
            if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&contents) {
                if let Some(path) = parsed.get("coremltools_path").and_then(|v| v.as_str()) {
                    // Derive venv python from coremltools path:
                    // .../site-packages/coremltools/__init__.py
                    // → .../bin/python3
                    let p = Path::new(path);
                    if let Some(venv) = p.ancestors().find(|a| a.join("bin/python3").exists()) {
                        return venv.join("bin/python3").to_string_lossy().to_string();
                    }
                }
            }
        }
    }
    "python3".to_string() // fallback
}

/// Compute SHA-256 of the compiled .mlmodelc (from metadata.json).
fn compute_modelc_hash(path: &str) -> String {
    let metadata = Path::new(path).join("metadata.json");
    if let Ok(contents) = std::fs::read(&metadata) {
        format!("{:x}", Sha256::digest(&contents))
    } else {
        String::new()
    }
}

fn copy_dir(src: &str, dst: &Path) -> Result<(), String> {
    // Simple recursive copy for .mlmodelc directories
    let src = Path::new(src);
    if !src.is_dir() { return Ok(()); }
    let _ = std::fs::create_dir_all(dst);
    for entry in std::fs::read_dir(src).map_err(|e| format!("read_dir: {}", e))? {
        let entry = entry.map_err(|e| format!("entry: {}", e))?;
        let dest = dst.join(entry.file_name());
        if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            copy_dir(&entry.path().to_string_lossy(), &dest)?;
        } else {
            let _ = std::fs::copy(entry.path(), &dest);
        }
    }
    Ok(())
}

/// Emit a Core ML profile, validating constraints.
pub fn emit_coreml_profile(
    profile: CompileProfile,
    islands: &[CoreMlIslandReceipt],
) -> Result<(), String> {
    match profile {
        CompileProfile::HybridRequired if islands.is_empty() => {
            return Err("HybridRequired profile requires at least one Core ML island".into());
        }
        _ => {}
    }
    Ok(())
}
