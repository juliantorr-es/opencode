//! Core ML profile compilation pipeline — compilation of .mlpackage → .modelc,
//! profile validation, and receipt tracking for MLX/Core ML hybrid deployment.

use std::path::Path;

/// Deployment profile for Core ML integration.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CompileProfile {
    /// Pure MLX — no Core ML.
    MlXOnly,
    /// MLX with optional Core ML islands.
    MlXPlusCoreMlOptional,
    /// Hybrid execution requiring at least one Core ML island.
    HybridRequired,
}

/// Receipt for a compiled Core ML island.
#[derive(Debug, Clone)]
pub struct CoreMlIslandReceipt {
    /// Unique island identifier.
    pub island_id: String,
    /// SHA-256 hash of the source .mlpackage.
    pub model_hash: String,
    /// Compute units assigned (e.g. "all", "cpuAndNeuralEngine", "cpuAndGPU").
    pub compute_units: String,
    /// Whether parity checking passed against the MLX reference.
    pub parity_passed: bool,
    /// Path to the compiled .modelc bundle.
    pub compiled_modelc_path: String,
    /// Version of the compilation tools used.
    pub tools_version: String,
}

/// Compile a Core ML island from an .mlpackage to a .modelc bundle.
///
/// This is a stub: it logs the intent via `eprintln!` and returns a placeholder
/// receipt with `parity_passed = true` and an empty `model_hash`.
pub fn compile_coreml_island(
    input_mlpackage: &Path,
    output_dir: &Path,
    island_id: &str,
) -> napi::Result<CoreMlIslandReceipt> {
    let compiled_modelc_path = output_dir.join(format!("{island_id}.modelc"));

    eprintln!(
        "[coreml_pipeline] compile_coreml_island: island={island_id}, input={input_pkg:?}, output={output_modelc:?}",
        island_id = island_id,
        input_pkg = input_mlpackage,
        output_modelc = compiled_modelc_path,
    );

    Ok(CoreMlIslandReceipt {
        island_id: island_id.to_string(),
        model_hash: String::new(),
        compute_units: "all".to_string(),
        parity_passed: true,
        compiled_modelc_path: compiled_modelc_path.to_string_lossy().to_string(),
        tools_version: "0.1.0-stub".to_string(),
    })
}

/// Emit a Core ML profile, validating that the profile constraint is met.
///
/// - `HybridRequired` requires at least one island.
/// - `MlXOnly` accepts zero islands.
/// - `MlXPlusCoreMlOptional` accepts any count.
pub fn emit_coreml_profile(
    profile: CompileProfile,
    islands: &[CoreMlIslandReceipt],
) -> napi::Result<()> {
    match profile {
        CompileProfile::HybridRequired if islands.is_empty() => {
            return Err(napi::Error::from_reason(
                "HybridRequired profile requires at least one Core ML island".to_string(),
            ));
        }
        _ => {}
    }

    eprintln!(
        "[coreml_pipeline] emit_coreml_profile: profile={profile:?}, island_count={count}",
        profile = profile,
        count = islands.len(),
    );

    Ok(())
}
