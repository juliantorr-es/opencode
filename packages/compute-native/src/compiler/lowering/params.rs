//! Core ML lowering parameter types — opcode, shape policy, target,
//! precision, parameter schema, storage encoding.

use crate::backend::routing::{OperationId, TensorId, TensorShape};

// ── Opcode ─────────────────────────────────────────────────────────────────

/// Fieldless opcode for the Core ML operation registry.
/// No data-bearing attributes — those belong on the `ScheduledOp`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Opcode {
    Constant,
    Identity,
    Add,
    Multiply,
    Matmul,
    Reshape,
    Transpose,
    Softmax,
    Silu,
}

impl Opcode {
    /// Human-readable name for diagnostics.
    pub fn name(&self) -> &'static str {
        match self {
            Opcode::Constant => "constant",
            Opcode::Identity => "identity",
            Opcode::Add => "add",
            Opcode::Multiply => "multiply",
            Opcode::Matmul => "matmul",
            Opcode::Reshape => "reshape",
            Opcode::Transpose => "transpose",
            Opcode::Softmax => "softmax",
            Opcode::Silu => "silu",
        }
    }
}

// ── ScheduledOp ────────────────────────────────────────────────────────────

/// A concrete operation in a scheduled region, with Core ML-specific
/// attributes attached.
#[derive(Debug, Clone)]
pub struct ScheduledOp {
    /// Stable operation identifier.
    pub op_id: OperationId,
    /// Core ML opcode.
    pub opcode: Opcode,
    /// Input tensor IDs.
    pub inputs: Vec<TensorId>,
    /// Output tensor IDs.
    pub outputs: Vec<TensorId>,
    /// Op-specific attributes.
    pub attrs: OpAttrs,
}

/// Per-op attributes for the 9-op envelope.
#[derive(Debug, Clone)]
pub enum OpAttrs {
    Constant {
        /// Row-major F32 data.
        data: Vec<f32>,
        /// Shape of the constant tensor.
        shape: Vec<u32>,
    },
    Identity,
    Add,
    Multiply,
    Matmul {
        transpose_x: bool,
        transpose_y: bool,
    },
    Reshape {
        /// Target shape. One dimension may be -1 (inferred).
        target_shape: Vec<i64>,
    },
    Transpose {
        /// Full permutation (e.g. [1, 0] for 2D transpose).
        permutation: Vec<u32>,
    },
    Softmax {
        /// Normalized axis.
        axis: i64,
    },
    Silu,
}

// ── Precision policy ──────────────────────────────────────────────────────

/// Three distinct precision concerns in one policy.
/// This gate only supports F32 for all three.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PrecisionPolicy {
    /// Compute F32, weights F32, interface F32.
    F32,
    /// Refused in this gate.
    Fp16,
}

impl PrecisionPolicy {
    pub fn name(&self) -> &'static str {
        match self {
            PrecisionPolicy::F32 => "fp32",
            PrecisionPolicy::Fp16 => "fp16",
        }
    }

    /// Returns Ok if this precision is supported by this gate.
    pub fn validate(&self) -> Result<(), &'static str> {
        match self {
            PrecisionPolicy::F32 => Ok(()),
            PrecisionPolicy::Fp16 => Err("FP16 not supported in this gate"),
        }
    }
}

// ── Shape policy ──────────────────────────────────────────────────────────

/// How a tensor shape is constrained.
/// Only `Fixed` is accepted in this gate.
#[derive(Debug, Clone)]
pub enum ShapePolicy {
    Fixed(Vec<u32>),
    Bounded { default: Vec<u32>, min: Vec<u32>, max: Vec<u32> },
    Enumerated { default: Vec<u32>, alternatives: Vec<Vec<u32>> },
    Symbolic { named_dims: Vec<NamedDim> },
}

impl ShapePolicy {
    pub fn name(&self) -> &'static str {
        match self {
            ShapePolicy::Fixed(_) => "fixed",
            ShapePolicy::Bounded { .. } => "bounded",
            ShapePolicy::Enumerated { .. } => "enumerated",
            ShapePolicy::Symbolic { .. } => "symbolic",
        }
    }

    /// Returns Ok only for Fixed. Others return a structured refusal.
    pub fn validate(&self) -> Result<(), String> {
        match self {
            ShapePolicy::Fixed(_) => Ok(()),
            ShapePolicy::Bounded { .. } => Err("bounded shapes not supported in this gate".into()),
            ShapePolicy::Enumerated { .. } => Err("enumerated shapes not supported in this gate".into()),
            ShapePolicy::Symbolic { .. } => Err("symbolic shapes not supported in this gate".into()),
        }
    }
}

/// A named symbolic dimension (for future use).
#[derive(Debug, Clone)]
pub struct NamedDim {
    pub name: String,
    pub size: u32,
}

// ── Storage encoding ──────────────────────────────────────────────────────

/// How weight data is stored in a constant.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum StorageEncoding {
    F32LittleEndian,
    Fp16LittleEndian,
    U8,
    I32,
}

impl StorageEncoding {
    pub fn name(&self) -> &'static str {
        match self {
            StorageEncoding::F32LittleEndian => "fp32le",
            StorageEncoding::Fp16LittleEndian => "fp16le",
            StorageEncoding::U8 => "u8",
            StorageEncoding::I32 => "i32",
        }
    }
}

// ── Target model ──────────────────────────────────────────────────────────

/// Validated target profile — indivisible compatibility row.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CoreMlTarget {
    /// macOS 13 / iOS 16 / Core ML 6 — spec 7, opset CoreML6.
    MacOS13,
    /// macOS 14 / iOS 17 / Core ML 7 — spec 8, opset CoreML7.
    MacOS14,
    /// macOS 15 / iOS 18 / Core ML 8 — spec 9, opset CoreML8.
    MacOS15,
}

impl CoreMlTarget {
    pub fn default_gate_target() -> Self {
        CoreMlTarget::MacOS13
    }

    pub fn spec_version(&self) -> u32 {
        match self {
            CoreMlTarget::MacOS13 => 7,
            CoreMlTarget::MacOS14 => 8,
            CoreMlTarget::MacOS15 => 9,
        }
    }

    pub fn deployment_target(&self) -> &'static str {
        match self {
            CoreMlTarget::MacOS13 => "macOS13",
            CoreMlTarget::MacOS14 => "macOS14",
            CoreMlTarget::MacOS15 => "macOS15",
        }
    }

    pub fn opset_identifier(&self) -> &'static str {
        match self {
            CoreMlTarget::MacOS13 => "CoreML6",
            CoreMlTarget::MacOS14 => "CoreML7",
            CoreMlTarget::MacOS15 => "CoreML8",
        }
    }
}

// ── OpParamSchema ─────────────────────────────────────────────────────────

/// Typed parameter schema mapping scheduled attributes to MIL input bindings.
#[derive(Debug, Clone)]
pub struct OpParamSchema {
    /// Constant-value inputs emitted alongside tensor inputs.
    pub constant_inputs: Vec<(String, mil_spec_value)>,
    /// Tensor inputs resolved from value_bindings.
    pub tensor_inputs: Vec<(String, TensorId)>,
}

// Re-export mil_spec::Value as mil_spec_value for the schema.
use coreml_proto::proto::mil_spec;
type mil_spec_value = mil_spec::Value;

// ── LoweringDiagnostic ─────────────────────────────────────────────────────

/// Structured diagnostic from the lowering pass.
#[derive(Debug, Clone)]
pub enum LoweringDiagnostic {
    UnsupportedOp {
        op_id: OperationId,
        opcode: Opcode,
        reason: String,
        suggestion: Option<String>,
    },
    ShapePolicyUnsupported {
        op_id: OperationId,
        policy: String,
    },
    ShapeMismatch {
        op_id: OperationId,
        tensor: TensorId,
        expected: String,
        found: String,
    },
    PrecisionUnsupported {
        op_id: OperationId,
        requested: String,
        supported: Vec<String>,
    },
    ConstraintViolation {
        op_id: OperationId,
        constraint: String,
        detail: String,
    },
    Warning {
        op_id: OperationId,
        message: String,
    },
}

impl LoweringDiagnostic {
    pub fn is_fatal(&self) -> bool {
        !matches!(self, LoweringDiagnostic::Warning { .. })
    }

    pub fn message(&self) -> String {
        match self {
            LoweringDiagnostic::UnsupportedOp { op_id, opcode, reason, .. } => {
                format!("op {:?} ({}): {}", op_id, opcode.name(), reason)
            }
            LoweringDiagnostic::ShapePolicyUnsupported { op_id, policy } => {
                format!("op {:?}: shape policy '{}' not supported", op_id, policy)
            }
            LoweringDiagnostic::ShapeMismatch { op_id, tensor, expected, found } => {
                format!("op {:?}: tensor {:?} expected {}, found {}", op_id, tensor, expected, found)
            }
            LoweringDiagnostic::PrecisionUnsupported { op_id, requested, supported } => {
                format!("op {:?}: precision '{}' not supported (supported: {:?})", op_id, requested, supported)
            }
            LoweringDiagnostic::ConstraintViolation { op_id, constraint, detail } => {
                format!("op {:?}: constraint '{}' violated: {}", op_id, constraint, detail)
            }
            LoweringDiagnostic::Warning { op_id, message } => {
                format!("op {:?}: {}", op_id, message)
            }
        }
    }
}

// ── LoweringDiagnostic ─────────────────────────────────────────────────────

/// Structured error from the Core ML lowering pass.
#[derive(Debug, Clone)]
pub struct CoreMlLoweringError {
    pub region_identity: String,
    pub fatal: Vec<LoweringDiagnostic>,
    pub warnings: Vec<LoweringDiagnostic>,
    pub source: Option<String>,
}

impl CoreMlLoweringError {
    pub fn new(region_identity: &str) -> Self {
        Self {
            region_identity: region_identity.to_string(),
            fatal: Vec::new(),
            warnings: Vec::new(),
            source: None,
        }
    }

    pub fn with_fatal(mut self, d: LoweringDiagnostic) -> Self {
        self.fatal.push(d);
        self
    }

    pub fn with_warning(mut self, d: LoweringDiagnostic) -> Self {
        self.warnings.push(d);
        self
    }

    pub fn with_source(mut self, s: String) -> Self {
        self.source = Some(s);
        self
    }
}

impl std::fmt::Display for CoreMlLoweringError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "CoreMlLoweringError [{}]", self.region_identity)?;
        for d in &self.fatal {
            write!(f, "\n  fatal: {}", d.message())?;
        }
        for d in &self.warnings {
            write!(f, "\n  warning: {}", d.message())?;
        }
        if let Some(ref s) = self.source {
            write!(f, "\n  source: {}", s)?;
        }
        Ok(())
    }
}

// ── MilValueRef ───────────────────────────────────────────────────────────

/// Reference to an SSA value in the MIL program being built.
#[derive(Debug, Clone)]
pub struct MilValueRef {
    /// SSA name in the MIL program.
    pub ssa_name: String,
    /// MIL type of the value.
    pub value_type: mil_spec::ValueType,
    /// MIL op type that produced this value.
    pub producing_op: String,
    /// Output index (for multi-output ops).
    pub output_index: u32,
}

impl MilValueRef {
    pub fn new(ssa_name: String, value_type: mil_spec::ValueType, producing_op: &str) -> Self {
        Self {
            ssa_name,
            value_type,
            producing_op: producing_op.to_string(),
            output_index: 0,
        }
    }
}

// ── TensorMeta ─────────────────────────────────────────────────────────────

/// Per-tensor metadata tracked during lowering.
#[derive(Debug, Clone)]
pub struct TensorMeta {
    pub dtype: mil_spec::DataType,
    pub shape_policy: ShapePolicy,
    pub is_input: bool,
    pub is_output: bool,
    pub is_constant: bool,
}
