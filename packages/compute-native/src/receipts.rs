//! Receipt emission for SharedTensorArena v1.
//!
//! Every arena lifecycle event, backend transition, Core ML prediction,
//! and hybrid job run produces a receipt. Receipts carry the IOSurface ID,
//! shape, row stride, lease intervals, output-backing feature name,
//! copy classification, and final lifecycle state.

use serde::{Deserialize, Serialize};
use std::time::Instant;
use uuid::Uuid;

/// Copy classification for the boundary crossing.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CopyClassification {
    ApplicationCopyFree,
    CopiedFallback,
    MaterializedLayoutConversion,
    InternalCoremlStagingUnknown,
}

impl std::fmt::Display for CopyClassification {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CopyClassification::ApplicationCopyFree => write!(f, "application_copy_free"),
            CopyClassification::CopiedFallback => write!(f, "copied_fallback"),
            CopyClassification::MaterializedLayoutConversion => {
                write!(f, "materialized_layout_conversion")
            }
            CopyClassification::InternalCoremlStagingUnknown => {
                write!(f, "internal_coreml_staging_unknown")
            }
        }
    }
}

/// Arena creation receipt.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ArenaCreationReceipt {
    pub arena_id: String,
    pub generation: u64,
    pub io_surface_id: i32,
    pub logical_shape: (u32, u32),
    pub physical_width: i32,
    pub physical_height: i32,
    pub bytes_per_row: i32,
    pub total_bytes: i32,
    pub pixel_format: i32,
    pub profile: String,
    pub created_at: String,
}

/// Backend lease receipt.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LeaseReceipt {
    pub arena_id: String,
    pub io_surface_id: i32,
    pub job_id: Uuid,
    pub backend: String,
    pub access: String,
    pub acquired_at: u128, // ms since epoch or relative
    pub duration_ms: Option<u64>,
}

/// Core ML prediction receipt.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CoreMlPredictionReceipt {
    pub job_id: Uuid,
    pub model_hash: String,
    pub island_id: Option<String>,
    pub input_arena_id: String,
    pub input_io_surface_id: i32,
    pub input_shape: (u32, u32),
    pub output_arena_id: String,
    pub output_io_surface_id: i32,
    pub output_shape: (u32, u32),
    pub output_backing_feature: String,
    pub duration_ms: u64,
    pub copy_classification: CopyClassification,
    pub internal_coreml_staging: bool, // always unknown — true = "Apple may stage internally"
    pub success: bool,
}

/// State mutation receipt.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StateMutationReceipt {
    pub job_id: Uuid,
    pub state_id: String,
    pub island_id: String,
    pub step: u32,
    pub duration_ms: u64,
    pub success: bool,
}

/// Hybrid job receipt — the combined receipt for a full MLX/Core ML job.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HybridJobReceipt {
    pub job_id: Uuid,
    pub session_id: Uuid,
    pub arena_creations: Vec<ArenaCreationReceipt>,
    pub compute_image_hash: String,
    pub coreml_artifact_hash: String,
    pub macos_version: String,
    pub capability_report_hash: String,
    pub state_id: Option<String>,
    pub arena_a_id: Option<String>,
    pub arena_b_id: Option<String>,
    pub lease_transitions: Vec<LeaseReceipt>,
    pub coreml_predictions: Vec<CoreMlPredictionReceipt>,
    pub state_mutations: Vec<StateMutationReceipt>,
    pub total_duration_ms: u64,
    pub application_copy_free: bool,
    pub internal_coreml_staging: bool,
    pub copy_classification: CopyClassification,
    pub finalizer_count: u32,
    pub final_arena_state: String,
    pub success: bool,
    pub error: Option<String>,
}

/// Receipt emitter — collects receipts during job execution.
#[derive(Debug, Default)]
pub struct ReceiptEmitter {
    arena_creations: Vec<ArenaCreationReceipt>,
    lease_transitions: Vec<LeaseReceipt>,
    coreml_predictions: Vec<CoreMlPredictionReceipt>,
    state_mutations: Vec<StateMutationReceipt>,
    start: Option<Instant>,
}

impl ReceiptEmitter {
    pub fn new() -> Self {
        ReceiptEmitter {
            start: Some(Instant::now()),
            ..Default::default()
        }
    }

    pub fn record_arena_creation(
        &mut self,
        arena_id: String,
        generation: u64,
        io_surface_id: i32,
        dim0: u32,
        dim1: u32,
        width: i32,
        height: i32,
        bpr: i32,
        total_bytes: i32,
        pixel_format: i32,
    ) {
        self.arena_creations.push(ArenaCreationReceipt {
            arena_id,
            generation,
            io_surface_id,
            logical_shape: (dim0, dim1),
            physical_width: width,
            physical_height: height,
            bytes_per_row: bpr,
            total_bytes,
            pixel_format,
            profile: "IOSurfaceFp16ContiguousV1".into(),
            created_at: format!("{:?}", Instant::now()),
        });
    }

    pub fn record_lease(
        &mut self,
        arena_id: String,
        io_surface_id: i32,
        job_id: Uuid,
        backend: String,
        access: String,
        acquired_at: Instant,
    ) {
        self.lease_transitions.push(LeaseReceipt {
            arena_id,
            io_surface_id,
            job_id,
            backend,
            access,
            acquired_at: acquired_at.elapsed().as_millis(),
            duration_ms: None,
        });
    }

    pub fn record_prediction(&mut self, receipt: CoreMlPredictionReceipt) {
        self.coreml_predictions.push(receipt);
    }

    pub fn record_state_mutation(&mut self, receipt: StateMutationReceipt) {
        self.state_mutations.push(receipt);
    }

    pub fn finalize(self, job_id: Uuid, session_id: Uuid) -> HybridJobReceipt {
        let total_ms = self
            .start
            .map(|s| s.elapsed().as_millis() as u64)
            .unwrap_or(0);
        let app_copy_free = self
            .coreml_predictions
            .iter()
            .all(|p| p.copy_classification == CopyClassification::ApplicationCopyFree);

        HybridJobReceipt {
            job_id,
            session_id,
            arena_creations: self.arena_creations,
            compute_image_hash: String::new(),
            coreml_artifact_hash: String::new(),
            macos_version: "15.0".into(),
            capability_report_hash: String::new(),
            state_id: None,
            arena_a_id: None,
            arena_b_id: None,
            lease_transitions: self.lease_transitions,
            coreml_predictions: self.coreml_predictions,
            state_mutations: self.state_mutations,
            total_duration_ms: total_ms,
            application_copy_free: app_copy_free,
            internal_coreml_staging: true, // always unknown
            copy_classification: if app_copy_free {
                CopyClassification::ApplicationCopyFree
            } else {
                CopyClassification::CopiedFallback
            },
            finalizer_count: 0,
            final_arena_state: "free".into(),
            success: true,
            error: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_receipt_emitter_basic() {
        let mut emitter = ReceiptEmitter::new();
        emitter.record_arena_creation("arena-a".into(), 1, 42, 1, 4, 4, 1, 8, 8, 0x4C303068);
        emitter.record_lease("arena-a".into(), 42, Uuid::new_v4(), "mlx".into(), "write".into(), Instant::now());

        let receipt = emitter.finalize(Uuid::new_v4(), Uuid::new_v4());
        assert_eq!(receipt.arena_creations.len(), 1);
        assert_eq!(receipt.lease_transitions.len(), 1);
        assert_eq!(receipt.arena_creations[0].io_surface_id, 42);
    }

    #[test]
    fn test_copy_classification_display() {
        assert_eq!(
            CopyClassification::ApplicationCopyFree.to_string(),
            "application_copy_free"
        );
        assert_eq!(
            CopyClassification::InternalCoremlStagingUnknown.to_string(),
            "internal_coreml_staging_unknown"
        );
    }

    #[test]
    fn test_hybrid_receipt_serde() {
        let receipt = HybridJobReceipt {
            job_id: Uuid::new_v4(),
            session_id: Uuid::new_v4(),
            compute_image_hash: "abc".into(),
            coreml_artifact_hash: "def".into(),
            macos_version: "15.0".into(),
            capability_report_hash: "".into(),
            state_id: None,
            arena_a_id: Some("a".into()),
            arena_b_id: Some("b".into()),
            lease_transitions: vec![],
            coreml_predictions: vec![],
            state_mutations: vec![],
            arena_creations: vec![],
            total_duration_ms: 100,
            application_copy_free: true,
            internal_coreml_staging: true,
            copy_classification: CopyClassification::ApplicationCopyFree,
            finalizer_count: 2,
            final_arena_state: "free".into(),
            success: true,
            error: None,
        };
        let json = serde_json::to_string(&receipt).expect("serialize");
        let parsed: HybridJobReceipt = serde_json::from_str(&json).expect("deserialize");
        assert!(parsed.application_copy_free);
        assert_eq!(
            parsed.copy_classification,
            CopyClassification::ApplicationCopyFree
        );
    }
}
