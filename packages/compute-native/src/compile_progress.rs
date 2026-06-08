use serde::Serialize;

#[derive(Clone, Serialize)]
pub struct CompileProgress {
    pub stage: String,
    pub bytes_processed: u64,
    pub bytes_total: u64,
    pub elapsed_ms: u64,
}

impl CompileProgress {
    pub fn emit(&self) {
        eprintln!(
            "[compile-progress] {} {}/{} bytes {}ms",
            self.stage, self.bytes_processed, self.bytes_total, self.elapsed_ms
        );
    }
}
