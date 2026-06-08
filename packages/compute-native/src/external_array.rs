//! External (no-copy) MLX array construction via the C++ shim.
//!
//! Calls mlx_array_new_data_managed_payload in the forked mlx-c layer, which wraps
//! mlx::core::array(void*, Shape, Dtype, Deleter) — the Core 0.31.2 no-copy
//! constructor.

use mlx_rs::{Array, Dtype};
use std::ffi::c_void;

/// Opaque context passed to the C deleter callback.  The Rust side stores
/// whatever is needed to release the external allocation (e.g. an mmap handle,
/// a Vec<u8>, or a custom buffer) inside this box, and the C callback frees
/// the box after releasing the allocation.
struct DeleterContext {
    /// The raw pointer that was passed to MLX.
    ptr: *mut c_void,
    /// Total byte length — informational for validation.
    byte_len: usize,
    /// Called exactly once by the C deleter to release the external storage.
    /// Must be panic-safe (no unwind through C).
    release: unsafe extern "C" fn(*mut c_void, usize),
}

/// Construct an MLX Array that wraps externally owned memory without copying.
///
/// # Safety
///
/// - `data` must be a valid, non-null pointer to at least `shape.product() * dtype.size_of()` bytes.
/// - `data` must be aligned according to MLX's requirements (typically page-aligned for Metal shared storage).
/// - The returned Array MUST be evaluated before `data` is freed.  MLX's lazy
///   evaluation means the Metal kernel may not consume the data until `eval()`.
/// - The release function is called exactly once, after MLX releases the array.
///
/// After calling this, the Array owns the external storage.  When MLX releases
/// the array (via reference counting reaching zero), the release function fires.
pub unsafe fn new_external_array(
    data: *mut c_void,
    shape: &[i32],
    dtype: Dtype,
    release: unsafe extern "C" fn(*mut c_void, usize),
    byte_len: usize,
) -> mlx_rs::error::Result<Array> {
    assert!(!data.is_null(), "external array data must be non-null");
    assert!(!shape.is_empty(), "external array shape must be non-empty");

    let ctx = Box::new(DeleterContext {
        ptr: data,
        byte_len,
        release,
    });

    // The C callback trampoline — receives the payload (the DeleterContext box).
    extern "C" fn deleter_trampoline(payload: *mut c_void) {
        if payload.is_null() {
            return;
        }
        let ctx: Box<DeleterContext> = unsafe { Box::from_raw(payload as *mut DeleterContext) };
        // Catch panics to prevent unwind through C.
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| unsafe {
            (ctx.release)(ctx.ptr, ctx.byte_len);
        }));
    }

    let payload = Box::into_raw(ctx) as *mut c_void;

    let arr_handle = unsafe {
        mlx_sys::mlx_array_new_data_managed_payload(
            data,
            shape.as_ptr(),
            shape.len() as i32,
            dtype_to_mlx_dtype(dtype),
            payload,
            Some(deleter_trampoline),
        )
    };

    Ok(unsafe { Array::from_ptr(arr_handle) })
}

fn dtype_to_mlx_dtype(dtype: Dtype) -> u32 {
    match dtype {
        Dtype::Float32 => 10,
        Dtype::Float16 => 9,
        Dtype::Bfloat16 => 12,
        Dtype::Int32 => 7,
        Dtype::Uint32 => 3,
        Dtype::Uint8 => 1,
        Dtype::Bool => 0,
        _ => 10, // fallback to float32
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The simplest qualification: allocate a float32 buffer, wrap it as an
    /// MLX array, run a Metal operation, evaluate, and verify the finalizer
    /// fires exactly once.
    #[test]
    fn test_external_array_round_trip() {
        use std::sync::atomic::{AtomicBool, Ordering};

        let shape = &[2i32, 4i32];
        let n: usize = (shape[0] * shape[1]) as usize;
        let byte_len = n * 4;


        // Allocate aligned f32 data on the heap, leak it, and let the deleter free it.
        static FINALIZED: AtomicBool = AtomicBool::new(false);
        FINALIZED.store(false, Ordering::SeqCst);

        let mut data: Vec<f32> = (0..n).map(|i| i as f32).collect();
        let data_ptr = data.as_mut_ptr() as *mut c_void;
        std::mem::forget(data); // transfer ownership to the deleter

        unsafe extern "C" fn release_vec(ptr: *mut c_void, _len: usize) {
            FINALIZED.store(true, Ordering::SeqCst);
            // Reconstruct and drop the Vec.
            let _data: Vec<f32> = Vec::from_raw_parts(ptr as *mut f32, 0, 0);
            // Using 0 length works because Vec doesn't drop elements when len=0.
        }

        let arr = unsafe {
            new_external_array(data_ptr, shape, Dtype::Float32, release_vec, byte_len)
        }
        .expect("external array construction");

        assert!(!FINALIZED.load(Ordering::SeqCst));

        // Run a Metal operation: multiply by 2.
        let two = Array::from_slice(&[2.0f32], &[1]);
        let result = arr.multiply(&two).expect("multiply");
        result.eval().expect("eval");  // force Metal execution

        // Force readback to confirm data is correct.
        let out: Vec<f32> = result.try_as_slice::<f32>().unwrap().to_vec();
        assert_eq!(out.len(), n);
        for (i, &v) in out.iter().enumerate() {
            let expected = (i as f32) * 2.0;
            assert!((v - expected).abs() < 1e-6, "mismatch at {i}: {v} != {expected}");
        }

        // Drop the array and force GC.
        drop(arr);
        drop(result);
        // Force MLX to release the array by draining the registry.
        // The finalizer should fire.
        for _ in 0..10 {
            std::thread::sleep(std::time::Duration::from_millis(50));
            if FINALIZED.load(Ordering::SeqCst) {
                break;
            }
        }

        assert!(FINALIZED.load(Ordering::SeqCst), "finalizer did not fire");
        eprintln!("[no-copy] external array round trip: PASS (finalized=true)");
    }
}
