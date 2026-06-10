//! Backend abstraction layer — generic TensorBackend trait and MlxBackend adapter.
//!
//! The trait exposes model-level operations (matmul, rms_norm, RoPE, etc.)
//! through opaque `TensorHandle` indices. The MlxBackend implementation wraps
//! `mlx_rs::Array` operations behind a handle-based registry.

use mlx_rs::Array;
use mlx_rs::ops;

// ── Handle types ───────────────────────────────────────────────────────────

/// Opaque handle for a tensor stored in a backend's internal registry.
pub type TensorHandle = usize;

/// Opaque handle for a quantized weight tensor (stored separately from
/// regular tensors for quantization-specific operations).
pub type QuantizedWeightHandle = usize;

// ── Operation descriptors ──────────────────────────────────────────────────

/// Describes a quantized matrix multiplication (A @ W_q).
pub struct QuantizedMatmulOp {
    pub m: u32,
    pub n: u32,
    pub k: u32,
    pub input_dtype: String,
    pub weight_dtype: String,
    pub scale_dtype: String,
    pub bias_dtype: String,
    pub output_dtype: String,
    pub group_size: u32,
    pub bits: u8,
    pub transpose: bool,
}

/// Describes a standard matrix multiplication (A @ B).
pub struct MatmulOp {
    pub m: u32,
    pub n: u32,
    pub k: u32,
}

/// Describes a RMS normalization operation.
pub struct RmsNormOp {
    pub dim: u32,
    pub eps: f32,
}

/// Describes a Rotary Position Embedding (RoPE) operation.
pub struct RoPEOp {
    pub head_dim: u32,
    pub positions: Vec<u32>,
}

// ── Evaluation receipt ─────────────────────────────────────────────────────

/// Telemetry from an [`evaluate`](TensorBackend::evaluate) call.
pub struct EvaluationReceipt {
    pub eval_duration_ns: u64,
    pub gpu_duration_ns: Option<u64>,
    pub active_memory_after: u64,
    pub cache_memory_after: u64,
}

// ── Backend trait ──────────────────────────────────────────────────────────

/// Abstract tensor-compute backend.
///
/// Every operation returns a new `TensorHandle`.  The backend owns the
/// underlying arrays and manages their lifecycle through
/// [`create_*`](TensorBackend::create_f32) and
/// [`release`](TensorBackend::release).
pub trait TensorBackend {
    // ── Creation ───────────────────────────────────────────────────────

    /// Create a tensor from f32 data.
    fn create_f32(&mut self, data: &[f32], shape: &[i32]) -> Result<TensorHandle, String>;

    /// Create a tensor from u32 data.
    fn create_u32(&mut self, data: &[u32], shape: &[i32]) -> Result<TensorHandle, String>;

    /// Create a tensor from bfloat16 data (stored as u16 per element).
    fn create_bf16(&mut self, data: &[u16], shape: &[i32]) -> Result<TensorHandle, String>;

    /// Create a tensor from raw bytes, interpreting them as `dtype`.
    ///
    /// Supported dtype strings: `"float32"`, `"bfloat16"`, `"float16"`,
    /// `"uint32"`, `"uint8"`, `"int8"`.
    fn create_external(
        &mut self,
        data: &[u8],
        shape: &[i32],
        dtype: &str,
    ) -> Result<TensorHandle, String>;

    // ── Core compute ───────────────────────────────────────────────────

    /// Fused quantized matrix multiplication: `y = x @ dequantize(w)`.
    fn quantized_matmul(
        &mut self,
        op: &QuantizedMatmulOp,
        x: TensorHandle,
        w: QuantizedWeightHandle,
        scales: TensorHandle,
        biases: TensorHandle,
    ) -> Result<TensorHandle, String>;

    /// Standard matrix multiplication: `y = a @ b`.
    fn matmul(&mut self, a: TensorHandle, b: TensorHandle) -> Result<TensorHandle, String>;

    /// Root Mean Square normalization: `y = rms_norm(x, weight)`.
    fn rms_norm(
        &mut self,
        op: &RmsNormOp,
        x: TensorHandle,
        weight: TensorHandle,
    ) -> Result<TensorHandle, String>;

    /// Rotary Position Embedding.
    fn rope(&mut self, op: &RoPEOp, x: TensorHandle) -> Result<TensorHandle, String>;

    /// Element-wise addition.
    fn add(&mut self, a: TensorHandle, b: TensorHandle) -> Result<TensorHandle, String>;

    /// Element-wise multiplication.
    fn multiply(&mut self, a: TensorHandle, b: TensorHandle) -> Result<TensorHandle, String>;

    /// SiLU activation: `x * sigmoid(x)`.
    fn silu(&mut self, x: TensorHandle) -> Result<TensorHandle, String>;

    /// Transpose dimensions.
    fn transpose(&mut self, x: TensorHandle, dims: &[i32]) -> Result<TensorHandle, String>;

    /// Reshape tensor.
    fn reshape(&mut self, x: TensorHandle, shape: &[i32]) -> Result<TensorHandle, String>;

    /// Softmax along an axis.
    fn softmax(&mut self, x: TensorHandle, axis: i32) -> Result<TensorHandle, String>;

    /// Gather values along an axis using index array.
    fn index_select(
        &mut self,
        x: TensorHandle,
        indices: &[u32],
        axis: i32,
    ) -> Result<TensorHandle, String>;

    // ── Lifecycle / inspection ─────────────────────────────────────────

    /// Evaluate one or more output tensors, materialising the computation
    /// graph.  Returns telemetry.
    fn evaluate(&mut self, outputs: &[TensorHandle]) -> Result<EvaluationReceipt, String>;

    /// Read back the f32 data of a tensor (blocks until data is available).
    fn read_f32(&self, handle: TensorHandle) -> Result<Vec<f32>, String>;

    /// Return the shape of a tensor.
    fn shape(&self, handle: TensorHandle) -> Result<Vec<i32>, String>;

    /// Release a tensor handle, freeing its underlying storage.
    fn release(&mut self, handle: TensorHandle) -> Result<(), String>;

    /// Return `(active_bytes, cache_bytes)` for the backend's allocator.
    fn active_memory(&self) -> (u64, u64);

    /// A short, human-readable name for this backend (e.g. `"mlx"`).
    fn backend_name(&self) -> &'static str;

    /// Which substrate this backend runs on: `"cpu"` or `"gpu"`.
    fn backend_substrate(&self) -> String;
}

// ── MLX backend ────────────────────────────────────────────────────────────

/// MLX-backed implementation of [`TensorBackend`].
///
/// Stores arrays in a slot-map indexed by `TensorHandle`.  A free list
/// recycles slots from released handles.
pub struct MlxBackend {
    arrays: Vec<Option<Array>>,
    free_list: Vec<usize>,
    name: String,
}

impl MlxBackend {
    /// Create a new empty backend.
    pub fn new() -> Self {
        Self {
            arrays: Vec::new(),
            free_list: Vec::new(),
            name: "mlx".to_string(),
        }
    }

    /// Create a new backend with a custom name.
    pub fn with_name(name: impl Into<String>) -> Self {
        Self {
            arrays: Vec::new(),
            free_list: Vec::new(),
            name: name.into(),
        }
    }

    /// Allocate a slot for `arr` and return the handle.
    fn alloc(&mut self, arr: Array) -> TensorHandle {
        if let Some(idx) = self.free_list.pop() {
            self.arrays[idx] = Some(arr);
            idx
        } else {
            let idx = self.arrays.len();
            self.arrays.push(Some(arr));
            idx
        }
    }

    /// Get an immutable reference to the array at `handle`.
    fn get(&self, handle: TensorHandle) -> Result<&Array, String> {
        self.arrays
            .get(handle)
            .and_then(|opt| opt.as_ref())
            .ok_or_else(|| format!("MlxBackend: invalid tensor handle {}", handle))
    }

    /// Get a mutable reference to the array at `handle`.
    fn get_mut(&mut self, handle: TensorHandle) -> Result<&mut Array, String> {
        self.arrays
            .get_mut(handle)
            .and_then(|opt| opt.as_mut())
            .ok_or_else(|| format!("MlxBackend: invalid tensor handle {}", handle))
    }
}

impl Default for MlxBackend {
    fn default() -> Self {
        Self::new()
    }
}

impl TensorBackend for MlxBackend {
    // ── Creation ───────────────────────────────────────────────────────

    fn create_f32(&mut self, data: &[f32], shape: &[i32]) -> Result<TensorHandle, String> {
        let arr = Array::from_slice(data, shape);
        Ok(self.alloc(arr))
    }

    fn create_u32(&mut self, data: &[u32], shape: &[i32]) -> Result<TensorHandle, String> {
        let arr = Array::from_slice(data, shape);
        Ok(self.alloc(arr))
    }

    fn create_bf16(&mut self, data: &[u16], shape: &[i32]) -> Result<TensorHandle, String> {
        // bfloat16: store as u16 bytes then cast.  MLX doesn't have a
        // public from_slice for bf16, so we create an f32 array and convert.
        let f32_vec: Vec<f32> = data
            .iter()
            .map(|&v| {
                let bits = (v as u32) << 16;
                f32::from_bits(bits)
            })
            .collect();
        let arr = Array::from_slice(&f32_vec, shape);
        Ok(self.alloc(arr))
    }

    fn create_external(
        &mut self,
        data: &[u8],
        shape: &[i32],
        dtype: &str,
    ) -> Result<TensorHandle, String> {
        let arr = match dtype {
            "float32" | "f32" => {
                let (prefix, aligned, suffix) = unsafe { data.align_to::<f32>() };
                if !prefix.is_empty() || !suffix.is_empty() {
                    return Err("create_external: f32 data not aligned to 4 bytes".into());
                }
                Array::from_slice(aligned, shape)
            }
            "uint32" | "u32" => {
                let (prefix, aligned, suffix) = unsafe { data.align_to::<u32>() };
                if !prefix.is_empty() || !suffix.is_empty() {
                    return Err("create_external: u32 data not aligned to 4 bytes".into());
                }
                Array::from_slice(aligned, shape)
            }
            "uint8" | "u8" => {
                let (prefix, aligned, suffix) = unsafe { data.align_to::<u8>() };
                if !prefix.is_empty() || !suffix.is_empty() {
                    return Err("create_external: u8 data alignment failed".into());
                }
                Array::from_slice(aligned, shape)
            }
            "bfloat16" | "bf16" => {
                let (prefix, aligned, suffix) = unsafe { data.align_to::<u16>() };
                if !prefix.is_empty() || !suffix.is_empty() {
                    return Err("create_external: bf16 data not aligned to 2 bytes".into());
                }
                let f32_vec: Vec<f32> = aligned
                    .iter()
                    .map(|&v| {
                        let bits = (v as u32) << 16;
                        f32::from_bits(bits)
                    })
                    .collect();
                Array::from_slice(&f32_vec, shape)
            }
            _ => {
                return Err(format!(
                    "create_external: unsupported dtype '{}'",
                    dtype
                ));
            }
        };
        Ok(self.alloc(arr))
    }

    // ── Core compute ───────────────────────────────────────────────────

    fn quantized_matmul(
        &mut self,
        op: &QuantizedMatmulOp,
        x: TensorHandle,
        w: QuantizedWeightHandle,
        scales: TensorHandle,
        biases: TensorHandle,
    ) -> Result<TensorHandle, String> {
        let x_arr = self.get(x)?;
        let w_arr = self.get(w)?;
        let s_arr = self.get(scales)?;
        let b_arr = self.get(biases)?;

        let out = ops::quantized_matmul(
            x_arr,
            w_arr,
            s_arr,
            b_arr,
            op.transpose,
            op.group_size as i32,
            op.bits as i32,
        )
        .map_err(|e| format!("quantized_matmul failed: {:?}", e))?;

        Ok(self.alloc(out))
    }

    fn matmul(&mut self, a: TensorHandle, b: TensorHandle) -> Result<TensorHandle, String> {
        let a_arr = self.get(a)?;
        let b_arr = self.get(b)?;
        let out = a_arr
            .matmul(b_arr)
            .map_err(|e| format!("matmul failed: {:?}", e))?;
        Ok(self.alloc(out))
    }

    fn rms_norm(
        &mut self,
        op: &RmsNormOp,
        x: TensorHandle,
        weight: TensorHandle,
    ) -> Result<TensorHandle, String> {
        let x_arr = self.get(x)?;
        let w_arr = self.get(weight)?;

        let out = mlx_rs::fast::rms_norm(x_arr, w_arr, op.eps)
            .map_err(|e| format!("rms_norm failed: {:?}", e))?;

        Ok(self.alloc(out))
    }

    fn rope(&mut self, op: &RoPEOp, x: TensorHandle) -> Result<TensorHandle, String> {
        let x_arr = self.get(x)?;

        // Use mlx_rs fast::rope with default base (10000.0), no traditional,
        // scale=1.0, and offset matching the first position.
        let offset = op.positions.first().copied().unwrap_or(0) as i32;
        let out = mlx_rs::fast::rope(
            x_arr,
            op.head_dim as i32,
            false,    // traditional = false
            None,     // base = default (10000.0)
            1.0,      // scale
            offset,
            None,     // freqs
        )
        .map_err(|e| format!("rope failed: {:?}", e))?;

        Ok(self.alloc(out))
    }

    fn add(&mut self, a: TensorHandle, b: TensorHandle) -> Result<TensorHandle, String> {
        let a_arr = self.get(a)?;
        let b_arr = self.get(b)?;
        let out = a_arr
            .add(b_arr)
            .map_err(|e| format!("add failed: {:?}", e))?;
        Ok(self.alloc(out))
    }

    fn multiply(&mut self, a: TensorHandle, b: TensorHandle) -> Result<TensorHandle, String> {
        let a_arr = self.get(a)?;
        let b_arr = self.get(b)?;
        let out = a_arr
            .multiply(b_arr)
            .map_err(|e| format!("multiply failed: {:?}", e))?;
        Ok(self.alloc(out))
    }

    fn silu(&mut self, x: TensorHandle) -> Result<TensorHandle, String> {
        let x_arr = self.get(x)?;
        // SiLU(x) = x * sigmoid(x)
        let sig = ops::sigmoid(x_arr).map_err(|e| format!("silu(sigmoid) failed: {:?}", e))?;
        let out = x_arr
            .multiply(&sig)
            .map_err(|e| format!("silu(multiply) failed: {:?}", e))?;
        Ok(self.alloc(out))
    }

    fn transpose(&mut self, x: TensorHandle, dims: &[i32]) -> Result<TensorHandle, String> {
        let x_arr = self.get(x)?;
        let out = ops::transpose_axes(x_arr, dims)
            .map_err(|e| format!("transpose failed: {:?}", e))?;
        Ok(self.alloc(out))
    }

    fn reshape(&mut self, x: TensorHandle, shape: &[i32]) -> Result<TensorHandle, String> {
        let x_arr = self.get(x)?;
        let out = ops::reshape(x_arr, shape)
            .map_err(|e| format!("reshape failed: {:?}", e))?;
        Ok(self.alloc(out))
    }

    fn softmax(&mut self, x: TensorHandle, axis: i32) -> Result<TensorHandle, String> {
        let x_arr = self.get(x)?;
        let out = ops::softmax_axis(x_arr, axis, None)
            .map_err(|e| format!("softmax failed: {:?}", e))?;
        Ok(self.alloc(out))
    }

    fn index_select(
        &mut self,
        x: TensorHandle,
        indices: &[u32],
        axis: i32,
    ) -> Result<TensorHandle, String> {
        let x_arr = self.get(x)?;
        let idx_arr = Array::from_slice(indices, &[indices.len() as i32]);
        let out = ops::indexing::take_along_axis(x_arr, &idx_arr, axis)
            .map_err(|e| format!("index_select failed: {:?}", e))?;
        Ok(self.alloc(out))
    }

    // ── Lifecycle / inspection ─────────────────────────────────────────

    fn evaluate(&mut self, outputs: &[TensorHandle]) -> Result<EvaluationReceipt, String> {
        let start = std::time::Instant::now();

        // Evaluate each output tensor.  In MLX, eval() materialises the
        // lazy computation graph for all dependencies.
        for &h in outputs {
            let arr = self.get(h)?;
            arr.eval().map_err(|e| format!("evaluate failed: {:?}", e))?;
        }

        let elapsed = start.elapsed();
        let (active, cached) = self.active_memory();

        Ok(EvaluationReceipt {
            eval_duration_ns: elapsed.as_nanos() as u64,
            gpu_duration_ns: None, // Phase 2: track GPU timing separately
            active_memory_after: active,
            cache_memory_after: cached,
        })
    }

    fn read_f32(&self, handle: TensorHandle) -> Result<Vec<f32>, String> {
        let arr = self.get(handle)?;
        // Ensure the array is materialised
        arr.eval().map_err(|e| format!("read_f32 eval failed: {:?}", e))?;
        arr.try_as_slice::<f32>()
            .map(|s| s.to_vec())
            .map_err(|e| format!("read_f32 failed: {:?}", e))
    }

    fn shape(&self, handle: TensorHandle) -> Result<Vec<i32>, String> {
        let arr = self.get(handle)?;
        Ok(arr.shape().to_vec())
    }

    fn release(&mut self, handle: TensorHandle) -> Result<(), String> {
        if handle >= self.arrays.len() {
            return Err(format!("release: invalid handle {}", handle));
        }
        if self.arrays[handle].is_none() {
            return Err(format!("release: handle {} already released", handle));
        }
        self.arrays[handle] = None;
        self.free_list.push(handle);
        Ok(())
    }

    fn active_memory(&self) -> (u64, u64) {
        #[cfg(target_os = "macos")]
        {
            let mut active: usize = 0;
            let mut cache: usize = 0;
            unsafe {
                mlx_sys::mlx_get_active_memory(&mut active);
                mlx_sys::mlx_get_cache_memory(&mut cache);
            }
            (active as u64, cache as u64)
        }
        #[cfg(not(target_os = "macos"))]
        {
            (0, 0)
        }
    }

    fn backend_name(&self) -> &'static str {
        "mlx"
    }

    fn backend_substrate(&self) -> String {
        #[cfg(target_os = "macos")]
        {
            "gpu".to_string()
        }
        #[cfg(not(target_os = "macos"))]
        {
            "cpu".to_string()
        }
    }
}

// ── Trace hooks (stub) ─────────────────────────────────────────────────────

/// Bounded ring buffer for native trace events.
///
/// Phase 2 will replace this with a lock-free concurrent ring buffer.
pub struct TraceRingBuffer {
    // Phase 2: bounded lock-free ring buffer
    _capacity: usize,
}

/// A single trace event emitted by the native compute kernel.
#[derive(Debug, Clone)]
pub enum TraceEvent {
    /// A new primitive was created.
    PrimitiveCreated {
        op_id: u64,
        kind: String,
    },
    /// A lazy-evaluation group has started.
    EvaluationStarted {
        group_id: u64,
        tensor_count: usize,
    },
    /// A lazy-evaluation group completed.
    EvaluationCompleted {
        group_id: u64,
        duration_ns: u64,
    },
    /// Temporary storage allocated.
    TemporaryAllocated {
        bytes: u64,
    },
    /// Temporary storage released.
    TemporaryReleased {
        bytes: u64,
    },
}

impl TraceRingBuffer {
    pub fn new(capacity: usize) -> Self {
        Self {
            _capacity: capacity,
        }
    }

    /// Record an event (no-op in the stub).
    pub fn record(&self, _event: TraceEvent) {
        // Phase 2: push into concurrent ring buffer
    }

    /// Drain all pending events (returns empty in the stub).
    pub fn drain(&self) -> Vec<TraceEvent> {
        Vec::new()
    }
}
