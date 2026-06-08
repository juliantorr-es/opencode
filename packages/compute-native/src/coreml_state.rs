//! Core ML stateful prediction bridge — Rust FFI bindings.

extern "C" {
    fn tribunus_coreml_state_create(
        out_state: *mut *mut std::ffi::c_void,
        model: *mut std::ffi::c_void,
    ) -> i32;

    fn tribunus_coreml_state_destroy(state: *mut std::ffi::c_void);

    fn tribunus_coreml_predict_stateful(
        model: *mut std::ffi::c_void,
        state: *mut std::ffi::c_void,
        input_name: *const i8,
        input_arena: *const crate::arena::ArenaInfo,
        output_name: *const i8,
        output_arena: *mut crate::arena::ArenaInfo,
    ) -> i32;
}

/// Owned Core ML state handle.
pub struct CoreMlStateHandle {
    ptr: *mut std::ffi::c_void,
}

impl CoreMlStateHandle {
    /// Create a new state from a loaded model.
    /// The model_ptr should come from CoreMlModel (the loaded MLModel).
    pub fn new(model_ptr: *mut std::ffi::c_void) -> Result<Self, String> {
        let mut ptr: *mut std::ffi::c_void = std::ptr::null_mut();
        let status = unsafe { tribunus_coreml_state_create(&mut ptr, model_ptr) };
        if status != 0 {
            return Err(format!("tribunus_coreml_state_create failed: {}", status));
        }
        Ok(CoreMlStateHandle { ptr })
    }

    /// Run stateful prediction with IOSurface-backed arenas.
    pub fn predict_stateful(
        &self,
        model_ptr: *mut std::ffi::c_void,
        input_name: &str,
        input_arena: &crate::arena::ArenaInfo,
        output_name: &str,
        output_arena: &mut crate::arena::ArenaInfo,
    ) -> Result<(), String> {
        let c_in = std::ffi::CString::new(input_name).map_err(|e| format!("CString: {}", e))?;
        let c_out = std::ffi::CString::new(output_name).map_err(|e| format!("CString: {}", e))?;
        let status = unsafe {
            tribunus_coreml_predict_stateful(
                model_ptr,
                self.ptr,
                c_in.as_ptr(),
                input_arena,
                c_out.as_ptr(),
                output_arena,
            )
        };
        if status != 0 {
            return Err(format!("tribunus_coreml_predict_stateful failed: {}", status));
        }
        Ok(())
    }
}

impl Drop for CoreMlStateHandle {
    fn drop(&mut self) {
        if !self.ptr.is_null() {
            unsafe { tribunus_coreml_state_destroy(self.ptr) };
        }
    }
}

// Safety: MLState is documented as thread-safe for prediction in isolated sessions.
unsafe impl Send for CoreMlStateHandle {}
unsafe impl Sync for CoreMlStateHandle {}
