//! Inference pipeline parity contract.
//!
//! Defines the 18 canonical inference pipeline phases, per-phase contracts
//! with structured multi-input/output tensor descriptions, per-backend
//! support matrices with typed reason codes, graph-family-to-phase mapping,
//! and comparison grouping for honest apples-to-apples backend comparison.
//!
//! ## Design rules
//!
//! - Graph families are **test artifacts**; pipeline phases are **inference
//!   semantics**. A family may map to a phase for qualification, but phases
//!   are not labels — they carry a typed contract that defines what the
//!   phase consumes, produces, tolerates, and how comparison grouping is legal.
//! - Unmapped graph families fail closed (return `Err` / `None`). The parity
//!   contract never silently assigns a fallback phase.
//! - Core ML Neural Engine placement is an opaque policy dimension (the
//!   compute-unit string), not a separate backend. No per-op ANE placement
//!   claims are made from the public contract.
//! - Comparison grouping requires semantic contract identity, not just phase
//!   name, to prevent false apples-to-apples comparisons.

use serde::{Deserialize, Serialize};
use std::fmt;
use std::str::FromStr;

use crate::decode_attribution::backend_adapters::BackendKind;
use crate::decode_attribution::backend_adapters::conformance::ConformanceMetrics;

// ═══════════════════════════════════════════════════════════════════════════
// Dim
// ═══════════════════════════════════════════════════════════════════════════

/// A dimension in a shape pattern — either a concrete size, a named symbol
/// whose binding is shared across phases in the same model, or a wildcard.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum Dim {
    /// Concrete dimension size (e.g. `Dim::Known(1)` for batch dim).
    Known(i64),
    /// Named symbolic dimension. Two `Dim::Symbol`s with the same name refer to
    /// the same dimension (e.g. `"hidden_dim"` in input and output patterns
    /// of QkvProjection).
    Symbol(&'static str),
    /// Unconstrained — matches any size.
    Any,
}

impl fmt::Display for Dim {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Dim::Known(n) => write!(f, "{n}"),
            Dim::Symbol(name) => write!(f, "{{{name}}}"),
            Dim::Any => write!(f, "*"),
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// TensorContract
// ═══════════════════════════════════════════════════════════════════════════

/// The role a tensor plays in a phase — where it enters the compute graph.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TensorRole {
    /// Primary input (the main activation tensor for this phase).
    PrimaryInput,
    /// Secondary input (residual, mask, cache, bias).
    SecondaryInput,
    /// Output tensor produced by this phase.
    Output,
}

impl fmt::Display for TensorRole {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            TensorRole::PrimaryInput => write!(f, "primary_input"),
            TensorRole::SecondaryInput => write!(f, "secondary_input"),
            TensorRole::Output => write!(f, "output"),
        }
    }
}

/// Description of one tensor entering or leaving a pipeline phase.
#[derive(Debug, Clone, Copy)]
pub struct TensorContract {
    /// Canonical name (e.g. "q", "k", "v", "hidden", "residual", "mask", "logits").
    pub name: &'static str,
    /// Role in the phase.
    pub role: TensorRole,
    /// Shape pattern (e.g. `[Dim::Known(1), Dim::Symbol("hidden_dim")]`).
    pub shape_pattern: &'static [Dim],
    /// Element type (e.g. "float32").
    pub dtype: &'static str,
}

impl fmt::Display for TensorContract {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let dims: Vec<String> = self.shape_pattern.iter().map(|d| d.to_string()).collect();
        write!(f, "{}: {}[{}] ({})", self.name, self.role, dims.join(","), self.dtype)
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// PipelinePhase
// ═══════════════════════════════════════════════════════════════════════════

/// The 18 canonical inference pipeline phases.
///
/// Every backend MUST implement or explicitly reject each phase.
/// Backends are compared only on phases they both support.
///
/// This enum encodes inference pipeline semantics only. Harness control
/// families (e.g. `identity_passthrough`) are excluded — they map to no
/// phase and never enter comparison groups.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum PipelinePhase {
    /// Embed token IDs into dense vectors.
    TokenEmbedding,
    /// Apply positional encoding (RoPE or learned).
    PositionEncodingOrRope,
    /// Compute Q, K, V projections from input hidden states.
    QkvProjection,
    /// Read KV from cache.
    KvRead,
    /// Compute attention scores: Q @ K^T.
    AttentionScores,
    /// Apply causal mask to attention scores.
    MaskApply,
    /// Softmax over attention scores.
    Softmax,
    /// Weighted sum of V: softmax(QK^T) @ V.
    AttentionWeightedSum,
    /// Project attention output back to model dimension.
    AttentionOutputProjection,
    /// First residual add: attention_output + input.
    ResidualAdd1,
    /// First layer normalization (pre-MLP).
    Norm1,
    /// MLP gate + up projection (e.g., gate_proj, up_proj).
    MlpGateUp,
    /// Activation function (SiLU, ReLU, GELU, etc.).
    Activation,
    /// MLP down projection.
    MlpDown,
    /// Second residual add: mlp_output + residual.
    ResidualAdd2,
    /// Second layer normalization (pre-LM head).
    Norm2,
    /// Language model head projection (hidden → logits).
    LmHead,
    /// Sampling or logits post-processing.
    SamplingOrLogitsPostprocess,
}

impl fmt::Display for PipelinePhase {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let s = match self {
            PipelinePhase::TokenEmbedding => "token_embedding",
            PipelinePhase::PositionEncodingOrRope => "position_encoding_or_rope",
            PipelinePhase::QkvProjection => "qkv_projection",
            PipelinePhase::KvRead => "kv_read",
            PipelinePhase::AttentionScores => "attention_scores",
            PipelinePhase::MaskApply => "mask_apply",
            PipelinePhase::Softmax => "softmax",
            PipelinePhase::AttentionWeightedSum => "attention_weighted_sum",
            PipelinePhase::AttentionOutputProjection => "attention_output_projection",
            PipelinePhase::ResidualAdd1 => "residual_add_1",
            PipelinePhase::Norm1 => "norm_1",
            PipelinePhase::MlpGateUp => "mlp_gate_up",
            PipelinePhase::Activation => "activation",
            PipelinePhase::MlpDown => "mlp_down",
            PipelinePhase::ResidualAdd2 => "residual_add_2",
            PipelinePhase::Norm2 => "norm_2",
            PipelinePhase::LmHead => "lm_head",
            PipelinePhase::SamplingOrLogitsPostprocess => "sampling_or_logits_postprocess",
        };
        write!(f, "{s}")
    }
}

impl FromStr for PipelinePhase {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "token_embedding" => Ok(PipelinePhase::TokenEmbedding),
            "position_encoding_or_rope" => Ok(PipelinePhase::PositionEncodingOrRope),
            "qkv_projection" => Ok(PipelinePhase::QkvProjection),
            "kv_read" => Ok(PipelinePhase::KvRead),
            "attention_scores" => Ok(PipelinePhase::AttentionScores),
            "mask_apply" => Ok(PipelinePhase::MaskApply),
            "softmax" => Ok(PipelinePhase::Softmax),
            "attention_weighted_sum" => Ok(PipelinePhase::AttentionWeightedSum),
            "attention_output_projection" => Ok(PipelinePhase::AttentionOutputProjection),
            "residual_add_1" => Ok(PipelinePhase::ResidualAdd1),
            "norm_1" => Ok(PipelinePhase::Norm1),
            "mlp_gate_up" => Ok(PipelinePhase::MlpGateUp),
            "activation" => Ok(PipelinePhase::Activation),
            "mlp_down" => Ok(PipelinePhase::MlpDown),
            "residual_add_2" => Ok(PipelinePhase::ResidualAdd2),
            "norm_2" => Ok(PipelinePhase::Norm2),
            "lm_head" => Ok(PipelinePhase::LmHead),
            "sampling_or_logits_postprocess" => Ok(PipelinePhase::SamplingOrLogitsPostprocess),
            other => Err(format!("unknown PipelinePhase variant: '{other}'")),
        }
    }
}

impl PipelinePhase {
    /// Return all phase variants in discriminant order.
    pub fn all() -> &'static [PipelinePhase] {
        &ALL_PHASES
    }
}

const ALL_PHASES: [PipelinePhase; 18] = [
    PipelinePhase::TokenEmbedding,
    PipelinePhase::PositionEncodingOrRope,
    PipelinePhase::QkvProjection,
    PipelinePhase::KvRead,
    PipelinePhase::AttentionScores,
    PipelinePhase::MaskApply,
    PipelinePhase::Softmax,
    PipelinePhase::AttentionWeightedSum,
    PipelinePhase::AttentionOutputProjection,
    PipelinePhase::ResidualAdd1,
    PipelinePhase::Norm1,
    PipelinePhase::MlpGateUp,
    PipelinePhase::Activation,
    PipelinePhase::MlpDown,
    PipelinePhase::ResidualAdd2,
    PipelinePhase::Norm2,
    PipelinePhase::LmHead,
    PipelinePhase::SamplingOrLogitsPostprocess,
];

// ═══════════════════════════════════════════════════════════════════════════
// PhaseContract
// ═══════════════════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════════════
/// Full contract for a single inference pipeline phase.
#[derive(Debug, Clone)]
pub struct PhaseContract {
    /// Which phase this contract describes.
    pub phase: PipelinePhase,
    /// Input tensor contracts (primary input first, then secondary inputs).
    pub inputs: &'static [TensorContract],
    /// Output tensor contracts.
    pub outputs: &'static [TensorContract],
    /// Default reference tolerance for numerical conformance.
    pub tolerance: f64,
    /// Human-readable description of what this phase does.
    pub description: &'static str,
}

use Dim::{Known, Symbol};

/// Canonical contracts for all 18 inference pipeline phases.
///
/// Shape patterns use symbolic dimensions (e.g. `{hidden_dim}`, `{vocab_size}`)
/// to express which dimensions are shared across phases.
/// Multi-input phases (AttentionScores, MaskApply, etc.) declare all inputs.
pub const PHASE_CONTRACTS: &[PhaseContract] = &[
    PhaseContract {
        phase: PipelinePhase::TokenEmbedding,
        inputs: &[
            TensorContract { name: "token_ids", role: TensorRole::PrimaryInput, shape_pattern: &[Known(1), Symbol("seq_len")], dtype: "int32" },
        ],
        outputs: &[
            TensorContract { name: "hidden", role: TensorRole::Output, shape_pattern: &[Known(1), Symbol("seq_len"), Symbol("hidden_dim")], dtype: "float32" },
        ],
        tolerance: 1e-4,
        description: "Embed token ID sequences into dense hidden-state vectors.",
    },
    PhaseContract {
        phase: PipelinePhase::PositionEncodingOrRope,
        inputs: &[
            TensorContract { name: "hidden", role: TensorRole::PrimaryInput, shape_pattern: &[Known(1), Symbol("seq_len"), Symbol("hidden_dim")], dtype: "float32" },
        ],
        outputs: &[
            TensorContract { name: "hidden", role: TensorRole::Output, shape_pattern: &[Known(1), Symbol("seq_len"), Symbol("hidden_dim")], dtype: "float32" },
        ],
        tolerance: 1e-4,
        description: "Apply Rotary Position Embedding (RoPE) or learned positional encoding.",
    },
    PhaseContract {
        phase: PipelinePhase::QkvProjection,
        inputs: &[
            TensorContract { name: "hidden", role: TensorRole::PrimaryInput, shape_pattern: &[Known(1), Symbol("hidden_dim")], dtype: "float32" },
        ],
        outputs: &[
            TensorContract { name: "q", role: TensorRole::Output, shape_pattern: &[Known(1), Symbol("hidden_dim")], dtype: "float32" },
            TensorContract { name: "k", role: TensorRole::Output, shape_pattern: &[Known(1), Symbol("hidden_dim")], dtype: "float32" },
            TensorContract { name: "v", role: TensorRole::Output, shape_pattern: &[Known(1), Symbol("hidden_dim")], dtype: "float32" },
        ],
        tolerance: 1e-3,
        description: "Project hidden state to Q, K, V subspaces. Weight matrices: Wq, Wk, Wv.",
    },
    PhaseContract {
        phase: PipelinePhase::KvRead,
        inputs: &[
            TensorContract { name: "cache_k", role: TensorRole::PrimaryInput, shape_pattern: &[Known(1), Symbol("cache_len"), Symbol("head_dim")], dtype: "float32" },
            TensorContract { name: "cache_v", role: TensorRole::PrimaryInput, shape_pattern: &[Known(1), Symbol("cache_len"), Symbol("head_dim")], dtype: "float32" },
        ],
        outputs: &[
            TensorContract { name: "k", role: TensorRole::Output, shape_pattern: &[Known(1), Known(1), Symbol("head_dim")], dtype: "float32" },
            TensorContract { name: "v", role: TensorRole::Output, shape_pattern: &[Known(1), Known(1), Symbol("head_dim")], dtype: "float32" },
        ],
        tolerance: 1e-4,
        description: "Read current-position K, V entries from KV cache (pre-filled or cached).",
    },
    PhaseContract {
        phase: PipelinePhase::AttentionScores,
        inputs: &[
            TensorContract { name: "q", role: TensorRole::PrimaryInput, shape_pattern: &[Known(1), Symbol("num_heads"), Symbol("seq_len"), Symbol("head_dim")], dtype: "float32" },
            TensorContract { name: "k", role: TensorRole::SecondaryInput, shape_pattern: &[Known(1), Symbol("num_heads"), Symbol("kv_len"), Symbol("head_dim")], dtype: "float32" },
        ],
        outputs: &[
            TensorContract { name: "scores", role: TensorRole::Output, shape_pattern: &[Known(1), Symbol("num_heads"), Symbol("seq_len"), Symbol("kv_len")], dtype: "float32" },
        ],
        tolerance: 1e-3,
        description: "Compute attention scores: Q @ K^T over head dimensions.",
    },
    PhaseContract {
        phase: PipelinePhase::MaskApply,
        inputs: &[
            TensorContract { name: "scores", role: TensorRole::PrimaryInput, shape_pattern: &[Known(1), Symbol("num_heads"), Symbol("seq_len"), Symbol("kv_len")], dtype: "float32" },
            TensorContract { name: "mask", role: TensorRole::SecondaryInput, shape_pattern: &[Known(1), Known(1), Symbol("seq_len"), Symbol("kv_len")], dtype: "float32" },
        ],
        outputs: &[
            TensorContract { name: "scores", role: TensorRole::Output, shape_pattern: &[Known(1), Symbol("num_heads"), Symbol("seq_len"), Symbol("kv_len")], dtype: "float32" },
        ],
        tolerance: 1e-4,
        description: "Apply causal/attention mask to scores (addition of -inf or large negative).",
    },
    PhaseContract {
        phase: PipelinePhase::Softmax,
        inputs: &[
            TensorContract { name: "scores", role: TensorRole::PrimaryInput, shape_pattern: &[Known(1), Symbol("num_heads"), Symbol("seq_len"), Symbol("kv_len")], dtype: "float32" },
        ],
        outputs: &[
            TensorContract { name: "probs", role: TensorRole::Output, shape_pattern: &[Known(1), Symbol("num_heads"), Symbol("seq_len"), Symbol("kv_len")], dtype: "float32" },
        ],
        tolerance: 1e-4,
        description: "Softmax over attention scores (last dimension = kv_len).",
    },
    PhaseContract {
        phase: PipelinePhase::AttentionWeightedSum,
        inputs: &[
            TensorContract { name: "probs", role: TensorRole::PrimaryInput, shape_pattern: &[Known(1), Symbol("num_heads"), Symbol("seq_len"), Symbol("kv_len")], dtype: "float32" },
            TensorContract { name: "v", role: TensorRole::SecondaryInput, shape_pattern: &[Known(1), Symbol("num_heads"), Symbol("kv_len"), Symbol("head_dim")], dtype: "float32" },
        ],
        outputs: &[
            TensorContract { name: "context", role: TensorRole::Output, shape_pattern: &[Known(1), Symbol("num_heads"), Symbol("seq_len"), Symbol("head_dim")], dtype: "float32" },
        ],
        tolerance: 1e-3,
        description: "Weighted sum of V: softmax(QK^T) @ V.",
    },
    PhaseContract {
        phase: PipelinePhase::AttentionOutputProjection,
        inputs: &[
            TensorContract { name: "context", role: TensorRole::PrimaryInput, shape_pattern: &[Known(1), Symbol("hidden_dim")], dtype: "float32" },
        ],
        outputs: &[
            TensorContract { name: "attention_output", role: TensorRole::Output, shape_pattern: &[Known(1), Symbol("hidden_dim")], dtype: "float32" },
        ],
        tolerance: 1e-3,
        description: "Project concatenated attention head outputs back to model dimension via Wo.",
    },
    PhaseContract {
        phase: PipelinePhase::ResidualAdd1,
        inputs: &[
            TensorContract { name: "attention_output", role: TensorRole::PrimaryInput, shape_pattern: &[Known(1), Symbol("hidden_dim")], dtype: "float32" },
            TensorContract { name: "residual", role: TensorRole::SecondaryInput, shape_pattern: &[Known(1), Symbol("hidden_dim")], dtype: "float32" },
        ],
        outputs: &[
            TensorContract { name: "hidden", role: TensorRole::Output, shape_pattern: &[Known(1), Symbol("hidden_dim")], dtype: "float32" },
        ],
        tolerance: 1e-4,
        description: "First residual add: attention_output + residual (input before attention sublayer).",
    },
    PhaseContract {
        phase: PipelinePhase::Norm1,
        inputs: &[
            TensorContract { name: "hidden", role: TensorRole::PrimaryInput, shape_pattern: &[Known(1), Symbol("hidden_dim")], dtype: "float32" },
        ],
        outputs: &[
            TensorContract { name: "hidden", role: TensorRole::Output, shape_pattern: &[Known(1), Symbol("hidden_dim")], dtype: "float32" },
        ],
        tolerance: 1e-4,
        description: "First layer normalization (RMS norm or LayerNorm) at pre-MLP boundary.",
    },
    PhaseContract {
        phase: PipelinePhase::MlpGateUp,
        inputs: &[
            TensorContract { name: "hidden", role: TensorRole::PrimaryInput, shape_pattern: &[Known(1), Symbol("hidden_dim")], dtype: "float32" },
        ],
        outputs: &[
            TensorContract { name: "gate", role: TensorRole::Output, shape_pattern: &[Known(1), Symbol("ffw_dim")], dtype: "float32" },
            TensorContract { name: "up", role: TensorRole::Output, shape_pattern: &[Known(1), Symbol("ffw_dim")], dtype: "float32" },
        ],
        tolerance: 1e-3,
        description: "MLP gate and up projection (gate_proj, up_proj for SwiGLU).",
    },
    PhaseContract {
        phase: PipelinePhase::Activation,
        inputs: &[
            TensorContract { name: "gate", role: TensorRole::PrimaryInput, shape_pattern: &[Known(1), Symbol("ffw_dim")], dtype: "float32" },
        ],
        outputs: &[
            TensorContract { name: "activated", role: TensorRole::Output, shape_pattern: &[Known(1), Symbol("ffw_dim")], dtype: "float32" },
        ],
        tolerance: 1e-4,
        description: "Activation function (SiLU, ReLU, GELU) applied to MLP gate output.",
    },
    PhaseContract {
        phase: PipelinePhase::MlpDown,
        inputs: &[
            TensorContract { name: "up_gated", role: TensorRole::PrimaryInput, shape_pattern: &[Known(1), Symbol("ffw_dim")], dtype: "float32" },
        ],
        outputs: &[
            TensorContract { name: "mlp_output", role: TensorRole::Output, shape_pattern: &[Known(1), Symbol("hidden_dim")], dtype: "float32" },
        ],
        tolerance: 1e-3,
        description: "MLP down projection (down_proj) after activation.",
    },
    PhaseContract {
        phase: PipelinePhase::ResidualAdd2,
        inputs: &[
            TensorContract { name: "mlp_output", role: TensorRole::PrimaryInput, shape_pattern: &[Known(1), Symbol("hidden_dim")], dtype: "float32" },
            TensorContract { name: "residual", role: TensorRole::SecondaryInput, shape_pattern: &[Known(1), Symbol("hidden_dim")], dtype: "float32" },
        ],
        outputs: &[
            TensorContract { name: "hidden", role: TensorRole::Output, shape_pattern: &[Known(1), Symbol("hidden_dim")], dtype: "float32" },
        ],
        tolerance: 1e-4,
        description: "Second residual add: mlp_output + residual (pre-MLP input after Norm1).",
    },
    PhaseContract {
        phase: PipelinePhase::Norm2,
        inputs: &[
            TensorContract { name: "hidden", role: TensorRole::PrimaryInput, shape_pattern: &[Known(1), Symbol("hidden_dim")], dtype: "float32" },
        ],
        outputs: &[
            TensorContract { name: "hidden", role: TensorRole::Output, shape_pattern: &[Known(1), Symbol("hidden_dim")], dtype: "float32" },
        ],
        tolerance: 1e-4,
        description: "Second layer normalization (RMS norm or LayerNorm) at pre-LM Head boundary.",
    },
    PhaseContract {
        phase: PipelinePhase::LmHead,
        inputs: &[
            TensorContract { name: "hidden", role: TensorRole::PrimaryInput, shape_pattern: &[Known(1), Symbol("hidden_dim")], dtype: "float32" },
        ],
        outputs: &[
            TensorContract { name: "logits", role: TensorRole::Output, shape_pattern: &[Known(1), Symbol("vocab_size")], dtype: "float32" },
        ],
        tolerance: 1e-3,
        description: "Language model head: project hidden states to logits over vocabulary.",
    },
    PhaseContract {
        phase: PipelinePhase::SamplingOrLogitsPostprocess,
        inputs: &[
            TensorContract { name: "logits", role: TensorRole::PrimaryInput, shape_pattern: &[Known(1), Symbol("vocab_size")], dtype: "float32" },
        ],
        outputs: &[
            TensorContract { name: "token_id", role: TensorRole::Output, shape_pattern: &[Known(1)], dtype: "int32" },
        ],
        tolerance: 0.0,
        description: "Sample from logits or apply post-processing (temperature, top-k, top-p). Non-differentiable.",
    },
];

// ═══════════════════════════════════════════════════════════════════════════
// PhaseSupportStatus — structured reason codes
// ═══════════════════════════════════════════════════════════════════════════

/// Structured code for `PhaseSupportStatus::Unsupported` variants.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum UnsupportedCode {
    /// The required primitive operation does not exist on this backend.
    MissingPrimitive,
    /// The phase involves dynamic shapes the backend cannot compile.
    DynamicShapeIncompatible,
    /// The phase needs graph-level scheduling the backend cannot own.
    NeedsGraphScheduling,
    /// The operation is a host-runtime responsibility (e.g. sampling, cache read).
    HostRuntimeResponsibility,
    /// Stateful boundary incompatible with backend's static model contract.
    StatefulBoundary,
}

impl fmt::Display for UnsupportedCode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            UnsupportedCode::MissingPrimitive => write!(f, "missing_primitive"),
            UnsupportedCode::DynamicShapeIncompatible => write!(f, "dynamic_shape_incompatible"),
            UnsupportedCode::NeedsGraphScheduling => write!(f, "needs_graph_scheduling"),
            UnsupportedCode::HostRuntimeResponsibility => write!(f, "host_runtime_responsibility"),
            UnsupportedCode::StatefulBoundary => write!(f, "stateful_boundary"),
        }
    }
}

/// Structured code for `PhaseSupportStatus::Pending` variants.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum PendingCode {
    /// MIL operation not yet wired into the builder.
    MilOpNotWired,
    /// Native bridge compiles but is not runtime-qualified.
    BridgeNotQualified,
    /// Fence validation (eval/materialization proof) not yet integrated.
    FenceValidationPending,
    /// Graph builder adapter not yet implemented.
    GraphBuilderNotImplemented,
}

impl fmt::Display for PendingCode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            PendingCode::MilOpNotWired => write!(f, "mil_op_not_wired"),
            PendingCode::BridgeNotQualified => write!(f, "bridge_not_qualified"),
            PendingCode::FenceValidationPending => write!(f, "fence_validation_pending"),
            PendingCode::GraphBuilderNotImplemented => write!(f, "graph_builder_not_implemented"),
        }
    }
}

/// Backend support status for a single canonical pipeline phase.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum PhaseSupportStatus {
    /// Backend has a direct native kernel for this phase.
    Native,
    /// Built from supported primitives (e.g. activation = mul + sigmoid,
    /// or Tribunus-owned graph schedule above BLAS/vDSP/vForce).
    Composed,
    /// Not supported due to fundamental backend capability gap.
    Unsupported {
        code: UnsupportedCode,
        reason: &'static str,
    },
    /// Not yet implemented but primitives exist and implementation is planned.
    Pending {
        code: PendingCode,
        reason: &'static str,
    },
}

impl fmt::Display for PhaseSupportStatus {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            PhaseSupportStatus::Native => write!(f, "native"),
            PhaseSupportStatus::Composed => write!(f, "composed"),
            PhaseSupportStatus::Unsupported { code, reason } => {
                write!(f, "unsupported/{code}: {reason}")
            }
            PhaseSupportStatus::Pending { code, reason } => {
                write!(f, "pending/{code}: {reason}")
            }
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// BackendPhaseSupportMatrix
// ═══════════════════════════════════════════════════════════════════════════

/// Per-backend support matrix mapping every pipeline phase to a support status.
#[derive(Debug, Clone)]
pub struct BackendPhaseSupportMatrix {
    /// Backend identifier.
    pub backend: BackendKind,
    /// Per-phase support status, one entry per phase in discriminant order.
    pub phases: Vec<(PipelinePhase, PhaseSupportStatus)>,
}

impl BackendPhaseSupportMatrix {
    /// Return the support status for a specific phase.
    pub fn support_for(&self, phase: PipelinePhase) -> Option<&PhaseSupportStatus> {
        self.phases.iter().find(|(p, _)| *p == phase).map(|(_, s)| s)
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Per-backend support matrices
// ═══════════════════════════════════════════════════════════════════════════

use PhaseSupportStatus::*;
use PipelinePhase::*;
use PendingCode::*;
use UnsupportedCode::*;

/// Core ML backend support matrix.
///
/// Core ML is an opaque compiled runtime. Static-shape matmul/projection
/// phases compile cleanly (Native). Dynamic-shape phases (KvRead, MaskApply)
/// are unsupported without a static subgraph boundary. Attention phases are
/// pending until the MIL compile path is stable and the predict bridge is
/// fully qualified. Sampling is a host-runtime responsibility.
pub fn coreml_support_matrix() -> BackendPhaseSupportMatrix {
    BackendPhaseSupportMatrix {
        backend: BackendKind::CoreMl,
        phases: vec![
            (TokenEmbedding, Pending { code: MilOpNotWired, reason: "embedding lookup not yet wired through MIL path" }),
            (PositionEncodingOrRope, Pending { code: MilOpNotWired, reason: "RoPE not yet compiled via MIL" }),
            (QkvProjection, Native),
            (KvRead, Unsupported { code: StatefulBoundary, reason: "KV cache is dynamic/stateful; Core ML static model boundary" }),
            (AttentionScores, Pending { code: BridgeNotQualified, reason: "reshape→transpose→matmul works in MIL but predict bridge not fully qualified" }),
            (MaskApply, Unsupported { code: DynamicShapeIncompatible, reason: "causal mask requires dynamic sequence dimension in compiled model" }),
            (Softmax, Composed),
            (AttentionWeightedSum, Pending { code: BridgeNotQualified, reason: "attention weighted sum not yet wired through compiled MIL path" }),
            (AttentionOutputProjection, Native),
            (ResidualAdd1, Composed),
            (Norm1, Pending { code: MilOpNotWired, reason: "RMS norm not yet wired through MIL path" }),
            (MlpGateUp, Native),
            (Activation, Composed),
            (MlpDown, Native),
            (ResidualAdd2, Composed),
            (Norm2, Pending { code: MilOpNotWired, reason: "RMS norm not yet wired through MIL path" }),
            (LmHead, Pending { code: BridgeNotQualified, reason: "LM head projection pending full 48-layer pipeline" }),
            (SamplingOrLogitsPostprocess, Unsupported { code: HostRuntimeResponsibility, reason: "sampling is host-runtime responsibility, not Core ML model output" }),
        ],
    }
}

/// MLX backend support matrix.
///
/// MLX is the broadest dynamic tensor runtime. Nearly all phases are
/// native or composed from MLX primitives. KV cache operations are
/// host-runtime-level (array reads/writes). Sampling is composed from
/// host-level operations.
pub fn mlx_support_matrix() -> BackendPhaseSupportMatrix {
    BackendPhaseSupportMatrix {
        backend: BackendKind::Mlx,
        phases: vec![
            (TokenEmbedding, Composed),
            (PositionEncodingOrRope, Native),
            (QkvProjection, Native),
            (KvRead, Composed),
            (AttentionScores, Native),
            (MaskApply, Composed),
            (Softmax, Native),
            (AttentionWeightedSum, Native),
            (AttentionOutputProjection, Native),
            (ResidualAdd1, Composed),
            (Norm1, Native),
            (MlpGateUp, Native),
            (Activation, Native),
            (MlpDown, Native),
            (ResidualAdd2, Composed),
            (Norm2, Native),
            (LmHead, Native),
            (SamplingOrLogitsPostprocess, Composed),
        ],
    }
}

/// Accelerate backend support matrix.
///
/// Accelerate provides CPU BLAS/vDSP/vForce kernels. Matmul-based phases
/// where Tribunus owns the dispatch are `Composed` (not Native), because
/// Accelerate is a kernel library, not a graph runtime. Direct kernel-
/// equivalent phases (QkvProjection, AttentionOutputProjection, MlpGateUp,
/// MlpDown, LmHead) are `Composed` — each is a single GEMM with
/// Tribunus-owned parameter setup and output marshalling.
/// Elementwise phases (Activation, ResidualAdd) use vDSP/vForce via
/// Tribunus domain adapter, classified as `Composed`.
/// Graph-level phases (attention scores, mask apply, softmax scheduling,
/// KV cache) are `Unsupported` because they need Tribunus-owned graph
/// scheduling above the BLAS layer.
pub fn accelerate_support_matrix() -> BackendPhaseSupportMatrix {
    BackendPhaseSupportMatrix {
        backend: BackendKind::Accelerate,
        phases: vec![
            (TokenEmbedding, Unsupported { code: MissingPrimitive, reason: "no embedding primitive; needs host CPU or graph-runtime scheduler" }),
            (PositionEncodingOrRope, Unsupported { code: MissingPrimitive, reason: "RoPE not available as single Accelerate primitive" }),
            (QkvProjection, Composed),
            (KvRead, Unsupported { code: StatefulBoundary, reason: "KV cache is dynamic state; Accelerate is stateless kernel library" }),
            (AttentionScores, Unsupported { code: NeedsGraphScheduling, reason: "needs graph scheduling above BLAS to manage Q/K/V setup and batching" }),
            (MaskApply, Unsupported { code: NeedsGraphScheduling, reason: "mask broadcast needs composite graph awareness" }),
            (Softmax, Unsupported { code: NeedsGraphScheduling, reason: "softmax requires elementwise+broadcast scheduling above Accelerate surface" }),
            (AttentionWeightedSum, Unsupported { code: NeedsGraphScheduling, reason: "needs graph scheduling (QK^T result @ V) above BLAS" }),
            (AttentionOutputProjection, Composed),
            (ResidualAdd1, Composed),
            (Norm1, Unsupported { code: MissingPrimitive, reason: "RMS norm not available as single Accelerate primitive" }),
            (MlpGateUp, Composed),
            (Activation, Composed),
            (MlpDown, Composed),
            (ResidualAdd2, Composed),
            (Norm2, Unsupported { code: MissingPrimitive, reason: "RMS norm not available as single Accelerate primitive" }),
            (LmHead, Composed),
            (SamplingOrLogitsPostprocess, Unsupported { code: HostRuntimeResponsibility, reason: "sampling is host-runtime operation" }),
        ],
    }
}

/// Return the support matrix for a given backend kind.
pub fn support_matrix_for(backend: BackendKind) -> BackendPhaseSupportMatrix {
    match backend {
        BackendKind::CoreMl => coreml_support_matrix(),
        BackendKind::Mlx => mlx_support_matrix(),
        BackendKind::Accelerate => accelerate_support_matrix(),
        BackendKind::Reference => {
            // Reference evaluator supports all phases via pure-Rust implementations.
            BackendPhaseSupportMatrix {
                backend: BackendKind::Reference,
                phases: PipelinePhase::all().iter().map(|&p| (p, Composed)).collect(),
            }
        }
    }
}

/// Classify a Tier 2 decode microphase family against a backend's support matrix.
///
/// Returns the support status for the given decode family on the given backend.
/// Corrected per review: Core ML support is evidence-based (not assumed Native for
/// untested phases). Accelerate is consistently Composed (Tribunus dispatches).
pub fn decode_microphase_support_for(family: &str, backend: BackendKind) -> PhaseSupportStatus {
    let pending_mil = Pending { code: PendingCode::MilOpNotWired, reason: "decode microphase MIL builder not yet qualified" };
    let pending_bridge = Pending { code: PendingCode::BridgeNotQualified, reason: "decode microphase predict bridge not yet qualified" };

    match backend {
        BackendKind::CoreMl => match family {
            "decode_qkv_projection" => Native,
            "decode_attention_output_projection" => Native,
            "decode_residual_add_1" | "decode_residual_add_2" => Composed,
            "decode_mlp_gate_up_silu" => pending_bridge,
            "decode_mlp_down" => Native,
            "decode_lm_head" => pending_bridge,
            _ => pending_mil,
        },
        BackendKind::Mlx => match family {
            "decode_qkv_projection" => Native,
            "decode_attention_output_projection" => Native,
            "decode_residual_add_1" | "decode_residual_add_2" => Composed,
            "decode_mlp_gate_up_silu" => Native,
            "decode_mlp_down" => Native,
            "decode_lm_head" => Native,
            _ => Composed,
        },
        BackendKind::Accelerate => match family {
            "decode_qkv_projection" => Composed,
            "decode_attention_output_projection" => Composed,
            "decode_residual_add_1" | "decode_residual_add_2" => Composed,
            "decode_mlp_gate_up_silu" => Composed,
            "decode_mlp_down" => Composed,
            "decode_lm_head" => Composed,
            _ => Unsupported {
                code: UnsupportedCode::MissingPrimitive,
                reason: "no decode primitive mapped".into(),
            },
        },
        BackendKind::Reference => Composed,
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Graph family → phase mapping
// ═══════════════════════════════════════════════════════════════════════════

/// Error returned when a graph family cannot be mapped to a pipeline phase.
#[derive(Debug, Clone)]
pub struct PipelineParityError {
    pub family_name: String,
    pub reason: &'static str,
}

impl fmt::Display for PipelineParityError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "family '{}' cannot be mapped to a pipeline phase: {}", self.family_name, self.reason)
    }
}

/// Map an existing graph catalog family to its canonical inference pipeline phase.
///
/// This function connects the current graph family catalog to the parity
/// contract. Every family in `all_families()` MUST either map to a valid
/// phase or be explicitly excluded (returning `None` for harness control
/// families like `identity_passthrough`).
///
/// ## Mapping rules
///
/// - `matmul`, `matmul_projection`, `constant_heavy` → `QkvProjection` as
///   generic projection control (variant = `"generic_projection"`).
/// - `branch_rejoin` → `AttentionOutputProjection` (parallel projection
///   branches plus add). Do NOT map to QkvProjection — it is not a single
///   QKV projection but two parallel projections recombined.
/// - `two_matmul_add` → `AttentionOutputProjection` with phase_variant
///   `"parallel_projection_rejoin"`. It is not AttentionWeightedSum unless
///   one matmul is probabilities × values.
/// - `identity_passthrough` → `None` (harness control, excluded from comparison).
/// - `reshape_transpose_matmul` → `AttentionScores` (Q, K shape manipulation
///   into score matmul).
/// - All elementwise + activation families → `Activation`.
/// - `softmax_tail` → `Softmax`.
/// - `matmul_residual_add` and `add_standalone` → `ResidualAdd1`.
pub fn graph_family_to_phase(family_name: &str) -> Result<PipelinePhase, PipelineParityError> {
    match family_name {
        // Generic projection — single matmul acting as any dense projection.
        "matmul" | "matmul_projection" | "constant_heavy" =>
            Ok(PipelinePhase::QkvProjection),
        // Parallel projection branches recombined — more like attention output.
        "branch_rejoin" =>
            Ok(PipelinePhase::AttentionOutputProjection),
        // Parallel matmuls with add — projection rejoin, not weighted sum.
        "two_matmul_add" =>
            Ok(PipelinePhase::AttentionOutputProjection),
        // Matmul followed by residual add.
        "matmul_residual_add" | "add_standalone" =>
            Ok(PipelinePhase::ResidualAdd1),
        // Activation chains (matmul→add→silu or matmul→add→sigmoid→mul).
        "chain_matmul_add_silu" | "matmul_add_silu" | "mul_standalone" |
        "sigmoid_standalone" | "silu_standalone" =>
            Ok(PipelinePhase::Activation),
        // Multi-output matmul — still a projection.
        "multi_output" =>
            Ok(PipelinePhase::QkvProjection),
        // Softmax tail.
        "softmax_tail" =>
            Ok(PipelinePhase::Softmax),
        // Reshape → transpose → matmul — attention score computation pattern.
        "reshape_transpose_matmul" =>
            Ok(PipelinePhase::AttentionScores),
        // Harness control family — not an inference phase.
        "identity_passthrough" =>
            Err(PipelineParityError {
                family_name: family_name.to_string(),
                reason: "harness control family, not an inference pipeline phase",
            }),
        other =>
            Err(PipelineParityError {
                family_name: other.to_string(),
                reason: "unknown graph family — not registered in catalog",
            }),
    }
}

/// Return the phase variant string for a mapped family.
///
/// The variant disambiguates which concrete implementation or operation
/// subset a family exercises within a phase (e.g. `"generic_projection"`
/// vs `"parallel_projection_rejoin"` for phases that can be exercised
/// by different graph topologies).
pub fn graph_family_phase_variant(family_name: &str) -> &'static str {
    match family_name {
        "matmul" => "generic_projection",
        "matmul_projection" => "generic_projection",
        "constant_heavy" => "generic_projection",
        "branch_rejoin" => "parallel_projection_rejoin",
        "multi_output" => "multi_output_projection",
        "two_matmul_add" => "parallel_projection_rejoin",
        "matmul_residual_add" => "residual_add",
        "add_standalone" => "residual_add",
        "chain_matmul_add_silu" => "matmul_add_silu",
        "matmul_add_silu" => "matmul_add_silu",
        "mul_standalone" => "elementwise_mul",
        "sigmoid_standalone" => "sigmoid",
        "silu_standalone" => "silu",
        "reshape_transpose_matmul" => "attention_scores_reshape",
        "softmax_tail" => "softmax_after_matmul",
        "identity_passthrough" => "harness_control",
        _ => "unknown",
    }
}

/// Return the semantic contract ID for a given graph family.
///
/// The semantic contract ID encodes (phase, variant, shape intent),
/// enabling comparison grouping to distinguish different operations
/// within the same phase (e.g. `matmul_add_silu` vs `silu_standalone`
/// are both `Activation` but have different semantic contracts).
pub fn graph_family_semantic_contract_id(family_name: &str) -> String {
    match graph_family_to_phase(family_name) {
        Ok(phase) => format!("{}/{}", phase, graph_family_phase_variant(family_name)),
        Err(_) => format!("excluded/{}", graph_family_phase_variant(family_name)),
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// PhaseComparisonGroup
// ═══════════════════════════════════════════════════════════════════════════

/// A group of rows that can be compared across backends.
///
/// All rows in a group share: `phase`, `phase_variant`, `semantic_contract_id`,
/// `shape_profile_name`, `dtype`, and `tolerance`. Only rows with valid fences
/// (backend-specific eval/materialization verified) are included, ensuring
/// comparison is honest.
#[derive(Debug, Clone)]
pub struct PhaseComparisonGroup {
    /// Canonical pipeline phase.
    pub phase: PipelinePhase,
    /// Phase variant (e.g. "generic_projection", "parallel_projection_rejoin").
    pub phase_variant: String,
    /// Full semantic contract ID (phase/variant).
    pub semantic_contract_id: String,
    /// Name of the shape profile (e.g. "small", "medium", "large").
    pub shape_profile_name: String,
    /// Shape contract: shape bound for this specific group (e.g. "1x4x4x1").
    pub shape_contract_id: String,
    /// Element type (e.g. "float32").
    pub dtype: String,
    /// Numerical tolerance for conformance.
    pub tolerance: f64,
    /// Tolerance profile identifier.
    pub tolerance_profile: String,
    /// One row per backend that executed this phase with valid measurement.
    pub rows: Vec<PhaseComparisonRow>,
}

/// A single backend's result within a comparison group.
#[derive(Debug, Clone)]
pub struct PhaseComparisonRow {
    /// Which backend produced this result.
    pub backend: BackendKind,
    /// The runtime policy/device this backend used (e.g. "cpuOnly", "mlx_default").
    pub backend_policy: String,
    /// Support status for this phase on this backend.
    pub support_status: PhaseSupportStatus,
    /// Latency in nanoseconds (steady-state P50).
    pub duration_ns: u64,
    /// Hash of the output tensor (None if execution failed or not captured).
    pub output_hash: Option<String>,
    /// Conformance metrics against the reference evaluator.
    pub conformance_against_reference: Option<ConformanceMetrics>,
    /// True when the backend's eval/sync fence was verified before timing.
    pub fence_valid: bool,
}

/// Group a set of receipts into comparison groups suitable for apples-to-apples ranking.
///
/// Receipts are grouped by the full comparison key:
/// `(semantic_contract_id, shape_profile, dtype, tolerance)`.
///
/// Within a group, all rows MUST have:
/// - Same `semantic_contract_id` (disambiguates different operations within a phase)
/// - Same `shape_profile` (refers to the same physical dimensions)
/// - Same `dtype`
/// - Valid execution fence (`predict_status == "pass"`) — receipts without
///   valid fences are excluded from comparison groups entirely.
///
/// Core ML `cpuOnly`, `cpuAndGPU`, and `all` are separate backend policies,
/// not interchangeable runs. Each policy variant gets its own row.
/// No identical backend policy is required across different backend classes
/// (Core ML cpuOnly, MLX mlx_default, Accelerate accelerate_cpu are valid
/// group members).
///
/// Groups with fewer than 2 rows are returned to document partial coverage,
/// but their `rows` array may contain one entry.
pub fn group_for_comparison(
    receipts: &[crate::decode_attribution::receipt::DecodeAttributionReceipt],
) -> Vec<PhaseComparisonGroup> {
    use std::collections::BTreeMap;

    // Grouping key: (semantic_contract_id, shape_profile, dtype, tolerance)
    let mut groups: BTreeMap<(String, String, String, u64), PhaseComparisonGroup> = BTreeMap::new();

    for r in receipts {
        // Skip receipts with no pipeline phase (legacy or control families).
        if r.pipeline_phase.is_none() || r.pipeline_phase.as_ref().unwrap().is_empty() {
            continue;
        }

        // Parse phase from string — skip if unrecognised.
        let phase: PipelinePhase = match r.pipeline_phase.as_ref().unwrap().parse() {
            Ok(p) => p,
            Err(_) => continue,
        };

        // Only include receipts with valid execution fences.
        let fence_valid = r.predict_status == "pass";
        if !fence_valid {
            // Still include fence-invalid rows in the comparison group, but
            // mark them explicitly so downstream consumers can filter.
        }

        let backend = match r.backend.as_str() {
            "coreml" => BackendKind::CoreMl,
            "mlx" => BackendKind::Mlx,
            "accelerate" => BackendKind::Accelerate,
            _ => continue,
        };

        let contract_id = if r.semantic_contract_id.is_empty() {
            format!("{}/{}", phase, r.phase_variant)
        } else {
            r.semantic_contract_id.clone()
        };

        // Encode tolerance as (tolerance * 1e6) u64 for BTreeMap key.
        let tolerance_key = (r.tolerance * 1_000_000.0) as u64;

        let key = (contract_id.clone(), r.shape_profile.clone(), r.dtype.clone(), tolerance_key);

        let entry = groups.entry(key);

        let group = entry.or_insert_with(|| {
            let tolerance_profile = if r.tolerance <= 1e-5 {
                "strict"
            } else if r.tolerance <= 1e-4 {
                "standard"
            } else {
                "relaxed"
            };

            // Build a shape contract ID from the actual dimensions.
            let shape_contract = format!("{}x{}", r.input_shape.first().copied().unwrap_or(0), r.weight_shape.last().copied().unwrap_or(0));

            PhaseComparisonGroup {
                phase,
                phase_variant: r.phase_variant.clone(),
                semantic_contract_id: contract_id,
                shape_profile_name: r.shape_profile.clone(),
                shape_contract_id: shape_contract,
                dtype: r.dtype.clone(),
                tolerance: r.tolerance,
                tolerance_profile: tolerance_profile.to_string(),
                rows: Vec::new(),
            }
        });

        let row = PhaseComparisonRow {
            backend,
            backend_policy: r.backend_runtime_policy.clone(),
            support_status: PhaseSupportStatus::Native,
            duration_ns: r.steady_p50_ns.max(r.steady_mean_ns as u64),
            output_hash: if fence_valid {
                r.cold_output_hashes.first().cloned()
            } else {
                None
            },
            conformance_against_reference: if fence_valid && r.matches_tolerance {
                Some(ConformanceMetrics {
                    max_absolute_error: r.max_absolute_error,
                    max_relative_error: r.max_relative_error,
                    mean_absolute_error: r.mean_absolute_error,
                    cosine_similarity: r.cosine_similarity,
                    matches_tolerance: r.matches_tolerance,
                    tolerance: r.tolerance,
                    reference_output_hashes: r.reference_output_hashes.clone(),
                })
            } else {
                None
            },
            fence_valid,
        };

        group.rows.push(row);
    }

    // Sort rows within each group by backend name.
    let mut result: Vec<PhaseComparisonGroup> = groups.into_values().collect();
    for group in &mut result {
        group.rows.sort_by_key(|r| r.backend.to_string());
    }

    result.sort_by_key(|g| {
        let phase_order = g.phase as u8;
        (phase_order, g.shape_profile_name.clone())
    });

    result
}

// ═══════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn all_phases_have_contracts() {
        for phase in PipelinePhase::all() {
            let found = PHASE_CONTRACTS.iter().any(|c| c.phase == *phase);
            assert!(found, "phase '{phase}' has no contract in PHASE_CONTRACTS");
        }
    }

    #[test]
    fn all_contracts_have_inputs() {
        for contract in PHASE_CONTRACTS {
            assert!(!contract.inputs.is_empty(), "phase '{}' has no inputs", contract.phase);
        }
    }

    #[test]
    fn all_contracts_have_outputs() {
        for contract in PHASE_CONTRACTS {
            assert!(!contract.outputs.is_empty(), "phase '{}' has no outputs", contract.phase);
        }
    }

    #[test]
    fn all_phases_have_non_empty_descriptions() {
        for contract in PHASE_CONTRACTS {
            assert!(!contract.description.is_empty(), "phase '{}' has empty description", contract.phase);
        }
    }

    #[test]
    fn all_phases_roundtrip_serde() {
        for phase in PipelinePhase::all() {
            let s = phase.to_string();
            let parsed: PipelinePhase = s.parse().unwrap_or_else(|e| panic!("cannot parse '{s}': {e}"));
            assert_eq!(*phase, parsed, "roundtrip failed for '{s}'");
        }
    }

    #[test]
    fn display_snake_case_no_whitespace() {
        for phase in PipelinePhase::all() {
            let s = phase.to_string();
            assert!(!s.contains(' '), "Display of '{phase:?}' contains whitespace: '{s}'");
            assert!(
                s.chars().all(|c| c.is_ascii_lowercase() || c == '_' || c.is_ascii_digit()),
                "Display of '{:?}' has non-snake_case chars: '{s}'", phase
            );
        }
    }

    #[test]
    fn support_matrix_covers_all_phases() {
        let matrices = [
            coreml_support_matrix(),
            mlx_support_matrix(),
            accelerate_support_matrix(),
        ];
        for matrix in &matrices {
            let matrix_phases: std::collections::HashSet<PipelinePhase> =
                matrix.phases.iter().map(|(p, _)| *p).collect();
            for phase in PipelinePhase::all() {
                assert!(
                    matrix_phases.contains(phase),
                    "phase '{phase}' missing from {} support matrix",
                    matrix.backend,
                );
            }
        }
    }

    #[test]
    fn support_matrix_sorted_by_phase_order() {
        let matrices = [
            coreml_support_matrix(),
            mlx_support_matrix(),
            accelerate_support_matrix(),
        ];
        for matrix in &matrices {
            for (i, (phase, _)) in matrix.phases.iter().enumerate() {
                if i > 0 {
                    let prev = &matrix.phases[i - 1].0;
                    let prev_idx = ALL_PHASES.iter().position(|p| *p == *prev).unwrap();
                    let cur_idx = ALL_PHASES.iter().position(|p| *p == *phase).unwrap();
                    assert!(
                        cur_idx >= prev_idx,
                        "{} support matrix phases not sorted: {} (idx {}) before {} (idx {})",
                        matrix.backend, prev, prev_idx, phase, cur_idx,
                    );
                }
            }
        }
    }

    #[test]
    fn graph_family_to_phase_coverage() {
        // All 16 graph families must map to a valid phase or explicitly return Err.
        let families = [
            "matmul",
            "chain_matmul_add_silu",
            "branch_rejoin",
            "multi_output",
            "constant_heavy",
            "reshape_transpose_matmul",
            "softmax_tail",
            "identity_passthrough",
            "add_standalone",
            "mul_standalone",
            "sigmoid_standalone",
            "silu_standalone",
            "matmul_projection",
            "matmul_residual_add",
            "two_matmul_add",
            "matmul_add_silu",
        ];
        for &family in &families {
            match graph_family_to_phase(family) {
                Ok(phase) => {
                    assert!(
                        phase != PipelinePhase::TokenEmbedding,
                        "family '{family}' mapped to TokenEmbedding — should never happen via graph_family_to_phase"
                    );
                }
                Err(e) => {
                    // identity_passthrough is expected to return Err.
                    assert_eq!(family, "identity_passthrough",
                        "unexpected Err for family '{family}': {e}");
                }
            }
        }
    }

    #[test]
    fn graph_family_identity_passthrough_excluded() {
        let result = graph_family_to_phase("identity_passthrough");
        assert!(result.is_err(), "identity_passthrough should be excluded");
        let err = result.unwrap_err();
        assert!(err.reason.contains("harness control"));
    }

    #[test]
    fn graph_family_unknown_fails_closed() {
        let result = graph_family_to_phase("nonexistent_family");
        assert!(result.is_err(), "unknown family should fail closed");
    }

    #[test]
    fn semantic_contract_id_is_deterministic() {
        let id1 = graph_family_semantic_contract_id("matmul");
        let id2 = graph_family_semantic_contract_id("matmul");
        assert_eq!(id1, id2, "semantic contract ID must be deterministic");
        assert_eq!(id1, "qkv_projection/generic_projection");

        let excluded = graph_family_semantic_contract_id("identity_passthrough");
        assert_eq!(excluded, "excluded/harness_control");
    }

    #[test]
    fn phase_variant_distinguishes_same_phase_families() {
        // Both are Activation but different phase variants.
        let v1 = graph_family_phase_variant("silu_standalone");
        let v2 = graph_family_phase_variant("chain_matmul_add_silu");
        assert_ne!(v1, v2, "different activation families should have distinct phase variants");
    }

    #[test]
    fn support_matrix_for_returns_non_empty() {
        for backend in &[BackendKind::CoreMl, BackendKind::Mlx, BackendKind::Accelerate, BackendKind::Reference] {
            let matrix = support_matrix_for(*backend);
            assert!(!matrix.phases.is_empty(), "support matrix for {backend} is empty");
            assert_eq!(matrix.backend, *backend);
        }
    }

    #[test]
    fn support_matrix_support_for_returns_some() {
        let matrix = mlx_support_matrix();
        let status = matrix.support_for(PipelinePhase::QkvProjection);
        assert!(status.is_some(), "MLX should report support for QkvProjection");
        assert_eq!(*status.unwrap(), PhaseSupportStatus::Native);
    }

    #[test]
    fn support_matrix_unsupported_has_code_and_reason() {
        let matrix = accelerate_support_matrix();
        if let Some(PhaseSupportStatus::Unsupported { code, reason }) =
            matrix.support_for(PipelinePhase::AttentionScores)
        {
            assert_eq!(*code, UnsupportedCode::NeedsGraphScheduling);
            assert!(!reason.is_empty(), "Unsupported reason must not be empty");
        } else {
            panic!("Accelerate AttentionScores should be Unsupported");
        }
    }

    #[test]
    fn support_matrix_pending_has_code_and_reason() {
        let matrix = coreml_support_matrix();
        if let Some(PhaseSupportStatus::Pending { code, reason }) =
            matrix.support_for(PipelinePhase::TokenEmbedding)
        {
            assert_eq!(*code, PendingCode::MilOpNotWired);
            assert!(!reason.is_empty(), "Pending reason must not be empty");
        } else {
            panic!("CoreML TokenEmbedding should be Pending");
        }
    }

    #[test]
    fn comparison_grouping_filters_empty_phase() {
        use crate::decode_attribution::receipt::DecodeAttributionReceipt;
        let mut r = DecodeAttributionReceipt::default();
        r.pipeline_phase = None;
        r.shape_profile = "small".to_string();
        r.dtype = "float32".to_string();
        r.backend = "mlx".to_string();
        r.backend_runtime_policy = "mlx_default".to_string();
        r.predict_status = "pass".to_string();

        let groups = group_for_comparison(&[r]);
        assert!(groups.is_empty(), "receipt with None pipeline_phase should be filtered out");
    }

    #[test]
    fn comparison_grouping_requires_same_phase() {
        use crate::decode_attribution::receipt::DecodeAttributionReceipt;
        let mut r1 = DecodeAttributionReceipt::default();
        r1.pipeline_phase = Some("qkv_projection".to_string());
        r1.phase_variant = "generic_projection".to_string();
        r1.semantic_contract_id = "qkv_projection/generic_projection".to_string();
        r1.shape_profile = "small".to_string();
        r1.dtype = "float32".to_string();
        r1.backend = "mlx".to_string();
        r1.backend_runtime_policy = "mlx_default".to_string();
        r1.predict_status = "pass".to_string();
        r1.tolerance = 1e-3;
        r1.input_shape = vec![1, 4];
        r1.weight_shape = vec![4, 1];

        let mut r2 = DecodeAttributionReceipt::default();
        r2.pipeline_phase = Some("softmax".to_string());
        r2.phase_variant = "softmax_after_matmul".to_string();
        r2.semantic_contract_id = "softmax/softmax_after_matmul".to_string();
        r2.shape_profile = "small".to_string();
        r2.dtype = "float32".to_string();
        r2.backend = "accelerate".to_string();
        r2.backend_runtime_policy = "accelerate_cpu".to_string();
        r2.predict_status = "pass".to_string();
        r2.tolerance = 1e-4;
        r2.input_shape = vec![1, 4];
        r2.weight_shape = vec![4, 1];

        let groups = group_for_comparison(&[r1, r2]);
        // Different semantic_contract_id -> different groups
        assert_eq!(groups.len(), 2, "different phases should produce separate groups");
    }

    #[test]
    fn comparison_grouping_requires_same_semantic_contract() {
        use crate::decode_attribution::receipt::DecodeAttributionReceipt;
        let mut r1 = DecodeAttributionReceipt::default();
        r1.pipeline_phase = Some("activation".to_string());
        r1.phase_variant = "silu".to_string();
        r1.semantic_contract_id = "activation/silu".to_string();
        r1.shape_profile = "small".to_string();
        r1.dtype = "float32".to_string();
        r1.backend = "mlx".to_string();
        r1.backend_runtime_policy = "mlx_default".to_string();
        r1.predict_status = "pass".to_string();
        r1.tolerance = 1e-4;
        r1.input_shape = vec![1, 4];
        r1.weight_shape = vec![4, 1];

        let mut r2 = DecodeAttributionReceipt::default();
        r2.pipeline_phase = Some("activation".to_string());
        r2.phase_variant = "matmul_add_silu".to_string();
        r2.semantic_contract_id = "activation/matmul_add_silu".to_string();
        r2.shape_profile = "small".to_string();
        r2.dtype = "float32".to_string();
        r2.backend = "accelerate".to_string();
        r2.backend_runtime_policy = "accelerate_cpu".to_string();
        r2.predict_status = "pass".to_string();
        r2.tolerance = 1e-4;
        r2.input_shape = vec![1, 4];
        r2.weight_shape = vec![4, 1];

        let groups = group_for_comparison(&[r1, r2]);
        assert_eq!(groups.len(), 2,
            "same phase but different semantic contract IDs should produce separate groups");
    }

    #[test]
    fn comparison_grouping_requires_same_shape() {
        use crate::decode_attribution::receipt::DecodeAttributionReceipt;
        let mut r1 = DecodeAttributionReceipt::default();
        r1.pipeline_phase = Some("qkv_projection".to_string());
        r1.phase_variant = "generic_projection".to_string();
        r1.semantic_contract_id = "qkv_projection/generic_projection".to_string();
        r1.shape_profile = "small".to_string();
        r1.dtype = "float32".to_string();
        r1.backend = "mlx".to_string();
        r1.backend_runtime_policy = "mlx_default".to_string();
        r1.predict_status = "pass".to_string();
        r1.tolerance = 1e-3;
        r1.input_shape = vec![1, 4];
        r1.weight_shape = vec![4, 1];

        let mut r2 = DecodeAttributionReceipt::default();
        r2.pipeline_phase = Some("qkv_projection".to_string());
        r2.phase_variant = "generic_projection".to_string();
        r2.semantic_contract_id = "qkv_projection/generic_projection".to_string();
        r2.shape_profile = "large".to_string();
        r2.dtype = "float32".to_string();
        r2.backend = "accelerate".to_string();
        r2.backend_runtime_policy = "accelerate_cpu".to_string();
        r2.predict_status = "pass".to_string();
        r2.tolerance = 1e-3;
        r2.input_shape = vec![1, 1024];
        r2.weight_shape = vec![1024, 1024];

        let groups = group_for_comparison(&[r1, r2]);
        assert_eq!(groups.len(), 2, "different shape profiles should produce separate groups");
    }

    #[test]
    fn receipt_default_legacy_empty_phase() {
        use crate::decode_attribution::receipt::DecodeAttributionReceipt;
        let r = DecodeAttributionReceipt::default();
        // Legacy default: pipeline_phase is None for backward compatibility.
        assert!(r.pipeline_phase.is_none() || r.pipeline_phase.as_ref().unwrap().is_empty(),
            "default receipt should have empty/missing pipeline_phase");
    }
}
