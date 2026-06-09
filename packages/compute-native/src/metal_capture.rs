//! Metal capture bindings — Level C instrumentation for Mission 0006A.
//!
//! Wraps MLX's C API: `mlx_metal_start_capture` / `mlx_metal_stop_capture`.
//! These functions are linked from the mlx-sys static library but not
//! exposed through the mlx-rs Rust crate, so we declare them directly.

use std::ffi::CString;

/// Start capturing Metal GPU commands to a file.
/// The capture includes all Metal operations submitted after this call.
/// Returns true on success.
pub fn start_capture(path: &str) -> bool {
    let c_path = match CString::new(path) {
        Ok(s) => s,
        Err(_) => return false,
    };
    let ret = unsafe { mlx_metal_start_capture(c_path.as_ptr()) };
    ret == 0
}

/// Stop Metal capture and finalize the capture file.
/// Returns true on success.
pub fn stop_capture() -> bool {
    let ret = unsafe { mlx_metal_stop_capture() };
    ret == 0
}

/// Check if Metal is available on this machine.
pub fn is_available() -> bool {
    let mut res: bool = false;
    let ret = unsafe { mlx_metal_is_available(&mut res) };
    ret == 0 && res
}

// FFI declarations — linked from mlx-sys C library
extern "C" {
    fn mlx_metal_is_available(res: *mut bool) -> i32;
    fn mlx_metal_start_capture(path: *const std::ffi::c_char) -> i32;
    fn mlx_metal_stop_capture() -> i32;
}
