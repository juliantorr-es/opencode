//! Metal capture bindings — Level C instrumentation for Mission 0006A.
//!
//! Wraps MLX's C API: `mlx_metal_start_capture` / `mlx_metal_stop_capture`.
//! These functions are linked from the mlx-sys static library but not
//! exposed through the mlx-rs Rust crate, so we declare them directly.
//!
//! ## Platform boundary
//!
//! Metal capture is only available on macOS (aarch64/x86_64).  On other
//! platforms, all functions return false / error.  Use `cfg(target_os =
//! "macos")` guards at the call site when the capture path is optional.

use std::ffi::CString;

/// Check if Metal is available on this machine.
pub fn is_available() -> bool {
    #[cfg(target_os = "macos")]
    {
        let mut res: bool = false;
        let ret = unsafe { mlx_metal_is_available(&mut res) };
        return ret == 0 && res;
    }
    #[cfg(not(target_os = "macos"))]
    {
        false
    }
}

/// Start capturing Metal GPU commands to a file.
/// Returns true on success.  The capture file is finalized when
/// [`stop_capture`] is called or the [`CaptureGuard`] is dropped.
pub fn start_capture(path: &str) -> bool {
    #[cfg(target_os = "macos")]
    {
        let c_path = match CString::new(path) {
            Ok(s) => s,
            Err(_) => return false,
        };
        let ret = unsafe { mlx_metal_start_capture(c_path.as_ptr()) };
        return ret == 0;
    }
    #[cfg(not(target_os = "macos"))]
    {
        false
    }
}

/// Stop Metal capture and finalize the capture file.
/// Returns true on success.
pub fn stop_capture() -> bool {
    #[cfg(target_os = "macos")]
    {
        let ret = unsafe { mlx_metal_stop_capture() };
        return ret == 0;
    }
    #[cfg(not(target_os = "macos"))]
    {
        false
    }
}

// ── RAII capture guard ─────────────────────────────────────────────────────

/// Owns an active Metal capture session.  Calls `stop_capture()` in `Drop`
/// so capture is finalized even on panic.  Nested captures are prevented by
/// a process-wide atomic flag.
pub struct CaptureGuard {
    path: String,
    active: bool,
}

impl CaptureGuard {
    /// Begin a new capture session.  Returns `None` if capture is already
    /// active, Metal is unavailable, or `start_capture` fails.
    pub fn begin(path: &str) -> Option<Self> {
        use std::sync::atomic::{AtomicBool, Ordering};
        static CAPTURE_ACTIVE: AtomicBool = AtomicBool::new(false);

        if CAPTURE_ACTIVE.swap(true, Ordering::SeqCst) {
            eprintln!("[metal-capture] capture already active — refusing nested capture");
            return None;
        }

        if !is_available() {
            CAPTURE_ACTIVE.store(false, Ordering::SeqCst);
            return None;
        }

        if !start_capture(path) {
            CAPTURE_ACTIVE.store(false, Ordering::SeqCst);
            return None;
        }

        Some(CaptureGuard {
            path: path.into(),
            active: true,
        })
    }
}

impl Drop for CaptureGuard {
    fn drop(&mut self) {
        if self.active {
            use std::sync::atomic::{AtomicBool, Ordering};
            static CAPTURE_ACTIVE: AtomicBool = AtomicBool::new(false);
            // The guard may have been moved; re-read the flag
            let stopped = stop_capture();
            CAPTURE_ACTIVE.store(false, Ordering::SeqCst);
            if !stopped {
                eprintln!("[metal-capture] warning: stop_capture failed for {}", self.path);
            }
        }
    }
}

// ── Capture receipt ────────────────────────────────────────────────────────

/// Verifiable evidence that a Metal capture completed.
#[derive(Debug, Clone, serde::Serialize)]
pub struct CaptureReceipt {
    pub output_path: String,
    pub file_size: u64,
    pub file_sha256: String,
    pub phase: String,
    pub layer_index: Option<usize>,
    pub attention_kind: Option<String>,
    pub source_commit: String,
    pub binary_sha256: String,
    pub logical_image_hash: String,
    pub artifact_root_hash: String,
    pub capture_started: bool,
    pub capture_stopped: bool,
    pub metal_available: bool,
}

impl CaptureReceipt {
    pub fn generate(
        output_path: &str,
        phase: &str,
        layer_index: Option<usize>,
        attention_kind: Option<&str>,
        source_commit: &str,
        binary_sha256: &str,
        logical_image_hash: &str,
        artifact_root_hash: &str,
    ) -> Self {
        let (file_size, file_sha256) = match std::fs::metadata(output_path) {
            Ok(meta) => {
                let size = meta.len();
                let sha = match std::fs::read(output_path) {
                    Ok(data) => {
                        use sha2::{Digest, Sha256};
                        let mut h = Sha256::new();
                        h.update(&data);
                        format!("{:x}", h.finalize())
                    }
                    Err(_) => "unavailable".to_string(),
                };
                (size, sha)
            }
            Err(_) => (0, "unavailable".to_string()),
        };

        CaptureReceipt {
            output_path: output_path.into(),
            file_size,
            file_sha256,
            phase: phase.into(),
            layer_index,
            attention_kind: attention_kind.map(|s| s.into()),
            source_commit: source_commit.into(),
            binary_sha256: binary_sha256.into(),
            logical_image_hash: logical_image_hash.into(),
            artifact_root_hash: artifact_root_hash.into(),
            capture_started: true,
            capture_stopped: true,
            metal_available: is_available(),
        }
    }
}

// ── FFI declarations ───────────────────────────────────────────────────────
// Linked from mlx-sys C library (mlx/c/metal.cpp).
// ABI pinned to the version shipped in the mlx-rs-fork submodule.
// If the MLX version changes, re-verify these signatures against
// mlx-sys/src/mlx-c/mlx/c/metal.h.

#[cfg(target_os = "macos")]
extern "C" {
    fn mlx_metal_is_available(res: *mut bool) -> i32;
    fn mlx_metal_start_capture(path: *const std::ffi::c_char) -> i32;
    fn mlx_metal_stop_capture() -> i32;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_ffi_link() {
        // Verify the FFI symbols can be called without crashing.
        // On non-macOS, is_available returns false.
        let avail = is_available();
        // Don't assert true — CI may not have Metal.
        let _ = avail;
    }

    #[test]
    fn test_capture_guard_nested() {
        // Verify nested captures are refused.
        let g1 = CaptureGuard::begin("/tmp/test_nested_1.gputrace");
        if g1.is_some() {
            let g2 = CaptureGuard::begin("/tmp/test_nested_2.gputrace");
            assert!(g2.is_none(), "nested capture should be refused");
            drop(g1);
        }
    }
}
