use std::ffi::{c_void, CString};
use std::ptr;
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock, Arc};

extern "C" {
    fn tribunus_ane_init() -> i32;

    fn tribunus_ane_compile_mil(
        out_program: *mut *mut c_void,
        mil_text: *const i8,
        program_tag: *const i8,
    ) -> i32;

    fn tribunus_ane_eval(
        program: *mut c_void,
        inputs: *mut *mut c_void,
        num_inputs: i32,
        outputs: *mut *mut c_void,
        num_outputs: i32,
    ) -> i32;

    fn tribunus_ane_release_program(program: *mut c_void);

    fn tribunus_ane_compile_count() -> i32;

    fn tribunus_ane_program_reload_weights(
        program: *mut c_void,
        weight_path: *const i8,
        weight_data: *const c_void,
        weight_size: u64,
    ) -> i32;
}

pub struct AneProgram {
    ptr: *mut c_void,
}

impl AneProgram {
    pub fn init() -> Result<(), String> {
        let rc = unsafe { tribunus_ane_init() };
        if rc == 1 {
            Ok(())
        } else {
            Err("Apple Neural Engine private framework not available or failed to load".into())
        }
    }

    pub fn compile(mil_text: &str, tag: &str) -> Result<Self, String> {
        let c_mil = CString::new(mil_text).map_err(|e| format!("CString: {}", e))?;
        let c_tag = CString::new(tag).map_err(|e| format!("CString: {}", e))?;
        let mut ptr: *mut c_void = ptr::null_mut();
        let rc = unsafe { tribunus_ane_compile_mil(&mut ptr, c_mil.as_ptr(), c_tag.as_ptr()) };
        if rc != 0 {
            return Err(format!("tribunus_ane_compile_mil failed with error code: {}", rc));
        }
        Ok(AneProgram { ptr })
    }

    pub fn evaluate(&self, inputs: &[*mut c_void], outputs: &[*mut c_void]) -> Result<(), String> {
        if inputs.is_empty() || outputs.is_empty() {
            return Err("inputs or outputs cannot be empty".into());
        }
        let rc = unsafe {
            tribunus_ane_eval(
                self.ptr,
                inputs.as_ptr() as *mut *mut c_void,
                inputs.len() as i32,
                outputs.as_ptr() as *mut *mut c_void,
                outputs.len() as i32,
            )
        };
        if rc != 1 {
            return Err("tribunus_ane_eval failed".into());
        }
        Ok(())
    }

    pub fn reload_weights(&self, path: &str, data: &[u8]) -> Result<(), String> {
        let c_path = CString::new(path).map_err(|e| format!("CString: {}", e))?;
        let rc = unsafe {
            tribunus_ane_program_reload_weights(
                self.ptr,
                c_path.as_ptr(),
                data.as_ptr() as *const c_void,
                data.len() as u64,
            )
        };
        if rc != 1 {
            return Err("tribunus_ane_program_reload_weights failed".into());
        }
        Ok(())
    }

    pub fn compile_count() -> i32 {
        unsafe { tribunus_ane_compile_count() }
    }
}

impl Drop for AneProgram {
    fn drop(&mut self) {
        if !self.ptr.is_null() {
            unsafe { tribunus_ane_release_program(self.ptr) };
        }
    }
}

unsafe impl Send for AneProgram {}
unsafe impl Sync for AneProgram {}

pub struct AneProgramCache {
    programs: Mutex<HashMap<String, Arc<AneProgram>>>,
}

impl AneProgramCache {
    pub fn global() -> &'static Self {
        static CACHE: OnceLock<AneProgramCache> = OnceLock::new();
        CACHE.get_or_init(|| AneProgramCache {
            programs: Mutex::new(HashMap::new()),
        })
    }

    pub fn get_or_compile(&self, mil_text: &str, tag: &str) -> Result<Arc<AneProgram>, String> {
        let mut cache = self.programs.lock().map_err(|e| e.to_string())?;
        if let Some(prog) = cache.get(mil_text) {
            return Ok(prog.clone());
        }
        let prog = Arc::new(AneProgram::compile(mil_text, tag)?);
        cache.insert(mil_text.to_string(), prog.clone());
        Ok(prog)
    }

    pub fn clear(&self) {
        if let Ok(mut cache) = self.programs.lock() {
            cache.clear();
        }
    }
}
