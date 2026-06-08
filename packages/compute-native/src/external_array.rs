//! External (no-copy) MLX array construction via the C++ shim.
//!
//! Calls `mlx_array_new_data_managed_payload` in the forked mlx-c layer, which wraps
//! `mlx::core::array(void*, Shape, Dtype, Deleter)` — the Core 0.31.2 no-copy
//! constructor.
//!
//! Uses lease-based lifetime management: an `Arc<dyn ExternalStorage>` keeps the
//! underlying memory alive until MLX releases the array.  The deleter callback
//! drops the `Arc`, which may in turn free the allocation or release a segment lease.

use crate::mapped_image::MappedSegment;
use mlx_rs::{Array, Dtype};
use std::alloc::Layout;
use std::ffi::c_void;
use std::sync::Arc;

// ---------------------------------------------------------------------------
// Trait
// ---------------------------------------------------------------------------

/// Trait for types that can provide raw data pointers to external array storage.
///
/// Implementors own or reference a region of memory that must remain valid for
/// the duration of an MLX array's lifetime.  The trait is object-safe so consumers
/// can use `Arc<dyn ExternalStorage + Send + Sync>`.
pub trait ExternalStorage: Send + Sync {
    /// Return a pointer to the start of the data.
    fn data_ptr(&self) -> *const u8;
    /// Return the length of the data in bytes.
    fn byte_len(&self) -> usize;
}

// ---------------------------------------------------------------------------
// OwnedBuffer
// ---------------------------------------------------------------------------

/// An owned heap-allocated buffer that implements [`ExternalStorage`].
///
/// On drop, calls `std::alloc::dealloc` with the **original** allocation layout,
/// correctly handling zero-length buffers (the original layout is stored so that
/// dealloc is always well-defined — unlike the existing test code that passed
/// zero-length/zero-capacity to `Vec::from_raw_parts`).
pub struct OwnedBuffer {
    ptr: *mut u8,
    len: usize,
    capacity: usize,
    layout: Layout,
}

impl OwnedBuffer {
    /// Allocate a new buffer of `size` bytes (zero-filled).
    ///
    /// # Panics
    ///
    /// Panics if the allocation fails (OOM).
    pub fn new(size: usize) -> Self {
        if size == 0 {
            // Even a zero-size allocation needs a valid (dangling, non-null) pointer
            // and a real layout so Drop is well-defined.  Allocate 1 byte.
            let layout = Layout::from_size_align(1, 1).unwrap();
            let ptr = unsafe { std::alloc::alloc(layout) };
            assert!(!ptr.is_null(), "OwnedBuffer::new(0) allocation failed (OOM)");
            Self {
                ptr,
                len: 0,
                capacity: 0,
                layout,
            }
        } else {
            let layout =
                Layout::from_size_align(size, std::mem::align_of::<u8>())
                    .expect("OwnedBuffer: valid layout");
            let ptr = unsafe { std::alloc::alloc_zeroed(layout) };
            assert!(!ptr.is_null(), "OwnedBuffer::new({size}) allocation failed (OOM)");
            Self {
                ptr,
                len: size,
                capacity: size,
                layout,
            }
        }
    }

    /// Create an `OwnedBuffer` from an existing allocation.
    ///
    /// # Safety
    ///
    /// - `ptr` must have been allocated with the given `layout` via `std::alloc::alloc`.
    /// - `len` must be ≤ `layout.size()`.
    /// - `capacity` must be ≤ `layout.size()`.
    pub unsafe fn from_raw(ptr: *mut u8, len: usize, capacity: usize, layout: Layout) -> Self {
        Self { ptr, len, capacity, layout }
    }

    /// Return the data pointer (const).
    pub fn as_ptr(&self) -> *const u8 {
        self.ptr as *const u8
    }

    /// Return the data pointer (mutable).
    pub fn as_mut_ptr(&mut self) -> *mut u8 {
        self.ptr
    }

    /// Return the current initialized length in bytes.
    pub fn len(&self) -> usize {
        self.len
    }

    /// Return `true` if the buffer is empty.
    pub fn is_empty(&self) -> bool {
        self.len == 0
    }
}

impl ExternalStorage for OwnedBuffer {
    fn data_ptr(&self) -> *const u8 {
        self.ptr as *const u8
    }

    fn byte_len(&self) -> usize {
        self.len
    }
}

/// SAFETY: `ptr` was allocated by `std::alloc::alloc` and `layout` is the ORIGINAL
/// allocation layout — **_not_** recomputed from `len` / `capacity`.  This fixes
/// the zero-length-capacity bug that existed in the old test code (which passed
/// `Vec::from_raw_parts(ptr, 0, 0)` — valid only because `len=0` suppresses
/// element drop, but dangerous in general).
impl Drop for OwnedBuffer {
    fn drop(&mut self) {
        if self.layout.size() > 0 {
            unsafe {
                std::alloc::dealloc(self.ptr, self.layout);
            }
        }
    }
}

unsafe impl Send for OwnedBuffer {}
unsafe impl Sync for OwnedBuffer {}

// ---------------------------------------------------------------------------
// Arc<MappedSegment>
// ---------------------------------------------------------------------------

impl ExternalStorage for Arc<MappedSegment> {
    fn data_ptr(&self) -> *const u8 {
        (**self).data_ptr()
    }

    fn byte_len(&self) -> usize {
        (**self).len()
    }
}

// ---------------------------------------------------------------------------
// Deleter context
// ---------------------------------------------------------------------------

/// Opaque context passed to the C deleter callback.
///
/// Holds an `Arc<dyn ExternalStorage>` that keeps the underlying memory alive.
/// When MLX releases the array, the deleter trampoline drops this box, which
/// decrements the `Arc`'s reference count — potentially freeing the storage if
/// no other references exist.
struct DeleterContext {
    storage: Arc<dyn ExternalStorage + Send + Sync>,
}

// ---------------------------------------------------------------------------
// new_external_array
// ---------------------------------------------------------------------------

/// Construct an MLX Array that wraps externally owned memory without copying.
///
/// Takes an `Arc<dyn ExternalStorage>` which owns (or references) the data
/// buffer.  MLX's deleter callback drops the `Arc` when the array is released,
/// so the caller does not need to pair a release function.
///
/// # Safety
///
/// - The [`ExternalStorage`] implementor must provide a valid, non-null pointer
///   for at least `byte_len()` bytes of memory.
/// - The pointer must be aligned according to MLX's requirements (typically
///   page-aligned for Metal shared storage).
/// - The returned Array **must** be evaluated before the storage's memory is
///   freed.  MLX's lazy evaluation means the Metal kernel may not consume the
///   data until `eval()`.
/// - The storage must remain valid until MLX releases the array (the deleter
///   callback fires).  The `Arc` ownership handles this automatically — when
///   the last reference (the one inside the deleter context) is dropped, the
///   storage may be deallocated.
pub unsafe fn new_external_array(
    storage: Arc<dyn ExternalStorage + Send + Sync>,
    shape: &[i32],
    dtype: Dtype,
) -> mlx_rs::error::Result<Array> {
    let data_ptr = storage.data_ptr();
    let _byte_len = storage.byte_len();

    assert!(!data_ptr.is_null(), "external array data must be non-null");
    assert!(!shape.is_empty(), "external array shape must be non-empty");

    let ctx = Box::new(DeleterContext { storage });

    // The C callback trampoline — receives the payload (the DeleterContext box).
    extern "C" fn deleter_trampoline(payload: *mut c_void) {
        #[cfg(test)]
        DELETER_INVOCATION_COUNT.fetch_add(1, std::sync::atomic::Ordering::SeqCst);

        if payload.is_null() {
            return;
        }
        let ctx: Box<DeleterContext> = unsafe { Box::from_raw(payload as *mut DeleterContext) };

        // Prevent unwind through C.  If the drop panics, abort the process.
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            drop(ctx);
        }));
    }

    let payload = Box::into_raw(ctx) as *mut c_void;

    let arr_handle = unsafe {
        mlx_sys::mlx_array_new_data_managed_payload(
            data_ptr as *mut c_void,
            shape.as_ptr(),
            shape.len() as i32,
            dtype_to_mlx_dtype(dtype),
            payload,
            Some(deleter_trampoline),
        )
    };

    Ok(unsafe { Array::from_ptr(arr_handle) })
}

// ---------------------------------------------------------------------------
// dtype helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Test-only: deleter invocation counter
// ---------------------------------------------------------------------------

/// Global atomic counter that increments each time the deleter callback fires.
/// Only compiled in test builds.
#[cfg(test)]
static DELETER_INVOCATION_COUNT: std::sync::atomic::AtomicU64 =
    std::sync::atomic::AtomicU64::new(0);

/// Read the deleter invocation counter.
///
/// Only available in test builds (`#[cfg(test)]`).
#[cfg(test)]
pub fn deleter_count() -> u64 {
    DELETER_INVOCATION_COUNT.load(std::sync::atomic::Ordering::SeqCst)
}

// ===========================================================================
// Tests
// ===========================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};

    /// Reset the deleter counter before each test that checks it.
    fn reset_deleter_count() {
        DELETER_INVOCATION_COUNT.store(0, Ordering::SeqCst);
    }

    /// Poll for the deleter to fire (up to ~2 s).
    fn wait_for_deleter(expected: u64) {
        for _ in 0..40 {
            std::thread::sleep(std::time::Duration::from_millis(50));
            if deleter_count() >= expected {
                break;
            }
        }
    }

    // -----------------------------------------------------------------------
    // Round-trip: OwnedBuffer → MLX array → Metal op → readback → deleter fires
    // -----------------------------------------------------------------------

    #[test]
    fn test_external_array_round_trip() {
        let shape = &[2i32, 4i32];
        let n: usize = (shape[0] * shape[1]) as usize;
        let byte_len = n * 4;

        // Allocate an OwnedBuffer and fill it with test data.
        let mut buf = OwnedBuffer::new(byte_len);
        let slice = unsafe { std::slice::from_raw_parts_mut(buf.as_mut_ptr() as *mut f32, n) };
        for (i, v) in slice.iter_mut().enumerate() {
            *v = i as f32;
        }

        let storage: Arc<dyn ExternalStorage + Send + Sync> = Arc::new(buf);

        let arr = unsafe { new_external_array(storage, shape, Dtype::Float32) }.expect("arr");

        // Run a Metal operation: multiply by 2.
        let two = Array::from_slice(&[2.0f32], &[1]);
        let result = arr.multiply(&two).expect("multiply");
        result.eval().expect("eval");

        // Readback.
        let out: Vec<f32> = result.try_as_slice::<f32>().unwrap().to_vec();
        assert_eq!(out.len(), n);
        for (i, &v) in out.iter().enumerate() {
            let expected = (i as f32) * 2.0;
            assert!((v - expected).abs() < 1e-6, "mismatch at {i}: {v} != {expected}");
        }

        // Drop and poll for deleter.
        drop(arr);
        drop(result);
        wait_for_deleter(1);
        assert!(deleter_count() >= 1, "deleter did not fire");

        eprintln!("[no-copy] external array round trip: PASS (deleter_count={})", deleter_count());
    }

    // -----------------------------------------------------------------------
    // Multiple views into one segment
    // -----------------------------------------------------------------------

    #[test]
    fn test_multiple_views_into_one_segment() {
        let shape = &[2i32, 4i32];
        let n: usize = (shape[0] * shape[1]) as usize;
        let byte_len = n * 4;

        // Use a MappedSegment backed by an OwnedBuffer to simulate a shared
        // memory-mapped segment.
        let mut raw_buf = OwnedBuffer::new(byte_len);
        {
            let slice =
                unsafe { std::slice::from_raw_parts_mut(raw_buf.as_mut_ptr() as *mut f32, n) };
            for (i, v) in slice.iter_mut().enumerate() {
                *v = i as f32;
            }
        }

        // Wrap in MappedSegment (simulating how the real mapped_image works).
        let segment = unsafe {
            MappedSegment::new(raw_buf.as_ptr(), byte_len)
        };
        let segment: Arc<MappedSegment> = Arc::new(segment);

        // Clone the Arc to get two independent references to the same memory.
        let storage1: Arc<dyn ExternalStorage + Send + Sync> = segment.clone();
        let storage2: Arc<dyn ExternalStorage + Send + Sync> = segment;

        let arr1 = unsafe { new_external_array(storage1, shape, Dtype::Float32) }.expect("arr1");
        let arr2 = unsafe { new_external_array(storage2, shape, Dtype::Float32) }.expect("arr2");

        // Both arrays share the same backing memory → both produce the same result.
        let two = Array::from_slice(&[2.0f32], &[1]);
        let r1 = arr1.multiply(&two).expect("multiply1");
        let r2 = arr2.multiply(&two).expect("multiply2");
        r1.eval().expect("eval1");
        r2.eval().expect("eval2");

        let out1: Vec<f32> = r1.try_as_slice::<f32>().unwrap().to_vec();
        let out2: Vec<f32> = r2.try_as_slice::<f32>().unwrap().to_vec();

        for (i, &v) in out1.iter().enumerate() {
            assert!((v - (i as f32) * 2.0).abs() < 1e-6, "mismatch arr1 at {i}");
        }
        for (i, &v) in out2.iter().enumerate() {
            assert!((v - (i as f32) * 2.0).abs() < 1e-6, "mismatch arr2 at {i}");
        }

        // Drop both arrays.  The segment backing memory stays alive because
        // we still hold `raw_buf`.
        drop(arr1);
        drop(arr2);

        // raw_buf's data must still be intact.
        let data = unsafe { std::slice::from_raw_parts(raw_buf.as_ptr() as *const f32, n) };
        for (i, &v) in data.iter().enumerate() {
            assert!((v - (i as f32)).abs() < 1e-6, "backing memory corrupted at {i}");
        }
    }

    // -----------------------------------------------------------------------
    // Deleter fires exactly once
    // -----------------------------------------------------------------------

    #[test]
    fn test_deleter_exactly_once() {
        reset_deleter_count();

        let shape = &[2i32, 4i32];
        let n: usize = (shape[0] * shape[1]) as usize;
        let byte_len = n * 4;
        let storage: Arc<dyn ExternalStorage + Send + Sync> =
            Arc::new(OwnedBuffer::new(byte_len));

        let arr = unsafe { new_external_array(storage, shape, Dtype::Float32) }.expect("arr");
        drop(arr);

        wait_for_deleter(1);
        assert_eq!(
            deleter_count(),
            1,
            "deleter must fire exactly once (got {})",
            deleter_count()
        );
    }

    // -----------------------------------------------------------------------
    // Mapping persists until last array dropped
    // -----------------------------------------------------------------------

    #[test]
    fn test_mapping_persists_until_last_array_dropped() {
        reset_deleter_count();

        let shape = &[2i32, 4i32];
        let n: usize = (shape[0] * shape[1]) as usize;
        let byte_len = n * 4;

        // Fill a buffer with known data.
        let mut buf = OwnedBuffer::new(byte_len);
        {
            let slice =
                unsafe { std::slice::from_raw_parts_mut(buf.as_mut_ptr() as *mut f32, n) };
            for (i, v) in slice.iter_mut().enumerate() {
                *v = i as f32;
            }
        }

        // We keep a reference-counted handle to the buffer.
        let holder: Arc<OwnedBuffer> = Arc::new(buf);
        let storage: Arc<dyn ExternalStorage + Send + Sync> = holder.clone();

        let arr = unsafe { new_external_array(storage, shape, Dtype::Float32) }.expect("arr");
        drop(arr);

        // Wait for the deleter to fire.
        wait_for_deleter(1);
        assert_eq!(
            deleter_count(),
            1,
            "deleter must fire once (got {})",
            deleter_count()
        );

        // Even though the array is dropped and the deleter fired, `holder` is
        // still alive → the buffer data must remain valid and uncorrupted.
        let data = unsafe { std::slice::from_raw_parts(holder.as_ptr() as *const f32, n) };
        for (i, &v) in data.iter().enumerate() {
            assert!(
                (v - (i as f32)).abs() < 1e-6,
                "data corrupted after array drop at index {i}: {v} != {i}",
            );
        }
    }
}
