//! ANE artifact schemas — derived backend artifacts that the ANE compiler
//! will produce. No _ANECompiler calls are made here.
//!
//! The canonical ComputeImage weights remain authoritative. BLOBFILE,
//! fp16 conversion, padding, layout transposition, and ANE-specific
//! packing are derived backend artifacts whose receipts point back to
//! the source tensor identities.

use crate::backend::DType;
use crate::backend::routing::{EvidenceDigest, TensorId, BackendArtifactId};

// ── ANE MIL text artifact ────────────────────────────────────────────────

/// Textual MIL program ready for _ANECompiler ingestion.
///
/// Orion emits `program(1.3) { func main<ios18>(...) { ... } -> (...); }`
/// syntax directly. This artifact captures the text before compilation.
#[derive(Debug, Clone)]
pub struct AneMilTextArtifact {
    /// Content-addressed digest of this MIL text.
    pub digest: EvidenceDigest,
    /// The MIL program text (Orion format).
    pub mil_text: String,
    /// Backend artifact identity.
    pub artifact_id: BackendArtifactId,
    /// Source scheduled-region digest this artifact was lowered from.
    pub source_region_digest: EvidenceDigest,
}

// ── IOSurface contract ───────────────────────────────────────────────────

/// Deterministic IOSurface contract for ANE tensors.
///
/// Captures shape, dtype, alignment, and byte size for each tensor
/// that will be allocated as IOSurface-backed storage.
#[derive(Debug, Clone)]
pub struct AneIoContract {
    /// Content-addressed digest.
    pub digest: EvidenceDigest,
    /// Per-tensor IOSurface specifications.
    pub surfaces: Vec<AneIoSurfaceSpec>,
}

/// Specification for a single ANE IOSurface tensor.
#[derive(Debug, Clone)]
pub struct AneIoSurfaceSpec {
    /// Source tensor identity.
    pub tensor_id: TensorId,
    /// ANE layout: [1, C, 1, S] — Orion convention.
    pub shape: [u64; 4],
    /// Dtype on ANE (typically fp16).
    pub dtype: DType,
    /// Byte size of the allocation.
    pub byte_size: u64,
    /// Alignment requirement (typically page-aligned, 16384).
    pub alignment: u64,
    /// Whether this is an input or output (affects ordering).
    pub is_input: bool,
}

// ── Weight blob plan ─────────────────────────────────────────────────────

/// Deterministic weight-blob plan for ANE.
///
/// Describes how canonical ComputeImage weight segments are packed
/// into ANE-compatible BLOBFILE artifacts.
#[derive(Debug, Clone)]
pub struct AneWeightBlobPlan {
    /// Content-addressed digest.
    pub digest: EvidenceDigest,
    /// BLOBFILE entries.
    pub entries: Vec<AneBlobEntry>,
    /// Total byte size of all blobs.
    pub total_bytes: u64,
}

/// A single BLOBFILE entry describing one weight tensor.
#[derive(Debug, Clone)]
pub struct AneBlobEntry {
    /// Source tensor identity.
    pub tensor_id: TensorId,
    /// Path within the compiled ANE program's weight directory.
    pub relative_path: String,
    /// Offset from BLOBFILE start (64, after 128-byte header).
    pub offset: u64,
    /// Byte length of the payload.
    pub length: u64,
    /// Source dtype before conversion to ANE-compatible format.
    pub source_dtype: DType,
    /// Target dtype (fp16 for ANE weights).
    pub target_dtype: DType,
}

// ── Compile plan ─────────────────────────────────────────────────────────

/// Sealed ANE compile plan — everything needed to invoke _ANECompiler
/// once private APIs are available.
#[derive(Debug, Clone)]
pub struct AneCompilePlan {
    /// Content-addressed digest binding all sub-artifacts.
    pub digest: EvidenceDigest,
    /// MIL text artifact identity.
    pub mil_text_digest: EvidenceDigest,
    /// IOSurface contract identity.
    pub io_contract_digest: EvidenceDigest,
    /// Weight blob plan identity.
    pub weight_blob_digest: EvidenceDigest,
    /// Target opset (e.g. "ios18").
    pub opset: String,
    /// Machine profile this plan is qualified for.
    pub machine_profile_digest: EvidenceDigest,
    /// Estimated compile budget usage (1 per program).
    pub compile_budget_units: u32,
}

// ── Program artifact identity ────────────────────────────────────────────

/// Identity of a compiled ANE program (before actual compilation).
///
/// Once compiled, this identity is bound to the physical ANE program.
#[derive(Debug, Clone)]
pub struct AneProgramArtifactIdentity {
    /// Backend artifact identifier.
    pub artifact_id: BackendArtifactId,
    /// Compile plan that produced this program.
    pub compile_plan_digest: EvidenceDigest,
    /// Content-addressed identity (placeholder until compilation).
    pub program_digest: EvidenceDigest,
}

// ── Program generation ───────────────────────────────────────────────────

/// A generation of an ANE program — incremented on weight patches
/// and reloads even when the program code identity is unchanged.
#[derive(Debug, Clone)]
pub struct AneProgramGeneration {
    /// Stable program code identity.
    pub code_identity: AneProgramArtifactIdentity,
    /// Generation number (incremented on patch/reload).
    pub generation: u32,
    /// Weight artifact identity at this generation.
    pub weight_digest: EvidenceDigest,
    /// Whether this generation has been compiled and loaded.
    pub compiled: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn artifact_schemas_are_constructible() {
        let plan = AneCompilePlan {
            digest: EvidenceDigest("test-digest".into()),
            mil_text_digest: EvidenceDigest("mil-001".into()),
            io_contract_digest: EvidenceDigest("io-001".into()),
            weight_blob_digest: EvidenceDigest("w-001".into()),
            opset: "ios18".into(),
            machine_profile_digest: EvidenceDigest("m1-max".into()),
            compile_budget_units: 1,
        };
        assert!(!plan.digest.0.is_empty());
        assert_eq!(plan.compile_budget_units, 1);
    }

    #[test]
    fn io_contract_captures_ane_layout() {
        let spec = AneIoSurfaceSpec {
            tensor_id: TensorId(1),
            shape: [1, 4, 1, 4],
            dtype: DType::F16,
            byte_size: 49152,
            alignment: 16384,
            is_input: true,
        };
        assert_eq!(spec.shape[0], 1);
        assert_eq!(spec.shape[3], 4);
        assert!(spec.byte_size >= 49152);
    }

    #[test]
    fn program_generation_increments() {
        let id = AneProgramArtifactIdentity {
            artifact_id: BackendArtifactId(1),
            compile_plan_digest: EvidenceDigest("cp-001".into()),
            program_digest: EvidenceDigest("prog-001".into()),
        };
        let gen1 = AneProgramGeneration {
            code_identity: id.clone(),
            generation: 1,
            weight_digest: EvidenceDigest("w-v1".into()),
            compiled: true,
        };
        let gen2 = AneProgramGeneration {
            code_identity: id,
            generation: 2,
            weight_digest: EvidenceDigest("w-v2".into()),
            compiled: false,
        };
        assert_eq!(gen1.generation, 1);
        assert_eq!(gen2.generation, 2);
        assert_ne!(gen1.weight_digest, gen2.weight_digest);
    }
}
