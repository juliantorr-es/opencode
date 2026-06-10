//! Accelerate CPU backend — vDSP, BLAS, BNNS, vForce.
//!
//! This is a scaffolding backend. Every primitive returns "not yet
//! implemented" until native Accelerate FFI bindings are added.
//! The operation-to-sublibrary mappings document which Accelerate
//! component handles each operation family.

use super::routing::*;
use super::accelerate_ffi;
use super::*;

/// Sublibrary within the Accelerate framework.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AccelerateSubLibrary {
    Blas,   // matrix operations
    VDsp,   // signal processing, element-wise
    Bnns,   // neural network primitives
    VForce, // transcendental functions
}

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
        // Not supported as single operations on Accelerate:
        OperationFamily::MlpBlock
        | OperationFamily::AttentionBlock
        | OperationFamily::DecoderLayer
        | OperationFamily::PrefillFragment
        | OperationFamily::IndexSelect => None,
    }
}

/// Accelerate CPU backend.
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

    pub fn with_name(name: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            tensors: Vec::new(),
            generations: Vec::new(),
            shapes: Vec::new(),
            free_list: Vec::new(),
        }
    }

    /// Dispatch a single operation through the routing layer
    /// (inherent method — not part of TensorBackend).
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
    fn default() -> Self {
        Self::new()
    }
}

impl TensorBackend for AccelerateBackend {
    fn create_f32(&mut self, data: &[f32], shape: &[i32]) -> Result<TensorHandle, String> {
        let idx = if let Some(idx) = self.free_list.pop() {
            self.generations[idx] += 1;
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
        Ok(TensorHandle {
            slot: idx as u32,
            generation: self.generations[idx],
        })
    }
    fn create_u32(&mut self, _data: &[u32], _shape: &[i32]) -> Result<TensorHandle, String> {
        Err("AccelerateBackend: create_u32 not yet implemented".into())
    }
    fn create_f32_from_bf16_bits(
        &mut self,
        _data: &[u16],
        _shape: &[i32],
    ) -> Result<TensorHandle, String> {
        Err("AccelerateBackend: create_f32_from_bf16_bits not yet implemented".into())
    }
    fn create_owned_from_bytes(
        &mut self,
        _data: &[u8],
        _shape: &[i32],
        _dtype: DType,
    ) -> Result<TensorHandle, String> {
        Err("AccelerateBackend: create_owned_from_bytes not yet implemented".into())
    }
    fn quantized_matmul(
        &mut self,
        _op: &QuantizedMatmulOp,
        _x: TensorHandle,
        _w: QuantizedWeightHandle,
        _scales: TensorHandle,
        _biases: TensorHandle,
    ) -> Result<TensorHandle, String> {
        Err("AccelerateBackend: quantized_matmul not yet implemented".into())
    }
    fn matmul(&mut self, op: &MatmulOp, a: TensorHandle, b: TensorHandle) -> Result<TensorHandle, String> {
        let a_data = self.read_f32(a)?;
        let b_data = self.read_f32(b)?;

        let m = op.m as i32;
        let n = op.n as i32;
        let k = op.k as i32;
        let mut c_data = vec![0.0f32; (m * n) as usize];

        let alpha: f32 = 1.0;
        let beta: f32 = 0.0;

        unsafe {
            accelerate_ffi::cblas_sgemm(
                accelerate_ffi::CBLAS_ROW_MAJOR,
                accelerate_ffi::CBLAS_NO_TRANS,
                accelerate_ffi::CBLAS_NO_TRANS,
                m,
                n,
                k,
                &alpha as *const f32,
                a_data.data.as_ptr(),
                k,
                b_data.data.as_ptr(),
                n,
                &beta as *const f32,
                c_data.as_mut_ptr(),
                n,
            );
        }

        let out = self.create_f32(&c_data, &[m, n])?;
        Ok(out)
    }
    fn rms_norm(
        &mut self,
        _op: &RmsNormOp,
        _x: TensorHandle,
        _weight: TensorHandle,
    ) -> Result<TensorHandle, String> {
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
    fn transpose(
        &mut self,
        _x: TensorHandle,
        _dims: &[i32],
    ) -> Result<TensorHandle, String> {
        Err("AccelerateBackend: transpose not yet implemented".into())
    }
    fn reshape(
        &mut self,
        _x: TensorHandle,
        _shape: &[i32],
    ) -> Result<TensorHandle, String> {
        Err("AccelerateBackend: reshape not yet implemented".into())
    }
    fn softmax(&mut self, _x: TensorHandle, _axis: i32) -> Result<TensorHandle, String> {
        Err("AccelerateBackend: softmax not yet implemented".into())
    }
    fn index_select(
        &mut self,
        _x: TensorHandle,
        _indices: &[u32],
        _axis: i32,
    ) -> Result<TensorHandle, String> {
        Err("AccelerateBackend: index_select not yet implemented".into())
    }
    fn evaluate(
        &mut self,
        _group_id: u64,
        _outputs: &[TensorHandle],
    ) -> Result<EvaluationReceipt, String> {
        Err("AccelerateBackend: evaluate not yet implemented".into())
    }
    fn read_f32(&mut self, handle: TensorHandle) -> Result<ReadbackReceipt, String> {
        let slot = handle.slot as usize;
        let gen = handle.generation;
        match self.tensors.get(slot) {
            Some(Some(data)) if gen == self.generations[slot] => Ok(ReadbackReceipt {
                data: data.clone(),
                forced_eval: false,
                sync_ns: 0,
                observed_substrate: Some("accelerate".into()),
            }),
            _ => Err(format!(
                "AccelerateBackend: invalid tensor handle (slot={}, gen={})",
                slot, gen,
            )),
        }
    }
    fn shape(&self, handle: TensorHandle) -> Result<Vec<i32>, String> {
        let slot = handle.slot as usize;
        let gen = handle.generation;
        match self.shapes.get(slot) {
            Some(Some(shape)) if gen == self.generations[slot] => Ok(shape.clone()),
            _ => Err(format!(
                "AccelerateBackend: invalid tensor handle (slot={}, gen={})",
                slot, gen,
            )),
        }
    }
    fn release(&mut self, handle: TensorHandle) -> Result<(), String> {
        let slot = handle.slot as usize;
        let gen = handle.generation;
        match self.tensors.get(slot) {
            Some(Some(_)) if gen == self.generations[slot] => {
                self.tensors[slot] = None;
                self.shapes[slot] = None;
                self.free_list.push(slot);
                Ok(())
            }
            _ => Err(format!(
                "AccelerateBackend: invalid tensor handle (slot={}, gen={})",
                slot, gen,
            )),
        }
    }
    fn active_memory(&self) -> (u64, u64) {
        let active: u64 = self
            .tensors
            .iter()
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
