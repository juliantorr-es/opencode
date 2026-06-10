//! Semantic module — backend-neutral representation of model meaning.
//!
//! The [`SemanticModule`] captures every tensor and operation with logical
//! shape, dtype, quantization contract, mutability, producer/consumer
//! lineage, statefulness, aliasing restrictions, and numerical tolerance
//! class. No hardware layout, placement, or materialization decisions
//! appear here. Those belong in [`super::scheduled::ScheduledModule`].
//!
//! Stateful operations such as KV-cache updates are represented explicitly
//! rather than disguised as ordinary tensors.

use std::collections::HashMap;

use crate::backend::DType;
use crate::backend::routing::{
    EvidenceDigest, LogicalShape, OperationFamily, OperationId, Phase,
    QuantizationContract, TensorId,
};

// ── Semantic tensor ────────────────────────────────────────────────────────

/// A tensor in the semantic graph — carries logical identity, shape,
/// dtype, and lineage without any physical layout or placement.
#[derive(Debug, Clone)]
pub struct SemanticTensor {
    /// Stable logical identifier.
    pub id: TensorId,
    /// Human-readable name within the model graph.
    pub name: String,
    /// Logical shape (no layout-specific stride or padding).
    pub shape: LogicalShape,
    /// Element type.
    pub dtype: DType,
    /// Whether this tensor may be mutated after creation.
    pub mutable: bool,
    /// Semantic role in the model (e.g. "weight", "activation", "kv_cache").
    pub role: TensorRole,
    /// Quantization contract if this tensor is quantized.
    pub quantization: Option<QuantizationContract>,
    /// Which operation produced this tensor.
    pub producer: Option<OperationId>,
    /// Which operations consume this tensor.
    pub consumers: Vec<OperationId>,
    /// Numerical tolerance class for correctness checking.
    pub tolerance_class: ToleranceClass,
    /// Whether this tensor may alias another tensor (shared storage).
    pub aliases: Vec<TensorId>,
}

/// Semantic role of a tensor in the model graph.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TensorRole {
    /// Trainable model weight.
    Weight,
    /// Activation flowing between layers.
    Activation,
    /// KV-cache entry (stateful across tokens).
    KvCache,
    /// Bias parameter.
    Bias,
    /// Normalization scale (gamma/beta).
    NormScale,
    /// Attention mask.
    Mask,
    /// Model input (token embeddings or prefill).
    Input,
    /// Model output (logits or hidden state).
    Output,
    /// Intermediate temporary (discarded after region).
    Intermediate,
}

/// Numerical tolerance class for correctness comparison.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum ToleranceClass {
    /// Exact match required (identity operations, copies).
    Exact,
    /// fp16-level tolerance (~1e-3 relative).
    Fp16,
    /// fp32-level tolerance (~1e-6 relative).
    Fp32,
    /// Quantized tolerance (model-specific).
    Quantized { bits: u8 },
    /// Custom tolerance contract.
    Custom { epsilon: f64, relative: bool },
}

// ── Semantic operation ─────────────────────────────────────────────────────

/// An operation in the semantic graph — described purely by its logical
/// contract without any backend or layout selection.
#[derive(Debug, Clone)]
pub struct SemanticOp {
    /// Stable logical identifier.
    pub id: OperationId,
    /// Human-readable name.
    pub name: String,
    /// Operation classification.
    pub family: OperationFamily,
    /// Which model layer contains this operation (0-indexed).
    pub layer_index: Option<u32>,
    /// Execution phase (prefill, decode, conditioning, qualification).
    pub phase: Phase,
    /// Input tensors (logical IDs).
    pub inputs: Vec<TensorId>,
    /// Output tensors (logical IDs).
    pub outputs: Vec<TensorId>,
    /// Whether this operation is stateful (mutates KV cache or other state).
    pub stateful: bool,
    /// State tensors read by this operation (e.g. KV cache read).
    pub state_reads: Vec<TensorId>,
    /// State tensors written by this operation (e.g. KV cache write).
    pub state_writes: Vec<TensorId>,
    /// Quantization contract for inputs/outputs.
    pub quantization: Option<QuantizationContract>,
    /// Tolerance class for numerical verification.
    pub tolerance_class: ToleranceClass,
}

// ── Semantic module ────────────────────────────────────────────────────────

/// The complete backend-neutral semantic representation of a model.
///
/// Carries enough information to validate model correctness, perform
/// shape inference, attribute quantization policies, and track tensor
/// lineage without committing to any physical layout or backend.
#[derive(Debug, Clone)]
pub struct SemanticModule {
    /// Module identity — content-addressed digest of the semantic graph.
    pub digest: EvidenceDigest,
    /// All tensors in the model graph, keyed by stable ID.
    pub tensors: HashMap<TensorId, SemanticTensor>,
    /// All operations in the model graph, in topological execution order.
    pub operations: Vec<SemanticOp>,
    /// Named model inputs.
    pub inputs: Vec<TensorId>,
    /// Named model outputs.
    pub outputs: Vec<TensorId>,
    /// Stateful tensors that persist across invocations.
    pub state: Vec<TensorId>,
    /// Model-level numerical contract (global tolerance policy).
    pub model_contract: ModelContract,
}

/// Global numerical contract for the model.
#[derive(Debug, Clone)]
pub struct ModelContract {
    /// Default tolerance class when not specified per-tensor.
    pub default_tolerance: ToleranceClass,
    /// Whether quantized execution is permitted.
    pub quantization_allowed: bool,
    /// Model architecture identifier.
    pub architecture: String,
    /// Model version.
    pub version: String,
}

impl SemanticModule {
    /// Create a new empty semantic module.
    pub fn new(architecture: &str, version: &str) -> Self {
        Self {
            digest: EvidenceDigest(String::new()),
            tensors: HashMap::new(),
            operations: Vec::new(),
            inputs: Vec::new(),
            outputs: Vec::new(),
            state: Vec::new(),
            model_contract: ModelContract {
                default_tolerance: ToleranceClass::Fp32,
                quantization_allowed: true,
                architecture: architecture.to_string(),
                version: version.to_string(),
            },
        }
    }

    /// Declare a model input tensor.
    pub fn declare_input(
        &mut self,
        id: TensorId,
        name: &str,
        shape: LogicalShape,
        dtype: DType,
    ) -> &mut SemanticTensor {
        self.inputs.push(id);
        self.tensors.entry(id).or_insert_with(|| SemanticTensor {
            id,
            name: name.to_string(),
            shape,
            dtype,
            mutable: false,
            role: TensorRole::Input,
            quantization: None,
            producer: None,
            consumers: Vec::new(),
            tolerance_class: self.model_contract.default_tolerance,
            aliases: Vec::new(),
        })
    }

    /// Declare a model output tensor.
    pub fn declare_output(&mut self, id: TensorId) {
        self.outputs.push(id);
        if let Some(t) = self.tensors.get_mut(&id) {
            t.role = TensorRole::Output;
        }
    }

    /// Add a weight tensor.
    pub fn add_weight(
        &mut self,
        id: TensorId,
        name: &str,
        shape: LogicalShape,
        dtype: DType,
        quantization: Option<QuantizationContract>,
    ) -> &mut SemanticTensor {
        self.tensors.entry(id).or_insert_with(|| SemanticTensor {
            id,
            name: name.to_string(),
            shape,
            dtype,
            mutable: false,
            role: TensorRole::Weight,
            quantization,
            producer: None,
            consumers: Vec::new(),
            tolerance_class: self.model_contract.default_tolerance,
            aliases: Vec::new(),
        })
    }

    /// Add an activation tensor (produced by an operation).
    pub fn add_activation(
        &mut self,
        id: TensorId,
        name: &str,
        shape: LogicalShape,
        dtype: DType,
        producer: OperationId,
    ) -> &mut SemanticTensor {
        self.tensors.entry(id).or_insert_with(|| SemanticTensor {
            id,
            name: name.to_string(),
            shape,
            dtype,
            mutable: false,
            role: TensorRole::Activation,
            quantization: None,
            producer: Some(producer),
            consumers: Vec::new(),
            tolerance_class: self.model_contract.default_tolerance,
            aliases: Vec::new(),
        })
    }

    /// Add a stateful tensor (e.g. KV cache).
    pub fn add_state(
        &mut self,
        id: TensorId,
        name: &str,
        shape: LogicalShape,
        dtype: DType,
    ) -> &mut SemanticTensor {
        self.state.push(id);
        self.tensors.entry(id).or_insert_with(|| SemanticTensor {
            id,
            name: name.to_string(),
            shape,
            dtype,
            mutable: true,
            role: TensorRole::KvCache,
            quantization: None,
            producer: None,
            consumers: Vec::new(),
            tolerance_class: self.model_contract.default_tolerance,
            aliases: Vec::new(),
        })
    }

    /// Register an operation in the semantic graph. Updates
    /// producer/consumer edges on referenced tensors.
    pub fn push_op(&mut self, op: SemanticOp) {
        let op_id = op.id;
        for &input_id in &op.inputs {
            if let Some(t) = self.tensors.get_mut(&input_id) {
                t.consumers.push(op_id);
            }
        }
        for &output_id in &op.outputs {
            if let Some(t) = self.tensors.get_mut(&output_id) {
                t.producer = Some(op_id);
            }
        }
        self.operations.push(op);
    }

    /// Compute the content-addressed digest of this semantic module.
    pub fn seal(&mut self) -> EvidenceDigest {
        use sha2::{Digest, Sha256};
        let mut h = Sha256::new();
        for op in &self.operations {
            h.update(format!("{:?}", op.id.0).as_bytes());
            h.update(op.name.as_bytes());
            h.update(format!("{:?}", op.family).as_bytes());
        }
        let digest = format!("{:x}", h.finalize());
        self.digest = EvidenceDigest(digest.clone());
        self.digest.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backend::routing::{OperationFamily, Phase};

    #[test]
    fn build_semantic_matmul() {
        let mut m = SemanticModule::new("test", "0.1.0");

        let a = TensorId(1);
        let b = TensorId(2);
        let c = TensorId(3);

        m.declare_input(a, "a", LogicalShape { dims: vec![1, 4] }, DType::F32);
        m.add_weight(b, "w", LogicalShape { dims: vec![4, 1] }, DType::F32, None);
        m.add_activation(c, "out", LogicalShape { dims: vec![1, 1] }, DType::F32, OperationId(1));

        m.push_op(SemanticOp {
            id: OperationId(1),
            name: "matmul".into(),
            family: OperationFamily::Matmul,
            layer_index: None,
            phase: Phase::Qualification,
            inputs: vec![a, b],
            outputs: vec![c],
            stateful: false,
            state_reads: vec![],
            state_writes: vec![],
            quantization: None,
            tolerance_class: ToleranceClass::Fp16,
        });

        m.declare_output(c);
        let digest = m.seal();

        assert!(!digest.0.is_empty());
        assert_eq!(m.operations.len(), 1);
        assert_eq!(m.tensors.len(), 3);
        assert_eq!(m.inputs.len(), 1);
        assert_eq!(m.outputs.len(), 1);

        // Verify producer/consumer edges
        let t_c = m.tensors.get(&c).unwrap();
        assert_eq!(t_c.producer, Some(OperationId(1)));
        let t_a = m.tensors.get(&a).unwrap();
        assert_eq!(t_a.consumers, vec![OperationId(1)]);
    }
}
