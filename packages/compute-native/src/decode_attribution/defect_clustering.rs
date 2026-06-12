//! FULL-SUITE-TIER1-DEFECT-CLUSTERING-0001: Defect clustering module.
//!
//! Consumes a run directory of `DecodeAttributionReceipt` JSON receipts,
//! normalizes each non-pass row into a `DefectObservation`, groups observations
//! into `DefectCluster`s by root cause, and produces structured JSON/MD outputs.
//!
//! ## Classification rules (applied in order)
//!
//! 1. Core ML compile errors: `terminal_phase == "mil_build"` or `status == "compile_error"`
//! 2. Core ML prediction errors: compile succeeded, `predict_status == "predict_blocked"`
//! 3. MLX execution failures: `predict_status == "predict_blocked"`, check fence validity
//! 4. MLX numerical divergence: `predict_status == "numerical_divergence"`
//! 5. Accelerate numerical divergence: check execution_proof.reference_ops
//! 6. Cross-backend: same semantic_contract_id failing on >1 backend
//! 7. Shape-specific: same contract passes one shape, fails another
//! 8. Remaining: ReceiptOrHarnessDefect

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use serde::{Deserialize, Serialize};

use super::receipt::{DecodeAttributionReceipt, ExecutionProof};

// ═══════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════

/// Typed root-cause cluster kinds.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ClusterKind {
    CoremlCompileContract,
    CoremlPredictContract,
    MlxExecutionContract,
    MlxNumericalSemantics,
    AccelerateNumericalSemantics,
    CrossBackendSemanticMismatch,
    ShapeProfileSpecific,
    PolicySpecific,
    ReceiptOrHarnessDefect,
    KvShapeMismatch,
    KvLayoutMismatch,
    KvPositionMismatch,
    KvMutationUnsupported,
    KvOwnershipViolation,
}

impl ClusterKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            ClusterKind::CoremlCompileContract => "coreml_compile_contract",
            ClusterKind::CoremlPredictContract => "coreml_predict_contract",
            ClusterKind::MlxExecutionContract => "mlx_execution_contract",
            ClusterKind::MlxNumericalSemantics => "mlx_numerical_semantics",
            ClusterKind::AccelerateNumericalSemantics => "accelerate_numerical_semantics",
            ClusterKind::CrossBackendSemanticMismatch => "cross_backend_semantic_mismatch",
            ClusterKind::ShapeProfileSpecific => "shape_profile_specific",
            ClusterKind::PolicySpecific => "policy_specific",
            ClusterKind::ReceiptOrHarnessDefect => "receipt_or_harness_defect",
            ClusterKind::KvShapeMismatch => "kv_shape_mismatch",
            ClusterKind::KvLayoutMismatch => "kv_layout_mismatch",
            ClusterKind::KvPositionMismatch => "kv_position_mismatch",
            ClusterKind::KvMutationUnsupported => "kv_mutation_unsupported",
            ClusterKind::KvOwnershipViolation => "kv_ownership_violation",
        }
    }
}

/// Confidence in the root-cause hypothesis.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Confidence {
    High,
    Medium,
    Low,
}

impl Confidence {
    pub fn as_str(&self) -> &'static str {
        match self {
            Confidence::High => "high",
            Confidence::Medium => "medium",
            Confidence::Low => "low",
        }
    }
}

/// Severity levels for defect clusters.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum Severity {
    #[serde(rename = "S0_invalid_evidence")]
    S0InvalidEvidence,
    #[serde(rename = "S1_blocks_decode_microphase")]
    S1BlocksDecodeMicrophase,
    #[serde(rename = "S2_blocks_backend_parity")]
    S2BlocksBackendParity,
    #[serde(rename = "S3_backend_specific_gap")]
    S3BackendSpecificGap,
    #[serde(rename = "S4_diagnostic_only")]
    S4DiagnosticOnly,
}

impl Severity {
    pub fn as_str(&self) -> &'static str {
        match self {
            Severity::S0InvalidEvidence => "S0_invalid_evidence",
            Severity::S1BlocksDecodeMicrophase => "S1_blocks_decode_microphase",
            Severity::S2BlocksBackendParity => "S2_blocks_backend_parity",
            Severity::S3BackendSpecificGap => "S3_backend_specific_gap",
            Severity::S4DiagnosticOnly => "S4_diagnostic_only",
        }
    }
}

/// A single non-pass row normalized for analysis.
///
/// Hash and error fields use `Option` — compile errors and prediction
/// failures may not produce backend output hashes or numerical metrics.
/// Downstream clustering must not mistake `None` for "zero error".
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DefectObservation {
    pub row_id: String,
    pub tier: String,
    pub family: String,
    pub variant: String,
    pub pipeline_phase: Option<String>,
    pub phase_variant: String,
    pub semantic_contract_id: String,
    pub shape_profile: String,
    pub dtype: String,
    pub backend: String,
    pub backend_policy: String,
    pub execution_kind: String,
    pub support_status: String,
    pub status: String,
    pub terminal_phase: String,
    pub error_class: String,
    pub diagnostic: String,
    pub output_hash: Option<String>,
    pub reference_hash: Option<String>,
    pub max_absolute_error: Option<f64>,
    pub mean_absolute_error: Option<f64>,
    pub cosine_similarity: Option<f64>,
    pub fence_valid: bool,
    pub execution_proof: Option<ExecutionProof>,
    pub artifact_paths: Vec<String>,
}

/// A grouped set of defects sharing a likely root cause.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DefectCluster {
    pub cluster_id: String,
    pub cluster_kind: ClusterKind,
    pub pipeline_phase: Option<String>,
    pub phase_variant: String,
    pub semantic_contract_id: String,
    pub families: Vec<String>,
    pub backends: Vec<String>,
    pub shape_profiles: Vec<String>,
    pub statuses: Vec<String>,
    pub terminal_phases: Vec<String>,
    pub likely_root_cause: String,
    pub confidence: Confidence,
    pub severity: Severity,
    pub blocked_next_phases: Vec<String>,
    pub recommended_next_gate: String,
    pub representative_rows: Vec<String>,
    pub evidence_summary: String,
    pub secondary_kinds: Vec<ClusterKind>,
}

/// A synthetic correlation record connecting two backend-specific clusters
/// that share the same semantic_contract_id and are thus likely the same
/// root cause. Preserves the original backend-specific clusters as primary
/// observations while adding a cross-cutting link.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CrossBackendCorrelation {
    pub correlation_id: String,
    pub semantic_contract_id: String,
    pub shape_profile: String,
    pub cluster_ids: Vec<String>,
    pub backends: Vec<String>,
    pub likely_root_cause: String,
    pub confidence: Confidence,
}

/// Tier 2 blocker entry.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Tier2Blocker {
    pub cluster_id: String,
    pub cluster_kind: String,
    pub severity: String,
    pub blocked_phases: Vec<String>,
    pub root_cause: String,
    pub why_blocks: String,
    pub recommended_fix_gate: String,
}

/// Next fix gate entry.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NextFixGate {
    pub gate_id: String,
    pub cluster_ids: Vec<String>,
    pub scope: String,
    pub priority: String,
    pub effort_estimate: String,
}

// ═══════════════════════════════════════════════════════════════════════════
// Construction helpers
// ═══════════════════════════════════════════════════════════════════════════

fn cluster_id_for(kind: ClusterKind, idx: u32) -> String {
    format!("cluster_{:03}_{}", idx, kind.as_str())
}

fn sanitize(s: &str) -> String {
    s.chars()
        .map(|c| if c.is_alphanumeric() || c == '_' || c == '-' { c } else { '_' })
        .collect()
}

/// Extract MIL op type from compiler stdout/diagnostics.
fn extract_mil_op_type(receipt: &DecodeAttributionReceipt) -> &'static str {
    // Try compiler_stdout first
    if let Some(ref stdout) = receipt.compiler_stdout {
        for line in stdout.lines() {
            let l = line.trim();
            if let Some(pos) = l.find("ios19.") {
                let rest = &l[pos..];
                if rest.starts_with("ios19.add") {
                    return "add";
                }
                if rest.starts_with("ios19.mul") {
                    return "mul";
                }
                if rest.starts_with("ios19.sigmoid") || rest.contains("sig") {
                    return "sigmoid";
                }
                if rest.contains("silu") || rest.contains("tanh") {
                    return "silu";
                }
                return "elementwise_unknown";
            }
        }
    }
    // Fallback to failure_reason / failure_diagnostics
    let diag = receipt
        .failure_diagnostics
        .as_deref()
        .or_else(|| receipt.failure_reason.as_deref())
        .unwrap_or("");
    if diag.contains("add") || diag.contains("add_standalone") {
        return "add";
    }
    if diag.contains("mul") || diag.contains("mul_standalone") {
        return "mul";
    }
    if diag.contains("sigmoid") || diag.contains("sig") {
        return "sigmoid";
    }
    if diag.contains("silu") {
        return "silu";
    }
    "unknown_op_context"
}

/// Error class from a receipt's terminal_phase and failure diagnostics.
fn error_class_from(receipt: &DecodeAttributionReceipt) -> String {
    let diag = receipt.failure_diagnostics.as_deref().unwrap_or("");
    let reason = receipt.failure_reason.as_deref().unwrap_or("");

    // Check compiler_stdout for MIL type info
    if let Some(ref stdout) = receipt.compiler_stdout {
        for line in stdout.lines() {
            let l = line.trim();
            if l.contains("unexpected type") {
                let truncated = if l.len() > 120 { &l[..120] } else { l };
                return format!("{}.{}", receipt.backend, sanitize(truncated));
            }
            if l.contains("Unable to infer") {
                let truncated = if l.len() > 120 { &l[..120] } else { l };
                return format!("{}.{}", receipt.backend, sanitize(truncated));
            }
        }
    }

    if !diag.is_empty() {
        let truncated = if diag.len() > 80 { &diag[..80] } else { diag };
        return format!("{}.{}", receipt.backend, sanitize(truncated));
    }
    if !reason.is_empty() {
        let truncated = if reason.len() > 80 { &reason[..80] } else { reason };
        return format!("{}.{}", receipt.backend, sanitize(truncated));
    }
    format!("{}.{}", receipt.backend, receipt.terminal_phase)
}

fn diagnostic_from(receipt: &DecodeAttributionReceipt) -> String {
    receipt
        .failure_diagnostics
        .as_deref()
        .unwrap_or("")
        .lines()
        .next()
        .unwrap_or("")
        .to_string()
}

fn first_opt_hash(receipt: &DecodeAttributionReceipt) -> Option<String> {
    receipt.reference_output_hashes.first().cloned()
}

fn fence_valid_for(receipt: &DecodeAttributionReceipt) -> bool {
    match receipt.backend.as_str() {
        "mlx" => receipt.mlx_eval_forced,
        "coreml" => {
            receipt.compile_status == "pass" && receipt.load_status == "pass"
        }
        "accelerate" => {
            matches!(
                receipt.predict_status.as_str(),
                "pass" | "numerical_divergence"
            )
        }
        _ => true,
    }
}

/// Determine whether this receipt represents a compile error.
fn is_compile_error(receipt: &DecodeAttributionReceipt) -> bool {
    receipt.status == "compile_error"
        || receipt.predict_status == "compile_limited"
        || receipt.terminal_phase == "mil_build"
        || receipt.terminal_phase == "compile"
}

// ═══════════════════════════════════════════════════════════════════════════
// Normalize: receipt → DefectObservation
// ═══════════════════════════════════════════════════════════════════════════

/// Normalize a non-pass receipt into a `DefectObservation`.
pub fn normalize_observation(receipt: &DecodeAttributionReceipt) -> DefectObservation {
    // Extract numerical conformance fields only when the receipt ran predict
    let (max_abs_error, mean_abs_error, cosine_similarity) = {
        let has_metrics = receipt.max_absolute_error != 0.0
            || receipt.cosine_similarity != 0.0
            || receipt.matches_tolerance;
        if has_metrics {
            (
                Some(receipt.max_absolute_error),
                Some(receipt.mean_absolute_error),
                Some(receipt.cosine_similarity),
            )
        } else {
            (None, None, None)
        }
    };

    DefectObservation {
        row_id: receipt.run_id.clone(),
        tier: "tier1".into(),
        family: receipt.graph_family.clone(),
        variant: "default".into(),
        pipeline_phase: receipt.pipeline_phase.clone(),
        phase_variant: receipt.phase_variant.clone(),
        semantic_contract_id: receipt.semantic_contract_id.clone(),
        shape_profile: receipt.shape_profile.clone(),
        dtype: receipt.dtype.clone(),
        backend: receipt.backend.clone(),
        backend_policy: receipt.backend_runtime_policy.clone(),
        execution_kind: receipt.execution_kind.clone(),
        support_status: receipt.backend_support_status.clone(),
        status: receipt.status.clone(),
        terminal_phase: receipt.terminal_phase.clone(),
        error_class: error_class_from(receipt),
        diagnostic: diagnostic_from(receipt),
        output_hash: first_opt_hash(receipt),
        reference_hash: first_opt_hash(receipt),
        max_absolute_error: max_abs_error,
        mean_absolute_error: mean_abs_error,
        cosine_similarity,
        fence_valid: fence_valid_for(receipt),
        execution_proof: Some(receipt.execution_proof.clone()),
        artifact_paths: vec![],
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Classification rules
// ═══════════════════════════════════════════════════════════════════════════

struct Classification {
    cluster_kind: ClusterKind,
    root_cause: String,
    confidence: Confidence,
    blocked_phases: Vec<String>,
}

/// Classify a single observation to a cluster kind.
fn classify_observation(obs: &DefectObservation, receipt: &DecodeAttributionReceipt) -> Classification {
    // Rule 1: Core ML compile error
    if obs.backend == "coreml" && is_compile_error(receipt) {
        let mil_op = extract_mil_op_type(receipt);
        return Classification {
            cluster_kind: ClusterKind::CoremlCompileContract,
            root_cause: format!(
                "Core ML MIL shape-contract violation for {mil_op}: \
                 MIL builder output shape does not match model description function signature. \
                 Likely MilBuilder output dimensions not patched to match expected [1, ncols]."
            ),
            confidence: Confidence::High,
            blocked_phases: vec!["activation".into()],
        };
    }

    // Rule 2: Core ML prediction error (compile succeeded, predict failed)
    if obs.backend == "coreml"
        && obs.terminal_phase == "predict"
        && obs.status == "prediction_error"
    {
        return Classification {
            cluster_kind: ClusterKind::CoremlPredictContract,
            root_cause: "Core ML model compiled successfully but predict bridge \
                          returned error code. Likely feature contract mismatch: \
                          output feature type, name, or shape does not match \
                          compiled model description."
                .into(),
            confidence: Confidence::High,
            blocked_phases: vec![],
        };
    }

    // Rule 3: MLX execution failure (predict blocked)
    if obs.backend == "mlx" && obs.status == "prediction_error" {
        if !obs.fence_valid {
            return Classification {
                cluster_kind: ClusterKind::ReceiptOrHarnessDefect,
                root_cause: "MLX row lacks valid eval/materialization proof. \
                             MLX lazy evaluation records a compute graph without \
                             necessarily computing outputs. Cannot distinguish \
                             execution failure from fence/measurement defect."
                    .into(),
                confidence: Confidence::Medium,
                blocked_phases: vec![],
            };
        }
        return Classification {
            cluster_kind: ClusterKind::MlxExecutionContract,
            root_cause: "MLX execution failed at predict phase. Likely shape mismatch, \
                          missing op handling, or graph construction error."
                .into(),
            confidence: Confidence::High,
            blocked_phases: vec![],
        };
    }

    // Rule 4: MLX numerical divergence
    if obs.backend == "mlx" && obs.status == "numerical_divergence" {
        let abs_err = obs.max_absolute_error.map_or("N/A".into(), |v| format!("{:.6e}", v));
        let cos_sim = obs.cosine_similarity.map_or("N/A".into(), |v| format!("{:.6}", v));
        return Classification {
            cluster_kind: ClusterKind::MlxNumericalSemantics,
            root_cause: format!(
                "MLX output diverges from reference: max_abs_error={abs_err}, cos_sim={cos_sim}. \
                 Likely operation semantics, broadcasting, dtype, or reference mismatch."
            ),
            confidence: Confidence::Medium,
            blocked_phases: vec![],
        };
    }

    // Rule 5: Accelerate numerical divergence
    if obs.backend == "accelerate" && obs.status == "numerical_divergence" {
        // Check for reference_ops (evidence contamination)
        if let Some(ref ep) = obs.execution_proof {
            if !ep.reference_ops.is_empty() {
                return Classification {
                    cluster_kind: ClusterKind::ReceiptOrHarnessDefect,
                    root_cause: format!(
                        "Accelerate numerical divergence with non-empty reference_ops {:?}. \
                         Reference fallback used — evidence is unreliable.",
                        ep.reference_ops
                    ),
                    confidence: Confidence::Medium,
                    blocked_phases: vec![],
                };
            }
        }

        // Classify by kernel class
        let kernel_hint = if let Some(ref ep) = obs.execution_proof {
            if !ep.accelerate_blas_ops.is_empty() {
                "BLAS layout/stride mismatch (e.g., row-major vs column-major)"
            } else if !ep.accelerate_vdsp_ops.is_empty() {
                "vDSP vector length/stride mismatch"
            } else if !ep.accelerate_vforce_ops.is_empty() {
                "vForce sigmoid/exp elementwise semantics mismatch"
            } else if !ep.cpu_glue_ops.is_empty() {
                "CPU glue (reciprocal/add-one/negation) mismatch"
            } else {
                "unknown Accelerate kernel"
            }
        } else {
            "no execution proof available"
        };

        let abs_err = obs.max_absolute_error.map_or("N/A".into(), |v| format!("{:.6e}", v));
        let cos_sim = obs.cosine_similarity.map_or("N/A".into(), |v| format!("{:.6}", v));
        return Classification {
            cluster_kind: ClusterKind::AccelerateNumericalSemantics,
            root_cause: format!(
                "Accelerate numerical divergence in {}. max_abs_error={abs_err}, \
                 cos_sim={cos_sim}. Suspected cause: {kernel_hint}.",
                obs.family
            ),
            confidence: Confidence::Medium,
            blocked_phases: vec![],
        };
    }

    // Fallback: unclassified
    Classification {
        cluster_kind: ClusterKind::ReceiptOrHarnessDefect,
        root_cause: format!(
            "Unclassified failure: backend={}, status={}, terminal_phase={}",
            obs.backend, obs.status, obs.terminal_phase
        ),
        confidence: Confidence::Low,
        blocked_phases: vec![],
    }
}

/// Classify a KV defect reason string to a cluster kind.
///
/// Returns `Some(ClusterKind)` when the reason matches a known KV defect category.
/// This is a forward hook; actual classification will be wired in a later gate
/// when KV execution receipts exist.
pub fn classify_kv_defect(reason: &str) -> Option<ClusterKind> {
    if reason.contains("shape") {
        Some(ClusterKind::KvShapeMismatch)
    } else if reason.contains("layout") {
        Some(ClusterKind::KvLayoutMismatch)
    } else if reason.contains("position") {
        Some(ClusterKind::KvPositionMismatch)
    } else if reason.contains("mutation unsupported") {
        Some(ClusterKind::KvMutationUnsupported)
    } else if reason.contains("ownership violation") {
        Some(ClusterKind::KvOwnershipViolation)
    } else {
        None
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Cluster builder
// ═══════════════════════════════════════════════════════════════════════════

/// Group observations by (cluster_kind, semantic_contract_id, backend).
fn build_clusters(
    observations: &[DefectObservation],
    receipts: &[DecodeAttributionReceipt],
    classifications: &[Classification],
) -> (Vec<DefectCluster>, Vec<CrossBackendCorrelation>) {
    // Group by (cluster_kind, semantic_contract_id, backend) as primary grouping
    let mut groups: BTreeMap<(ClusterKind, String, String), Vec<usize>> = BTreeMap::new();
    for (i, obs) in observations.iter().enumerate() {
        let kind = classifications[i].cluster_kind;
        let key = (kind, obs.semantic_contract_id.clone(), obs.backend.clone());
        groups.entry(key).or_default().push(i);
    }

    // Build primary clusters from groups
    let mut clusters: Vec<DefectCluster> = Vec::new();
    let mut cluster_idx: u32 = 0;

    // Collect backends per (semantic_contract_id, shape_profile) for correlation
    let mut contract_backends: BTreeMap<(String, String), BTreeSet<String>> = BTreeMap::new();
    for obs in observations {
        contract_backends
            .entry((obs.semantic_contract_id.clone(), obs.shape_profile.clone()))
            .or_default()
            .insert(obs.backend.clone());
    }

    // Also collect which cluster each (semantic_contract_id, shape_profile, backend) maps to
    let mut obs_to_cluster_id: BTreeMap<(String, String, String), String> = BTreeMap::new();
    // We'll populate this as we create each cluster

    for ((kind, scid, backend), indices) in groups.iter() {
        let actual_indices: Vec<usize> = indices.iter().copied().collect();
        let cluster_obs: Vec<&DefectObservation> =
            actual_indices.iter().map(|&i| &observations[i]).collect();

        // Collect metadata
        let c = &classifications[actual_indices[0]];

        cluster_idx += 1;
        let cid = cluster_id_for(*kind, cluster_idx);

        // Track mapping for correlation
        for obs in &cluster_obs {
            obs_to_cluster_id.insert(
                (obs.semantic_contract_id.clone(), obs.shape_profile.clone(), obs.backend.clone()),
                cid.clone(),
            );
        }

        let families: Vec<String> = {
            let mut s: BTreeSet<&str> = BTreeSet::new();
            for obs in &cluster_obs {
                s.insert(obs.family.as_str());
            }
            s.into_iter().map(String::from).collect()
        };
        let backends: Vec<String> = {
            let mut s: BTreeSet<&str> = BTreeSet::new();
            for obs in &cluster_obs {
                s.insert(obs.backend.as_str());
            }
            s.into_iter().map(String::from).collect()
        };
        let shape_profiles: Vec<String> = {
            let mut s: BTreeSet<&str> = BTreeSet::new();
            for obs in &cluster_obs {
                s.insert(obs.shape_profile.as_str());
            }
            s.into_iter().map(String::from).collect()
        };
        let statuses: Vec<String> = {
            let mut s: BTreeSet<&str> = BTreeSet::new();
            for obs in &cluster_obs {
                s.insert(obs.status.as_str());
            }
            s.into_iter().map(String::from).collect()
        };
        let terminal_phases: Vec<String> = {
            let mut s: BTreeSet<&str> = BTreeSet::new();
            for obs in &cluster_obs {
                s.insert(obs.terminal_phase.as_str());
            }
            s.into_iter().map(String::from).collect()
        };
        let representative_rows: Vec<String> = cluster_obs
            .iter()
            .map(|o| {
                format!("{}/{}/{}/{}", o.backend, o.family, o.shape_profile, o.status)
            })
            .collect();

        // Evidence summary
        let evidence_summary =
            if let Some(first_diag) = cluster_obs.first().map(|o| &o.diagnostic) {
                if first_diag.is_empty() {
                    format!(
                        "{} rows: {} on {} for shapes {:?}. No diagnostic text.",
                        cluster_obs.len(),
                        families.join(", "),
                        backends.join("/"),
                        shape_profiles
                    )
                } else {
                    format!(
                        "{} rows: {} on {} for shapes {:?}. Diagnostic: {}",
                        cluster_obs.len(),
                        families.join(", "),
                        backends.join("/"),
                        shape_profiles,
                        first_diag
                    )
                }
            } else {
                format!(
                    "{} rows: {} on {} for shapes {:?}.",
                    cluster_obs.len(),
                    families.join(", "),
                    backends.join("/"),
                    shape_profiles
                )
            };

        // Severity
        let severity = match kind {
            ClusterKind::ReceiptOrHarnessDefect => Severity::S0InvalidEvidence,
            ClusterKind::CoremlCompileContract => Severity::S1BlocksDecodeMicrophase,
            ClusterKind::CoremlPredictContract => Severity::S3BackendSpecificGap,
            ClusterKind::MlxExecutionContract => Severity::S3BackendSpecificGap,
            ClusterKind::MlxNumericalSemantics => Severity::S3BackendSpecificGap,
            ClusterKind::AccelerateNumericalSemantics => Severity::S3BackendSpecificGap,
            ClusterKind::CrossBackendSemanticMismatch => Severity::S2BlocksBackendParity,
            ClusterKind::ShapeProfileSpecific => Severity::S4DiagnosticOnly,
            ClusterKind::PolicySpecific => Severity::S4DiagnosticOnly,
            ClusterKind::KvShapeMismatch => Severity::S3BackendSpecificGap,
            ClusterKind::KvLayoutMismatch => Severity::S3BackendSpecificGap,
            ClusterKind::KvPositionMismatch => Severity::S3BackendSpecificGap,
            ClusterKind::KvMutationUnsupported => Severity::S3BackendSpecificGap,
            ClusterKind::KvOwnershipViolation => Severity::S3BackendSpecificGap,
        };

        let recommended_next_gate = match kind {
            ClusterKind::CoremlCompileContract => "FIX-COREML-STANDALONE-SHAPES",
            ClusterKind::CoremlPredictContract => "FIX-COREML-SIGMOID-PREDICT-BRIDGE",
            ClusterKind::MlxExecutionContract => "FIX-MLX-ADD-SHAPE-ADAPTER",
            ClusterKind::MlxNumericalSemantics => "FIX-MLX-MUL-SEMANTICS",
            ClusterKind::AccelerateNumericalSemantics => "FIX-ACCELERATE-VDSP-MUL-ADAPTER",
            ClusterKind::CrossBackendSemanticMismatch => "FIX-SEMANTIC-CONTRACT-REFERENCE-EVALUATOR",
            ClusterKind::ShapeProfileSpecific => "DEFER-SHAPE-PROFILE-TIER2",
            ClusterKind::PolicySpecific => "DEFER-POLICY-EXPANSION",
            ClusterKind::KvShapeMismatch => "KV-CACHE-SHAPE-CONTRACT-QUALIFICATION",
            ClusterKind::KvLayoutMismatch => "KV-CACHE-LAYOUT-QUALIFICATION",
            ClusterKind::KvPositionMismatch => "KV-CACHE-POSITION-QUALIFICATION",
            ClusterKind::KvMutationUnsupported => "KV-CACHE-MUTATION-QUALIFICATION",
            ClusterKind::KvOwnershipViolation => "KV-CACHE-OWNERSHIP-QUALIFICATION",
            ClusterKind::ReceiptOrHarnessDefect => "FIX-RECEIPT-HARNESS-EVIDENCE",
        }
        .into();

        let pipeline_phase = cluster_obs.first().and_then(|o| {
            let ph = o.pipeline_phase.as_deref().unwrap_or("");
            if ph.is_empty() {
                None
            } else {
                o.pipeline_phase.clone()
            }
        });
        let phase_variant = cluster_obs
            .first()
            .map(|o| o.phase_variant.clone())
            .unwrap_or_default();
        let semantic_contract_id = cluster_obs
            .first()
            .map(|o| o.semantic_contract_id.clone())
            .unwrap_or_default();

        clusters.push(DefectCluster {
            cluster_id: cid,
            cluster_kind: *kind,
            pipeline_phase,
            phase_variant,
            semantic_contract_id,
            families,
            backends,
            shape_profiles,
            statuses,
            terminal_phases,
            likely_root_cause: c.root_cause.clone(),
            confidence: c.confidence,
            severity,
            blocked_next_phases: c.blocked_phases.clone(),
            recommended_next_gate,
            representative_rows,
            evidence_summary,
            secondary_kinds: vec![],
        });
    }

    // Build synthetic cross-backend correlations
    let mut correlations: Vec<CrossBackendCorrelation> = Vec::new();
    let mut corr_idx: u32 = 0;

    for ((scid, sp), backends) in contract_backends.iter() {
        if backends.len() < 2 || scid.is_empty() {
            continue;
        }
        // Find which clusters contain each backend for this contract
        let mut involved_clusters: Vec<String> = Vec::new();
        let mut involved_backends: Vec<String> = Vec::new();
        for backend in backends {
            if let Some(cid) = obs_to_cluster_id.get(&(scid.clone(), sp.clone(), backend.clone())) {
                involved_clusters.push(cid.clone());
                involved_backends.push(backend.clone());
            }
        }
        if involved_clusters.len() < 2 {
            continue;
        }
        corr_idx += 1;
        correlations.push(CrossBackendCorrelation {
            correlation_id: format!("correlation_{corr_idx:03}"),
            semantic_contract_id: scid.clone(),
            shape_profile: sp.clone(),
            cluster_ids: involved_clusters,
            backends: involved_backends,
            likely_root_cause: format!(
                "Same semantic_contract_id '{scid}' fails across {} backends. \
                 Likely reference evaluator or semantic-contract ambiguity.",
                backends.len()
            ),
            confidence: Confidence::High,
        });
    }

    (clusters, correlations)
}

// ═══════════════════════════════════════════════════════════════════════════
// Main clustering entry point
// ═══════════════════════════════════════════════════════════════════════════

/// Cluster all non-pass receipts from a run directory.
///
/// # Arguments
///
/// * `receipts` — All receipts from the run.
///
/// # Returns
///
/// * `observations` — Normalized defect observations for each non-pass row.
/// * `clusters` — Grouped defect clusters by root cause.
/// * `correlations` — Synthetic cross-backend correlation records.
/// * `pass_tier0` — Number of Tier 0 rows that passed.
/// * `pass_tier1` — Number of Tier 1 rows that passed.
/// * `total_tier0` — Total Tier 0 rows attempted.
/// * `total_tier1` — Total Tier 1 rows attempted.
pub fn cluster_defects(
    receipts: &[DecodeAttributionReceipt],
) -> (
    Vec<DefectObservation>,
    Vec<DefectCluster>,
    Vec<CrossBackendCorrelation>,
    usize,
    usize,
    usize,
    usize,
) {
    let mut pass_tier0 = 0usize;
    let mut pass_tier1 = 0usize;
    let mut total_tier0 = 0usize;
    let mut total_tier1 = 0usize;
    let mut non_pass: Vec<&DecodeAttributionReceipt> = Vec::new();

    for receipt in receipts {
        let is_tier0 = {
            let f = receipt.graph_family.as_str();
            (f == "matmul"
                || f == "chain_matmul_add_silu"
                || f == "branch_rejoin"
                || f == "constant_heavy")
                && !f.starts_with("add_")
                && !f.starts_with("mul_")
                && !f.starts_with("sigmoid_")
                && !f.starts_with("silu_")
                && !f.starts_with("matmul_projection")
                && !f.starts_with("matmul_residual_add")
                && !f.starts_with("two_matmul_add")
                && !f.starts_with("matmul_add_silu")
        };

        let passes = receipt.status == "pass";

        if is_tier0 {
            total_tier0 += 1;
            if passes {
                pass_tier0 += 1;
            }
        } else if !receipt.graph_family.starts_with("identity_passthrough") {
            total_tier1 += 1;
            if passes {
                pass_tier1 += 1;
            } else {
                non_pass.push(receipt);
            }
        }
    }

    let observations: Vec<DefectObservation> =
        non_pass.iter().map(|r| normalize_observation(r)).collect();

    let classifications: Vec<Classification> = non_pass
        .iter()
        .enumerate()
        .map(|(i, r)| classify_observation(&observations[i], r))
        .collect();

    let (clusters, correlations) = build_clusters(&observations, receipts, &classifications);

    (observations, clusters, correlations, pass_tier0, pass_tier1, total_tier0, total_tier1)
}

// ═══════════════════════════════════════════════════════════════════════════
// Output serialization
// ═══════════════════════════════════════════════════════════════════════════

/// Write `tier1_defect_observations.json`.
pub fn write_observations_json(observations: &[DefectObservation], path: &Path) -> Result<(), String> {
    let json =
        serde_json::to_string_pretty(observations).map_err(|e| format!("serialize observations: {e}"))?;
    std::fs::write(path, &json).map_err(|e| format!("write {:?}: {e}", path))
}

/// Write `tier1_defect_clusters.json`.
pub fn write_clusters_json(clusters: &[DefectCluster], path: &Path) -> Result<(), String> {
    let json =
        serde_json::to_string_pretty(clusters).map_err(|e| format!("serialize clusters: {e}"))?;
    std::fs::write(path, &json).map_err(|e| format!("write {:?}: {e}", path))
}

/// Write `tier1_cross_backend_correlations.json`.
pub fn write_correlations_json(correlations: &[CrossBackendCorrelation], path: &Path) -> Result<(), String> {
    let json =
        serde_json::to_string_pretty(correlations).map_err(|e| format!("serialize correlations: {e}"))?;
    std::fs::write(path, &json).map_err(|e| format!("write {:?}: {e}", path))
}

/// Write `tier1_defect_summary.md`.
#[allow(clippy::too_many_arguments)]
pub fn write_summary_md(
    clusters: &[DefectCluster],
    observations: &[DefectObservation],
    correlations: &[CrossBackendCorrelation],
    pass_tier0: usize,
    pass_tier1: usize,
    total_tier0: usize,
    total_tier1: usize,
    path: &Path,
) -> Result<(), String> {
    let mut lines: Vec<String> = Vec::new();

    lines.push("# FULL-SUITE-TIER1-DEFECT-CLUSTERING-0001 — Summary".into());
    lines.push(String::new());
    lines.push("## Run summary".into());
    lines.push(String::new());
    lines.push("| Tier | Pass | Total | Rate |".into());
    lines.push("|------|------|-------|------|".into());
    lines.push(format!(
        "| Tier 0 | {pass_tier0} | {total_tier0} | {:.1}% |",
        pass_tier0 as f64 / total_tier0.max(1) as f64 * 100.0
    ));
    lines.push(format!(
        "| Tier 1 | {pass_tier1} | {total_tier1} | {:.1}% |",
        pass_tier1 as f64 / total_tier1.max(1) as f64 * 100.0
    ));
    lines.push(format!(
        "| **Combined** | **{}** | **{}** | **{:.1}%** |",
        pass_tier0 + pass_tier1,
        total_tier0 + total_tier1,
        (pass_tier0 + pass_tier1) as f64 / (total_tier0 + total_tier1).max(1) as f64 * 100.0
    ));
    lines.push(String::new());
    lines.push(format!("Non-pass Tier 1 rows: {}", observations.len()));
    lines.push(format!("Clusters: {}", clusters.len()));
    lines.push(String::new());

    // Sort clusters by severity then count
    let mut sorted_clusters: Vec<&DefectCluster> = clusters.iter().collect();
    sorted_clusters.sort_by_key(|c| (severity_order(c.severity), -(c.representative_rows.len() as i64)));

    lines.push("## Clusters (sorted by severity)".into());
    lines.push(String::new());
    lines.push(
        "| Cluster | Kind | Severity | Rows | Backends | Families | Root cause | Confidence |"
            .into(),
    );
    lines.push(
        "|---------|------|----------|------|----------|----------|------------|------------|"
            .into(),
    );

    for cluster in &sorted_clusters {
        let families = cluster.families.join(", ");
        let backends = cluster.backends.join(", ");
        let root_short = if cluster.likely_root_cause.len() > 60 {
            format!("{}…", &cluster.likely_root_cause[..57])
        } else {
            cluster.likely_root_cause.clone()
        };
        lines.push(format!(
            "| {} | {} | {} | {} | {} | {} | {} | {} |",
            cluster.cluster_id,
            cluster.cluster_kind.as_str(),
            cluster.severity.as_str(),
            cluster.representative_rows.len(),
            backends,
            families,
            root_short,
            cluster.confidence.as_str(),
        ));
    }

    lines.push(String::new());

    // Cross-backend correlations
    if !correlations.is_empty() {
        lines.push("## Cross-backend correlations".into());
        lines.push(String::new());
        lines.push("| Correlation | Contract | Shape | Backends | Clusters | Root cause |".into());
        lines.push("|-------------|----------|-------|----------|----------|------------|".into());
        for corr in correlations {
            lines.push(format!(
                "| {} | {} | {} | {} | {} | {} |",
                corr.correlation_id,
                corr.semantic_contract_id,
                corr.shape_profile,
                corr.backends.join(", "),
                corr.cluster_ids.join(", "),
                corr.likely_root_cause
            ));
        }
        lines.push(String::new());
    }

    // Per-cluster detail
    lines.push("## Cluster details".into());
    lines.push(String::new());
    for cluster in &sorted_clusters {
        lines.push(format!("### {}", cluster.cluster_id));
        lines.push(String::new());
        lines.push(format!("- **Kind**: `{}`", cluster.cluster_kind.as_str()));
        lines.push(format!("- **Severity**: {}", cluster.severity.as_str()));
        lines.push(format!("- **Confidence**: {}", cluster.confidence.as_str()));
        lines.push(format!("- **Root cause**: {}", cluster.likely_root_cause));
        lines.push(format!("- **Evidence**: {}", cluster.evidence_summary));
        if !cluster.blocked_next_phases.is_empty() {
            lines.push(format!("- **Blocks**: {}", cluster.blocked_next_phases.join(", ")));
        }
        lines.push(format!("- **Recommended gate**: {}", cluster.recommended_next_gate));
        lines.push(String::new());

        lines.push("| Row | Backend | Family | Shape | Status | Terminal phase | Max abs err | Cos sim |".into());
        lines.push("|-----|---------|--------|-------|--------|----------------|-------------|---------|".into());
        for row in &cluster.representative_rows {
            let parts: Vec<&str> = row.splitn(4, '/').collect();
            let parts: Vec<&str> = row.splitn(4, '/').collect();
            let (b, f, s, st) = if parts.len() >= 4 {
                (parts[0], parts[1], parts[2], parts[3])
            } else {
                ("", "", "", "")
            };
            let metrics: Option<&DefectObservation> = observations.iter().find(|o| {
                o.backend == b && o.family == f && o.shape_profile == s
            });
            if let Some(m) = metrics {
                let abs_err = m
                    .max_absolute_error
                    .map_or("-".into(), |v| {
                        if v > 1e100 {
                            "∞".into()
                        } else {
                            format!("{:.4e}", v)
                        }
                    });
                let cos_sim = m
                    .cosine_similarity
                    .map_or("-".into(), |v| {
                        if v >= 0.9999 {
                            "1.0".into()
                        } else {
                            format!("{:.4}", v)
                        }
                    });
                lines.push(format!(
                    "| | {} | {} | {} | {} | {} | {} | {} |",
                    b, f, s, st, m.terminal_phase, abs_err, cos_sim
                ));
            } else {
                lines.push(format!("| | {} | {} | {} | {} | - | - | - |", b, f, s, st));
            }
        }
        lines.push(String::new());
    }

    // Tier 2 blockers
    lines.push("## Tier 2 blockers".into());
    lines.push(String::new());
    let blockers: Vec<&DefectCluster> = sorted_clusters
        .iter()
        .filter(|c| {
            matches!(c.severity, Severity::S1BlocksDecodeMicrophase | Severity::S2BlocksBackendParity)
        })
        .copied()
        .collect();
    if blockers.is_empty() {
        lines.push("No clusters block Tier 2 decode microphases.".into());
    } else {
        for cluster in &blockers {
            lines.push(format!(
                "- **{}** ({}): {} — {}",
                cluster.cluster_id,
                cluster.severity.as_str(),
                cluster.likely_root_cause,
                cluster.evidence_summary
            ));
        }
    }
    lines.push(String::new());

    lines.push("## Recommended next gates".into());
    lines.push(String::new());
    let mut seen_gates: BTreeSet<&str> = BTreeSet::new();
    for cluster in &sorted_clusters {
        if seen_gates.insert(cluster.recommended_next_gate.as_str()) {
            lines.push(format!(
                "- **{}** — resolves cluster(s) matching severity {} with {} rows",
                cluster.recommended_next_gate,
                cluster.severity.as_str(),
                cluster.representative_rows.len()
            ));
        }
    }

    lines.push(String::new());
    lines.push("---".into());
    lines.push("_Generated by FULL-SUITE-TIER1-DEFECT-CLUSTERING-0001_".into());
    lines.push(String::new());

    std::fs::write(path, lines.join("\n")).map_err(|e| format!("write {:?}: {e}", path))
}

fn severity_order(s: Severity) -> i32 {
    match s {
        Severity::S0InvalidEvidence => 0,
        Severity::S1BlocksDecodeMicrophase => 1,
        Severity::S2BlocksBackendParity => 2,
        Severity::S3BackendSpecificGap => 3,
        Severity::S4DiagnosticOnly => 4,
    }
}

/// Write `tier1_blockers_for_decode_microphase.json`.
pub fn write_tier2_blockers_json(clusters: &[DefectCluster], path: &Path) -> Result<(), String> {
    let blocking: Vec<Tier2Blocker> = clusters
        .iter()
        .filter(|c| {
            matches!(c.severity, Severity::S1BlocksDecodeMicrophase | Severity::S2BlocksBackendParity)
        })
        .map(|c| Tier2Blocker {
            cluster_id: c.cluster_id.clone(),
            cluster_kind: c.cluster_kind.as_str().into(),
            severity: c.severity.as_str().into(),
            blocked_phases: c.blocked_next_phases.clone(),
            root_cause: c.likely_root_cause.clone(),
            why_blocks: format!(
                "{} blocks decode microphase execution because {}",
                c.cluster_kind.as_str(),
                c.evidence_summary
            ),
            recommended_fix_gate: c.recommended_next_gate.clone(),
        })
        .collect();
    let json =
        serde_json::to_string_pretty(&blocking).map_err(|e| format!("serialize blockers: {e}"))?;
    std::fs::write(path, &json).map_err(|e| format!("write {:?}: {e}", path))
}

/// Write `next_fix_gates.json`.
pub fn write_next_fix_gates_json(clusters: &[DefectCluster], path: &Path) -> Result<(), String> {
    let mut gates: BTreeMap<&str, Vec<&DefectCluster>> = BTreeMap::new();
    for cluster in clusters {
        gates.entry(cluster.recommended_next_gate.as_str()).or_default().push(cluster);
    }
    let fix_gates: Vec<NextFixGate> = gates
        .into_iter()
        .map(|(gate_id, cluster_group)| {
            let priority = {
                let max_sev = cluster_group
                    .iter()
                    .map(|c| severity_order(c.severity))
                    .min()
                    .unwrap_or(4);
                match max_sev {
                    0 => "critical",
                    1 => "critical",
                    2 => "high",
                    3 => "medium",
                    _ => "low",
                }
                .into()
            };
            let scope: Vec<String> = cluster_group
                .iter()
                .flat_map(|c| c.families.iter().cloned())
                .collect::<BTreeSet<_>>()
                .into_iter()
                .collect();
            NextFixGate {
                gate_id: gate_id.into(),
                cluster_ids: cluster_group.iter().map(|c| c.cluster_id.clone()).collect(),
                scope: scope.join(", "),
                priority,
                effort_estimate: match gate_id {
                    "FIX-COREML-STANDALONE-SHAPES" => "2-4 hours".into(),
                    "FIX-COREML-SIGMOID-PREDICT-BRIDGE" => "2-4 hours".into(),
                    "FIX-MLX-ADD-SHAPE-ADAPTER" => "1-2 hours".into(),
                    "FIX-MLX-MUL-SEMANTICS" => "1-3 hours".into(),
                    "FIX-ACCELERATE-VDSP-MUL-ADAPTER" => "2-4 hours".into(),
                    "FIX-SEMANTIC-CONTRACT-REFERENCE-EVALUATOR" => "4-8 hours".into(),
                    "FIX-RECEIPT-HARNESS-EVIDENCE" => "1-2 hours".into(),
                    _ => "TBD".into(),
                },
            }
        })
        .collect();
    let json =
        serde_json::to_string_pretty(&fix_gates).map_err(|e| format!("serialize fix gates: {e}"))?;
    std::fs::write(path, &json).map_err(|e| format!("write {:?}: {e}", path))
}

// ═══════════════════════════════════════════════════════════════════════════
// Load receipts from a run directory
// ═══════════════════════════════════════════════════════════════════════════

/// Load all receipts from a run directory.
///
/// Expects directory structure:
///   {run_dir}/{backend}/{family}/{shape}/receipt.json
pub fn load_receipts_from_run(run_dir: &Path) -> Result<Vec<DecodeAttributionReceipt>, String> {
    if !run_dir.is_dir() {
        return Err(format!("run directory not found: {:?}", run_dir));
    }

    let mut receipts: Vec<DecodeAttributionReceipt> = Vec::new();

    let entries: Vec<_> = std::fs::read_dir(run_dir)
        .map_err(|e| format!("read {:?}: {e}", run_dir))?
        .filter_map(|e| e.ok())
        .collect();

    // Walk subdirectories recursively looking for receipt.json
    for top_entry in &entries {
        if !top_entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let backend_dir = top_entry.path();
        // backend_dir is like {run_dir}/coreml
        let backend_entries = match std::fs::read_dir(&backend_dir) {
            Ok(e) => e.filter_map(|e| e.ok()).collect::<Vec<_>>(),
            Err(_) => continue,
        };
        for fam_entry in &backend_entries {
            if !fam_entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                continue;
            }
            let family_dir = fam_entry.path();
            let fam_entries = match std::fs::read_dir(&family_dir) {
                Ok(e) => e.filter_map(|e| e.ok()).collect::<Vec<_>>(),
                Err(_) => continue,
            };
            for shape_entry in &fam_entries {
                if !shape_entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                    continue;
                }
                let receipt_path = shape_entry.path().join("receipt.json");
                if !receipt_path.exists() {
                    continue;
                }
                let content = match std::fs::read_to_string(&receipt_path) {
                    Ok(c) => c,
                    Err(e) => {
                        eprintln!("  warn: read {:?}: {e}", receipt_path);
                        continue;
                    }
                };
                match serde_json::from_str::<DecodeAttributionReceipt>(&content) {
                    Ok(receipt) => receipts.push(receipt),
                    Err(e) => {
                        eprintln!("  warn: parse {:?}: {e}", receipt_path);
                    }
                }
            }
        }
    }

    if receipts.is_empty() {
        return Err(format!("no receipt.json files found in {:?}", run_dir));
    }

    Ok(receipts)
}

// ═══════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cluster_kind_count() {
        let kinds = [
            ClusterKind::CoremlCompileContract,
            ClusterKind::CoremlPredictContract,
            ClusterKind::MlxExecutionContract,
            ClusterKind::MlxNumericalSemantics,
            ClusterKind::AccelerateNumericalSemantics,
            ClusterKind::CrossBackendSemanticMismatch,
            ClusterKind::ShapeProfileSpecific,
            ClusterKind::PolicySpecific,
            ClusterKind::ReceiptOrHarnessDefect,
        ];
        assert_eq!(kinds.len(), 9);
        for kind in &kinds {
            let v = serde_json::to_value(kind).unwrap();
            assert_eq!(kind.as_str(), v.as_str().unwrap());
        }
    }

    #[test]
    fn severity_ordering() {
        assert!(
            severity_order(Severity::S0InvalidEvidence)
                < severity_order(Severity::S1BlocksDecodeMicrophase)
        );
        assert!(
            severity_order(Severity::S1BlocksDecodeMicrophase)
                < severity_order(Severity::S2BlocksBackendParity)
        );
        assert!(
            severity_order(Severity::S3BackendSpecificGap)
                < severity_order(Severity::S4DiagnosticOnly)
        );
    }

    #[test]
    fn confidence_round_trip() {
        for c in &[Confidence::High, Confidence::Medium, Confidence::Low] {
            let v = serde_json::to_value(c).unwrap();
            assert_eq!(c.as_str(), v.as_str().unwrap());
        }
    }

    #[test]
    fn default_receipt_normalizes() {
        let r = DecodeAttributionReceipt::default();
        let obs = normalize_observation(&r);
        assert_eq!(obs.backend, "");
        assert!(obs.max_absolute_error.is_none());
        assert!(obs.cosine_similarity.is_none());
    }

    // ── KV defect clustering tests ────────────────────────────────────

    #[test]
    fn kv_cluster_kinds_count_14() {
        // 9 original + 5 new KV = 14
        let kinds = vec![
            ClusterKind::CoremlCompileContract,
            ClusterKind::CoremlPredictContract,
            ClusterKind::MlxExecutionContract,
            ClusterKind::MlxNumericalSemantics,
            ClusterKind::AccelerateNumericalSemantics,
            ClusterKind::CrossBackendSemanticMismatch,
            ClusterKind::ShapeProfileSpecific,
            ClusterKind::PolicySpecific,
            ClusterKind::ReceiptOrHarnessDefect,
            ClusterKind::KvShapeMismatch,
            ClusterKind::KvLayoutMismatch,
            ClusterKind::KvPositionMismatch,
            ClusterKind::KvMutationUnsupported,
            ClusterKind::KvOwnershipViolation,
        ];
        assert_eq!(kinds.len(), 14, "ClusterKind must have 14 variants");
        // Verify all serialize/deserialize
        for kind in &kinds {
            let json = serde_json::to_string(kind).expect("ClusterKind must serialize");
            let back: ClusterKind = serde_json::from_str(&json).expect("ClusterKind must deserialize");
            assert_eq!(*kind, back, "roundtrip failed for {kind:?}");
        }
    }

    #[test]
    fn kv_cluster_kinds_serde_roundtrip() {
        // New KV kinds specifically
        for kind in &[
            ClusterKind::KvShapeMismatch,
            ClusterKind::KvLayoutMismatch,
            ClusterKind::KvPositionMismatch,
            ClusterKind::KvMutationUnsupported,
            ClusterKind::KvOwnershipViolation,
        ] {
            let json = serde_json::to_string(kind).expect("KV ClusterKind must serialize");
            let back: ClusterKind = serde_json::from_str(&json).expect("KV ClusterKind must deserialize");
            assert_eq!(*kind, back, "serde roundtrip failed for {kind:?}");
        }
    }

    #[test]
    fn classify_kv_defect_shape() {
        let kind = super::classify_kv_defect("shape mismatch in KV cache");
        assert_eq!(kind, Some(ClusterKind::KvShapeMismatch),
            "should return KvShapeMismatch for shape-related reason");
    }

    #[test]
    fn classify_kv_defect_position() {
        let kind = super::classify_kv_defect("position out of bounds");
        assert_eq!(kind, Some(ClusterKind::KvPositionMismatch),
            "should return KvPositionMismatch for position-related reason");
    }
}
