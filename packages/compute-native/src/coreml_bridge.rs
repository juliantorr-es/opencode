//! Core ML execution bridge — Rust FFI bindings.

use crate::arena::ArenaInfo;

extern "C" {
    fn tribunus_coreml_load_model(out_model: *mut *mut std::ffi::c_void, path: *const i8) -> i32;
    fn tribunus_coreml_free_model(model: *mut std::ffi::c_void);
    fn tribunus_coreml_predict(
        model: *mut std::ffi::c_void,
        input_name: *const i8,
        input_arena: *const ArenaInfo,
        output_name: *const i8,
        output_arena: *const ArenaInfo,
    ) -> i32;
    fn tribunus_coreml_predict_pixelbuffer(
        model: *mut std::ffi::c_void,
        input_name: *const i8,
        input_arena: *const ArenaInfo,
        output_name: *const i8,
        output_arena: *mut ArenaInfo,
    ) -> i32;
}

/// Owned Core ML model handle.
pub struct CoreMlModel {
pub(crate) ptr: *mut std::ffi::c_void,
}

impl CoreMlModel {
    /// Load a compiled Core ML model from disk.
    pub fn load(path: &str) -> Result<Self, String> {
        let c_path = std::ffi::CString::new(path).map_err(|e| format!("CString: {}", e))?;
        let mut ptr: *mut std::ffi::c_void = std::ptr::null_mut();
        let status = unsafe { tribunus_coreml_load_model(&mut ptr, c_path.as_ptr()) };
        if status != 0 {
            return Err(format!("tribunus_coreml_load_model failed: {}", status));
        }
        Ok(CoreMlModel { ptr })
    }

    /// Run prediction: input arena → model → output arena.
    /// Both arenas must remain alive until after the prediction completes.
    /// The output arena's data is valid after this call returns.
    pub fn predict(
        &self,
        input_name: &str,
        input_arena: &ArenaInfo,
        output_name: &str,
        output_arena: &ArenaInfo,
    ) -> Result<(), String> {
        let c_in_name = std::ffi::CString::new(input_name).map_err(|e| format!("CString: {}", e))?;
        let c_out_name = std::ffi::CString::new(output_name).map_err(|e| format!("CString: {}", e))?;
        let status = unsafe {
            tribunus_coreml_predict(
                self.ptr,
                c_in_name.as_ptr(),
                input_arena,
                c_out_name.as_ptr(),
                output_arena,
            )
        };
        if status != 0 {
            return Err(format!("tribunus_coreml_predict failed: {}", status));
        }
        Ok(())
    }

    /// Run prediction using the IOSurface/CVPixelBuffer path.
    ///
    /// Both arenas must be IOSurface-backed (created via `Arena::new`).
    /// The output arena's `ArenaInfo` may be updated with the output CVPixelBuffer
    /// metadata; the original IOSurface backing remains the same.
    pub fn predict_pixelbuffer(
        &self,
        input_name: &str,
        input_arena: &ArenaInfo,
        output_name: &str,
        output_arena: &mut ArenaInfo,
    ) -> Result<(), String> {
        let c_in_name = std::ffi::CString::new(input_name).map_err(|e| format!("CString: {}", e))?;
        let c_out_name = std::ffi::CString::new(output_name).map_err(|e| format!("CString: {}", e))?;
        let status = unsafe {
            tribunus_coreml_predict_pixelbuffer(
                self.ptr,
                c_in_name.as_ptr(),
                input_arena,
                c_out_name.as_ptr(),
                output_arena,
            )
        };
        if status != 0 {
            return Err(format!("tribunus_coreml_predict_pixelbuffer failed: {}", status));
        }
        Ok(())
    }
}

impl Drop for CoreMlModel {
    fn drop(&mut self) {
        if !self.ptr.is_null() {
            unsafe { tribunus_coreml_free_model(self.ptr) };
        }
    }
}

// Safety: MLModel is documented as thread-safe for prediction.
unsafe impl Send for CoreMlModel {}
unsafe impl Sync for CoreMlModel {}
