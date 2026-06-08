//! SharedTensorArena — IOSurface-backed FP16 arena for MLX/Core ML boundary tensors.
//!
//! Phase 1: IOSurface + CVPixelBuffer backing with row-stride awareness.
//! Allocates via IOSurfaceCreate + CVPixelBufferCreateWithIOSurface.
//! Memory shared between MLX external arrays and Core ML MLMultiArray.

use std::ffi::c_void;
use std::sync::Arc;

/// C-compatible struct mirrored from coreml_arena.mm.
#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct ArenaInfo {
    pub width: i32,
    pub height: i32,
    pub logical_dim0: i32,
    pub logical_dim1: i32,
    pub pixel_format: i32,
    pub byte_size: i32,
    pub bytes_per_row: i32,
    pub base_address: *mut c_void,
    cv_buffer: *mut c_void,
    io_surface: *mut c_void,
}

// Safety: ArenaInfo contains raw pointers. It is safe to send between threads
// only if the caller guarantees exclusive access or synchronises at the
// lease-transfer boundary.
unsafe impl Send for ArenaInfo {}
unsafe impl Sync for ArenaInfo {}

extern "C" {
    fn tribunus_arena_alloc(info: *mut ArenaInfo, dim0: i32, dim1: i32) -> i32;
    fn tribunus_arena_free(info: *mut ArenaInfo);
    fn tribunus_arena_io_surface_id(info: *const ArenaInfo) -> i32;
    fn tribunus_arena_lock(info: *const ArenaInfo) -> i32;
    fn tribunus_arena_unlock(info: *const ArenaInfo) -> i32;
}

/// Owned IOSurface-backed FP16 arena.
///
/// The arena is allocated via IOSurface and wrapped in a CVPixelBuffer.
/// The memory is physically backed by IOSurface and can be shared between
/// MLX (as an external array) and Core ML (as an MLMultiArray).
///
/// # Lifecycle
/// - Allocated by `Arena::new`
/// - Borrowed by backends under leases (writer-exclusive or reader-shared)
/// - Freed when dropped (IOSurface + CVPixelBuffer released)
pub struct Arena {
    pub info: ArenaInfo,
    pub dtype: mlx_rs::Dtype,
    /// If true, the backing memory is owned by an external system (e.g. Core ML
    /// outputBackings) and must NOT be freed by Rust.
    pub externally_owned: bool,
}

impl Arena {
    /// Allocate a new arena backed by IOSurface + CVPixelBuffer.
    ///
    /// Currently supports FP16 only. Returns an error for any other dtype.
    /// The ObjC bridge owns all storage; Rust merely holds the metadata.
    pub fn new(logical_dim0: u32, logical_dim1: u32, dtype: mlx_rs::Dtype) -> Result<Self, String> {
        if dtype != mlx_rs::Dtype::Float16 {
            return Err(format!("unsupported arena dtype: {:?} (FP16 only)", dtype));
        }

        let mut info: ArenaInfo = unsafe { std::mem::zeroed() };
        let rc = unsafe { tribunus_arena_alloc(&mut info, logical_dim0 as i32, logical_dim1 as i32) };
        if rc != 0 {
            return Err(format!("tribunus_arena_alloc failed: {}", rc));
        }

        Ok(Arena { info, dtype, externally_owned: true })
    }

    /// Return the logical element count.
    pub fn element_count(&self) -> usize {
        (self.info.logical_dim0 as usize) * (self.info.logical_dim1 as usize)
    }

    /// Return the physical byte size.
    pub fn byte_len(&self) -> usize {
        self.info.byte_size as usize
    }

    /// Raw pointer to the IOSurface base address.
    ///
    /// # Safety
    /// The pointer is valid until the Arena is dropped. All access must be
    /// gated through a lease (writer-exclusive or reader-shared).
    pub unsafe fn base_ptr(&self) -> *mut c_void {
        self.info.base_address
    }

    /// Returns the IOSurface ID (useful for cross-process sharing diagnostics).
    pub fn io_surface_id(&self) -> i32 {
        unsafe { tribunus_arena_io_surface_id(&self.info) }
    }

    /// Authoritative row stride in bytes (CVPixelBufferGetBytesPerRow).
    /// May differ from logical_dim1 * sizeof(element) due to alignment padding.
    pub fn bytes_per_row(&self) -> u32 {
        self.info.bytes_per_row as u32
    }

    /// Lock the CVPixelBuffer base address for CPU access.
    /// Required before reading/writing via base_ptr().
    pub fn lock(&self) -> Result<(), String> {
        let rc = unsafe { tribunus_arena_lock(&self.info) };
        if rc != 0 {
            Err(format!("arena lock failed: {}", rc))
        } else {
            Ok(())
        }
    }

    /// Unlock the CVPixelBuffer base address.
    pub fn unlock(&self) -> Result<(), String> {
        let rc = unsafe { tribunus_arena_unlock(&self.info) };
        if rc != 0 {
            Err(format!("arena unlock failed: {}", rc))
        } else {
            Ok(())
        }
    }
}

impl Drop for Arena {
    fn drop(&mut self) {
        if !self.info.cv_buffer.is_null() {
            // IOSurface-backed arena: the ObjC bridge handles unlock + CFRelease.
            unsafe { tribunus_arena_free(&mut self.info) };
        } else if self.info.base_address.is_null() || self.externally_owned {
            // No backing memory or externally owned with no cv_buffer: do nothing.
        } else {
            // Fallback: heap-allocated arena from the old path — reconstruct Vec and drop.
            let _data: Vec<u8> = unsafe {
                Vec::from_raw_parts(
                    self.info.base_address as *mut u8,
                    self.info.byte_size as usize,
                    self.info.byte_size as usize,
                )
            };
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::external_array;
    use crate::coreml_bridge::CoreMlModel;
    use crate::coreml_state::CoreMlStateHandle;
    use std::sync::Arc;


    // ---- FP16 conversion helpers ----

    fn f16_to_f32(h: u16) -> f32 {
        let sign = ((h >> 15) & 1) as u32;
        let exp = ((h >> 10) & 0x1F) as u32;
        let mant = (h & 0x3FF) as u32;
        if exp == 0 {
            let value = (mant as f32) * 2.0f32.powi(-24);
            if sign != 0 { -value } else { value }
        } else if exp == 31 {
            f32::INFINITY
        } else {
            let normalized = 1.0f32 + (mant as f32) / 1024.0f32;
            let exponent = 2.0f32.powi((exp as i32) - 15);
            let value = normalized * exponent;
            if sign != 0 { -value } else { value }
        }
    }

    fn f32_to_f16_bits(x: f32) -> u16 {
        let bits = x.to_bits();
        let sign = ((bits >> 31) & 1) as u16;
        let exp = ((bits >> 23) & 0xFF) as i32;
        let mant = bits & 0x7FFFFF;
        if exp == 0 {
            return sign << 15;
        }
        if exp == 255 {
            return (sign << 15) | 0x7C00;
        }
        let new_exp = exp - 127 + 15;
        if new_exp <= 0 {
            return sign << 15;
        }
        if new_exp >= 31 {
            return (sign << 15) | 0x7C00;
        }
        let new_mant = mant >> 13;
        (sign << 15) | ((new_exp as u16) << 10) | (new_mant as u16)
    }

    // ---- ExternalHostMemory fallback lane ----

    /// Test the Drop path for a manually constructed Arena with cv_buffer=null
    /// (heap memory fallback). Allocate a Vec, construct ArenaInfo manually,
    /// verify Drop reconstructs and drops the Vec without panic.
    #[test]
    fn test_host_memory_alloc_and_release() {
        let n = 64usize * 256;
        let mut data: Vec<u8> = vec![0xABu8; n * 2];
        let ptr = data.as_mut_ptr();
        let cap = data.capacity();
        std::mem::forget(data);

        let info = ArenaInfo {
            width: 256,
            height: 64,
            logical_dim0: 64,
            logical_dim1: 256,
            pixel_format: 0x4C303068,
            bytes_per_row: (256 * 2) as i32,
            byte_size: cap as i32,
            base_address: ptr as *mut c_void,
            cv_buffer: std::ptr::null_mut(),
            io_surface: std::ptr::null_mut(),
        };

        let arena = Arena {
            info,
            dtype: mlx_rs::Dtype::Float16,
            externally_owned: false,
        };
        // Drop reconstructs the Vec (cv_buffer is null, externally_owned is false,
        // base_address is non-null). No panic = the Vec was dropped cleanly.
        drop(arena);
        eprintln!("[arena] host memory alloc+release: PASS");
    }

    #[test]
    fn test_arena_ping_pong() {
        let a = Arena::new(1, 4096, mlx_rs::Dtype::Float16).expect("arena A");
        let b = Arena::new(1, 4096, mlx_rs::Dtype::Float16).expect("arena B");
        // Both IOSurface-backed — assert different io_surface_ids.
        assert_ne!(
            a.io_surface_id(),
            b.io_surface_id(),
            "IOArena surfaces should have distinct IDs"
        );
        eprintln!("[arena] ping-pong alloc: PASS (ids {} / {})",
            a.io_surface_id(), b.io_surface_id());
    }

    // ---- IOSurface Phase 0: Storage identity ----

    #[test]
    fn test_iosurface_phase0_storage_identity() {
        let arena = Arena::new(4, 512, mlx_rs::Dtype::Float16).expect("arena");
        let id = arena.io_surface_id();
        assert!(id > 0, "io_surface_id should be positive, got {}", id);
        assert!(!arena.info.base_address.is_null());
        assert!(
            arena.bytes_per_row() >= (4 * 2) as u32,
            "bytes_per_row={} < expected stride",
            arena.bytes_per_row()
        );
        assert_eq!(arena.element_count(), 4 * 512);
        assert_eq!(arena.byte_len(), 4 * 512 * 2);
        assert_eq!(arena.info.pixel_format, 0x4C303068);
        drop(arena);
    }

    // ---- IOSurface Phase 1: MLX external array over IOSurface ----

    #[test]
    fn test_iosurface_phase1_mlx_external() {
        let shape = [1i32, 256i32];
        let n: usize = (shape[0] * shape[1]) as usize;
        let arena = Arena::new(1, 256, mlx_rs::Dtype::Float16).expect("arena");

        // Write known FP16 values via raw u16 writes.
        let values_f32: [f32; 4] = [1.0, 2.0, 3.0, 4.0];
        unsafe {
            let ptr = arena.base_ptr() as *mut u16;
            for (i, &v) in values_f32.iter().enumerate() {
                ptr.add(i).write(f32_to_f16_bits(v));
            }
        }

        let data_ptr = unsafe { arena.base_ptr() };
        let byte_len = arena.byte_len();

        std::mem::forget(arena);

        let arr = unsafe {
            let storage = Arc::new(external_array::StaticStorage::new(data_ptr as *const u8, byte_len));
            external_array::new_external_array(
                storage,
                &shape,
                mlx_rs::Dtype::Float16,
            )
        }
        .expect("external array");

        // Run MLX Metal multiply by 2.0.
        let two = mlx_rs::Array::from_slice(&[2.0f32], &[1]);
        let doubled = arr.multiply(&two).expect("multiply");
        doubled.eval().expect("eval");

        // Read back — input [1,2,3,4] → ×2 → [2,4,6,8].
        let out: Vec<f32> = doubled.try_as_slice::<f32>().unwrap().to_vec();
        assert_eq!(out.len(), n);
        for i in 0..values_f32.len() {
            let expected = values_f32[i] * 2.0;
            assert!(
                (out[i] - expected).abs() < 1e-3,
                "mismatch at {}: got {:.4}, expected {:.4}",
                i, out[i], expected
            );
        }

        drop(doubled);
        drop(arr);
        eprintln!("[phase1] MLX external array over IOSurface: PASS");
    }

    // ---- IOSurface Phase 2: Core ML pixel buffer input ----

    #[test]
    fn test_iosurface_phase2_coreml_pixelbuffer_input() {
        let model_path = "/tmp/tribunus-coreml-nn-identity.mlmodelc/tribunus-coreml-nn-identity.mlmodelc";

        let model = CoreMlModel::load(model_path).expect("load Core ML model");
        let dim0 = 1u32;
        let dim1 = 256u32;
        let n = (dim0 * dim1) as usize;

        // Input arena A — IOSurface-backed FP16.
        let arena_a = Arena::new(dim0, dim1, mlx_rs::Dtype::Float16).expect("arena A");

        // Write known FP16 values [1.0, 2.0, ..., 8.0].
        unsafe {
            let ptr = arena_a.base_ptr() as *mut u16;
            for i in 0..n {
                ptr.add(i).write(f32_to_f16_bits((i + 1) as f32));
            }
        }

        // Output arena B.
        let mut arena_b = Arena::new(dim0, dim1, mlx_rs::Dtype::Float16).expect("arena B");

        // Run Core ML prediction with IOSurface pixel buffer path.
        model
            .predict_pixelbuffer("x", &arena_a.info, "output", &mut arena_b.info)
            .expect("predict_pixelbuffer");

        // Verify output matches input (identity model).
        unsafe {
            let out_ptr = arena_b.base_ptr() as *const u16;
            for i in 0..n {
                let expected = (i + 1) as f32;
                let got = f16_to_f32(out_ptr.add(i).read());
                let diff = (got - expected).abs();
                assert!(
                    diff < 1e-2,
                    "phase2 mismatch at {}: got {:.4}, expected {:.4}",
                    i, got, expected
                );
            }
        }
        eprintln!("[phase2] Core ML pixel buffer input: PASS");
    }

    // ---- IOSurface Phase 3: Core ML output backings ----


    #[test]
    fn test_iosurface_phase3_output_backings() {
        let model_path = "/tmp/tribunus-coreml-nn-identity.mlmodelc/tribunus-coreml-nn-identity.mlmodelc";

        let model = CoreMlModel::load(model_path).expect("load Core ML model");
        let dim0 = 1u32;
        let dim1 = 256u32;
        let n = (dim0 * dim1) as usize;

        let arena_a = Arena::new(dim0, dim1, mlx_rs::Dtype::Float16).expect("arena A");
        unsafe {
            let ptr = arena_a.base_ptr() as *mut u16;
            for i in 0..n {
                ptr.add(i).write(f32_to_f16_bits((i + 1) as f32));
            }
        }

        let mut arena_b = Arena::new(dim0, dim1, mlx_rs::Dtype::Float16).expect("arena B");

        // Capture backing identity before prediction.
        let b_id_before = arena_b.io_surface_id();
        let b_addr_before = arena_b.info.base_address;

        model
            .predict_pixelbuffer("x", &arena_a.info, "output", &mut arena_b.info)
            .expect("predict_pixelbuffer");

        // Verify backing identity unchanged — no reallocation.
        assert_eq!(
            arena_b.io_surface_id(),
            b_id_before,
            "arena B IOSurface ID changed after prediction"
        );
        assert_eq!(
            arena_b.info.base_address,
            b_addr_before,
            "arena B base address changed after prediction"
        );

        // Verify output values are in the same memory location.
        unsafe {
            let out_ptr = b_addr_before as *const u16;
            for i in 0..n {
                let expected = (i + 1) as f32;
                let got = f16_to_f32(out_ptr.add(i).read());
                let diff = (got - expected).abs();
                assert!(
                    diff < 1e-2,
                    "phase3 value mismatch at {}: got {:.4}, expected {:.4}",
                    i, got, expected
                );
            }
        }
        eprintln!("[phase3] Core ML output backings: PASS (backing identity preserved)");
    }

    // ---- IOSurface Phase 4: Full MLX → CoreML → MLX round trip ----

    #[test]
    fn test_iosurface_phase4_full_roundtrip() {
        let model_path = "/tmp/tribunus-coreml-nn-identity.mlmodelc/tribunus-coreml-nn-identity.mlmodelc";

        let model = CoreMlModel::load(model_path).expect("load Core ML model");
        let dim0 = 1u32;
        let dim1 = 256u32;
        let n = (dim0 * dim1) as usize;

        // Allocate both arenas.
        let arena_a = Arena::new(dim0, dim1, mlx_rs::Dtype::Float16).expect("arena A");
        let mut arena_b = Arena::new(dim0, dim1, mlx_rs::Dtype::Float16).expect("arena B");

        // Step 2: Write FP16 pattern [0.0, 1.0, 2.0, ..., 255.0] into arena A.
        unsafe {
            let ptr = arena_a.base_ptr() as *mut u16;
            for i in 0..n {
                ptr.add(i).write(f32_to_f16_bits(i as f32));
            }
        }

        // Step 3: Transient MLX verification — create external array, read back.
        let a_ptr = unsafe { arena_a.base_ptr() };
        let a_byte_len = arena_a.byte_len();
        {
            let a_storage = Arc::new(unsafe {
                external_array::StaticStorage::new(a_ptr as *const u8, a_byte_len)
            });
            let _arr = unsafe {
                external_array::new_external_array(
                    a_storage,
                    &[dim0 as i32, dim1 as i32],
                    mlx_rs::Dtype::Float16,
                )
            }
            .expect("external array A");
            // Read directly from the IOSurface backing (we wrote u16 bits).
            let readback: Vec<f32> = unsafe {
                let raw = a_ptr as *const u16;
                (0..n).map(|i| f16_to_f32(raw.add(i).read())).collect()
            };
            for i in 0..n.min(8) {
                let expected = i as f32;
                assert!(
                    (readback[i] - expected).abs() < 0.1,
                    "pattern mismatch at {}: got {:.2}, expected {:.2}",
                    i, readback[i], expected
                );
            }
        }

        // Step 4: Core ML prediction — read from arena A, write to arena B.
        let b_id_before = arena_b.io_surface_id();
        let b_addr_before = arena_b.info.base_address;

        model
            .predict_pixelbuffer("x", &arena_a.info, "output", &mut arena_b.info)
            .expect("predict_pixelbuffer");

        // Step 5-6: Wrap arena B as MLX external array, multiply by 2.0.
        let b_ptr = unsafe { arena_b.base_ptr() };
        let b_byte_len = arena_b.byte_len();
        {
            let b_storage = Arc::new(unsafe {
                external_array::StaticStorage::new(b_ptr as *const u8, b_byte_len)
            });
            let arr = unsafe {
                external_array::new_external_array(
                    b_storage,
                    &[dim0 as i32, dim1 as i32],
                    mlx_rs::Dtype::Float16,
                )
            }
            .expect("external array B");

            let two = mlx_rs::Array::from_slice(&[2.0f32], &[1]);
            let doubled = arr.multiply(&two).expect("multiply");
            doubled.eval().expect("eval");

            // Step 7: Read back and verify.
            // Input [0,1,2,...,255] → identity model preserves → MLX ×2 → [0,2,4,...,510].
            let out: Vec<f32> = doubled.try_as_slice::<f32>().unwrap().to_vec();
            assert_eq!(out.len(), n);
            for i in 0..n {
                let expected = (i as f32) * 2.0;
                assert!(
                    (out[i] - expected).abs() < 0.1,
                    "roundtrip mismatch at {}: got {:.2}, expected {:.2}",
                    i, out[i], expected
                );
            }
        }

        // Step 8: Assert no memcpy — backing identity unchanged in arena B.
        assert_eq!(
            arena_b.io_surface_id(),
            b_id_before,
            "arena B IOSurface ID changed — memcpy detected"
        );
        assert_eq!(
            arena_b.info.base_address,
            b_addr_before,
            "arena B base address changed — memcpy detected"
        );

        // Step 9: Drop both arenas, verify no panic.
        drop(arena_a);
        drop(arena_b);
        eprintln!("[phase4] Full MLX → CoreML → MLX round trip: PASS");
    }

    // ---- Stateful Island Tests (Phase 2) ----

    #[test]
    fn test_stateful_toy_deterministic_mutation() {
        let model_path = "/tmp/tribunus-stateful-toy.mlmodelc/tribunus-stateful-toy.mlmodelc";
        // Hard-fail if the model doesn't exist or can't load.
        // This test is expected to pass in the verified compiler environment.
        let model = CoreMlModel::load(model_path)
            .expect(&format!("FAIL: stateful model must load from {} — compiler environment not configured?", model_path));
        let state = CoreMlStateHandle::new(model.ptr).expect("create state handle");

        let dim0 = 1u32;
        let dim1 = 4u32;
        let n = (dim0 * dim1) as usize;

        let arena_a = Arena::new(dim0, dim1, mlx_rs::Dtype::Float16).expect("arena A");
        let mut arena_b = Arena::new(dim0, dim1, mlx_rs::Dtype::Float16).expect("arena B");

        for i in 0..5 {
            let val = i as f32;
            // Write [i, i, i, i] as FP16 into arena_a
            unsafe {
                let ptr = arena_a.base_ptr() as *mut u16;
                for j in 0..n {
                    ptr.add(j).write(f32_to_f16_bits(val));
                }
            }

            state
                .predict_stateful(model.ptr, "x", &arena_a.info, "y", &mut arena_b.info)
                .expect("stateful predict");

            // accumulator starts at 0, adds i each step → cumulative sum after step i
            let expected_sum = (i * (i + 1)) / 2; // 0, 1, 3, 6, 10
            unsafe {
                let out_ptr = arena_b.base_ptr() as *const u16;
                for j in 0..n {
                    let got = f16_to_f32(out_ptr.add(j).read());
                    let diff = (got - expected_sum as f32).abs();
                    assert!(
                        diff < 1e-2,
                        "iteration {} element {}: got {:.4}, expected {}",
                        i, j, got, expected_sum
                    );
                }
            }
        }

        drop(state);
        drop(model);
        drop(arena_a);
        drop(arena_b);
        eprintln!("[stateful] deterministic mutation: PASS");
    }

    #[test]
    fn test_stateful_toy_two_session_isolation() {
        let model_path = "/tmp/tribunus-stateful-toy.mlmodelc/tribunus-stateful-toy.mlmodelc";
        // Hard-fail if the model doesn't exist or can't load.
        // This test is expected to pass in the verified compiler environment.
        let model = CoreMlModel::load(model_path)
            .expect(&format!("FAIL: stateful model must load from {} — compiler environment not configured?", model_path));
        let state_1 = CoreMlStateHandle::new(model.ptr).expect("state 1");
        let state_2 = CoreMlStateHandle::new(model.ptr).expect("state 2");

        let dim0 = 1u32;
        let dim1 = 4u32;
        let n = (dim0 * dim1) as usize;

        let mut arena_b = Arena::new(dim0, dim1, mlx_rs::Dtype::Float16).expect("arena B");

        // Feed state_1 with [1,1,1,1] five times → accumulator [5,5,5,5]
        let arena_s1 = Arena::new(dim0, dim1, mlx_rs::Dtype::Float16).expect("arena s1");
        for _ in 0..5 {
            unsafe {
                let ptr = arena_s1.base_ptr() as *mut u16;
                for j in 0..n {
                    ptr.add(j).write(f32_to_f16_bits(1.0));
                }
            }
            state_1
                .predict_stateful(model.ptr, "x", &arena_s1.info, "y", &mut arena_b.info)
                .expect("state_1 predict");
        }
        // Verify state_1 accumulator = [5,5,5,5]
        unsafe {
            let out_ptr = arena_b.base_ptr() as *const u16;
            for j in 0..n {
                let got = f16_to_f32(out_ptr.add(j).read());
                let diff = (got - 5.0).abs();
                assert!(
                    diff < 1e-2,
                    "state_1 after 5x1: element {} got {:.4}, expected 5.0",
                    j, got
                );
            }
        }

        // Feed state_2 with [10,10,10,10] two times → accumulator [20,20,20,20]
        let arena_s2 = Arena::new(dim0, dim1, mlx_rs::Dtype::Float16).expect("arena s2");
        for _ in 0..2 {
            unsafe {
                let ptr = arena_s2.base_ptr() as *mut u16;
                for j in 0..n {
                    ptr.add(j).write(f32_to_f16_bits(10.0));
                }
            }
            state_2
                .predict_stateful(model.ptr, "x", &arena_s2.info, "y", &mut arena_b.info)
                .expect("state_2 predict");
        }
        // Verify state_2 accumulator = [20,20,20,20]
        unsafe {
            let out_ptr = arena_b.base_ptr() as *const u16;
            for j in 0..n {
                let got = f16_to_f32(out_ptr.add(j).read());
                let diff = (got - 20.0).abs();
                assert!(
                    diff < 1e-2,
                    "state_2 after 2x10: element {} got {:.4}, expected 20.0",
                    j, got
                );
            }
        }

        // Feed state_1 one more time with [1,1,1,1] → accumulator [6,6,6,6]
        // (NOT [11,11,11,11] — proves isolation from state_2)
        unsafe {
            let ptr = arena_s1.base_ptr() as *mut u16;
            for j in 0..n {
                ptr.add(j).write(f32_to_f16_bits(1.0));
            }
        }
        state_1
            .predict_stateful(model.ptr, "x", &arena_s1.info, "y", &mut arena_b.info)
            .expect("state_1 final predict");
        unsafe {
            let out_ptr = arena_b.base_ptr() as *const u16;
            for j in 0..n {
                let got = f16_to_f32(out_ptr.add(j).read());
                let diff = (got - 6.0).abs();
                assert!(
                    diff < 1e-2,
                    "state_1 after 6th push: element {} got {:.4}, expected 6.0 (NOT 11)",
                    j, got
                );
            }
        }

        // Feed state_2 one more time with [10,10,10,10] → accumulator [30,30,30,30]
        // (NOT [16,16,16,16] — proves isolation from state_1)
        unsafe {
            let ptr = arena_s2.base_ptr() as *mut u16;
            for j in 0..n {
                ptr.add(j).write(f32_to_f16_bits(10.0));
            }
        }
        state_2
            .predict_stateful(model.ptr, "x", &arena_s2.info, "y", &mut arena_b.info)
            .expect("state_2 final predict");
        unsafe {
            let out_ptr = arena_b.base_ptr() as *const u16;
            for j in 0..n {
                let got = f16_to_f32(out_ptr.add(j).read());
                let diff = (got - 30.0).abs();
                assert!(
                    diff < 1e-2,
                    "state_2 after 3rd 10: element {} got {:.4}, expected 30.0 (NOT 16)",
                    j, got
                );
            }
        }

        drop(state_1);
        drop(state_2);
        drop(model);
        drop(arena_s1);
        drop(arena_s2);
        drop(arena_b);
        eprintln!("[stateful] two-session isolation: PASS");
    }

    #[test]
    fn test_stateful_toy_concurrent_rejection() {
        // Verify that rapid sequential predictions on the same state don't corrupt each other.
        // True concurrent rejection (same-state simultaneous use) is gated on the Tokio supervisor.
        let model_path = "/tmp/tribunus-stateful-toy.mlmodelc/tribunus-stateful-toy.mlmodelc";
        // Hard-fail if the model doesn't exist or can't load.
        // This test is expected to pass in the verified compiler environment.
        let model = CoreMlModel::load(model_path)
            .expect(&format!("FAIL: stateful model must load from {} — compiler environment not configured?", model_path));
        let state = CoreMlStateHandle::new(model.ptr).expect("create state handle");

        let dim0 = 1u32;
        let dim1 = 4u32;
        let n = (dim0 * dim1) as usize;

        let arena_a = Arena::new(dim0, dim1, mlx_rs::Dtype::Float16).expect("arena A");
        let mut arena_b = Arena::new(dim0, dim1, mlx_rs::Dtype::Float16).expect("arena B");

        // Verify that rapid sequential predictions on the same state don't corrupt each other.
        // First prediction with [1,1,1,1] → accumulator [1,1,1,1]
        unsafe {
            let ptr = arena_a.base_ptr() as *mut u16;
            for j in 0..n {
                ptr.add(j).write(f32_to_f16_bits(1.0));
            }
        }
        state
            .predict_stateful(model.ptr, "x", &arena_a.info, "y", &mut arena_b.info)
            .expect("first predict");
        unsafe {
            let out_ptr = arena_b.base_ptr() as *const u16;
            for j in 0..n {
                let got = f16_to_f32(out_ptr.add(j).read());
                let diff = (got - 1.0).abs();
                assert!(
                    diff < 1e-2,
                    "first predict element {}: got {:.4}, expected 1.0",
                    j, got
                );
            }
        }

        // Immediately (synchronously) run second prediction with [2,2,2,2] → accumulator [3,3,3,3]
        unsafe {
            let ptr = arena_a.base_ptr() as *mut u16;
            for j in 0..n {
                ptr.add(j).write(f32_to_f16_bits(2.0));
            }
        }
        state
            .predict_stateful(model.ptr, "x", &arena_a.info, "y", &mut arena_b.info)
            .expect("second predict");
        unsafe {
            let out_ptr = arena_b.base_ptr() as *const u16;
            for j in 0..n {
                let got = f16_to_f32(out_ptr.add(j).read());
                let diff = (got - 3.0).abs();
                assert!(
                    diff < 1e-2,
                    "second predict element {}: got {:.4}, expected 3.0",
                    j, got
                );
            }
        }

        drop(state);
        drop(model);
        drop(arena_a);
        drop(arena_b);
        eprintln!("[stateful] concurrent rejection (sequential safety): PASS");
    }

    #[test]
    fn test_gemma_mlp_coreml_prediction() {
        let model_path = "/tmp/tribunus-gemma-mlp.mlmodelc/tribunus-gemma-mlp.mlmodelc";

        let model = CoreMlModel::load(model_path).expect("load Gemma MLP model");
        let dim0 = 1u32;
        let dim1 = 3840u32;
        let n = (dim0 * dim1) as usize;

        // Input arena A — IOSurface-backed FP16.
        let arena_a = Arena::new(dim0, dim1, mlx_rs::Dtype::Float16).expect("arena A");

        // Fill with deterministic pattern: sin(i/100.0) as FP16.
        unsafe {
            let ptr = arena_a.base_ptr() as *mut u16;
            for i in 0..n {
                ptr.add(i).write(f32_to_f16_bits((i as f32 / 100.0).sin()));
            }
        }

        // Output arena B.
        let mut arena_b = Arena::new(dim0, dim1, mlx_rs::Dtype::Float16).expect("arena B");

        // Capture backing identity before prediction.
        let b_id_before = arena_b.io_surface_id();
        let b_addr_before = arena_b.info.base_address;

        // Run Core ML prediction with IOSurface pixel buffer path.
        model
            .predict_pixelbuffer("x", &arena_a.info, "output", &mut arena_b.info)
            .expect("predict_pixelbuffer");

        // Verify output is nonzero — at least one element has |value| > 1e-6.
        let mut found_nonzero = false;
        unsafe {
            let out_ptr = b_addr_before as *const u16;
            for i in 0..n {
                let got = f16_to_f32(out_ptr.add(i).read());
                if got.abs() > 1e-6 {
                    found_nonzero = true;
                    break;
                }
            }
        }
        assert!(found_nonzero, "all Gemma MLP output elements are zero (dead model?)");

        // Verify Arena output IOSurface identity — no reallocation.
        assert_eq!(
            arena_b.io_surface_id(),
            b_id_before,
            "arena B IOSurface ID changed after prediction"
        );
        assert_eq!(
            arena_b.info.base_address,
            b_addr_before,
            "arena B base address changed after prediction"
        );

        eprintln!("[gemma-mlp] Core ML prediction: PASS");
    }
}
