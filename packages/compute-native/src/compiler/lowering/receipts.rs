//! Immutable stage receipts for the Core ML lowering pipeline
//! and the aggregate gate qualification report.

use crate::compiler::LoweringReceipt;
use crate::backend::routing::{BackendArtifactId, BackendId, EvidenceDigest, OperationId, TensorId};

use super::params::{
    CoreMlTarget, LoweringDiagnostic, MilValueRef, Opcode, PrecisionPolicy, ShapePolicy, TensorMeta,
};

// ── MIL lowering receipt ──────────────────────────────────────────────────

/// Receipt from stage 1 (lowering): MIL production.
#[derive(Debug, Clone)]
pub struct MilLoweringReceipt {
    /// Digest of the produced MIL program.
    pub program_digest: EvidenceDigest,
    /// Number of operations emitted.
    pub op_count: usize,
    /// Number of constants registered (after dedup).
    pub constant_count: usize,
    /// Per-op legality results.
    pub op_legality: Vec<OpLegalityEntry>,
    /// Warnings accumulated during lowering.
    pub warnings: Vec<LoweringDiagnostic>,
    /// Opset used.
    pub opset: String,
}

/// Legality result for one scheduled operation during lowering.
#[derive(Debug, Clone)]
pub struct OpLegalityEntry {
    pub op_id: OperationId,
    pub opcode: Opcode,
    pub legal: bool,
    pub diagnostics: Vec<LoweringDiagnostic>,
}

// ── Package receipt ──────────────────────────────────────────────────────

/// Receipt from stage 2 (packaging): deterministic materialization.
#[derive(Debug, Clone)]
pub struct PackageReceipt {
    /// SHA-256 of the source .mlpackage directory.
    pub source_package_sha256: String,
    /// SHA-256 of the manifest file.
    pub manifest_sha256: String,
    /// Number of weight files written.
    pub weight_file_count: usize,
    /// Hash of each weight file (for dedup verification).
    pub weight_file_hashes: Vec<String>,
}

// ── Compilation receipt ──────────────────────────────────────────────────

/// Receipt from stage 3 (compilation): Apple compiler acceptance.
#[derive(Debug, Clone)]
pub struct CompilationReceipt {
    /// Toolchain attestation.
    pub toolchain: crate::toolchain_attest::ToolchainAttestation,
    /// SHA-256 of the compiled .mlmodelc metadata.json.
    pub compiled_sha256: String,
    /// Compile duration in nanoseconds.
    pub compile_duration_ns: u64,
    /// Exit status of xcrun coremlcompiler.
    pub exit_status: i32,
    /// Requested compute units (for provenance only).
    pub requested_compute_units: String,
}

// ── Runtime load receipt ─────────────────────────────────────────────────

/// Receipt from CoreMlModel::load: MLModel construction.
#[derive(Debug, Clone)]
pub struct RuntimeLoadReceipt {
    /// Model path.
    pub model_path: String,
    /// Compute units set on MLModelConfiguration.
    pub requested_compute_units: String,
    /// Load duration in nanoseconds.
    pub load_duration_ns: u64,
    /// Whether the load succeeded.
    pub success: bool,
}

// ── Prediction receipt ───────────────────────────────────────────────────

/// Receipt from CoreMlModel::predict.
#[derive(Debug, Clone)]
pub struct PredictionReceipt {
    /// Input tensor IDs.
    pub inputs: Vec<TensorId>,
    /// Output tensor IDs.
    pub outputs: Vec<TensorId>,
    /// Output shapes.
    pub output_shapes: Vec<Vec<u32>>,
    /// Output hashes (SHA-256).
    pub output_hashes: Vec<String>,
    /// Prediction duration in nanoseconds.
    pub predict_duration_ns: u64,
}

// ── Cross-backend conformance receipt ─────────────────────────────────────

/// Per-output error from cross-backend numerical comparison.
#[derive(Debug, Clone)]
pub struct NamedOutputError {
    pub output_name: String,
    pub max_absolute_error: f32,
    pub max_relative_error: f32,
    pub matches_tolerance: bool,
}

/// Receipt from cross-backend numerical conformance testing.
#[derive(Debug, Clone)]
pub struct CrossBackendConformanceReceipt {
    /// Reference backend identity.
    pub reference_backend: BackendId,
    /// Tested backend identity.
    pub tested_backend: BackendId,
    /// Per-output error metrics.
    pub output_errors: Vec<NamedOutputError>,
    /// Whether all outputs passed the tolerance threshold.
    pub qualified: bool,
    /// Tolerance threshold used.
    pub tolerance: f32,
    /// Number of outputs compared.
    pub output_count: usize,
}

// ── OpInventoryEntry ─────────────────────────────────────────────────────

/// Entry in the operation inventory — emitted by each emitter.
#[derive(Debug, Clone)]
pub struct OpInventoryEntry {
    /// Scheduled operation ID.
    pub scheduled_op_id: OperationId,
    /// MIL operation type string (e.g. "matmul", "add", "const").
    pub mil_op_type: String,
    /// Input bindings (name → MilValueRef).
    pub input_bindings: Vec<(String, MilValueRef)>,
    /// Output bindings (name → MilValueRef).
    pub output_bindings: Vec<(String, MilValueRef)>,
    /// Inferred MIL types for outputs.
    pub output_types: Vec<mil_spec_value_type>,
    /// Opset of the emitted operation.
    pub opset: String,
    /// Whether this operation passed preflight.
    pub legal: bool,
}

use coreml_proto::proto::mil_spec;
type mil_spec_value_type = mil_spec::ValueType;

// ── TensorSignature ──────────────────────────────────────────────────────

/// Input or output tensor signature on a lowering receipt.
#[derive(Debug, Clone)]
pub struct TensorSignature {
    pub name: String,
    pub shape: Vec<u32>,
    pub dtype: String,
    pub shape_policy: ShapePolicy,
}

// ── Gate Qualification Report ─────────────────────────────────────────────

/// Aggregate report collected at the end of the gate's conformance campaign.
#[derive(Debug, Clone)]
pub struct CoreMlLoweringGateReport {
    pub target: CoreMlTarget,
    pub precision: PrecisionPolicy,
    /// Stage 1 receipt.
    pub lowering: MilLoweringReceipt,
    /// Stage 2 receipt.
    pub package: PackageReceipt,
    /// Stage 3 receipt.
    pub compilation: CompilationReceipt,
    /// Optional runtime load receipt.
    pub runtime_load: Option<RuntimeLoadReceipt>,
    /// Optional prediction receipt.
    pub prediction: Option<PredictionReceipt>,
    /// Optional conformance receipt.
    pub conformance: Option<CrossBackendConformanceReceipt>,
    /// Whether the implementation is qualified.
    pub qualified: bool,
}
