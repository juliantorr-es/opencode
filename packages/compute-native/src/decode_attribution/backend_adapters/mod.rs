//! Backend adapters for the Three-Backend Decode Attribution Gate.
//!
//! Each adapter implements the same lifecycle:
//! - `prepare`: backend-specific setup (compile/load for CoreML, array packing for Accelerate, array construction for MLX)
//! - `cold_predict`: exactly one execution, timed
//! - `warmup`: N executions, only total time recorded
//! - `steady`: M executions, every sample recorded for distribution stats
//! - `teardown`: cleanup
//!
//! The lifecycle is comparable across backends without pretending lifecycle equivalence.
//! CoreML has materialize/compile/load phases; Accelerate and MLX do not.

pub mod coreml_adapter;
pub mod accelerate_adapter;
pub mod mlx_adapter;
pub mod reference_adapter;
pub mod conformance;
pub mod predict_loop;

use std::fmt;

// ── Shared types ───────────────────────────────────────────────────────────

/// Backend identifiers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum BackendKind {
    CoreMl,
    Accelerate,
    Mlx,
    Reference,
}

impl fmt::Display for BackendKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            BackendKind::CoreMl => write!(f, "coreml"),
            BackendKind::Accelerate => write!(f, "accelerate"),
            BackendKind::Mlx => write!(f, "mlx"),
            BackendKind::Reference => write!(f, "reference"),
        }
    }
}

/// Static capability tier: what a backend can represent in principle.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum BackendSupportTier {
    /// Backend has a direct kernel for this graph family.
    SupportedNative,
    /// Built from supported primitives (e.g., MLX chain = matmul+add+silu).
    SupportedComposed,
    /// Cannot express this graph in the backend's execution model.
    UnsupportedGraph,
    /// Backend has the primitives but no adapter yet.
    NotImplemented,
}

impl fmt::Display for BackendSupportTier {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            BackendSupportTier::SupportedNative => write!(f, "supported_native"),
            BackendSupportTier::SupportedComposed => write!(f, "supported_composed"),
            BackendSupportTier::UnsupportedGraph => write!(f, "unsupported_graph"),
            BackendSupportTier::NotImplemented => write!(f, "not_implemented"),
        }
    }
}

/// Phase-specific failure classification for observed runtime outcomes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum PredictFailureClass {
    /// MIL program generation failed (package write, protobuf build).
    MaterializeLimited,
    /// Core ML compiler (coremlcompiler) failed.
    CompileLimited,
    /// Load of compiled model failed (CoreMlModel::load).
    LoadBlocked,
    /// Prediction bridge (tribunus_coreml_predict) failed.
    PredictBlocked,
    /// Output diverged from reference beyond tolerance.
    NumericalDivergence,
    /// Execution exceeded timeout.
    Timeout,
    /// Out-of-memory during execution.
    MemoryOom,
}

impl fmt::Display for PredictFailureClass {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            PredictFailureClass::MaterializeLimited => write!(f, "materialize_limited"),
            PredictFailureClass::CompileLimited => write!(f, "compile_limited"),
            PredictFailureClass::LoadBlocked => write!(f, "load_blocked"),
            PredictFailureClass::PredictBlocked => write!(f, "predict_blocked"),
            PredictFailureClass::NumericalDivergence => write!(f, "numerical_divergence"),
            PredictFailureClass::Timeout => write!(f, "timeout"),
            PredictFailureClass::MemoryOom => write!(f, "memory_oom"),
        }
    }
}

/// Runtime policy per backend.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum BackendRuntimePolicy {
    CoreMlCpuOnly,
    CoreMlCpuAndGpu,
    AccelerateCpu,
    MlxDefault,
    MlxCpu,
    MlxGpu,
}

impl fmt::Display for BackendRuntimePolicy {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            BackendRuntimePolicy::CoreMlCpuOnly => write!(f, "cpuOnly"),
            BackendRuntimePolicy::CoreMlCpuAndGpu => write!(f, "cpuAndGPU"),
            BackendRuntimePolicy::AccelerateCpu => write!(f, "accelerate_cpu"),
            BackendRuntimePolicy::MlxDefault => write!(f, "mlx_default"),
            BackendRuntimePolicy::MlxCpu => write!(f, "mlx_cpu"),
            BackendRuntimePolicy::MlxGpu => write!(f, "mlx_gpu"),
        }
    }
}

impl BackendRuntimePolicy {
    pub fn coreml_from_str(s: &str) -> Self {
        match s {
            "cpuOnly" => BackendRuntimePolicy::CoreMlCpuOnly,
            _ => BackendRuntimePolicy::CoreMlCpuAndGpu,
        }
    }
}

/// Backend support status for a given graph family.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BackendSupportStatus {
    Supported,
    UnsupportedGraph,
    NotImplemented,
    NotApplicable,
    Error,
}

impl fmt::Display for BackendSupportStatus {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            BackendSupportStatus::Supported => write!(f, "supported"),
            BackendSupportStatus::UnsupportedGraph => write!(f, "unsupported_graph"),
            BackendSupportStatus::NotImplemented => write!(f, "not_implemented"),
            BackendSupportStatus::NotApplicable => write!(f, "not_applicable"),
            BackendSupportStatus::Error => write!(f, "error"),
        }
    }
}

/// A single timing result from a backend execution.
#[derive(Debug, Clone)]
pub struct BackendTiming {
    pub duration_ns: u64,
    pub output_hash: Option<String>,
}

/// Prepared run — the result of backend-specific setup, consumed by predict loops.
pub struct PreparedBackendRun {
    pub backend: BackendKind,
    pub runtime_policy: BackendRuntimePolicy,
    pub prepare_duration_ns: u64,
    pub mlx_device: String,
    pub mlx_eval_forced: bool,
    pub mlx_eval_method: String,
    // Backend-specific state kept alive for the duration of the run.
    // CoreML: the loaded model handle.
    pub coreml_model: Option<crate::coreml_bridge::CoreMlModel>,
}
