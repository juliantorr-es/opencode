//! Core ML profile compilation pipeline — direct xcrun coremlcompiler
//! invocation from Rust.  No Python dependency.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::fs;
use sha2::{Sha256, Digest};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CompileProfile { MlXOnly, MlXPlusCoreMlOptional, HybridRequired }

#[derive(Debug, Clone)]
pub struct CoreMlIslandReceipt {
    pub island_id: String, pub model_hash: String, pub compiled_hash: String,
    pub compute_units: String, pub parity_passed: bool,
    pub compiled_modelc_path: String, pub tools_version: String, pub compile_ns: u64,
}

/// Compile a source .mlpackage directory via xcrun coremlcompiler.
/// Returns receipt with source/compiled hashes and compile duration.
pub fn compile_mlpackage(
    mlpackage_path: &Path, output_dir: &Path, island_id: &str, compute_units: &str,
) -> Result<CoreMlIslandReceipt, String> {
    let start = std::time::Instant::now();
    if !mlpackage_path.is_dir() { return Err(format!("not found: {:?}", mlpackage_path)); }
    let model_hash = dir_sha256(mlpackage_path);
    let dest = output_dir.join(format!("{}.modelc", island_id));
    let _ = fs::create_dir_all(output_dir);
    let result = Command::new("xcrun")
        .args(["coremlcompiler", "compile", &mlpackage_path.to_string_lossy(), &dest.to_string_lossy()])
        .output().map_err(|e| format!("xcrun: {}", e))?;
    if !result.status.success() {
        return Err(format!("coremlcompiler failed: {}", String::from_utf8_lossy(&result.stderr)));
    }
    let inner = find_model_dir(&dest).ok_or_else(|| format!("no metadata.json in {:?}", dest))?;
    let compiled_hash = file_sha256(&inner.join("metadata.json"));
    let compile_ns = start.elapsed().as_nanos() as u64;
    Ok(CoreMlIslandReceipt {
        island_id: island_id.to_string(), model_hash, compiled_hash,
        compute_units: compute_units.to_string(), parity_passed: false,
        compiled_modelc_path: inner.to_string_lossy().to_string(),
        tools_version: "xcrun-coremlcompiler-system".into(), compile_ns,
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
