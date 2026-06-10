//! Accelerate CPU backend — vDSP, BLAS, BNNS, vForce.
//!
//! F32 matmul wired via cblas_sgemm.  All other primitives return
//! "not yet implemented" until native bindings are added.

use super::accelerate_ffi;
use super::routing::*;
use super::*;

/// Maps an operation family to the appropriate Accelerate sublibrary.
pub fn sublibrary_for(family: OperationFamily) -> Option<AccelerateSubLibrary> {
    match family {
        OperationFamily::Matmul => Some(AccelerateSubLibrary::Blas),
        OperationFamily::QuantizedMatmul => Some(AccelerateSubLibrary::Bnns),
        OperationFamily::RmsNorm => Some(AccelerateSubLibrary::Bnns),
        OperationFamily::RoPE => Some(AccelerateSubLibrary::VDsp),
        OperationFamily::Silu => Some(AccelerateSubLibrary::VForce),
        OperationFamily::Add => Some(AccelerateSubLibrary::VDsp),
        OperationFamily::Multiply => Some(AccelerateSubLibrary::VDsp),
        OperationFamily::Softmax => Some(AccelerateSubLibrary::Bnns),
        OperationFamily::Transpose => Some(AccelerateSubLibrary::VDsp),
        OperationFamily::Reshape => Some(AccelerateSubLibrary::VDsp),
        OperationFamily::Reduction => Some(AccelerateSubLibrary::VDsp),
        OperationFamily::Sampling => Some(AccelerateSubLibrary::VDsp),
        OperationFamily::LayoutTransform => Some(AccelerateSubLibrary::VDsp),
        OperationFamily::Checksum => Some(AccelerateSubLibrary::VDsp),
        OperationFamily::MlpBlock
        | OperationFamily::AttentionBlock
        | OperationFamily::DecoderLayer
        | OperationFamily::PrefillFragment
        | OperationFamily::IndexSelect => None,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AccelerateSubLibrary {
    Blas,
    VDsp,
    Bnns,
    VForce,
}

pub struct AccelerateBackend {
    name: String,
    tensors: Vec<Option<Vec<f32>>>,
    generations: Vec<u32>,
    shapes: Vec<Option<Vec<i32>>>,
    free_list: Vec<usize>,
}

impl AccelerateBackend {
    pub fn new() -> Self {
        Self {
            name: "accelerate".into(),
            tensors: Vec::new(),
            generations: Vec::new(),
            shapes: Vec::new(),
            free_list: Vec::new(),
        }
    }

    /// Immutable access to backend-resident f32 data (no copy).
    fn data(&self, handle: TensorHandle) -> Result<&[f32], String> {
        let slot = handle.slot as usize;
        match self.tensors.get(slot) {
            Some(Some(data)) if handle.generation == self.generations[slot] => Ok(data),
            _ => Err(format!("AccelerateBackend: invalid handle slot={slot} gen={}", handle.generation)),
        }
    }

    /// Shape of a stored tensor (immutable access).
    fn stored_shape(&self, handle: TensorHandle) -> Result<&[i32], String> {
        let slot = handle.slot as usize;
        match self.shapes.get(slot) {
            Some(Some(shape)) if handle.generation == self.generations[slot] => Ok(shape),
            _ => Err(format!("AccelerateBackend: invalid handle slot={slot}")),
        }
    }

    pub fn execute(
        &mut self,
        operation: &OperationDescriptor,
        _inputs: &[TensorHandle],
    ) -> Result<BackendExecutionReceipt, String> {
        let mapping = sublibrary_for(operation.family);
        Err(format!(
            "AccelerateBackend: {:?} maps to {:?} but native implementation not yet available",
            operation.family, mapping
        ))
    }
}

impl Default for AccelerateBackend {
    fn default() -> Self { Self::new() }
}

impl TensorBackend for AccelerateBackend {
    fn create_f32(&mut self, data: &[f32], shape: &[i32]) -> Result<TensorHandle, String> {
        let expected: usize = shape.iter().map(|&d| d as usize).product();
        if data.len() != expected {
            return Err(format!(
                "create_f32: data length {} != shape product {} for shape {:?}",
                data.len(), expected, shape,
            ));
        }
        let idx = if let Some(idx) = self.free_list.pop() {
            let new_gen = self.generations[idx]
                .checked_add(1)
                .ok_or_else(|| format!("AccelerateBackend: generation overflow at slot {idx}"))?;
            self.generations[idx] = new_gen;
            self.tensors[idx] = Some(data.to_vec());
            self.shapes[idx] = Some(shape.to_vec());
            idx
        } else {
            let idx = self.tensors.len();
            self.tensors.push(Some(data.to_vec()));
            self.generations.push(1);
            self.shapes.push(Some(shape.to_vec()));
            idx
        };
        Ok(TensorHandle { slot: idx as u32, generation: self.generations[idx] })
    }

    fn create_u32(&mut self, _data: &[u32], _shape: &[i32]) -> Result<TensorHandle, String> {
        Err("AccelerateBackend: create_u32 not yet implemented".into())
    }
    fn create_f32_from_bf16_bits(&mut self, _data: &[u16], _shape: &[i32]) -> Result<TensorHandle, String> {
        Err("AccelerateBackend: create_f32_from_bf16_bits not yet implemented".into())
    }
    fn create_owned_from_bytes(&mut self, _data: &[u8], _shape: &[i32], _dtype: DType) -> Result<TensorHandle, String> {
        Err("AccelerateBackend: create_owned_from_bytes not yet implemented".into())
    }
    fn quantized_matmul(&mut self, _op: &QuantizedMatmulOp, _x: TensorHandle, _w: QuantizedWeightHandle, _scales: TensorHandle, _biases: TensorHandle) -> Result<TensorHandle, String> {
        Err("AccelerateBackend: quantized_matmul not yet implemented".into())
    }

    fn matmul(&mut self, op: &MatmulOp, a: TensorHandle, b: TensorHandle) -> Result<TensorHandle, String> {
        // Shape validation before FFI
        let a_shape = self.stored_shape(a)?;
        let b_shape = self.stored_shape(b)?;
        if a_shape.len() < 2 || b_shape.len() < 2 {
            return Err("matmul: tensors must have at least 2 dimensions".into());
        }
        let a_m = a_shape[a_shape.len() - 2] as u32;
        let a_k = a_shape[a_shape.len() - 1] as u32;
        let b_k = b_shape[b_shape.len() - 2] as u32;
        let b_n = b_shape[b_shape.len() - 1] as u32;
        if a_m != op.m { return Err(format!("A.M={a_m} != op.m={}", op.m)); }
        if a_k != op.k || b_k != op.k { return Err(format!("K mismatch: A.K={a_k}, B.K={b_k}, op.k={}", op.k)); }
        if b_n != op.n { return Err(format!("B.N={b_n} != op.n={}", op.n)); }
        if op.m == 0 || op.n == 0 || op.k == 0 { return Err("matmul: dimensions must be positive".into()); }

        let m = op.m as i32;
        let n = op.n as i32;
        let k = op.k as i32;
        let out_len = (m as usize).checked_mul(n as usize)
            .ok_or("matmul: output size overflow")?;
        let mut c_data = vec![0.0f32; out_len];

        // No-copy access to resident buffers
        let a_ptr = self.data(a)?;
        let b_ptr = self.data(b)?;

        unsafe {
            accelerate_ffi::cblas_sgemm(
                accelerate_ffi::CBLAS_ROW_MAJOR,
                accelerate_ffi::CBLAS_NO_TRANS,
                accelerate_ffi::CBLAS_NO_TRANS,
                m, n, k,
                1.0f32,           // alpha — passed by value
                a_ptr.as_ptr(), k,
                b_ptr.as_ptr(), n,
                0.0f32,           // beta — passed by value
                c_data.as_mut_ptr(), n,
            );
        }

        self.create_f32(&c_data, &[m, n])
    }

    fn rms_norm(&mut self, _op: &RmsNormOp, _x: TensorHandle, _weight: TensorHandle) -> Result<TensorHandle, String> {
        Err("AccelerateBackend: rms_norm not yet implemented".into())
    }
    fn rope(&mut self, _op: &RoPEOp, _x: TensorHandle) -> Result<TensorHandle, String> {
        Err("AccelerateBackend: rope not yet implemented".into())
    }
    fn add(&mut self, _a: TensorHandle, _b: TensorHandle) -> Result<TensorHandle, String> {
        Err("AccelerateBackend: add not yet implemented".into())
    }
    fn multiply(&mut self, _a: TensorHandle, _b: TensorHandle) -> Result<TensorHandle, String> {
        Err("AccelerateBackend: multiply not yet implemented".into())
    }
    fn silu(&mut self, _x: TensorHandle) -> Result<TensorHandle, String> {
        Err("AccelerateBackend: silu not yet implemented".into())
    }
    fn transpose(&mut self, _x: TensorHandle, _dims: &[i32]) -> Result<TensorHandle, String> {
        Err("AccelerateBackend: transpose not yet implemented".into())
    }
    fn reshape(&mut self, _x: TensorHandle, _shape: &[i32]) -> Result<TensorHandle, String> {
        Err("AccelerateBackend: reshape not yet implemented".into())
    }
    fn softmax(&mut self, _x: TensorHandle, _axis: i32) -> Result<TensorHandle, String> {
        Err("AccelerateBackend: softmax not yet implemented".into())
    }
    fn index_select(&mut self, _x: TensorHandle, _indices: &[u32], _axis: i32) -> Result<TensorHandle, String> {
        Err("AccelerateBackend: index_select not yet implemented".into())
    }

    fn evaluate(&mut self, group_id: u64, outputs: &[TensorHandle]) -> Result<EvaluationReceipt, String> {
        // Accelerate executes eagerly — outputs are already materialised.
        let (active, cached) = self.active_memory();
        Ok(EvaluationReceipt {
            group_id,
            graph_build_ns: 0,
            submit_ns: 0,
            sync_ns: 0,
            output_count: outputs.len(),
            active_memory_after: active,
            cache_memory_after: cached,
            observed_substrate: Some("cpu".into()),
            eval_calls: 0,
        })
    }

    fn read_f32(&mut self, handle: TensorHandle) -> Result<ReadbackReceipt, String> {
        let data = self.data(handle)?.to_vec();
        Ok(ReadbackReceipt {
            data,
            forced_eval: false,
            sync_ns: 0,
            observed_substrate: Some("cpu".into()),
        })
    }

    fn shape(&self, handle: TensorHandle) -> Result<Vec<i32>, String> {
        self.stored_shape(handle).map(|s| s.to_vec())
    }

    fn release(&mut self, handle: TensorHandle) -> Result<(), String> {
        let slot = handle.slot as usize;
        let gen = handle.generation;
        if slot >= self.tensors.len() || self.generations[slot] != gen {
            return Err(format!("AccelerateBackend: invalid handle slot={slot} gen={gen}"));
        }
        self.tensors[slot] = None;
        self.shapes[slot] = None;
        self.free_list.push(slot);
        Ok(())
    }

    fn active_memory(&self) -> (u64, u64) {
        let active: u64 = self.tensors.iter()
            .filter_map(|t| t.as_ref())
            .map(|d| (d.len() * 4) as u64)
            .sum();
        (active, 0)
    }

    fn backend_capabilities(&self) -> BackendCapabilities {
        BackendCapabilities {
            can_gpu: false,
            can_cpu: true,
            supports_quantized: false,
            supports_bf16_native: false,
            backend_name: self.name.clone(),
        }
    }
}
