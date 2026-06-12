use std::cmp::Ordering;
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::decode_attribution::backend_adapters::BackendKind;
use crate::pipeline_parity::{
    decode_microphase_support_for, kv_phase_support_for, support_matrix_for, PendingCode,
    PhaseSupportStatus, PipelinePhase,
};

pub const KNOWN_EXTERNAL_ARRAY_ALLOWLIST: &[&str] = &[];
pub const GAP_REPORT_ID: &str = "COMPUTE-GAP-REPORT-0001";

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub enum GapSeverity {
    S0,
    S1,
    S2,
    S3,
    S4,
}

impl GapSeverity {
    pub fn as_numeric(self) -> u8 {
        match self {
            Self::S0 => 0,
            Self::S1 => 1,
            Self::S2 => 2,
            Self::S3 => 3,
            Self::S4 => 4,
        }
    }

    fn is_s3_or_higher(self) -> bool {
        self.as_numeric() >= 3
    }

    fn is_s4(self) -> bool {
        self.as_numeric() == 4
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GapSource {
    Rustc,
    Clippy,
    CargoTest,
    Tier1DefectCluster,
    Tier2Manifest,
    SupportMatrix,
    KvContract,
    ReferenceAdapter,
    CoremlBridge,
    MlxRuntime,
    AccelerateComposed,
    PythonReference,
    ManualBlocker,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GapSubsystem {
    DecodeAttribution,
    PipelineParity,
    ShapeMap,
    DefectClustering,
    ReferenceAdapter,
    ManifestGenerator,
    CoremlAdapter,
    MlxAdapter,
    AccelerateAdapter,
    ExternalArray,
    KvCacheContracts,
    ReceiptGeneration,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GapStatus {
    Open,
    KnownPreexisting,
    Deferred,
    IntentionalUnsupported,
    PendingQualification,
    BlockedUpstream,
    FixedInCurrentRun,
    NeedsTriage,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GapClassification {
    CompileWarning,
    ClippyWarning,
    TestFailure,
    Tier1DefectCluster,
    Tier2Manifest,
    KvContractGap,
    BackendOwnershipGap,
    PendingQualification,
    UnsupportedPath,
    DeprecatedArtifactMismatch,
    BridgeFailure,
    NumericalDivergence,
    SupportMatrixMismatch,
    EvidenceMissing,
    ReceiptMissing,
    ManualBlocker,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BackendGapCell {
    Qualified,
    HostManaged,
    Pending,
    Unsupported,
    Tier1Blocked,
    NotApplicable,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ComputeGap {
    pub gap_id: String,
    pub source: GapSource,
    pub subsystem: GapSubsystem,
    pub severity: GapSeverity,
    pub classification: GapClassification,
    pub status: GapStatus,
    pub message: String,
    pub backend: Option<String>,
    pub phase: Option<String>,
    pub family: Option<String>,
    pub shape_profile: Option<String>,
    pub semantic_shape_profile: Option<String>,
    pub tier: Option<String>,
    pub test_name: Option<String>,
    pub row_id: Option<String>,
    pub owner_gate: Option<String>,
    pub evidence_path: Option<String>,
    pub blocks_promotion: bool,
    pub blocks_runtime_claim: bool,
    pub blocks_release_claim: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackendGapMatrix {
    pub basis: String,
    pub phases: Vec<String>,
    pub coreml: Vec<String>,
    pub mlx: Vec<String>,
    pub accelerate: Vec<String>,
}

#[derive(Debug, Clone, Copy, Default)]
pub struct GapReportAccounting {
    pub observed_tier1_total: u32,
    pub tier1_pass_count: u32,
    pub tier1_nonpass_count: u32,
    pub tier1_gap_rows: u32,
    pub observed_tier2_manifest_rows: u32,
    pub tier2_gap_rows: u32,
    pub observed_kv_contract_rows: u32,
    pub kv_contract_gap_rows: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GapReportReceipt {
    pub report_id: String,
    pub generated_at: String,
    pub total_warnings: u32,
    pub total_errors: u32,
    pub total_failing_tests: u32,
    pub total_open_gaps: u32,
    pub s3_s4_gaps: u32,
    pub tier0_pass_count: u32,
    pub tier1_pass_count: u32,
    pub tier1_nonpass_count: u32,
    pub tier1_gap_rows: u32,
    pub tier2_manifest_count: u32,
    pub tier2_gap_rows: u32,
    pub kv_contract_count: u32,
    pub kv_contract_gap_rows: u32,
    pub observed_tier1_total: u32,
    pub observed_tier2_manifest_rows: u32,
    pub observed_kv_contract_rows: u32,
    pub false_qualification_risks_detected: bool,
    pub artifact_count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FixGate {
    pub gate_id: String,
    pub priority: String,
    pub description: String,
    pub owned_gaps: Vec<String>,
    pub scope: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ArtifactReceiptEntry {
    pub sha256: String,
    pub row_count: u64,
}

#[derive(Debug, Deserialize)]
struct Tier1ClusterRow {
    cluster_kind: String,
    pipeline_phase: Option<String>,
    families: Vec<String>,
    backends: Vec<String>,
    shape_profiles: Vec<String>,
    severity: String,
    recommended_next_gate: String,
    representative_rows: Vec<String>,
    evidence_summary: String,
}

#[derive(Debug, Deserialize)]
struct Tier2SupportRow {
    row_id: String,
    family: String,
    shape_profile: String,
    semantic_shape_profile: String,
    backend: String,
    support_status: String,
    reason: Option<String>,
    blocked_by_tier1_defect: Option<String>,
}

#[derive(Debug, Deserialize)]
struct Tier2ReceiptIndexRow {
    row_id: String,
    tier: String,
    family: String,
    shape_profile: String,
    semantic_shape_profile: String,
    pipeline_phase: String,
    backend: String,
    support_status: String,
    blocked: bool,
}

fn phase_str(phase: PipelinePhase) -> String {
    phase.to_string()
}

fn is_kv_phase(phase: PipelinePhase) -> bool {
    matches!(phase, PipelinePhase::KvRead | PipelinePhase::KvWrite | PipelinePhase::KvAppend | PipelinePhase::KvView)
}

fn severity_for_tier1(value: &str) -> GapSeverity {
    match value {
        "S0_invalid_evidence" => GapSeverity::S4,
        "S1_blocks_decode_microphase" => GapSeverity::S3,
        "S2_blocks_backend_parity" => GapSeverity::S3,
        "S3_backend_specific_gap" => GapSeverity::S2,
        "S4_diagnostic_only" => GapSeverity::S1,
        _ => GapSeverity::S2,
    }
}

fn classification_for_tier1(cluster_kind: &str) -> GapClassification {
    match cluster_kind {
        "CoremlCompileContract" | "CoremlPredictContract" | "MlxExecutionContract" => {
            GapClassification::BridgeFailure
        }
        "MlxNumericalSemantics" | "AccelerateNumericalSemantics" | "CrossBackendSemanticMismatch" => {
            GapClassification::NumericalDivergence
        }
        "KvOwnershipViolation" => GapClassification::BackendOwnershipGap,
        "KvMutationUnsupported" | "KvShapeMismatch" | "KvLayoutMismatch" | "KvPositionMismatch" => {
            GapClassification::UnsupportedPath
        }
        "PolicySpecific" | "ReceiptOrHarnessDefect" | "ShapeProfileSpecific" => {
            GapClassification::SupportMatrixMismatch
        }
        _ => GapClassification::Tier1DefectCluster,
    }
}

fn severity_for_support_status(status: &str) -> GapSeverity {
    if status.starts_with("pending") {
        GapSeverity::S3
    } else if status.starts_with("unsupported") {
        GapSeverity::S2
    } else {
        GapSeverity::S1
    }
}

fn classification_for_support_status(status: &str) -> GapClassification {
    if status.starts_with("pending") {
        GapClassification::PendingQualification
    } else {
        GapClassification::UnsupportedPath
    }
}

fn status_for_support_status(status: &str) -> GapStatus {
    if status.starts_with("pending") {
        GapStatus::PendingQualification
    } else {
        GapStatus::IntentionalUnsupported
    }
}

fn current_timestamp() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    secs.to_string()
}

fn read_text_if_exists(path: &Path) -> Result<Option<String>, String> {
    if !path.exists() {
        return Ok(None);
    }
    fs::read_to_string(path)
        .map(Some)
        .map_err(|e| format!("read {:?}: {e}", path))
}

fn gap_sort_cmp(left: &ComputeGap, left_idx: usize, right: &ComputeGap, right_idx: usize) -> Ordering {
    (4 - left.severity.as_numeric())
        .cmp(&(4 - right.severity.as_numeric()))
        .then_with(|| u8::from(!left.blocks_promotion).cmp(&u8::from(!right.blocks_promotion)))
        .then_with(|| u8::from(!left.blocks_runtime_claim).cmp(&u8::from(!right.blocks_runtime_claim)))
        .then_with(|| u8::from(!left.blocks_release_claim).cmp(&u8::from(!right.blocks_release_claim)))
        .then_with(|| source_sort_rank(left.source).cmp(&source_sort_rank(right.source)))
        .then_with(|| subsystem_sort_rank(left.subsystem).cmp(&subsystem_sort_rank(right.subsystem)))
        .then_with(|| tier_sort_rank(left.tier.as_deref()).cmp(&tier_sort_rank(right.tier.as_deref())))
        .then_with(|| left.classification.cmp(&right.classification))
        .then_with(|| left.backend.cmp(&right.backend))
        .then_with(|| left.phase.cmp(&right.phase))
        .then_with(|| left.family.cmp(&right.family))
        .then_with(|| left.shape_profile.cmp(&right.shape_profile))
        .then_with(|| left.test_name.cmp(&right.test_name))
        .then_with(|| left.owner_gate.cmp(&right.owner_gate))
        .then_with(|| left.message.cmp(&right.message))
        .then_with(|| left_idx.cmp(&right_idx))
}

fn source_sort_rank(source: GapSource) -> u8 {
    match source {
        GapSource::Tier1DefectCluster => 0,
        GapSource::Tier2Manifest => 1,
        GapSource::KvContract => 2,
        GapSource::SupportMatrix => 3,
        GapSource::CargoTest => 4,
        GapSource::Rustc | GapSource::Clippy => 5,
        GapSource::PythonReference => 6,
        GapSource::ReferenceAdapter => 7,
        GapSource::CoremlBridge => 8,
        GapSource::MlxRuntime => 9,
        GapSource::AccelerateComposed => 10,
        GapSource::ManualBlocker => 11,
    }
}

fn subsystem_sort_rank(subsystem: GapSubsystem) -> u8 {
    match subsystem {
        GapSubsystem::DefectClustering => 0,
        GapSubsystem::ManifestGenerator => 1,
        GapSubsystem::KvCacheContracts => 2,
        GapSubsystem::PipelineParity => 3,
        GapSubsystem::DecodeAttribution => 4,
        GapSubsystem::ExternalArray => 5,
        GapSubsystem::ReferenceAdapter => 6,
        GapSubsystem::CoremlAdapter => 7,
        GapSubsystem::MlxAdapter => 8,
        GapSubsystem::AccelerateAdapter => 9,
        GapSubsystem::ShapeMap => 10,
        GapSubsystem::ReceiptGeneration => 11,
    }
}

fn tier_sort_rank(tier: Option<&str>) -> u8 {
    match tier {
        Some("tier1") => 0,
        Some("tier2") => 1,
        Some("tier3") => 2,
        Some("tier0") => 3,
        _ => 4,
    }
}

fn gap_matches_external_array_allowlist(name: &str) -> bool {
    KNOWN_EXTERNAL_ARRAY_ALLOWLIST.iter().any(|allowed| allowed == &name)
}

fn gap_from_missing_evidence(source: GapSource, subsystem: GapSubsystem, message: String, evidence_path: String) -> ComputeGap {
    ComputeGap {
        gap_id: String::new(),
        source,
        subsystem,
        severity: GapSeverity::S3,
        classification: GapClassification::EvidenceMissing,
        status: GapStatus::BlockedUpstream,
        message,
        backend: None,
        phase: None,
        family: None,
        shape_profile: None,
        semantic_shape_profile: None,
        tier: None,
        test_name: None,
        row_id: None,
        owner_gate: None,
        evidence_path: Some(evidence_path),
        blocks_promotion: true,
        blocks_runtime_claim: true,
        blocks_release_claim: false,
    }
}

fn gap_from_missing_receipt(message: String, evidence_path: String) -> ComputeGap {
    ComputeGap {
        gap_id: String::new(),
        source: GapSource::ManualBlocker,
        subsystem: GapSubsystem::ReceiptGeneration,
        severity: GapSeverity::S3,
        classification: GapClassification::ReceiptMissing,
        status: GapStatus::BlockedUpstream,
        message,
        backend: None,
        phase: None,
        family: None,
        shape_profile: None,
        semantic_shape_profile: None,
        tier: Some("receipt".into()),
        test_name: None,
        row_id: None,
        owner_gate: None,
        evidence_path: Some(evidence_path),
        blocks_promotion: true,
        blocks_runtime_claim: true,
        blocks_release_claim: false,
    }
}

fn gap_from_test_failure(test_name: String, message: String, status: GapStatus) -> ComputeGap {
    ComputeGap {
        gap_id: String::new(),
        source: GapSource::CargoTest,
        subsystem: GapSubsystem::ExternalArray,
        severity: GapSeverity::S3,
        classification: GapClassification::TestFailure,
        status,
        message,
        backend: None,
        phase: None,
        family: None,
        shape_profile: None,
        semantic_shape_profile: None,
        tier: Some("cargo".into()),
        test_name: Some(test_name),
        row_id: None,
        owner_gate: None,
        evidence_path: None,
        blocks_promotion: true,
        blocks_runtime_claim: true,
        blocks_release_claim: false,
    }
}

fn gap_from_warning(source: GapSource, classification: GapClassification, message: String) -> ComputeGap {
    ComputeGap {
        gap_id: String::new(),
        source,
        subsystem: GapSubsystem::DecodeAttribution,
        severity: GapSeverity::S1,
        classification,
        status: GapStatus::NeedsTriage,
        message,
        backend: None,
        phase: None,
        family: None,
        shape_profile: None,
        semantic_shape_profile: None,
        tier: Some("cargo".into()),
        test_name: None,
        row_id: None,
        owner_gate: None,
        evidence_path: None,
        blocks_promotion: false,
        blocks_runtime_claim: false,
        blocks_release_claim: false,
    }
}

fn gap_from_tier1_row(row: Tier1ClusterRow) -> ComputeGap {
    let backend = row
        .representative_rows
        .first()
        .and_then(|rep| rep.split('/').next())
        .map(ToString::to_string)
        .or_else(|| row.backends.first().cloned());
    let family = row
        .representative_rows
        .first()
        .and_then(|rep| rep.split('/').nth(1))
        .map(ToString::to_string)
        .or_else(|| row.families.first().cloned());
    let shape_profile = row
        .representative_rows
        .first()
        .and_then(|rep| rep.split('/').nth(2))
        .map(ToString::to_string)
        .or_else(|| row.shape_profiles.first().cloned());
    let row_id = row.representative_rows.first().cloned();
    let severity = severity_for_tier1(&row.severity);
    let blocks_promotion = matches!(
        row.severity.as_str(),
        "S1_blocks_decode_microphase" | "S2_blocks_backend_parity"
    );

    ComputeGap {
        gap_id: String::new(),
        source: GapSource::Tier1DefectCluster,
        subsystem: GapSubsystem::DefectClustering,
        severity,
        classification: classification_for_tier1(&row.cluster_kind),
        status: if severity.is_s3_or_higher() {
            GapStatus::NeedsTriage
        } else {
            GapStatus::BlockedUpstream
        },
        message: row.evidence_summary.clone(),
        backend,
        phase: row.pipeline_phase.clone(),
        family,
        shape_profile,
        semantic_shape_profile: None,
        tier: Some("tier1".into()),
        test_name: None,
        row_id,
        owner_gate: Some(row.recommended_next_gate.clone()),
        evidence_path: None,
        blocks_promotion,
        blocks_runtime_claim: severity.is_s3_or_higher(),
        blocks_release_claim: severity.is_s4(),
    }
}

fn gap_from_tier2_support_row(row: Tier2SupportRow) -> Option<ComputeGap> {
    if !(row.support_status.starts_with("pending") || row.support_status.starts_with("unsupported")) {
        return None;
    }

    let phase = row
        .row_id
        .split('/')
        .nth(2)
        .map(|value| value.to_string())
        .or_else(|| Some(String::new()));
    let required = row.blocked_by_tier1_defect.is_some();
    let unsupported = row.support_status.starts_with("unsupported");
    Some(ComputeGap {
        gap_id: String::new(),
        source: GapSource::Tier2Manifest,
        subsystem: GapSubsystem::ManifestGenerator,
        severity: severity_for_support_status(&row.support_status),
        classification: classification_for_support_status(&row.support_status),
        status: status_for_support_status(&row.support_status),
        message: row.reason.unwrap_or_else(|| row.support_status.clone()),
        backend: Some(row.backend),
        phase,
        family: Some(row.family),
        shape_profile: Some(row.shape_profile),
        semantic_shape_profile: Some(row.semantic_shape_profile),
        tier: Some("tier2".into()),
        test_name: None,
        row_id: Some(row.row_id),
        owner_gate: None,
        evidence_path: None,
        blocks_promotion: if unsupported { required } else { true },
        blocks_runtime_claim: if unsupported { required } else { severity_for_support_status(&row.support_status).is_s3_or_higher() },
        blocks_release_claim: if unsupported { required } else { severity_for_support_status(&row.support_status).is_s4() },
    })
}

fn gap_from_receipt_blocker(row: Tier2ReceiptIndexRow) -> Option<ComputeGap> {
    if !row.blocked {
        return None;
    }

    Some(ComputeGap {
        gap_id: String::new(),
        source: GapSource::Tier2Manifest,
        subsystem: GapSubsystem::ReceiptGeneration,
        severity: GapSeverity::S3,
        classification: GapClassification::Tier1DefectCluster,
        status: GapStatus::BlockedUpstream,
        message: format!("blocked row: {}", row.support_status),
        backend: Some(row.backend),
        phase: Some(row.pipeline_phase),
        family: Some(row.family),
        shape_profile: Some(row.shape_profile),
        semantic_shape_profile: Some(row.semantic_shape_profile),
        tier: Some(row.tier),
        test_name: None,
        row_id: Some(row.row_id),
        owner_gate: None,
        evidence_path: None,
        blocks_promotion: true,
        blocks_runtime_claim: true,
        blocks_release_claim: false,
    })
}

fn support_status_to_cell(status: &PhaseSupportStatus) -> BackendGapCell {
    match status {
        PhaseSupportStatus::Native => BackendGapCell::Qualified,
        PhaseSupportStatus::Composed => BackendGapCell::HostManaged,
        PhaseSupportStatus::Pending { .. } => BackendGapCell::Pending,
        PhaseSupportStatus::Unsupported { .. } => BackendGapCell::Unsupported,
    }
}

fn cell_to_string(cell: BackendGapCell) -> &'static str {
    match cell {
        BackendGapCell::Qualified => "qualified",
        BackendGapCell::HostManaged => "host_managed",
        BackendGapCell::Pending => "pending",
        BackendGapCell::Unsupported => "unsupported",
        BackendGapCell::Tier1Blocked => "tier1_blocked",
        BackendGapCell::NotApplicable => "not_applicable",
    }
}

fn parse_kv_contract_value(contract: &Value, backend: Option<&str>) -> Option<ComputeGap> {
    let ownership = contract.get("ownership")?.as_str()?;
    let contract_id = contract
        .get("contract_id")
        .and_then(Value::as_str)
        .unwrap_or("");
    let phase = contract
        .get("phase")
        .and_then(Value::as_str)
        .map(ToString::to_string)
        .or_else(|| contract_id.split('/').next().map(|part| part.trim_start_matches("kv.").to_string()));
    let profile_id = contract.get("profile_id").and_then(Value::as_str).map(ToString::to_string);
    let backend = contract
        .get("backend")
        .and_then(Value::as_str)
        .map(ToString::to_string)
        .or_else(|| backend.map(ToString::to_string));
    let shape_profile = contract
        .get("shape_profile")
        .and_then(Value::as_str)
        .map(ToString::to_string)
        .or_else(|| profile_id.clone());
    let message = format!(
        "{} {}",
        ownership,
        contract.get("mutation").and_then(Value::as_str).unwrap_or("")
    )
    .trim()
    .to_string();

    match ownership {
        "unsupported" => Some(ComputeGap {
            gap_id: String::new(),
            source: GapSource::KvContract,
            subsystem: GapSubsystem::KvCacheContracts,
            severity: GapSeverity::S2,
            classification: GapClassification::KvContractGap,
            status: GapStatus::IntentionalUnsupported,
            message: if message.is_empty() { "unsupported KV contract".into() } else { message },
            backend,
            phase,
            family: None,
            shape_profile,
            semantic_shape_profile: None,
            tier: None,
            test_name: None,
            row_id: None,
            owner_gate: None,
            evidence_path: None,
            blocks_promotion: true,
            blocks_runtime_claim: false,
            blocks_release_claim: false,
        }),
        "pending_qualification" => Some(ComputeGap {
            gap_id: String::new(),
            source: GapSource::KvContract,
            subsystem: GapSubsystem::KvCacheContracts,
            severity: GapSeverity::S3,
            classification: GapClassification::KvContractGap,
            status: GapStatus::PendingQualification,
            message: if message.is_empty() { "pending KV contract qualification".into() } else { message },
            backend,
            phase,
            family: None,
            shape_profile,
            semantic_shape_profile: None,
            tier: None,
            test_name: None,
            row_id: None,
            owner_gate: None,
            evidence_path: None,
            blocks_promotion: true,
            blocks_runtime_claim: true,
            blocks_release_claim: false,
        }),
        "backend_owned" => {
            let backend_is_coreml = backend.as_deref() == Some("coreml");
            if backend_is_coreml {
                Some(ComputeGap {
                    gap_id: String::new(),
                    source: GapSource::KvContract,
                    subsystem: GapSubsystem::KvCacheContracts,
                    severity: GapSeverity::S4,
                    classification: GapClassification::BackendOwnershipGap,
                    status: GapStatus::NeedsTriage,
                    message: "Core ML backend-owned KV mutation is a false-qualification risk".into(),
                    backend,
                    phase,
                    family: None,
                    shape_profile,
                    semantic_shape_profile: None,
                    tier: None,
                    test_name: None,
                    row_id: None,
                    owner_gate: Some("COREML-STATEFUL-BRIDGE-QUALIFICATION-0001".into()),
                    evidence_path: None,
                    blocks_promotion: true,
                    blocks_runtime_claim: true,
                    blocks_release_claim: true,
                })
            } else {
                None
            }
        }
        _ => None,
    }
}

pub fn load_cargo_build_log(path: &Path) -> Result<Vec<ComputeGap>, String> {
    let Some(text) = read_text_if_exists(path)? else {
        return Ok(vec![gap_from_missing_evidence(
            GapSource::Rustc,
            GapSubsystem::DecodeAttribution,
            "missing cargo build log".into(),
            path.display().to_string(),
        )]);
    };
    Ok(text
        .lines()
        .filter(|line| line.contains("warning:") && !line.contains("error:"))
        .map(|line| gap_from_warning(GapSource::Rustc, GapClassification::CompileWarning, line.trim().to_string()))
        .collect())
}

pub fn load_cargo_clippy_log(path: &Path) -> Result<Vec<ComputeGap>, String> {
    let Some(text) = read_text_if_exists(path)? else {
        return Ok(vec![gap_from_missing_evidence(
            GapSource::Clippy,
            GapSubsystem::DecodeAttribution,
            "missing cargo clippy log".into(),
            path.display().to_string(),
        )]);
    };
    Ok(text
        .lines()
        .filter(|line| line.contains("warning:") && !line.contains("error:"))
        .map(|line| gap_from_warning(GapSource::Clippy, GapClassification::ClippyWarning, line.trim().to_string()))
        .collect())
}

pub fn load_cargo_test_log(path: &Path) -> Result<Vec<ComputeGap>, String> {
    let Some(text) = read_text_if_exists(path)? else {
        return Ok(vec![gap_from_missing_evidence(
            GapSource::CargoTest,
            GapSubsystem::ExternalArray,
            "missing cargo test log".into(),
            path.display().to_string(),
        )]);
    };

    let failure_details = parse_cargo_test_failure_details(&text);
    let mut gaps = Vec::new();
    let mut saw_failed_test = false;
    for line in text.lines() {
        let line = line.trim();
        if let Some(rest) = line.strip_prefix("test ") {
            if let Some(name) = rest.strip_suffix(" FAILED") {
                let test_name = name.split(" ... ").next().unwrap_or(name).to_string();
                let status = if test_name.contains("external_array") && gap_matches_external_array_allowlist(&test_name) {
                    GapStatus::KnownPreexisting
                } else {
                    GapStatus::NeedsTriage
                };
                let message = failure_details
                    .get(&test_name)
                    .map(|detail| format!("{test_name}: {detail}"))
                    .unwrap_or_else(|| line.to_string());
                gaps.push(gap_from_test_failure(test_name, message, status));
                saw_failed_test = true;
            }
        }
    }

    if !saw_failed_test && text.contains("test result: FAILED") {
        gaps.push(gap_from_test_failure(
            "cargo_test_summary".into(),
            "cargo test summary reported failure".into(),
            GapStatus::NeedsTriage,
        ));
    }

    Ok(gaps)
}

fn parse_cargo_test_failure_details(text: &str) -> BTreeMap<String, String> {
    let mut details = BTreeMap::new();
    let mut in_failures = false;
    let mut current_name: Option<String> = None;
    let mut current_body: Vec<String> = Vec::new();

    let mut flush = |details: &mut BTreeMap<String, String>, current_name: &mut Option<String>, current_body: &mut Vec<String>| {
        if let Some(name) = current_name.take() {
            let body = current_body
                .iter()
                .map(|line| line.trim())
                .filter(|line| !line.is_empty())
                .collect::<Vec<_>>()
                .join(" ");
            if !body.is_empty() {
                details.insert(name, body);
            }
        }
        current_body.clear();
    };

    for line in text.lines() {
        let trimmed = line.trim_end();
        if trimmed == "failures:" {
            in_failures = true;
            continue;
        }
        if !in_failures {
            continue;
        }
        if trimmed.starts_with("test ") && trimmed.ends_with("FAILED") {
            continue;
        }
        if trimmed.is_empty() {
            flush(&mut details, &mut current_name, &mut current_body);
            continue;
        }
        if !line.starts_with(' ') && trimmed.ends_with(':') {
            flush(&mut details, &mut current_name, &mut current_body);
            current_name = Some(trimmed.trim_end_matches(':').to_string());
            continue;
        }
        if current_name.is_some() {
            current_body.push(trimmed.to_string());
        }
    }

    flush(&mut details, &mut current_name, &mut current_body);
    details
}

pub fn load_tier1_defects(run_dir: &Path) -> Result<Vec<ComputeGap>, String> {
    let cluster_path = run_dir.join("clustering").join("tier1_defect_clusters.json");
    if !cluster_path.exists() {
        return Ok(vec![gap_from_missing_evidence(
            GapSource::Tier1DefectCluster,
            GapSubsystem::DefectClustering,
            "missing tier1 defect cluster file".into(),
            cluster_path.display().to_string(),
        )]);
    }

    let text = fs::read_to_string(&cluster_path).map_err(|e| format!("read {:?}: {e}", cluster_path))?;
    let clusters: Vec<Tier1ClusterRow> =
        serde_json::from_str(&text).map_err(|e| format!("parse {:?}: {e}", cluster_path))?;
    Ok(clusters.into_iter().map(gap_from_tier1_row).collect())
}

pub fn load_tier2_manifest(output_dir: &Path) -> Result<Vec<ComputeGap>, String> {
    let support_path = output_dir.join("decode_microphase_support_matrix.json");
    let receipt_path = output_dir.join("decode_microphase_receipt_index.json");

    if !support_path.exists() {
        return Ok(vec![gap_from_missing_evidence(
            GapSource::Tier2Manifest,
            GapSubsystem::ManifestGenerator,
            "missing decode_microphase_support_matrix.json".into(),
            support_path.display().to_string(),
        )]);
    }
    if !receipt_path.exists() {
        return Ok(vec![gap_from_missing_receipt(
            "missing decode_microphase_receipt_index.json".into(),
            receipt_path.display().to_string(),
        )]);
    }

    let mut gaps = Vec::new();
    let mut seen_rows = BTreeSet::new();

    if support_path.exists() {
        let text = fs::read_to_string(&support_path).map_err(|e| format!("read {:?}: {e}", support_path))?;
        let rows: Vec<Tier2SupportRow> =
            serde_json::from_str(&text).map_err(|e| format!("parse {:?}: {e}", support_path))?;
        for row in rows {
            if let Some(gap) = gap_from_tier2_support_row(row) {
                if let Some(row_id) = gap.row_id.clone() {
                    seen_rows.insert(row_id);
                }
                gaps.push(gap);
            }
        }
    }

    if receipt_path.exists() {
        let text = fs::read_to_string(&receipt_path).map_err(|e| format!("read {:?}: {e}", receipt_path))?;
        let rows: Vec<Tier2ReceiptIndexRow> =
            serde_json::from_str(&text).map_err(|e| format!("parse {:?}: {e}", receipt_path))?;
        for row in rows {
            if row.blocked {
                if seen_rows.contains(&row.row_id) {
                    continue;
                }
                if let Some(gap) = gap_from_receipt_blocker(row) {
                    gaps.push(gap);
                }
            }
        }
    }

    Ok(gaps)
}

pub fn load_support_matrix(output_dir: &Path) -> Result<Vec<ComputeGap>, String> {
    let claimed_path = output_dir.join("support_matrix.json");
    let evidence_path = output_dir.join("decode_microphase_support_matrix.json");
    if !claimed_path.exists() {
        return Ok(vec![gap_from_missing_evidence(
            GapSource::SupportMatrix,
            GapSubsystem::PipelineParity,
            "missing support_matrix.json".into(),
            claimed_path.display().to_string(),
        )]);
    }
    if !evidence_path.exists() {
        return Ok(vec![gap_from_missing_evidence(
            GapSource::SupportMatrix,
            GapSubsystem::PipelineParity,
            "missing decode_microphase_support_matrix.json".into(),
            evidence_path.display().to_string(),
        )]);
    }

    let claimed_text = fs::read_to_string(&claimed_path).map_err(|e| format!("read {:?}: {e}", claimed_path))?;
    let evidence_text = fs::read_to_string(&evidence_path).map_err(|e| format!("read {:?}: {e}", evidence_path))?;
    let claimed_rows: Vec<Value> =
        serde_json::from_str(&claimed_text).map_err(|e| format!("parse {:?}: {e}", claimed_path))?;
    let evidence_rows: Vec<Value> =
        serde_json::from_str(&evidence_text).map_err(|e| format!("parse {:?}: {e}", evidence_path))?;

    let mut evidence = BTreeMap::new();
    for row in evidence_rows {
        let backend = row.get("backend").and_then(Value::as_str).unwrap_or_default().to_string();
        let family = row.get("family").and_then(Value::as_str).unwrap_or_default().to_string();
        let phase = row.get("pipeline_phase").and_then(Value::as_str).unwrap_or_default().to_string();
        let shape_profile = row.get("shape_profile").and_then(Value::as_str).unwrap_or_default().to_string();
        let semantic_shape_profile = row.get("semantic_shape_profile").and_then(Value::as_str).unwrap_or_default().to_string();
        let row_id = row.get("row_id").and_then(Value::as_str).unwrap_or_default().to_string();
        evidence.insert((backend, family, phase, shape_profile, semantic_shape_profile, row_id), row);
    }

    let mut gaps = Vec::new();
    for row in claimed_rows {
        let backend = row.get("backend").and_then(Value::as_str).unwrap_or_default().to_string();
        let family = row.get("family").and_then(Value::as_str).unwrap_or_default().to_string();
        let phase = row.get("pipeline_phase").and_then(Value::as_str).unwrap_or_default().to_string();
        let shape_profile = row.get("shape_profile").and_then(Value::as_str).unwrap_or_default().to_string();
        let semantic_shape_profile = row.get("semantic_shape_profile").and_then(Value::as_str).unwrap_or_default().to_string();
        let row_id = row.get("row_id").and_then(Value::as_str).unwrap_or_default().to_string();
        let claimed = row.get("support_status").and_then(Value::as_str).unwrap_or_default();
        if let Some(evidence_row) = evidence.get(&(backend.clone(), family.clone(), phase.clone(), shape_profile.clone(), semantic_shape_profile.clone(), row_id.clone())) {
            let actual = evidence_row.get("support_status").and_then(Value::as_str).unwrap_or_default();
            if claimed != actual {
                gaps.push(ComputeGap {
                    gap_id: String::new(),
                    source: GapSource::SupportMatrix,
                    subsystem: GapSubsystem::PipelineParity,
                    severity: if actual.starts_with("unsupported") { GapSeverity::S3 } else { GapSeverity::S2 },
                    classification: GapClassification::SupportMatrixMismatch,
                    status: GapStatus::NeedsTriage,
                    message: format!("support claim '{claimed}' disagrees with evidence '{actual}'"),
                    backend: Some(backend),
                    phase: row.get("pipeline_phase").and_then(Value::as_str).map(ToString::to_string),
                    family: Some(family),
                    shape_profile: row.get("shape_profile").and_then(Value::as_str).map(ToString::to_string),
                    semantic_shape_profile: row.get("semantic_shape_profile").and_then(Value::as_str).map(ToString::to_string),
                    tier: row.get("tier").and_then(Value::as_str).map(ToString::to_string),
                    test_name: None,
                    row_id: row.get("row_id").and_then(Value::as_str).map(ToString::to_string),
                    owner_gate: None,
                    evidence_path: None,
                    blocks_promotion: true,
                    blocks_runtime_claim: true,
                    blocks_release_claim: actual.starts_with("unsupported"),
                });
            }
        } else {
            gaps.push(gap_from_missing_evidence(
                GapSource::SupportMatrix,
                GapSubsystem::PipelineParity,
                format!("missing evidence row for support claim '{}'", row_id),
                evidence_path.display().to_string(),
            ));
        }
    }

    Ok(gaps)
}

pub fn load_kv_contracts(output_dir: &Path) -> Result<Vec<ComputeGap>, String> {
    let path = output_dir.join("kv_contracts.json");
    if !path.exists() {
        return Ok(vec![gap_from_missing_evidence(
            GapSource::KvContract,
            GapSubsystem::KvCacheContracts,
            "missing kv_contracts.json".into(),
            path.display().to_string(),
        )]);
    }

    let text = fs::read_to_string(&path).map_err(|e| format!("read {:?}: {e}", path))?;
    let parsed: Value = serde_json::from_str(&text).map_err(|e| format!("parse {:?}: {e}", path))?;
    let mut gaps = Vec::new();

    match parsed {
        Value::Array(items) => {
            for item in items {
                if let Some(gap) = parse_kv_contract_value(&item, None) {
                    gaps.push(gap);
                }
            }
        }
        Value::Object(map) => {
            for (backend, value) in map {
                if let Some(items) = value.as_array() {
                    for item in items {
                        if let Some(gap) = parse_kv_contract_value(item, Some(&backend)) {
                            gaps.push(gap);
                        }
                    }
                }
            }
        }
        _ => return Err(format!("{:?} did not contain contract rows", path)),
    }

    Ok(gaps)
}

pub fn load_python_reference(paths: &[PathBuf]) -> Result<Vec<ComputeGap>, String> {
    let mut gaps = Vec::new();
    for path in paths {
        if !path.exists() {
            gaps.push(gap_from_missing_evidence(
                GapSource::PythonReference,
                GapSubsystem::ReferenceAdapter,
                "missing python reference path".into(),
                path.display().to_string(),
            ));
            continue;
        }
        if path.is_dir() {
            walk_python_files(path, &mut gaps)?;
            continue;
        }
        if path.extension().and_then(|ext| ext.to_str()) == Some("py") {
            collect_python_gap(path, &mut gaps)?;
        }
    }
    Ok(gaps)
}

fn walk_python_files(dir: &Path, gaps: &mut Vec<ComputeGap>) -> Result<(), String> {
    for entry in fs::read_dir(dir).map_err(|e| format!("read_dir {:?}: {e}", dir))? {
        let entry = entry.map_err(|e| format!("read_dir {:?}: {e}", dir))?;
        let path = entry.path();
        if path.is_dir() {
            walk_python_files(&path, gaps)?;
        } else if path.extension().and_then(|ext| ext.to_str()) == Some("py") {
            collect_python_gap(&path, gaps)?;
        }
    }
    Ok(())
}

fn collect_python_gap(path: &Path, gaps: &mut Vec<ComputeGap>) -> Result<(), String> {
    let text = fs::read_to_string(path).map_err(|e| format!("read {:?}: {e}", path))?;
    let lower = text.to_lowercase();
    let file_name = path.file_name().and_then(|name| name.to_str()).unwrap_or_default().to_lowercase();
    if (file_name.contains("compare") || file_name.contains("diff") || file_name.contains("reference") || file_name.contains("report"))
        && (lower.contains("\"mismatch\"")
            || lower.contains("\"deprecated\"")
            || lower.contains("mismatch detected")
            || lower.contains("artifact mismatch")
            || lower.contains("reference output"))
    {
        gaps.push(ComputeGap {
            gap_id: String::new(),
            source: GapSource::PythonReference,
            subsystem: GapSubsystem::ReferenceAdapter,
            severity: GapSeverity::S3,
            classification: GapClassification::DeprecatedArtifactMismatch,
            status: GapStatus::NeedsTriage,
            message: "python reference artifact mismatch".into(),
            backend: None,
            phase: None,
            family: None,
            shape_profile: None,
            semantic_shape_profile: None,
            tier: None,
            test_name: None,
            row_id: None,
            owner_gate: Some("REFERENCE-ARTIFACT-RECONCILIATION-0001".into()),
            evidence_path: Some(path.display().to_string()),
            blocks_promotion: true,
            blocks_runtime_claim: true,
            blocks_release_claim: false,
        });
    }
    Ok(())
}

pub fn normalize_gaps(gaps: &[ComputeGap], accounting: GapReportAccounting) -> (Vec<ComputeGap>, GapReportReceipt) {
    let mut normalized: Vec<(usize, ComputeGap)> = gaps.iter().cloned().enumerate().collect();
    normalized.sort_by(|(idx_a, gap_a), (idx_b, gap_b)| gap_sort_cmp(gap_a, *idx_a, gap_b, *idx_b));

    let mut assigned = Vec::with_capacity(normalized.len());
    for (idx, (_, mut gap)) in normalized.into_iter().enumerate() {
        gap.gap_id = format!("GAP-{idx:04}");
        assigned.push(gap);
    }

    let total_warnings = assigned
        .iter()
        .filter(|gap| matches!(gap.classification, GapClassification::CompileWarning | GapClassification::ClippyWarning))
        .count() as u32;
    let total_errors = assigned.iter().filter(|gap| gap.severity.is_s3_or_higher()).count() as u32;
    let total_failing_tests = assigned.iter().filter(|gap| gap.classification == GapClassification::TestFailure).count() as u32;
    let total_open_gaps = assigned
        .iter()
        .filter(|gap| matches!(gap.status, GapStatus::Open | GapStatus::NeedsTriage | GapStatus::PendingQualification | GapStatus::BlockedUpstream))
        .count() as u32;
    let s3_s4_gaps = assigned.iter().filter(|gap| gap.severity.is_s3_or_higher()).count() as u32;
    let tier0_pass_count = assigned
        .iter()
        .filter(|gap| matches!(gap.source, GapSource::SupportMatrix) && matches!(gap.phase.as_deref(), Some(phase) if !phase.is_empty()))
        .count() as u32;
    let tier1_pass_count = assigned
        .iter()
        .filter(|gap| matches!(gap.source, GapSource::Tier1DefectCluster) && !gap.blocks_promotion)
        .count() as u32;
    let tier1_nonpass_count = assigned
        .iter()
        .filter(|gap| matches!(gap.source, GapSource::Tier1DefectCluster) && gap.blocks_promotion)
        .count() as u32;
    let tier2_manifest_count = assigned.iter().filter(|gap| matches!(gap.source, GapSource::Tier2Manifest)).count() as u32;
    let kv_contract_count = assigned.iter().filter(|gap| matches!(gap.source, GapSource::KvContract)).count() as u32;
    let false_qualification_risks_detected = assigned.iter().any(|gap| {
        gap.severity.is_s4()
            && gap.classification == GapClassification::BackendOwnershipGap
            && gap.backend.as_deref() == Some("coreml")
            && gap.phase.as_deref().is_some_and(|phase| phase.contains("kv_"))
    });

    let receipt = GapReportReceipt {
        report_id: GAP_REPORT_ID.into(),
        generated_at: current_timestamp(),
        total_warnings,
        total_errors,
        total_failing_tests,
        total_open_gaps,
        s3_s4_gaps,
        tier0_pass_count,
        tier1_pass_count,
        tier1_nonpass_count,
        tier1_gap_rows: accounting.tier1_gap_rows,
        tier2_manifest_count,
        tier2_gap_rows: accounting.tier2_gap_rows,
        kv_contract_count,
        kv_contract_gap_rows: accounting.kv_contract_gap_rows,
        observed_tier1_total: accounting.observed_tier1_total,
        observed_tier2_manifest_rows: accounting.observed_tier2_manifest_rows,
        observed_kv_contract_rows: accounting.observed_kv_contract_rows,
        false_qualification_risks_detected,
        artifact_count: 12,
    };

    (assigned, receipt)
}

pub fn build_backend_gap_matrix() -> BackendGapMatrix {
    let phases: Vec<String> = PipelinePhase::all().iter().copied().map(phase_str).collect();
    let mut coreml = Vec::with_capacity(phases.len());
    let mut mlx = Vec::with_capacity(phases.len());
    let mut accelerate = Vec::with_capacity(phases.len());

    for phase in PipelinePhase::all().iter().copied() {
        let status_for_backend = |backend: BackendKind| {
            let status = if is_kv_phase(phase) {
                kv_phase_support_for(backend).get(&phase).cloned().unwrap_or(PhaseSupportStatus::Pending {
                    code: PendingCode::GraphBuilderNotImplemented,
                    reason: "missing KV phase status",
                })
            } else {
                let decoded = match phase {
                    PipelinePhase::QkvProjection => decode_microphase_support_for("decode_qkv_projection", backend),
                    PipelinePhase::AttentionOutputProjection => decode_microphase_support_for("decode_attention_output_projection", backend),
                    PipelinePhase::ResidualAdd1 => decode_microphase_support_for("decode_residual_add_1", backend),
                    PipelinePhase::MlpGateUp => decode_microphase_support_for("decode_mlp_gate_up_silu", backend),
                    PipelinePhase::MlpDown => decode_microphase_support_for("decode_mlp_down", backend),
                    PipelinePhase::ResidualAdd2 => decode_microphase_support_for("decode_residual_add_2", backend),
                    PipelinePhase::LmHead => decode_microphase_support_for("decode_lm_head", backend),
                    _ => {
                        let matrix = support_matrix_for(backend);
                        matrix.support_for(phase).cloned().unwrap_or(PhaseSupportStatus::Pending {
                            code: PendingCode::GraphBuilderNotImplemented,
                            reason: "missing backend support status",
                        })
                    }
                };
                decoded
            };
            support_status_to_cell(&status)
        };

        coreml.push(cell_to_string(status_for_backend(BackendKind::CoreMl)).into());
        mlx.push(cell_to_string(status_for_backend(BackendKind::Mlx)).into());
        accelerate.push(cell_to_string(status_for_backend(BackendKind::Accelerate)).into());
    }

    BackendGapMatrix {
        basis: "declared_support_functions".into(),
        phases,
        coreml,
        mlx,
        accelerate,
    }
}

pub fn generate_fix_gates(gaps: &[ComputeGap]) -> Vec<FixGate> {
    let gates = [
        (
            "EXTERNAL-ARRAY-TEST-TRIAGE-0001",
            "critical",
            "Owns all external_array test failures",
            gate_external_array_test as fn(&ComputeGap) -> bool,
            "external_array test failures",
        ),
        (
            "TIER1-COVERAGE-CLOSURE-0001",
            "high",
            "Owns all Tier 1 non-pass gaps",
            gate_tier1_coverage as fn(&ComputeGap) -> bool,
            "Tier 1 defect clusters",
        ),
        (
            "BACKEND-OWNERSHIP-MATRIX-HARDENING-0001",
            "critical",
            "Owns S4 backend ownership risks",
            gate_backend_ownership_risk as fn(&ComputeGap) -> bool,
            "backend ownership risks",
        ),
        (
            "MLX-KV-RUNTIME-QUALIFICATION-0001",
            "high",
            "Owns pending MLX KV contract entries",
            gate_mlx_kv as fn(&ComputeGap) -> bool,
            "MLX KV contracts",
        ),
        (
            "COREML-STATEFUL-BRIDGE-QUALIFICATION-0001",
            "critical",
            "Owns Core ML KV ownership risks",
            gate_coreml_stateful_bridge as fn(&ComputeGap) -> bool,
            "Core ML KV ownership risks",
        ),
        (
            "ACCELERATE-COMPOSED-KERNEL-QUALIFICATION-0001",
            "medium",
            "Owns Accelerate composed/composite gaps",
            gate_accelerate_composed as fn(&ComputeGap) -> bool,
            "Accelerate composed/composite gaps",
        ),
    ];

    let mut fix_gates = Vec::new();
    for (gate_id, priority, description, predicate, scope) in gates {
        let owned_gaps: Vec<String> = gaps
            .iter()
            .filter(|gap| predicate(gap))
            .map(|gap| gap.gap_id.clone())
            .collect();
        if owned_gaps.is_empty() {
            continue;
        }
        fix_gates.push(FixGate {
            gate_id: gate_id.into(),
            priority: priority.into(),
            description: description.into(),
            owned_gaps,
            scope: scope.into(),
        });
    }

    fix_gates.sort_by(|a, b| a.gate_id.cmp(&b.gate_id));
    fix_gates
}

fn group_warnings_by_subsystem(gaps: &[ComputeGap]) -> BTreeMap<String, usize> {
    let mut groups = BTreeMap::new();
    for gap in gaps.iter().filter(|gap| matches!(gap.classification, GapClassification::CompileWarning | GapClassification::ClippyWarning)) {
        let key = format!("{:?}", gap.subsystem);
        *groups.entry(key).or_insert(0) += 1;
    }
    groups
}

fn count_by_backend_phase(gaps: &[ComputeGap]) -> BTreeMap<(String, String), usize> {
    let mut counts = BTreeMap::new();
    for gap in gaps {
        if gap.source != GapSource::KvContract {
            continue;
        }
        let backend = gap.backend.clone().unwrap_or_else(|| "unknown".into());
        let phase = gap.phase.clone().unwrap_or_else(|| "unknown".into());
        *counts.entry((backend, phase)).or_insert(0) += 1;
    }
    counts
}

fn write_markdown(path: &Path, contents: String) -> Result<(), String> {
    fs::write(path, contents).map_err(|e| format!("write {:?}: {e}", path))
}

fn write_json_pretty<T: Serialize + ?Sized>(path: &Path, value: &T) -> Result<(), String> {
    let json = serde_json::to_string_pretty(value).map_err(|e| format!("serialize {:?}: {e}", path))?;
    fs::write(path, json).map_err(|e| format!("write {:?}: {e}", path))
}

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn output_gaps_json(path: &Path, gaps: &[ComputeGap], filter: impl Fn(&ComputeGap) -> bool) -> Result<u64, String> {
    let subset: Vec<ComputeGap> = gaps.iter().cloned().filter(filter).collect();
    write_json_pretty(path, &subset)?;
    Ok(subset.len() as u64)
}

fn output_backend_matrix_json(path: &Path, matrix: &BackendGapMatrix) -> Result<u64, String> {
    write_json_pretty(path, matrix)?;
    Ok(matrix.phases.len() as u64)
}

fn gate_external_array_test(gap: &ComputeGap) -> bool {
    gap.classification == GapClassification::TestFailure
        && gap
            .test_name
            .as_deref()
            .is_some_and(|name| name.contains("external_array"))
}

fn gate_tier1_coverage(gap: &ComputeGap) -> bool {
    matches!(gap.source, GapSource::Tier1DefectCluster)
}

fn gate_backend_ownership_risk(gap: &ComputeGap) -> bool {
    gap.classification == GapClassification::BackendOwnershipGap && gap.severity.is_s4()
}

fn gate_mlx_kv(gap: &ComputeGap) -> bool {
    gap.source == GapSource::KvContract
        && gap.backend.as_deref() == Some("mlx")
        && gap.status == GapStatus::PendingQualification
}

fn gate_coreml_stateful_bridge(gap: &ComputeGap) -> bool {
    gap.classification == GapClassification::BackendOwnershipGap && gap.backend.as_deref() == Some("coreml")
}

fn gate_accelerate_composed(gap: &ComputeGap) -> bool {
    gap.backend.as_deref() == Some("accelerate")
        && matches!(
            gap.classification,
            GapClassification::UnsupportedPath
                | GapClassification::PendingQualification
                | GapClassification::Tier2Manifest
        )
}

pub fn generate_summary_md(
    receipt: &GapReportReceipt,
    gaps: &[ComputeGap],
    backend_matrix: &BackendGapMatrix,
    output_dir: &Path,
) -> Result<(), String> {
    let _ = output_dir;
    let mut lines = Vec::new();
    lines.push(format!("# {GAP_REPORT_ID}"));
    lines.push(String::new());
    lines.push("## Executive status".into());
    lines.push(String::new());
    lines.push(format!(
        "Total gaps: {} (warnings {}, errors {}, test failures {})",
        gaps.len(), receipt.total_warnings, receipt.total_errors, receipt.total_failing_tests
    ));
    lines.push(format!(
        "Open gaps: {}, S3/S4 gaps: {}, false qualification risks: {}",
        receipt.total_open_gaps, receipt.s3_s4_gaps, receipt.false_qualification_risks_detected
    ));
    lines.push(String::new());
    lines.push("## Coverage accounting".into());
    lines.push(String::new());
    lines.push("| Dimension | Observed total | Gap rows | Pass rows | Non-pass rows |".into());
    lines.push("|---|---|---|---|---|".into());
    lines.push(format!(
        "| Tier 1 | {} | {} | {} | {} |",
        receipt.observed_tier1_total,
        receipt.tier1_gap_rows,
        receipt.tier1_pass_count,
        receipt.tier1_nonpass_count
    ));
    lines.push(format!(
        "| Tier 2 manifest | {} | {} | n/a | n/a |",
        receipt.observed_tier2_manifest_rows,
        receipt.tier2_gap_rows
    ));
    lines.push(format!(
        "| KV contracts | {} | {} | n/a | n/a |",
        receipt.observed_kv_contract_rows,
        receipt.kv_contract_gap_rows
    ));
    lines.push(String::new());

    let critical_blockers: Vec<&ComputeGap> = gaps.iter().filter(|gap| gap.severity.is_s3_or_higher()).collect();
    lines.push("## Critical blockers".into());
    lines.push(String::new());
    if critical_blockers.is_empty() {
        lines.push("No S3/S4 gaps were found.".into());
    } else {
        lines.push("| Gap | Source | Backend | Phase | Message |".into());
        lines.push("|---|---|---|---|---|".into());
        for gap in critical_blockers.iter().take(32) {
            lines.push(format!(
                "| {} | {:?} | {} | {} | {} |",
                gap.gap_id,
                gap.source,
                gap.backend.clone().unwrap_or_default(),
                gap.phase.clone().unwrap_or_default(),
                gap.message
            ));
        }
    }
    lines.push(String::new());

    let test_failures: Vec<&ComputeGap> = gaps.iter().filter(|gap| gap.classification == GapClassification::TestFailure).collect();
    lines.push("## Test failures".into());
    lines.push(String::new());
    if test_failures.is_empty() {
        lines.push("No cargo test failures were ingested.".into());
    } else {
        lines.push("| Gap | Test | Status | Message |".into());
        lines.push("|---|---|---|---|".into());
        for gap in test_failures {
            lines.push(format!(
                "| {} | {} | {:?} | {} |",
                gap.gap_id,
                gap.test_name.clone().unwrap_or_default(),
                gap.status,
                gap.message
            ));
        }
    }
    lines.push(String::new());

    lines.push("## Rust/compiler warnings".into());
    lines.push(String::new());
    let warnings = group_warnings_by_subsystem(gaps);
    if warnings.is_empty() {
        lines.push("No rustc or clippy warnings were ingested.".into());
    } else {
        lines.push("| Subsystem | Count |".into());
        lines.push("|---|---|".into());
        for (subsystem, count) in warnings {
            lines.push(format!("| {} | {} |", subsystem, count));
        }
    }
    lines.push(String::new());

    lines.push("## Tier 1 coverage gaps".into());
    lines.push(String::new());
    let tier1 = gaps.iter().filter(|gap| matches!(gap.source, GapSource::Tier1DefectCluster)).collect::<Vec<_>>();
    if tier1.is_empty() {
        lines.push("No Tier 1 defect clusters were ingested.".into());
    } else {
        lines.push("| Gap | Gate | Backend | Family | Shape |".into());
        lines.push("|---|---|---|---|---|".into());
        for gap in tier1 {
            lines.push(format!(
                "| {} | {} | {} | {} | {} |",
                gap.gap_id,
                gap.owner_gate.clone().unwrap_or_default(),
                gap.backend.clone().unwrap_or_default(),
                gap.family.clone().unwrap_or_default(),
                gap.shape_profile.clone().unwrap_or_default()
            ));
        }
    }
    lines.push(String::new());

    lines.push("## Tier 2 manifest gaps".into());
    lines.push(String::new());
    let tier2 = gaps.iter().filter(|gap| matches!(gap.source, GapSource::Tier2Manifest)).collect::<Vec<_>>();
    if tier2.is_empty() {
        lines.push("No Tier 2 manifest gaps were ingested.".into());
    } else {
        let blocked_rows = tier2.iter().filter(|gap| gap.blocks_promotion).count();
        lines.push(format!("Blocked rows: {}", blocked_rows));
        lines.push("| Gap | Backend | Family | Phase | Status |".into());
        lines.push("|---|---|---|---|---|".into());
        for gap in tier2 {
            lines.push(format!(
                "| {} | {} | {} | {} | {:?} |",
                gap.gap_id,
                gap.backend.clone().unwrap_or_default(),
                gap.family.clone().unwrap_or_default(),
                gap.phase.clone().unwrap_or_default(),
                gap.status
            ));
        }
    }
    lines.push(String::new());

    lines.push("## KV contract gaps".into());
    lines.push(String::new());
    let kv = gaps.iter().filter(|gap| matches!(gap.source, GapSource::KvContract)).collect::<Vec<_>>();
    if kv.is_empty() {
        lines.push("No KV contract gaps were ingested.".into());
    } else {
        lines.push("| Backend | Phase | Count |".into());
        lines.push("|---|---|---|".into());
        for ((backend, phase), count) in count_by_backend_phase(gaps) {
            lines.push(format!("| {} | {} | {} |", backend, phase, count));
        }
    }
    lines.push(String::new());

    lines.push("## Declared backend support matrix".into());
    lines.push(String::new());
    lines.push("Basis: declared support functions, not observed run outcomes.".into());
    lines.push(String::new());
    lines.push("| Phase | CoreML | MLX | Accelerate |".into());
    lines.push("|---|---|---|---|".into());
    for (idx, phase) in backend_matrix.phases.iter().enumerate() {
        lines.push(format!(
            "| {} | {} | {} | {} |",
            phase,
            backend_matrix.coreml.get(idx).cloned().unwrap_or_default(),
            backend_matrix.mlx.get(idx).cloned().unwrap_or_default(),
            backend_matrix.accelerate.get(idx).cloned().unwrap_or_default(),
        ));
    }
    lines.push(String::new());

    lines.push("## Recommended next gates".into());
    lines.push(String::new());
    let mut gate_rows: BTreeMap<String, (String, BTreeSet<String>, u8)> = BTreeMap::new();
    for gate in generate_fix_gates(gaps) {
        let severity_rank = gate
            .owned_gaps
            .iter()
            .filter_map(|id| gaps.iter().find(|gap| gap.gap_id == *id))
            .map(|gap| gap.severity.as_numeric())
            .max()
            .unwrap_or(0);
        let entry = gate_rows.entry(gate.gate_id.clone()).or_insert((gate.priority.clone(), BTreeSet::new(), severity_rank));
        entry.0 = gate.priority;
        entry.2 = severity_rank;
        entry.1.extend(gate.owned_gaps);
    }
    if gate_rows.is_empty() {
        lines.push("No fix gates were generated.".into());
    } else {
        for (gate_id, (priority, owned, _)) in gate_rows {
            lines.push(format!(
                "- {} [{}] owns {}",
                gate_id,
                priority,
                owned.into_iter().collect::<Vec<_>>().join(", ")
            ));
        }
    }

    write_markdown(&output_dir.join("summary.md"), lines.join("\n"))
}

pub fn write_gap_report_artifacts(
    output_dir: &Path,
    gaps: &[ComputeGap],
    receipt: &GapReportReceipt,
    backend_matrix: &BackendGapMatrix,
) -> Result<BTreeMap<String, ArtifactReceiptEntry>, String> {
    fs::create_dir_all(output_dir).map_err(|e| format!("create {:?}: {e}", output_dir))?;

    let mut receipts = BTreeMap::new();

    let gap_ledger_path = output_dir.join("gap_ledger.json");
    write_json_pretty(&gap_ledger_path, gaps)?;
    receipts.insert(
        "gap_ledger.json".into(),
        ArtifactReceiptEntry {
            sha256: sha256_hex(&fs::read(&gap_ledger_path).map_err(|e| format!("read {:?}: {e}", gap_ledger_path))?),
            row_count: gaps.len() as u64,
        },
    );

    let warnings_path = output_dir.join("warnings.json");
    let warnings_count = output_gaps_json(&warnings_path, gaps, |gap| matches!(gap.classification, GapClassification::CompileWarning | GapClassification::ClippyWarning))?;
    receipts.insert(
        "warnings.json".into(),
        ArtifactReceiptEntry {
            sha256: sha256_hex(&fs::read(&warnings_path).map_err(|e| format!("read {:?}: {e}", warnings_path))?),
            row_count: warnings_count,
        },
    );

    let errors_path = output_dir.join("errors.json");
    let errors_count = output_gaps_json(&errors_path, gaps, |gap| gap.severity.is_s3_or_higher())?;
    receipts.insert(
        "errors.json".into(),
        ArtifactReceiptEntry {
            sha256: sha256_hex(&fs::read(&errors_path).map_err(|e| format!("read {:?}: {e}", errors_path))?),
            row_count: errors_count,
        },
    );

    let test_failures_path = output_dir.join("test_failures.json");
    let test_failures_count = output_gaps_json(&test_failures_path, gaps, |gap| gap.classification == GapClassification::TestFailure)?;
    receipts.insert(
        "test_failures.json".into(),
        ArtifactReceiptEntry {
            sha256: sha256_hex(&fs::read(&test_failures_path).map_err(|e| format!("read {:?}: {e}", test_failures_path))?),
            row_count: test_failures_count,
        },
    );

    let tier1_coverage_path = output_dir.join("tier1_coverage.json");
    let tier1_count = output_gaps_json(&tier1_coverage_path, gaps, |gap| matches!(gap.source, GapSource::Tier1DefectCluster))?;
    receipts.insert(
        "tier1_coverage.json".into(),
        ArtifactReceiptEntry {
            sha256: sha256_hex(&fs::read(&tier1_coverage_path).map_err(|e| format!("read {:?}: {e}", tier1_coverage_path))?),
            row_count: tier1_count,
        },
    );

    let tier2_coverage_path = output_dir.join("tier2_coverage.json");
    let tier2_count = output_gaps_json(&tier2_coverage_path, gaps, |gap| matches!(gap.source, GapSource::Tier2Manifest))?;
    receipts.insert(
        "tier2_coverage.json".into(),
        ArtifactReceiptEntry {
            sha256: sha256_hex(&fs::read(&tier2_coverage_path).map_err(|e| format!("read {:?}: {e}", tier2_coverage_path))?),
            row_count: tier2_count,
        },
    );

    let kv_contract_gaps_path = output_dir.join("kv_contract_gaps.json");
    let kv_count = output_gaps_json(&kv_contract_gaps_path, gaps, |gap| matches!(gap.classification, GapClassification::KvContractGap | GapClassification::BackendOwnershipGap))?;
    receipts.insert(
        "kv_contract_gaps.json".into(),
        ArtifactReceiptEntry {
            sha256: sha256_hex(&fs::read(&kv_contract_gaps_path).map_err(|e| format!("read {:?}: {e}", kv_contract_gaps_path))?),
            row_count: kv_count,
        },
    );

    let backend_gap_matrix_path = output_dir.join("backend_gap_matrix.json");
    let backend_matrix_rows = output_backend_matrix_json(&backend_gap_matrix_path, backend_matrix)?;
    receipts.insert(
        "backend_gap_matrix.json".into(),
        ArtifactReceiptEntry {
            sha256: sha256_hex(&fs::read(&backend_gap_matrix_path).map_err(|e| format!("read {:?}: {e}", backend_gap_matrix_path))?),
            row_count: backend_matrix_rows,
        },
    );

    let fix_gates = generate_fix_gates(gaps);
    let fix_gates_path = output_dir.join("fix_gates.json");
    write_json_pretty(&fix_gates_path, &fix_gates)?;
    receipts.insert(
        "fix_gates.json".into(),
        ArtifactReceiptEntry {
            sha256: sha256_hex(&fs::read(&fix_gates_path).map_err(|e| format!("read {:?}: {e}", fix_gates_path))?),
            row_count: fix_gates.len() as u64,
        },
    );

    let blockers: Vec<ComputeGap> = gaps.iter().cloned().filter(|gap| gap.blocks_promotion).collect();
    let blockers_path = output_dir.join("blockers.json");
    write_json_pretty(&blockers_path, &blockers)?;
    receipts.insert(
        "blockers.json".into(),
        ArtifactReceiptEntry {
            sha256: sha256_hex(&fs::read(&blockers_path).map_err(|e| format!("read {:?}: {e}", blockers_path))?),
            row_count: blockers.len() as u64,
        },
    );

    let summary_path = output_dir.join("summary.md");
    generate_summary_md(receipt, gaps, backend_matrix, output_dir)?;
    receipts.insert(
        "summary.md".into(),
        ArtifactReceiptEntry {
            sha256: sha256_hex(&fs::read(&summary_path).map_err(|e| format!("read {:?}: {e}", summary_path))?),
            row_count: 0,
        },
    );

    let receipt_index_path = output_dir.join("receipt_index.json");
    write_json_pretty(&receipt_index_path, &receipts)?;

    let receipt_index_sha = sha256_hex(&fs::read(&receipt_index_path).map_err(|e| format!("read {:?}: {e}", receipt_index_path))?);
    receipts.insert(
        "receipt_index.json".into(),
        ArtifactReceiptEntry {
            sha256: receipt_index_sha,
            row_count: (receipts.len() + 1) as u64,
        },
    );
    write_json_pretty(&receipt_index_path, &receipts)?;

    Ok(receipts)
}

fn extract_test_name(line: &str) -> Option<String> {
    let rest = line.strip_prefix("test ")?;
    let name = rest.split(" ... ").next()?;
    if name.is_empty() {
        None
    } else {
        Some(name.to_string())
    }
}

fn parse_raw_text_test_failures(text: &str) -> Vec<String> {
    text.lines()
        .filter_map(|line| {
            let line = line.trim();
            if line.starts_with("test ") && line.ends_with("FAILED") {
                extract_test_name(line)
            } else {
                None
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn severity_ordering() {
        assert!(GapSeverity::S4 > GapSeverity::S3);
        assert_eq!(GapSeverity::S0.as_numeric(), 0);
        assert_eq!(GapSeverity::S4.as_numeric(), 4);
    }

    #[test]
    fn gap_sort_priority() {
        let mut gaps = vec![
            ComputeGap {
                gap_id: String::new(),
                source: GapSource::Rustc,
                subsystem: GapSubsystem::DecodeAttribution,
                severity: GapSeverity::S1,
                classification: GapClassification::CompileWarning,
                status: GapStatus::NeedsTriage,
                message: "warn".into(),
                backend: None,
                phase: None,
                family: None,
                shape_profile: None,
                semantic_shape_profile: None,
                tier: Some("cargo".into()),
                test_name: None,
                row_id: None,
                owner_gate: None,
                evidence_path: None,
                blocks_promotion: false,
                blocks_runtime_claim: false,
                blocks_release_claim: false,
            },
            ComputeGap {
                gap_id: String::new(),
                source: GapSource::KvContract,
                subsystem: GapSubsystem::KvCacheContracts,
                severity: GapSeverity::S4,
                classification: GapClassification::BackendOwnershipGap,
                status: GapStatus::NeedsTriage,
                message: "risk".into(),
                backend: Some("coreml".into()),
                phase: Some("kv_read".into()),
                family: None,
                shape_profile: None,
                semantic_shape_profile: None,
                tier: None,
                test_name: None,
                row_id: None,
                owner_gate: None,
                evidence_path: None,
                blocks_promotion: true,
                blocks_runtime_claim: true,
                blocks_release_claim: true,
            },
        ];
        let (sorted, _) = normalize_gaps(&gaps, GapReportAccounting::default());
        assert_eq!(sorted[0].classification, GapClassification::BackendOwnershipGap);
    }

    #[test]
    fn normalize_assigns_sequential_ids() {
        let gaps = vec![gap_from_warning(GapSource::Rustc, GapClassification::CompileWarning, "one".into()), gap_from_warning(GapSource::Clippy, GapClassification::ClippyWarning, "two".into())];
        let (sorted, receipt) = normalize_gaps(&gaps, GapReportAccounting::default());
        assert_eq!(sorted[0].gap_id, "GAP-0000");
        assert_eq!(sorted[1].gap_id, "GAP-0001");
        assert_eq!(receipt.total_warnings, 2);
    }

    #[test]
    fn normalize_detects_false_qualification() {
        let gap = ComputeGap {
            gap_id: String::new(),
            source: GapSource::KvContract,
            subsystem: GapSubsystem::KvCacheContracts,
            severity: GapSeverity::S4,
            classification: GapClassification::BackendOwnershipGap,
            status: GapStatus::NeedsTriage,
            message: "risk".into(),
            backend: Some("coreml".into()),
            phase: Some("kv_read".into()),
            family: None,
            shape_profile: None,
            semantic_shape_profile: None,
            tier: None,
            test_name: None,
            row_id: None,
            owner_gate: None,
            evidence_path: None,
            blocks_promotion: true,
            blocks_runtime_claim: true,
            blocks_release_claim: true,
        };
        let (_, receipt) = normalize_gaps(&[gap], GapReportAccounting::default());
        assert!(receipt.false_qualification_risks_detected);
    }

    #[test]
    fn external_array_failure_becomes_needs_triage() {
        let gap = gap_from_test_failure("external_array_foo".into(), "test external_array_foo ... FAILED".into(), GapStatus::NeedsTriage);
        assert_eq!(gap.status, GapStatus::NeedsTriage);
    }

    #[test]
    fn tier1_defect_cluster_to_gap_severity_mapping() {
        assert_eq!(severity_for_tier1("S1_blocks_decode_microphase"), GapSeverity::S3);
        assert_eq!(severity_for_tier1("S4_diagnostic_only"), GapSeverity::S1);
    }

    #[test]
    fn kv_contract_backend_owned_coreml_is_s4() {
        let contract = serde_json::json!({
            "contract_id": "kv.kv_read/decode_small_v1/len16",
            "profile_id": "decode_small_v1",
            "backend": "coreml",
            "phase": "kv_read",
            "ownership": "backend_owned",
            "mutation": "read_only"
        });
        let gap = parse_kv_contract_value(&contract, None).expect("expected gap");
        assert_eq!(gap.severity, GapSeverity::S4);
        assert_eq!(gap.classification, GapClassification::BackendOwnershipGap);
    }

    #[test]
    fn tier2_pending_becomes_gap() {
        let row = Tier2SupportRow {
            row_id: "tier2/decode_mlp_gate_up_silu/default/small/coreml/cpuOnly".into(),
            family: "decode_mlp_gate_up_silu".into(),
            shape_profile: "small".into(),
            semantic_shape_profile: "decode_small_v1".into(),
            backend: "coreml".into(),
            support_status: "pending_BridgeNotQualified".into(),
            reason: Some("decode microphase predict bridge not yet qualified".into()),
            blocked_by_tier1_defect: Some("cluster_001".into()),
        };
        let gap = gap_from_tier2_support_row(row).expect("expected tier2 gap");
        assert_eq!(gap.classification, GapClassification::PendingQualification);
        assert!(gap.blocks_promotion);
    }

    #[test]
    fn parse_failed_test_names() {
        let names = parse_raw_text_test_failures("test external_array_smoke ... FAILED\ntest result: FAILED. 1 passed; 1 failed; 0 ignored;");
        assert_eq!(names, vec!["external_array_smoke".to_string()]);
    }

    #[test]
    fn empty_run_produces_empty_ledger() {
        let (gaps, receipt) = normalize_gaps(&[], GapReportAccounting::default());
        assert!(gaps.is_empty());
        assert_eq!(receipt.total_warnings, 0);
        assert_eq!(receipt.total_errors, 0);
    }

    #[test]
    fn receipt_index_generation() {
        let dir = tempdir().expect("tempdir");
        let gaps = vec![gap_from_warning(GapSource::Rustc, GapClassification::CompileWarning, "warn".into())];
        let (normalized, receipt) = normalize_gaps(&gaps, GapReportAccounting::default());
        let matrix = build_backend_gap_matrix();
        let receipts = write_gap_report_artifacts(dir.path(), &normalized, &receipt, &matrix).expect("write artifacts");
        assert!(receipts.contains_key("receipt_index.json"));
        assert!(dir.path().join("summary.md").exists());
    }

    #[test]
    fn gap_ledger_serde_roundtrip() {
        let gap = gap_from_warning(GapSource::Rustc, GapClassification::CompileWarning, "warn".into());
        let json = serde_json::to_string(&gap).expect("serialize");
        let roundtrip: ComputeGap = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(roundtrip.classification, GapClassification::CompileWarning);
    }
}
