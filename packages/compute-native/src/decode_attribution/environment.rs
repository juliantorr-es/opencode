use crate::toolchain_attest::ToolchainAttestation;
use std::process::Command;

/// Host identity recorded at benchmark startup.
#[derive(Debug, Clone)]
pub struct HostEnvironment {
    /// CPU brand string, e.g. "Apple M1" or "Intel(R) Core(TM) i9-..."
    pub host_chip: String,
    /// macOS version, e.g. "15.5"
    pub macos_version: String,
    /// Xcode build version, e.g. "17C100"
    pub xcode_build_version: String,
    /// coremlcompiler version string
    pub coremlcompiler_version: String,
}

/// Capture the current machine environment by probing sysctl, sw_vers,
/// and toolchain_attest. Returns an Err only if coremlcompiler is completely
/// unreachable (which is a hard failure for the benchmark).
pub fn capture_host_environment() -> Result<HostEnvironment, String> {
    // ── Host chip ─────────────────────────────────────────────────────────────
    // On arm64, `machdep.cpu.brand_string` is empty, so fall back to `hw.machine`
    // (returns "arm64"). For Intel the brand string has the full processor name.
    let host_chip = Command::new("sysctl")
        .args(["-n", "machdep.cpu.brand_string"])
        .output()
        .ok()
        .and_then(|o| {
            if o.status.success() {
                let s = String::from_utf8_lossy(&o.stdout).trim().to_string();
                if !s.is_empty() { return Some(s); }
            }
            None
        })
        .unwrap_or_else(|| {
            // arm64 fallback — "machdep.cpu.brand_string" is empty on Apple Silicon
            Command::new("sysctl")
                .args(["-n", "hw.machine"])
                .output()
                .ok()
                .and_then(|o| {
                    if o.status.success() {
                        let s = String::from_utf8_lossy(&o.stdout).trim().to_string();
                        if !s.is_empty() { return Some(s); }
                    }
                    None
                })
                .unwrap_or_else(|| "unknown".into())
        });

    // ── macOS version ─────────────────────────────────────────────────────────
    let macos_version = Command::new("sw_vers")
        .args(["-productVersion"])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_else(|_| "unknown".into());

    // ── Toolchain attestation (xcode build + coremlcompiler) ──────────────────
    // This is the hard gate: if coremlcompiler is unreachable the benchmark
    // cannot proceed.
    let attest = ToolchainAttestation::probe()?;

    Ok(HostEnvironment {
        host_chip,
        macos_version,
        xcode_build_version: attest.xcode_build_version,
        coremlcompiler_version: attest.coremlcompiler_version,
    })
}
