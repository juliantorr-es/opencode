// ── Projection identity types ──────────────────────────────────────────────
//
// Shared between Rust instrumentation (executor.rs) and TypeScript parser
// (standard-layer-events.ts).  The Rust side emits eprintln lines; the
// TypeScript side parses them.
//
// See the doc header (replaced below) for the full wire-format contract.

use std::fmt;

// ── ProjectionFamily ───────────────────────────────────────────────────────

/// The seven projection families in a Gemma 4 decoder layer.
///
/// Invocation order within a layer:
///   QProj=0, KProj=1, VProj=2, OProj=3, GateProj=4, UpProj=5, DownProj=6
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ProjectionFamily {
    QProj,
    KProj,
    VProj,
    OProj,
    GateProj,
    UpProj,
    DownProj,
}

impl ProjectionFamily {
    /// Wire-format name, e.g. `"q_proj"`, `"gate_proj"`.
    pub fn as_str(&self) -> &'static str {
        match self {
            ProjectionFamily::QProj => "q_proj",
            ProjectionFamily::KProj => "k_proj",
            ProjectionFamily::VProj => "v_proj",
            ProjectionFamily::OProj => "o_proj",
            ProjectionFamily::GateProj => "gate_proj",
            ProjectionFamily::UpProj => "up_proj",
            ProjectionFamily::DownProj => "down_proj",
        }
    }
}

impl fmt::Display for ProjectionFamily {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Parse a wire-format name into a [`ProjectionFamily`].
///
/// Returns `None` for unrecognised strings.
pub fn family_from_str(s: &str) -> Option<ProjectionFamily> {
    match s {
        "q_proj" => Some(ProjectionFamily::QProj),
        "k_proj" => Some(ProjectionFamily::KProj),
        "v_proj" => Some(ProjectionFamily::VProj),
        "o_proj" => Some(ProjectionFamily::OProj),
        "gate_proj" => Some(ProjectionFamily::GateProj),
        "up_proj" => Some(ProjectionFamily::UpProj),
        "down_proj" => Some(ProjectionFamily::DownProj),
        _ => None,
    }
}

/// Deterministic invocation order: matches the projection ordering inside a
/// Gemma 4 decoder layer (attention Q/K/V/O, then MLP gate/up/down).
pub const PROJECTION_ORDER: &[ProjectionFamily] = &[
    ProjectionFamily::QProj,
    ProjectionFamily::KProj,
    ProjectionFamily::VProj,
    ProjectionFamily::OProj,
    ProjectionFamily::GateProj,
    ProjectionFamily::UpProj,
    ProjectionFamily::DownProj,
];

/// Return the deterministic invocation index for a projection family.
pub fn invocation_for(family: ProjectionFamily) -> usize {
    // Safety: all variants are present in PROJECTION_ORDER.
    PROJECTION_ORDER.iter().position(|&f| f == family).unwrap()
}

// ── Phase / AttentionKind ──────────────────────────────────────────────────

/// Inference phase for projection attribution.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Phase {
    Prefill,
    Decode,
}

impl Phase {
    pub fn as_str(&self) -> &'static str {
        match self {
            Phase::Prefill => "prefill",
            Phase::Decode => "decode",
        }
    }
}

/// Attention variant for projection attribution.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AttentionKind {
    Sliding,
    Full,
}

impl AttentionKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            AttentionKind::Sliding => "sliding",
            AttentionKind::Full => "full",
        }
    }
}

// ── ProjectionContext ──────────────────────────────────────────────────────

/// Per-layer context carried through the projection chain for event emission.
#[derive(Debug, Clone)]
pub struct ProjectionContext {
    pub run_id: String,
    pub phase: Phase,
    pub forward_pass_index: u32,
    pub token_step: Option<u32>,
    pub layer_index: usize,
    pub attention_kind: AttentionKind,
}

impl ProjectionContext {
    /// Build a stage identifier string for the given family and invocation.
    ///
    /// Format: `{phase}_{token_step}_layer_{N}_{family}`
    ///
    /// Examples:
    ///   "decode_step_0_layer_12_q_proj"
    ///   "prefill__layer_5_gate_proj"     (no token_step for prefill)
    pub fn stage_id(&self, family: ProjectionFamily, _invocation: usize) -> String {
        let step_str = match self.token_step {
            Some(n) => format!("step_{}", n),
            None => String::new(),
        };
        format!(
            "{}_{}_layer_{}_{}",
            self.phase.as_str(),
            step_str,
            self.layer_index,
            family.as_str()
        )
    }
}

// ── Dtype helpers ──────────────────────────────────────────────────────────

/// Convert an MLX [`mlx_rs::Dtype`] to the wire-format storage dtype string
/// (short names: `"U8"`, `"F32"`, etc.).
pub fn dtype_to_storage(d: &mlx_rs::Dtype) -> &'static str {
    match d {
        mlx_rs::Dtype::Bool => "Bool",
        mlx_rs::Dtype::Uint8 => "U8",
        mlx_rs::Dtype::Uint16 => "U16",
        mlx_rs::Dtype::Uint32 => "U32",
        mlx_rs::Dtype::Uint64 => "U64",
        mlx_rs::Dtype::Int8 => "I8",
        mlx_rs::Dtype::Int16 => "I16",
        mlx_rs::Dtype::Int32 => "I32",
        mlx_rs::Dtype::Int64 => "I64",
        mlx_rs::Dtype::Float16 => "F16",
        mlx_rs::Dtype::Float32 => "F32",
        mlx_rs::Dtype::Float64 => "F64",
        mlx_rs::Dtype::Bfloat16 => "BF16",
        mlx_rs::Dtype::Complex64 => "Complex64",
    }
}
