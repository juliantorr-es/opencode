//! Core ML profile compilation pipeline — direct xcrun coremlcompiler
//! invocation from Rust, with pure-Rust MIL program construction.
//! No Python dependency.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::fs;
use sha2::{Sha256, Digest};
use coreml_proto::proto::mil_spec;

use crate::mil_builder::MilBuilder;
use crate::mlpackage::{self, ModelMeta};
use crate::toolchain_attest::ToolchainAttestation;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CompileProfile { MlXOnly, MlXPlusCoreMlOptional, HybridRequired }

/// Compilation receipt that binds source artifact identity,
/// compiled artifact identity, and toolchain provenance.
#[derive(Debug, Clone)]
pub struct CoreMlIslandReceipt {
    pub island_id: String,
    pub model_hash: String,
    pub compiled_hash: String,
    pub compute_units: String,
    pub parity_passed: bool,
    pub compiled_modelc_path: String,
    /// MIL opset used for this artifact (e.g. "CoreML9", "ios18").
    pub opset: String,
    /// Full toolchain identity — Xcode version, coremlcompiler path,
    /// target platform, invocation args, stdout/stderr digests.
    pub toolchain: ToolchainAttestation,
}

/// Compile a source .mlpackage directory via xcrun coremlcompiler.
/// Returns receipt with source/compiled hashes, compile duration, and
/// full toolchain attestation.
pub fn compile_mlpackage(
    mlpackage_path: &Path, output_dir: &Path, island_id: &str, compute_units: &str,
    opset: &str,
) -> Result<CoreMlIslandReceipt, String> {
    let start = std::time::Instant::now();
    if !mlpackage_path.is_dir() { return Err(format!("not found: {:?}", mlpackage_path)); }
    let model_hash = dir_sha256(mlpackage_path);
    let dest = output_dir.join(format!("{}.modelc", island_id));
    let _ = fs::create_dir_all(output_dir);

    let toolchain_base = ToolchainAttestation::probe()
        .map_err(|e| format!("toolchain not available: {e}"))?;

    let src_path = mlpackage_path.to_string_lossy().to_string();
    let dest_path = dest.to_string_lossy().to_string();
    let compile_args = ["compile", src_path.as_str(), dest_path.as_str()];

    let result = Command::new("xcrun")
        .arg("coremlcompiler")
        .args(&compile_args)
        .output().map_err(|e| format!("xcrun: {e}"))?;

    let compile_ns = start.elapsed().as_nanos() as u64;
    let toolchain = toolchain_base.with_compile_result(&compile_args, &result, compile_ns);

    if !result.status.success() {
        return Err(format!(
            "coremlcompiler failed: {}",
            String::from_utf8_lossy(&result.stderr)
        ));
    }

    let inner = find_model_dir(&dest).ok_or_else(|| format!("no metadata.json in {:?}", dest))?;
    let compiled_hash = file_sha256(&inner.join("metadata.json"));

    Ok(CoreMlIslandReceipt {
        island_id: island_id.to_string(),
        model_hash,
        compiled_hash,
        compute_units: compute_units.to_string(),
        parity_passed: false,
        compiled_modelc_path: inner.to_string_lossy().to_string(),
        opset: opset.to_string(),
        toolchain,
    })
}

fn find_model_dir(mlmodelc_path: &Path) -> Option<PathBuf> {
    fn walk(dir: &Path, depth: u32) -> Option<PathBuf> {
        if depth > 4 { return None; }
        if dir.join("metadata.json").exists() && dir.join("model.mil").exists() {
            return Some(dir.to_path_buf());
        }
        if let Ok(entries) = fs::read_dir(dir) {
            for e in entries.filter_map(|e| e.ok()) {
                if e.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                    if let Some(found) = walk(&e.path(), depth + 1) { return Some(found); }
                }
            }
        }
        None
    }
    walk(mlmodelc_path, 0)
}

fn file_sha256(path: &Path) -> String {
    fs::read(path).map(|d| format!("{:x}", Sha256::digest(&d))).unwrap_or_default()
}

fn dir_sha256(path: &Path) -> String {
    let mut h = Sha256::new();
    let mut entries: Vec<PathBuf> = Vec::new();
    if let Ok(read) = fs::read_dir(path) { for e in read.filter_map(|e| e.ok()) { entries.push(e.path()); } }
    entries.sort();
    for p in &entries {
        h.update(p.file_name().unwrap_or_default().to_string_lossy().as_bytes());
        if p.is_dir() { h.update(dir_sha256(p).as_bytes()); }
        else if let Ok(d) = fs::read(p) { h.update(&d); }
    }
    format!("{:x}", h.finalize())
}

pub fn emit_coreml_profile(profile: CompileProfile, islands: &[CoreMlIslandReceipt]) -> Result<(), String> {
    if matches!(profile, CompileProfile::HybridRequired) && islands.is_empty() {
        return Err("HybridRequired requires at least one island".into());
    }
    Ok(())
}

/// Build and compile a simple F32 matmul region.
///
/// Constructs the MIL program in pure Rust (no Python), writes the
/// `.mlpackage`, and compiles via `xcrun coremlcompiler`.
///
/// `weight_values` is interpreted as row-major f32 data with the given `weight_shape`.
pub fn build_matmul_region(
    input_name: &str,
    input_shape: &[i64],
    weight_name: &str,
    weight_values: &[f32],
    weight_shape: &[i64],
    output_dir: &Path,
    region_id: &str,
) -> Result<CoreMlIslandReceipt, String> {
    let prog = MilBuilder::new("main")
        .input(input_name, mil_spec::DataType::Float32, input_shape)
        .const_f32(weight_name, weight_values, weight_shape)
        .matmul(input_name, &format!("{}_0", weight_name))
        .output("matmul_1")  // const_f32(w) takes ssa 0, matmul gets 1
        .build()
        .expect("MIL builder error");

    let meta = ModelMeta {
        model_name: region_id.to_string(),
        function_name: "main".into(),
        inputs: vec![(input_name.to_string(), input_shape.to_vec())],
        outputs: vec![("matmul_1".to_string(), vec![input_shape[0], weight_shape[1]])],
        output_name: "matmul_1".into(),
        ..Default::default()
    };

    let tmp = tempfile::tempdir().map_err(|e| format!("tempdir: {}", e))?;
    let pkg_path = mlpackage::write_mlpackage(prog, tmp.path(), &meta)?;
    compile_mlpackage(&pkg_path, output_dir, region_id, "cpuAndGPU", "CoreML9")
}

/// Build, write, and compile a MIL program from a pre-built [`mil_spec::Program`].
pub fn build_and_compile(
    program: mil_spec::Program,
    meta: &ModelMeta,
    output_dir: &Path,
    region_id: &str,
    compute_units: &str,
) -> Result<CoreMlIslandReceipt, String> {
    let tmp = tempfile::tempdir().map_err(|e| format!("tempdir: {}", e))?;
    let pkg_path = mlpackage::write_mlpackage(program, tmp.path(), meta)?;
    compile_mlpackage(&pkg_path, output_dir, region_id, compute_units, "CoreML9")
}

#[cfg(test)]
mod tests {
    use super::*;
    use prost::Message;

    /// End-to-end Apple acceptance gate: build MIL program, write .mlpackage,
    /// compile via xcrun coremlcompiler, verify .mlmodelc exists.
    ///
    /// Skips if no Xcode toolchain is available.
    #[test]
    fn known_answer_f32_matmul_compiles() {
        let toolchain = match ToolchainAttestation::probe() {
            Ok(t) => t,
            Err(e) => {
                eprintln!("SKIP: toolchain not available: {e}");
                return;
            }
        };
        eprintln!(
            "compiler: {} ({})",
            toolchain.coremlcompiler_version,
            toolchain.xcode_build_version
        );

        let prog = MilBuilder::new("main")
            .input("x", mil_spec::DataType::Float32, &[1, 4])
            .const_f32("w", &[1.0_f32, 2.0, 3.0, 4.0], &[4, 1])
            .matmul("x", "w_0")
            .output("matmul_1")  // const_f32(w) takes ssa 0, matmul gets 1
            .build()
            .expect("MIL builder error");

        let meta = ModelMeta {
            model_name: "known-answer-matmul".into(),
            inputs: vec![("x".into(), vec![1, 4])],
            outputs: vec![("matmul_1".into(), vec![1, 1])],
            output_name: "matmul_1".into(),
            ..Default::default()
        };

        let tmp = tempfile::tempdir().expect("tempdir");
        let pkg_path =
            mlpackage::write_mlpackage(prog, tmp.path(), &meta).expect("write mlpackage");
        assert!(pkg_path.join("Manifest.json").exists());
        assert!(pkg_path.join("Data/com.apple.CoreML/model.mlmodel").exists());

        let receipt = compile_mlpackage(&pkg_path, tmp.path(), "known-answer", "cpuAndGPU", "CoreML9")
            .expect("coremlcompiler must accept .mlpackage");

        let modelc = Path::new(&receipt.compiled_modelc_path);
        assert!(modelc.is_dir(), "compiled modelc dir missing");
        assert!(modelc.join("metadata.json").exists());
        assert!(modelc.join("model.mil").exists());
        assert!(!receipt.compiled_hash.is_empty());
        assert!(!receipt.model_hash.is_empty());
        assert_eq!(receipt.island_id, "known-answer");
        assert_eq!(receipt.opset, "CoreML9");
        assert!(receipt.toolchain.compile_duration_ns > 0);
        assert_eq!(receipt.toolchain.exit_status, 0);

        eprintln!(
            "PASS: model_hash={} compiled_hash={} compile_ns={}",
            &receipt.model_hash[..16],
            &receipt.compiled_hash[..16],
            receipt.toolchain.compile_duration_ns
        );
    }

    /// Determinism: verifies that manifest JSON is byte-identical on repeated
    /// builds and that the protobuf decodes to the same logical content.
    ///
    /// Full byte-identical directory hashes are not yet guaranteed because
    /// prost-generated `HashMap` fields (e.g. `Operation.inputs`,
    /// `block_specializations`) have non-deterministic wire-format iteration.
    /// This is a known prost limitation — a future fix would use `IndexMap`
    /// or sorted encoding.
    #[test]
    fn deterministic_manifest_and_proto_roundtrip() {
        let build = || {
            let prog = MilBuilder::new("main")
                .input("a", mil_spec::DataType::Float32, &[2, 2])
                .input("b", mil_spec::DataType::Float32, &[2, 2])
                .add("a", "b")
                .mul("add_0", "add_0")
                .output("mul_1")
                .build()
                .expect("MIL builder error");
            let meta = ModelMeta {
                model_name: "det".into(),
                inputs: vec![("a".into(), vec![2, 2]), ("b".into(), vec![2, 2])],
                outputs: vec![("output".into(), vec![2, 2])],
                output_name: "output".into(),
                ..Default::default()
            };
            let tmp = tempfile::tempdir().expect("tempdir");
            let pkg_path =
                mlpackage::write_mlpackage(prog, tmp.path(), &meta).expect("write");

            // Manifest JSON must be byte-identical
            let manifest = fs::read(pkg_path.join("Manifest.json")).expect("read");
            let manifest_hash = format!("{:x}", Sha256::digest(&manifest));

            // Protobuf must decode to consistent logical structure
            let model_bytes =
                fs::read(pkg_path.join("Data/com.apple.CoreML/model.mlmodel")).expect("read");
            let model =
                coreml_proto::proto::Model::decode(model_bytes.as_slice()).expect("decode");
            assert_eq!(model.specification_version, 9);

            // Extract operation types in order (deterministic — stored as Vec)
            let ops: Vec<String> = match model.r#type {
                Some(coreml_proto::proto::model::Type::MlProgram(ref p)) => {
                    let f = p.functions.get("main").expect("main function");
                    let b = f.block_specializations.get(&f.opset).expect("block");
                    b.operations.iter().map(|o| o.r#type.clone()).collect()
                }
                _ => panic!("expected MlProgram"),
            };

            (manifest_hash, ops)
        };

        let (manifest_a, ops_a) = build();
        let (manifest_b, ops_b) = build();
        assert_eq!(manifest_a, manifest_b, "manifest JSON must be byte-identical");
        assert_eq!(ops_a, ops_b, "operation sequence must be deterministic");
        assert_eq!(ops_a, vec!["add", "mul"], "expected add then mul");
    }
}
