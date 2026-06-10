//! Toolchain attestation — Rust-native verification that xcrun, Xcode,
//! and coremlcompiler are present and compatible.
//!
//! Replaces the deleted `preflight.py` with Rust-native probing that
//! records developer directory, Xcode build, coremlcompiler identity,
//! target platform, invocation arguments, exit status, stdout/stderr
//! digests, and compilation duration.
//!
//! This attestation feeds into the compilation receipt so every
//! `.mlmodelc` artifact carries its toolchain provenance.

use sha2::{Digest, Sha256};
use std::process::Command;

/// Full toolchain identity recorded after a preflight probe or
/// after a compilation run.
#[derive(Debug, Clone)]
pub struct ToolchainAttestation {
    /// DEVELOPER_DIR or xcode-select -p output.
    pub developer_dir: String,
    /// Xcode build version string (e.g. "16F6").
    pub xcode_build_version: String,
    /// Resolved path to coremlcompiler (via xcrun -f).
    pub coremlcompiler_path: String,
    /// Version string from coremlcompiler --version.
    pub coremlcompiler_version: String,
    /// macOS version + arch, e.g. "macOS 15.4 arm64".
    pub target_platform: String,
    /// Invocation arguments (after xcrun).
    pub invocation_args: Vec<String>,
    /// Exit code from coremlcompiler.
    pub exit_status: i32,
    /// SHA-256 of captured stdout.
    pub stdout_sha256: String,
    /// SHA-256 of captured stderr.
    pub stderr_sha256: String,
    /// Wall-clock compilation duration in nanoseconds.
    pub compile_duration_ns: u64,
}

impl ToolchainAttestation {
    /// Probe the toolchain. Returns `Ok(Self)` if xcrun and
    /// coremlcompiler are present and working. Returns a human-readable
    /// `Err` if any prerequisite is missing.
    ///
    /// Record this at the start of a compilation session; the result
    /// feeds into every receipt.
    pub fn probe() -> Result<Self, String> {
        // --- xcode-select -p --------------------------------------------------
        let dev_dir = Command::new("xcrun")
            .args(["xcode-select", "-p"])
            .output()
            .map_err(|e| format!("xcrun missing: {e} — install Xcode"))?;
        if !dev_dir.status.success() {
            return Err("xcrun xcode-select -p failed — Xcode CLT not configured?".into());
        }
        let developer_dir = String::from_utf8_lossy(&dev_dir.stdout).trim().to_string();

        // --- Xcode build version ----------------------------------------------
        let xcode_build = Command::new("xcodebuild")
            .args(["-version"])
            .output()
            .map(|o| {
                let stdout = String::from_utf8_lossy(&o.stdout);
                // "Xcode 26.1\nBuild version 17C100\n" → "17C100"
                stdout
                    .lines()
                    .find(|l| l.starts_with("Build version "))
                    .map(|l| l.trim_start_matches("Build version ").to_string())
                    .unwrap_or_else(|| "unknown".into())
            })
            .unwrap_or_else(|_| "unknown".into());

        // --- coremlcompiler path ----------------------------------------------
        let cmc_path = Command::new("xcrun")
            .args(["-f", "coremlcompiler"])
            .output()
            .map_err(|e| format!("xcrun -f coremlcompiler failed: {e}"))?;
        let coremlcompiler_path =
            String::from_utf8_lossy(&cmc_path.stdout).trim().to_string();
        if coremlcompiler_path.is_empty() || !cmc_path.status.success() {
            return Err("coremlcompiler not found via xcrun -f".into());
        }

        // --- coremlcompiler version -------------------------------------------
        let cmc_ver = Command::new(&coremlcompiler_path)
            .args(["--version"])
            .output()
            .unwrap_or_else(|e| {
                Command::new("xcrun")
                    .args(["coremlcompiler", "--version"])
                    .output()
                    .unwrap_or_else(|_| {
                        panic!("cannot run coremlcompiler --version: {e}")
                    })
            });
        let coremlcompiler_version =
            String::from_utf8_lossy(&cmc_ver.stdout).trim().to_string();

        // --- target platform --------------------------------------------------
        let os_ver = Command::new("sw_vers")
            .args(["-productVersion"])
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .unwrap_or_else(|_| "unknown".into());
        let arch = std::env::consts::ARCH;
        let target_platform = format!("macOS {os_ver} {arch}");

        Ok(Self {
            developer_dir,
            xcode_build_version: xcode_build,
            coremlcompiler_path,
            coremlcompiler_version,
            target_platform,
            invocation_args: Vec::new(),
            exit_status: 0,
            stdout_sha256: String::new(),
            stderr_sha256: String::new(),
            compile_duration_ns: 0,
        })
    }

    /// Populate invocation-specific fields from a compilation run.
    pub fn with_compile_result(
        mut self,
        args: &[&str],
        output: &std::process::Output,
        duration_ns: u64,
    ) -> Self {
        self.invocation_args = args.iter().map(|s| s.to_string()).collect();
        self.exit_status = output.status.code().unwrap_or(-1);
        self.stdout_sha256 =
            format!("{:x}", Sha256::digest(&output.stdout));
        self.stderr_sha256 =
            format!("{:x}", Sha256::digest(&output.stderr));
        self.compile_duration_ns = duration_ns;
        self
    }
}
