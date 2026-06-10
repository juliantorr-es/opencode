//! Tribunus multi-level compiler IR and backend-lowering foundation.
//!
//! # Layers
//!
//! | Layer | Module | Responsibility |
//! |---|---|---|
//! | Semantic | [`semantic::SemanticModule`] | Backend-neutral model meaning: logical shapes, dtypes, tensor lineage, statefulness, tolerance classes |
//! | Scheduled | [`scheduled::ScheduledModule`] | Physical regions with concrete layouts, placements, transfers, memory plans, evaluation boundaries |
//! | Passes | [`pass::TransformPass`] | Versioned transformations with receipts |
//! | Backend | [`BackendLowering`] | Sealed backend artifact with legality receipts |

pub mod semantic;
pub mod scheduled;
pub mod pass;
pub mod lowering;
pub mod ane;

#[cfg(test)]
mod pipeline_tests;

use crate::backend::routing::{BackendArtifactId, BackendId, EvidenceDigest, OperationId};

/// Receipt produced when lowering a scheduled region to a backend artifact.
#[derive(Debug, Clone)]
pub struct LoweringReceipt {
    /// Identity of the backend that produced this artifact.
    pub backend_id: BackendId,
    /// Digest of the scheduled module that was lowered.
    pub source_schedule_digest: EvidenceDigest,
    /// Legality receipt — did the region pass backend validation?
    pub legality: LegalityReceipt,
    /// Identity of the produced backend artifact.
    pub artifact_id: BackendArtifactId,
    /// Compile duration in nanoseconds.
    pub compile_duration_ns: u64,
    /// Machine profile this artifact was compiled on.
    pub machine_profile_digest: EvidenceDigest,
    /// Whether this compilation hit the cache.
    pub cache_hit: bool,
}

/// Result of backend legality validation on a scheduled region.
#[derive(Debug, Clone)]
pub struct LegalityReceipt {
    /// Whether the region is legal for this backend.
    pub legal: bool,
    /// Violations found (if any).
    pub violations: Vec<LegalityViolation>,
}

/// A single legality violation detected during backend validation.
#[derive(Debug, Clone)]
pub struct LegalityViolation {
    /// Unique constraint identifier.
    pub constraint_id: String,
    /// Which operation(s) are affected.
    pub operation_ids: Vec<OperationId>,
    /// Human-readable description.
    pub message: String,
    /// Whether this violation is fatal.
    pub fatal: bool,
}

/// Trait for lowering a scheduled region to a backend-specific artifact.
///
/// Implementations must first validate the region against backend
/// constraints, then produce a sealed artifact if legal.
pub trait BackendLowering {
    /// The type of artifact produced by lowering.
    type Artifact;

    /// Validate a scheduled region against this backend's constraints.
    fn validate(
        &self,
        region: &scheduled::ScheduledRegion,
    ) -> Result<LegalityReceipt, String>;

    /// Lower a validated scheduled region to a backend artifact.
    fn lower(
        &self,
        region: &scheduled::ScheduledRegion,
    ) -> Result<(Self::Artifact, LoweringReceipt), String>;
}
