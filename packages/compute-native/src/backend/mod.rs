//! Backend abstraction layer — generic TensorBackend trait and MlxBackend adapter.
//!
//! The trait exposes model-level operations (matmul, rms_norm, RoPE, etc.)
//! through opaque generational-handle indices. The MlxBackend implementation wraps
//! `mlx_rs::Array` operations behind a generational slot-map registry.

pub mod routing;
pub mod graph;
pub mod tensor_registry;
pub mod coreml;
pub mod accelerate;

use mlx_rs::Array;
use mlx_rs::ops;

// ── DType ──────────────────────────────────────────────────────────────────

/// Canonical element type enumeration.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DType {
    F32,
    F16,
    BF16,
    I8,
    U8,
    I32,
    U32,
}

// ── Handle types ───────────────────────────────────────────────────────────

/// Generational handle for a tensor stored in a backend's internal registry.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TensorHandle {
    pub slot: u32,
    pub generation: u32,
}

/// Generational handle for a quantized weight tensor (stored separately from
/// regular tensors for quantization-specific operations).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct QuantizedWeightHandle {
    pub slot: u32,
    pub generation: u32,
}

// ── Operation descriptors ──────────────────────────────────────────────────

/// Describes a quantized matrix multiplication (A @ W_q).
pub struct QuantizedMatmulOp {
    pub m: u32,
    pub n: u32,
    pub k: u32,
    pub input_dtype: DType,
    pub weight_dtype: DType,
    pub scale_dtype: DType,
    pub bias_dtype: DType,
    pub output_dtype: DType,
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
    pub group_id: u64,
    pub graph_build_ns: u64, // reserved for Phase 2 (set to 0 now)
    pub submit_ns: u64,      // reserved for Phase 2 (set to 0 now)
    pub sync_ns: u64,        // wall time of eval() call
    pub output_count: usize,
    pub active_memory_after: u64,
    pub cache_memory_after: u64,
    /// Observed execution substrate — `None` until native instrumentation
    /// observes the actual dispatch path.  `can_gpu` in BackendCapabilities
    /// reports what the backend *can* do, not what a specific evaluation
    /// *did*.
    pub observed_substrate: Option<String>,

    /// Number of eval() calls issued (>=1).  When >1, the backend emitted
    /// multiple evaluation fences for this group because not all outputs
    /// shared a dependency chain.
    pub eval_calls: usize,
}

// ── Readback receipt ───────────────────────────────────────────────────────

/// Telemetry from a [`read_f32`](TensorBackend::read_f32) call.
pub struct ReadbackReceipt {
    pub data: Vec<f32>,
    pub forced_eval: bool, // true if readback triggered eval
    pub sync_ns: u64,      // wall time spent waiting
    pub observed_substrate: Option<String>,
}

// ── Backend capabilities ───────────────────────────────────────────────────

/// Describes the capabilities of a backend implementation.
#[derive(Debug, Clone)]
pub struct BackendCapabilities {
    pub can_gpu: bool,
    pub can_cpu: bool,
    pub supports_quantized: bool,
    pub supports_bf16_native: bool,
    pub backend_name: String,
}

// ── Backend trait ──────────────────────────────────────────────────────────

/// Abstract tensor-compute backend.
///
/// Every operation returns a new `TensorHandle`. The backend owns the
/// underlying arrays and manages their lifecycle through
/// [`create_*`](TensorBackend::create_f32) and
/// [`release`](TensorBackend::release).
///
/// Release of a handle invalidates that generation; the underlying storage
/// may persist if other lazy arrays retain dependencies. Physical release
/// must be measured separately via `active_memory()`.
pub trait TensorBackend {
    // ── Creation ───────────────────────────────────────────────────────

    /// Create a tensor from f32 data.
    fn create_f32(&mut self, data: &[f32], shape: &[i32]) -> Result<TensorHandle, String>;

    /// Create a tensor from u32 data.
    fn create_u32(&mut self, data: &[u32], shape: &[i32]) -> Result<TensorHandle, String>;

    /// Create a tensor from bfloat16 bits stored as u16 — converts to f32
    /// (no native BF16 array is created; see TODO in MlxBackend).
    fn create_f32_from_bf16_bits(
        &mut self,
        data: &[u16],
        shape: &[i32],
    ) -> Result<TensorHandle, String>;

    /// Create an owned tensor from raw bytes, copying the data and
    /// interpreting them as `dtype`.
    fn create_owned_from_bytes(
        &mut self,
        data: &[u8],
        shape: &[i32],
        dtype: DType,
    ) -> Result<TensorHandle, String>;

    /// Reserve an externally-owned allocation for zero-copy use.
    /// Default implementation returns an error.
    fn bind_external(
        &mut self,
        _owner_token: u64,
        _data: &[u8],
        _shape: &[i32],
        _dtype: DType,
    ) -> Result<TensorHandle, String> {
        Err("bind_external: not implemented for this backend".into())
    }

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
    fn matmul(&mut self, op: &MatmulOp, a: TensorHandle, b: TensorHandle) -> Result<TensorHandle, String>;

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

    // ── Missing ops (stubs) ────────────────────────────────────────────

    /// Concatenate tensors along an axis.
    fn concatenate(&mut self, _tensors: &[TensorHandle], _axis: i32) -> Result<TensorHandle, String> {
        Err("concatenate: not implemented".into())
    }

    /// Slice a tensor.
    fn slice(&mut self, _x: TensorHandle, _start: &[i32], _stop: &[i32], _step: &[i32]) -> Result<TensorHandle, String> {
        Err("slice: not implemented".into())
    }

    /// Cast a tensor to the given element type.
    fn cast(&mut self, _x: TensorHandle, _dtype: DType) -> Result<TensorHandle, String> {
        Err("cast: not implemented".into())
    }

    // ── Lifecycle / inspection ─────────────────────────────────────────

    /// Evaluate one or more output tensors, materialising the computation
    /// graph. Returns telemetry.
    fn evaluate(
        &mut self,
        group_id: u64,
        outputs: &[TensorHandle],
    ) -> Result<EvaluationReceipt, String>;

    /// Read back the f32 data of a tensor (blocks until data is available).
    fn read_f32(&mut self, handle: TensorHandle) -> Result<ReadbackReceipt, String>;

    /// Return the shape of a tensor.
    fn shape(&self, handle: TensorHandle) -> Result<Vec<i32>, String>;

    /// Release this backend handle. The underlying storage may persist
    /// if other lazy arrays retain dependencies; physical release must be
    /// measured separately via `active_memory()`.
    fn release(&mut self, handle: TensorHandle) -> Result<(), String>;

    /// Return `(active_bytes, cache_bytes)` for the backend's allocator.
    fn active_memory(&self) -> (u64, u64);

    /// Describe the capabilities of this backend.
    fn backend_capabilities(&self) -> BackendCapabilities;
}

// ── MLX backend ────────────────────────────────────────────────────────────

/// MLX-backed implementation of [`TensorBackend`].
///
/// Stores arrays in generational slot-maps indexed by `TensorHandle`. A free
/// list recycles slots from released handles. Slot generations are bumped
/// on reuse so stale handles are detected.
pub struct MlxBackend {
    arrays: Vec<Option<Array>>,
    generations: Vec<u32>,
    materialised: Vec<bool>,
    free_list: Vec<usize>,
    weight_arrays: Vec<Option<Array>>,
    weight_generations: Vec<u32>,
    weight_free_list: Vec<usize>,
    name: String,
}

impl MlxBackend {
    /// Create a new empty backend.
    pub fn new() -> Self {
        Self {
            arrays: Vec::new(),
            generations: Vec::new(),
            materialised: Vec::new(),
            free_list: Vec::new(),
            weight_arrays: Vec::new(),
            weight_generations: Vec::new(),
            weight_free_list: Vec::new(),
            name: "mlx".to_string(),
        }
    }

    /// Create a new backend with a custom name.
    pub fn with_name(name: impl Into<String>) -> Self {
        Self {
            arrays: Vec::new(),
            generations: Vec::new(),
            materialised: Vec::new(),
            free_list: Vec::new(),
            weight_arrays: Vec::new(),
            weight_generations: Vec::new(),
            weight_free_list: Vec::new(),
            name: name.into(),
        }
    }

    /// Allocate a slot for `arr` and return the handle.
    fn alloc(&mut self, arr: Array) -> TensorHandle {
        if let Some(idx) = self.free_list.pop() {
            self.generations[idx] += 1;
            self.arrays[idx] = Some(arr);
            TensorHandle {
                slot: idx as u32,
                generation: self.generations[idx],
            }
        } else {
            let idx = self.arrays.len();
            self.arrays.push(Some(arr));
            self.generations.push(1);
            TensorHandle {
                slot: idx as u32,
                generation: 1,
            }
        }
    }

    /// Allocate a slot for a quantized weight array and return the handle.
    fn alloc_weight(&mut self, arr: Array) -> QuantizedWeightHandle {
        if let Some(idx) = self.weight_free_list.pop() {
            self.weight_generations[idx] += 1;
            self.weight_arrays[idx] = Some(arr);
            QuantizedWeightHandle {
                slot: idx as u32,
                generation: self.weight_generations[idx],
            }
        } else {
            let idx = self.weight_arrays.len();
            self.weight_arrays.push(Some(arr));
            self.weight_generations.push(1);
            QuantizedWeightHandle {
                slot: idx as u32,
                generation: 1,
            }
        }
    }

    /// Get an immutable reference to the array at `handle`, validating
    /// slot and generation.
    fn get(&self, handle: TensorHandle) -> Result<&Array, String> {
        let slot = handle.slot as usize;
        let gen = handle.generation;
        match self.arrays.get(slot) {
            Some(Some(arr)) if gen == self.generations[slot] => Ok(arr),
            _ => Err(format!(
                "MlxBackend: invalid tensor handle (slot={}, gen={})",
                slot, gen,
            )),
        }
    }

    /// Get a mutable reference to the array at `handle`, validating
    /// slot and generation.
    fn get_mut(&mut self, handle: TensorHandle) -> Result<&mut Array, String> {
        let slot = handle.slot as usize;
        let gen = handle.generation;
        let arr_gen = self.generations.get(slot).copied();
        if let Some(Some(arr)) = self.arrays.get_mut(slot) {
            if arr_gen == Some(gen) {
                return Ok(arr);
            }
        }
        Err(format!(
            "MlxBackend: invalid tensor handle (slot={}, gen={})",
            slot, gen,
        ))
    }

    /// Get an immutable reference to a quantized weight array at `handle`.
    fn get_weight(&self, handle: QuantizedWeightHandle) -> Result<&Array, String> {
        let slot = handle.slot as usize;
        let gen = handle.generation;
        match self.weight_arrays.get(slot) {
            Some(Some(arr)) if gen == self.weight_generations[slot] => Ok(arr),
            _ => Err(format!(
                "MlxBackend: invalid weight handle (slot={}, gen={})",
                slot, gen,
            )),
        }
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

    fn create_f32_from_bf16_bits(
        &mut self,
        data: &[u16],
        shape: &[i32],
    ) -> Result<TensorHandle, String> {
        // TODO(Phase 2): create genuine MLX bf16 array via
        //   mlx_rs::Array::from_slice_bf16 when available.
        // For now we convert bf16 bits to f32 and store as f32.
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

    fn create_owned_from_bytes(
        &mut self,
        data: &[u8],
        shape: &[i32],
        dtype: DType,
    ) -> Result<TensorHandle, String> {
        let arr = match dtype {
            DType::F32 => {
                let (prefix, aligned, suffix) = unsafe { data.align_to::<f32>() };
                if !prefix.is_empty() || !suffix.is_empty() {
                    return Err("create_owned_from_bytes: F32 data not aligned to 4 bytes".into());
                }
                Array::from_slice(aligned, shape)
            }
            DType::U32 => {
                let (prefix, aligned, suffix) = unsafe { data.align_to::<u32>() };
                if !prefix.is_empty() || !suffix.is_empty() {
                    return Err("create_owned_from_bytes: U32 data not aligned to 4 bytes".into());
                }
                Array::from_slice(aligned, shape)
            }
            DType::F16 | DType::BF16 | DType::I8 | DType::U8 | DType::I32 => {
                return Err(format!(
                    "create_owned_from_bytes: dtype {:?} is not physically supported; \
                     use create_f32_from_bf16_bits for BF16 data",
                    dtype,
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
        // --- Full descriptor validation ---
        let x_arr = self.get(x)?;
        let x_shape = x_arr.shape();
        if x_shape.len() < 2 {
            return Err("quantized_matmul: input must have at least 2 dimensions".into());
        }
        let x_m = x_shape[x_shape.len() - 2] as u32;
        let x_k = x_shape[x_shape.len() - 1] as u32;
        if x_m != op.m {
            return Err(format!(
                "quantized_matmul: input M={} != op.m={}", x_m, op.m
            ));
        }
        if x_k != op.k {
            return Err(format!(
                "quantized_matmul: input K={} != op.k={}", x_k, op.k
            ));
        }

        let w_arr = self.get_weight(w)?;
        let w_shape = w_arr.shape();
        if w_shape.len() < 2 {
            return Err("quantized_matmul: weight must have at least 2 dimensions".into());
        }
        let w_k = w_shape[w_shape.len() - 2] as u32;
        // NOTE: The last dimension of the stored quantized weight is the
        // *logical* N dimension, NOT the packed-word count.  The packed-U32
        // ABI established in Mission 0006A encodes multiple quantized values
        // per word; the physical packed dimension differs from logical N.
        // If this assumption is wrong, production weights will fail
        // validation.  Phase 2 native tensor introspection must confirm.
        let w_n_logical = w_shape[w_shape.len() - 1] as u32;
        if w_k != op.k {
            return Err(format!(
                "quantized_matmul: weight K={} != op.k={}", w_k, op.k
            ));
        }
        if w_n_logical != op.n {
            return Err(format!(
                "quantized_matmul: weight logical-N={} != op.n={}", w_n_logical, op.n
            ));
        }

        // Validate scale and bias shapes exist (generation check only)
        let _s_arr = self.get(scales)?;
        let _b_arr = self.get(biases)?;

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

        // Validate output shape matches declared M×N
        let out_shape = out.shape();
        let out_m = if out_shape.len() >= 2 {
            out_shape[out_shape.len() - 2] as u32
        } else {
            out_shape[0] as u32
        };
        if out_m != op.m {
            return Err(format!(
                "quantized_matmul: output M={} != op.m={}", out_m, op.m
            ));
        }

        let out_n = out_shape.last().copied().unwrap_or(0) as u32;
        if out_n != op.n {
            return Err(format!(
                "quantized_matmul: output N={} != op.n={}", out_n, op.n
            ));
        }

        Ok(self.alloc(out))
    }

    fn matmul(&mut self, op: &MatmulOp, a: TensorHandle, b: TensorHandle) -> Result<TensorHandle, String> {
        let a_arr = self.get(a)?;
        let b_arr = self.get(b)?;

        let a_shape = a_arr.shape();
        let b_shape = b_arr.shape();
        let a_m = if a_shape.len() >= 2 { a_shape[a_shape.len() - 2] as u32 } else { 1 };
        let a_k = a_shape.last().copied().unwrap_or(0) as u32;
        let b_k = if b_shape.len() >= 2 { b_shape[b_shape.len() - 2] as u32 } else { b_shape[0] as u32 };
        let b_n = b_shape.last().copied().unwrap_or(0) as u32;

        if a_m != op.m {
            return Err(format!("matmul: A.M={} != op.m={}", a_m, op.m));
        }
        if a_k != op.k || b_k != op.k {
            return Err(format!("matmul: K mismatch (A.K={}, B.K={}, op.k={})", a_k, b_k, op.k));
        }
        if b_n != op.n {
            return Err(format!("matmul: B.N={} != op.n={}", b_n, op.n));
        }

        let out = a_arr
            .matmul(b_arr)
            .map_err(|e| format!("matmul failed: {:?}", e))?;

        // Validate output shape
        let out_shape = out.shape();
        let out_m = if out_shape.len() >= 2 { out_shape[out_shape.len() - 2] as u32 } else { 1 };
        let out_n = out_shape.last().copied().unwrap_or(0) as u32;
        if out_m != op.m || out_n != op.n {
            return Err(format!("matmul: output ({},{}) != op ({},{})", out_m, out_n, op.m, op.n));
        }

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

    fn evaluate(
        &mut self,
        group_id: u64,
        outputs: &[TensorHandle],
    ) -> Result<EvaluationReceipt, String> {
        let start = std::time::Instant::now();

        let mut eval_calls: usize = 0;
        for &h in outputs {
            let arr = self.get(h)?;
            arr.eval().map_err(|e| format!("evaluate failed: {:?}", e))?;
            eval_calls += 1;
        }

        for &h in outputs {
            let slot = h.slot as usize;
            if slot < self.materialised.len() && h.generation == self.generations[slot] {
                self.materialised[slot] = true;
            }
        }

        let elapsed = start.elapsed();
        let (active, cached) = self.active_memory();

        Ok(EvaluationReceipt {
            group_id,
            graph_build_ns: 0,
            submit_ns: 0,
            sync_ns: elapsed.as_nanos() as u64,
            output_count: outputs.len(),
            active_memory_after: active,
            cache_memory_after: cached,
            observed_substrate: None,
            eval_calls,
        })
    }

    fn read_f32(&mut self, handle: TensorHandle) -> Result<ReadbackReceipt, String> {
        let start = std::time::Instant::now();

        let was_materialised = {
            let slot = handle.slot as usize;
            slot < self.materialised.len()
                && handle.generation == self.generations[slot]
                && self.materialised[slot]
        };

        let (data, sync_ns): (Vec<f32>, u64) = match self.get(handle) {
            Ok(arr) => {
                arr.eval().map_err(|e| format!("read_f32 eval failed: {:?}", e))?;
                let elapsed = start.elapsed();
                let data = arr
                    .try_as_slice::<f32>()
                    .map(|s| s.to_vec())
                    .map_err(|e| format!("read_f32 failed: {:?}", e))?;
                (data, elapsed.as_nanos() as u64)
            }
            Err(e) => return Err(e),
        };

        if !was_materialised {
            let slot = handle.slot as usize;
            if slot < self.materialised.len() && handle.generation == self.generations[slot] {
                self.materialised[slot] = true;
            }
        }

        Ok(ReadbackReceipt {
            data,
            forced_eval: !was_materialised,
            sync_ns,
            observed_substrate: None,
        })
    }

    fn shape(&self, handle: TensorHandle) -> Result<Vec<i32>, String> {
        let arr = self.get(handle)?;
        Ok(arr.shape().to_vec())
    }

    fn release(&mut self, handle: TensorHandle) -> Result<(), String> {
        let slot = handle.slot as usize;
        let gen = handle.generation;

        // Validate slot and generation match
        if slot >= self.arrays.len() {
            return Err(format!("release: invalid handle (slot={}, gen={})", slot, gen));
        }
        let current_gen = self.generations[slot];
        if gen != current_gen {
            return Err(format!(
                "release: stale handle (slot={}, gen={}, current={})",
                slot, gen, current_gen,
            ));
        }
        if self.arrays[slot].is_none() {
            return Err(format!("release: handle already released (slot={}, gen={})", slot, gen));
        }

        self.arrays[slot] = None;
        self.generations[slot] += 1;
        self.free_list.push(slot);
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

    fn backend_capabilities(&self) -> BackendCapabilities {
        BackendCapabilities {
            can_gpu: cfg!(target_os = "macos"),
            can_cpu: true,
            supports_quantized: true,
            supports_bf16_native: false,
            backend_name: self.name.clone(),
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
