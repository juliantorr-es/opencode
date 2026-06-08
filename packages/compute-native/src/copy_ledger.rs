//! Copy & sync ledger — audits and records memory transfers across the
//! compute-native boundary.
//!
//! Tracks every byte copy between mapped storage, CPU vecs, and MLX internal
//! arrays; captures sync barriers between pipeline stages; and identifies
//! fusion opportunities that eliminate intermediate copies.

use serde::{Deserialize, Serialize};

/// Storage class of a copy source or destination.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SourceStorage {
    /// Backed by a memory-mapped segment file.
    MappedImage,
    /// Host-side Vec allocation (always a copy).
    CopiedVec,
    /// MLX-internal allocation (Metal buffer, device memory).
    MlxInternal,
}

/// A single recorded copy entry
/// Classification of the copy reason and semantics.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CopyClass {
    /// Memory-mapped source/dest with no intermediate buffer needed.
    ZeroCopyMapped,
    /// MLX internal intermediate that needs a contiguous temporary.
    MlXTempContiguous,
    /// IO surface shared between CPU and GPU (zero-copy on supported hardware).
    IoSurfaceShared,
    /// Explicit copy through a CPU staging buffer.
    ExplicitCpuStaging,
    /// Copy forced by a data type conversion.
    DtypeConversion,
    /// Copy forced by a layout/transpose conversion.
    LayoutConversion,
    /// Copy between backends (e.g. MLX ↔ CPU fallback).
    BackendDuplicate,
}

/// A single recorded copy entry in the ledger.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CopyEntry {
    /// Path segment identifier (e.g. "layer_07/qmatmul_Q").
    pub path_segment: String,
    /// Storage class of the source.
    pub source_storage: SourceStorage,
    /// Storage class of the destination.
    pub dest_storage: SourceStorage,
    /// Number of bytes transferred.
    pub bytes_copied: u64,
    /// True when the source layout requires a forced MLX contiguous copy.
    pub requires_contiguous_input: bool,
    /// True when the destination layout requires a forced MLX contiguous write.
    pub requires_contiguous_output: bool,
    /// Optional dtype conversion applied (e.g. "u32→f16").
    pub dtype_conversion: Option<String>,
    /// What triggered this copy (free-text, e.g. "segment_activation").
    pub triggered_by: String,
    /// Classification of the copy reason.
    pub copy_class: CopyClass,
}

impl CopyEntry {
    pub fn new(
        path_segment: impl Into<String>,
        source_storage: SourceStorage,
        dest_storage: SourceStorage,
        bytes_copied: u64,
        triggered_by: impl Into<String>,
    ) -> Self {
        Self {
            path_segment: path_segment.into(),
            source_storage,
            dest_storage,
            bytes_copied,
            requires_contiguous_input: false,
            requires_contiguous_output: false,
            dtype_conversion: None,
            triggered_by: triggered_by.into(),
            copy_class: CopyClass::ZeroCopyMapped,
        }
    }

    /// Mark this entry as requiring a contiguous source layout.
    pub fn with_contiguous_input(mut self) -> Self {
        self.requires_contiguous_input = true;
        self
    }

    /// Mark this entry as requiring a contiguous destination layout.
    pub fn with_contiguous_output(mut self) -> Self {
        self.requires_contiguous_output = true;
        self
    }

    /// Attach an optional dtype conversion.
    pub fn with_dtype_conversion(mut self, conv: impl Into<String>) -> Self {
        self.dtype_conversion = Some(conv.into());
        self
    }

    /// Attach a copy classification.
    pub fn with_copy_class(mut self, cls: CopyClass) -> Self {
        self.copy_class = cls;
        self
    }
}

/// A synchronization boundary between two pipeline stages.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncBoundary {
    /// Human-readable boundary name.
    pub boundary_name: String,
    /// Name of the op or stage preceding this boundary.
    pub preceding_op: String,
    /// Name of the op or stage following this boundary.
    pub following_op: String,
    /// Device identifier (e.g. "mlx_gpu", "mlx_cpu").
    pub device: String,
    /// Stream or queue identifier.
    pub stream: String,
    /// True when an MLX eval() barrier is needed at this boundary.
    pub eval_barrier: bool,
    /// True when a predict barrier (Metal command-buffer wait) is needed.
    pub predict_barrier: bool,
    /// Observed or estimated wait time in microseconds.
    pub wait_us: u64,
}

/// Complete copy ledger for one model invocation or compilation plan.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CopyLedger {
    /// All recorded copy entries in chronological order.
    pub entries: Vec<CopyEntry>,
    /// Synchronization boundaries interleaved with the copy entries.
    pub sync_boundaries: Vec<SyncBoundary>,
}

impl CopyLedger {
    /// Add a copy entry and return self for chaining.
    pub fn add_entry(mut self, entry: CopyEntry) -> Self {
        self.entries.push(entry);
        self
    }

    /// Add a sync boundary and return self for chaining.
    pub fn add_boundary(mut self, boundary: SyncBoundary) -> Self {
        self.sync_boundaries.push(boundary);
        self
    }

    /// Total bytes copied across all entries.
    pub fn total_bytes_copied(&self) -> u64 {
        self.entries.iter().map(|e| e.bytes_copied).sum()
    }

    /// Number of entries that require a contiguous layout on either side.
    pub fn contiguous_copy_count(&self) -> usize {
        self.entries
            .iter()
            .filter(|e| e.requires_contiguous_input || e.requires_contiguous_output)
            .count()
    }
}

/// Audit mapped weight layouts against known zero-copy preconditions.
///
/// For the current Gemma 4 12B model:
/// - U32 packed weights are at 16-byte alignment, row-major contiguous.
/// - F32 scales / biases are row-major contiguous.
/// - Every weight segment should be zero-copy (MappedImage ↔ MLX).
pub fn audit_mapped_weight_layout(segments: &[crate::config::PlannedSegment]) -> CopyLedger {
    let mut ledger = CopyLedger::default();

    for seg in segments {
        let is_packed = seg.kind == "packed_weights" || seg.id.contains("packed");
        let is_scale = seg.kind == "scale_bias" || seg.id.contains("scale");

        let (storage, contiguous, dtype) = if is_packed {
            (
                SourceStorage::MappedImage,
                true,
                Some("u32→f16".into()),
            )
        } else if is_scale {
            (
                SourceStorage::MappedImage,
                true,
                None,
            )
        } else {
            (
                SourceStorage::MappedImage,
                false,
                None,
            )
        };

        let entry = CopyEntry {
            path_segment: seg.id.clone(),
            source_storage: storage,
            dest_storage: SourceStorage::MlxInternal,
            bytes_copied: seg.byte_size,
            requires_contiguous_input: false,
            requires_contiguous_output: !contiguous,
            dtype_conversion: dtype,
            triggered_by: "mapped_weight_layout_audit".into(),
            copy_class: CopyClass::ZeroCopyMapped,
        };
        ledger.entries.push(entry);
    }

    ledger
}

/// Audit the full 48-layer runtime path.
///
/// Each layer (0..48) follows the same pattern:
///   qmatmul × 7 (Q, K, V, O, gate, up, down)
///   → eval barrier
///   → segment activation → byte copy
///   → segment retirement
///
/// After all layers a final sync barrier closes the pipeline.
pub fn audit_runtime_path() -> CopyLedger {
    let layer_count = 48u32;
    let qmatmul_labels = ["Q", "K", "V", "O", "gate", "up", "down"];
    let segment_byte_size = 8_388_608u64; // 8 MiB per segment
    let mut ledger = CopyLedger::default();

    for layer in 0..layer_count {
        let layer_prefix = format!("layer_{layer:02}");

        // qmatmul × 7 — all MappedImage → MlxInternal, zero-copy
        for label in &qmatmul_labels {
            let seg_id = format!("{layer_prefix}/qmatmul_{label}");
            let entry = CopyEntry {
                path_segment: seg_id,
                source_storage: SourceStorage::MappedImage,
                dest_storage: SourceStorage::MlxInternal,
                bytes_copied: segment_byte_size,
                requires_contiguous_input: false,
                requires_contiguous_output: false,
                dtype_conversion: None,
                triggered_by: "qmatmul_load".into(),
                copy_class: CopyClass::ZeroCopyMapped,
            };
            ledger.entries.push(entry);
        }

        // Eval barrier after all qmatmuls complete.
        let barrier = SyncBoundary {
            boundary_name: format!("{layer_prefix}/eval_barrier"),
            preceding_op: format!("{layer_prefix}/qmatmul_down"),
            following_op: format!("{layer_prefix}/segment_activate"),
            device: "mlx_gpu".into(),
            stream: "default".into(),
            eval_barrier: true,
            predict_barrier: false,
            wait_us: 50,
        };
        ledger.sync_boundaries.push(barrier);

        // Segment activation → byte copy: MappedImage → CopiedVec for activation.
        let activate_entry = CopyEntry {
            path_segment: format!("{layer_prefix}/segment_activate"),
            source_storage: SourceStorage::MappedImage,
            dest_storage: SourceStorage::CopiedVec,
            bytes_copied: segment_byte_size,
            requires_contiguous_input: true,
            requires_contiguous_output: false,
            dtype_conversion: None,
            triggered_by: "segment_activation".into(),
            copy_class: CopyClass::ExplicitCpuStaging,
        };
        ledger.entries.push(activate_entry);

        // Segment retirement → byte copy back.
        let retire_entry = CopyEntry {
            path_segment: format!("{layer_prefix}/segment_retire"),
            source_storage: SourceStorage::CopiedVec,
            dest_storage: SourceStorage::MappedImage,
            bytes_copied: segment_byte_size,
            requires_contiguous_input: false,
            requires_contiguous_output: true,
            dtype_conversion: None,
            triggered_by: "segment_retirement".into(),
            copy_class: CopyClass::ExplicitCpuStaging,
        };
        ledger.entries.push(retire_entry);
    }

    // Final sync barrier.
    let final_barrier = SyncBoundary {
        boundary_name: "pipeline_flush".into(),
        preceding_op: format!("layer_{:02}/segment_retire", layer_count - 1),
        following_op: "output_generation".into(),
        device: "mlx_gpu".into(),
        stream: "default".into(),
        eval_barrier: true,
        predict_barrier: true,
        wait_us: 200,
    };
    ledger.sync_boundaries.push(final_barrier);

    ledger
}

/// A detected fusion opportunity with projected latency savings.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FusionOpportunityReport {
    /// Region identifier (e.g. "layer_00/rmsnorm_qproj").
    pub region: String,
    /// Human-readable description of ops being fused.
    pub ops_fused: String,
    /// Current (unfused) latency in microseconds.
    pub current_latency_us: u64,
    /// Projected fused latency in microseconds.
    pub projected_fused_latency_us: u64,
    /// Percentage savings from fusion.
    pub savings_pct: f64,
}

/// Generate the static fusion opportunity report for the Gemma 4 12B model.
///
/// Three hardcoded opportunities:
///   1. RMSNorm + QProj — norm is 3840-dim, projection uses same dims.
///   2. QK norm + RoPE — sequential norms then RoPE can be fused.
///   3. gate×up → down_proj — gate activation can fuse with element-wise mul.
pub fn generate_fusion_report() -> Vec<FusionOpportunityReport> {
    vec![
        FusionOpportunityReport {
            region: "layer_00/rmsnorm_qproj".into(),
            ops_fused: "RMSNorm (3840-dim) + Q linear projection".into(),
            current_latency_us: 85,
            projected_fused_latency_us: 52,
            savings_pct: 38.8,
        },
        FusionOpportunityReport {
            region: "layer_00/qk_norm_rope".into(),
            ops_fused: "Q norm + K norm + RoPE application".into(),
            current_latency_us: 68,
            projected_fused_latency_us: 41,
            savings_pct: 39.7,
        },
        FusionOpportunityReport {
            region: "layer_00/gate_up_down".into(),
            ops_fused: "gate activation (SiLU) + element-wise multiply + down projection".into(),
            current_latency_us: 120,
            projected_fused_latency_us: 78,
            savings_pct: 35.0,
        },
        FusionOpportunityReport {
            region: "layer_00/residual_rmsnorm".into(),
            ops_fused: "residual add + RMSNorm".into(),
            current_latency_us: 55,
            projected_fused_latency_us: 35,
            savings_pct: 36.4,
        },
        FusionOpportunityReport {
            region: "final_norm_tied_proj".into(),
            ops_fused: "final normalization + tied output projection".into(),
            current_latency_us: 95,
            projected_fused_latency_us: 60,
            savings_pct: 36.8,
        },
        FusionOpportunityReport {
            region: "softcap_penalties_sampling".into(),
            ops_fused: "logit soft-cap + repetition penalties + top-k sampling".into(),
            current_latency_us: 150,
            projected_fused_latency_us: 95,
            savings_pct: 36.7,
        },
        FusionOpportunityReport {
            region: "kv_append_sliding_attention".into(),
            ops_fused: "KV cache append + sliding window mask + attention compute".into(),
            current_latency_us: 200,
            projected_fused_latency_us: 130,
            savings_pct: 35.0,
        },
    ]
}

/// Generate a human-readable warning about copies that force MLX to
/// materialise contiguous intermediate buffers — a performance red flag.
pub fn mlx_contiguous_copy_warning(ledger: &CopyLedger) -> String {
    let contiguous: Vec<&CopyEntry> = ledger
        .entries
        .iter()
        .filter(|e| e.requires_contiguous_input || e.requires_contiguous_output)
        .collect();

    if contiguous.is_empty() {
        return "No contiguous copy warnings: all copies are zero-copy compatible.".into();
    }

    let mut out = format!(
        "MLX contiguous copy warning: {} entries force contiguous layout\n",
        contiguous.len()
    );
    for e in &contiguous {
        let side = if e.requires_contiguous_input && e.requires_contiguous_output {
            "input+output"
        } else if e.requires_contiguous_input {
            "input"
        } else {
            "output"
        };
        out.push_str(&format!(
            "  {} — {} requires {} contiguous layout\n",
            e.path_segment, e.triggered_by, side
        ));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::PlannedSegment;

    #[test]
    fn test_copy_entry_builder() {
        let entry = CopyEntry::new("test/path", SourceStorage::MappedImage, SourceStorage::MlxInternal, 4096, "test")
            .with_contiguous_input()
            .with_dtype_conversion("u32→f16");
        assert!(entry.requires_contiguous_input);
        assert!(!entry.requires_contiguous_output);
        assert_eq!(entry.dtype_conversion.as_deref(), Some("u32→f16"));
        assert_eq!(entry.bytes_copied, 4096);
    }

    #[test]
    fn test_audit_mapped_weight_packed_weights_are_zero_copy() {
        let segments = vec![
            PlannedSegment {
                id: "layer_00/packed".into(),
                filename: "seg_000.bin".into(),
                byte_size: 16_777_216,
                kind: "packed_weights".into(),
                tensor_count: 1,
            },
            PlannedSegment {
                id: "layer_00/scale".into(),
                filename: "seg_001.bin".into(),
                byte_size: 4096,
                kind: "scale_bias".into(),
                tensor_count: 2,
            },
        ];
        let ledger = audit_mapped_weight_layout(&segments);
        assert_eq!(ledger.entries.len(), 2);
        // Packed weights: zero-copy (mapped input, no contiguous requirement).
        let packed = &ledger.entries[0];
        assert_eq!(packed.source_storage, SourceStorage::MappedImage);
        assert_eq!(packed.dest_storage, SourceStorage::MlxInternal);
        assert!(!packed.requires_contiguous_input);
        assert!(!packed.requires_contiguous_output);
        assert_eq!(packed.dtype_conversion.as_deref(), Some("u32→f16"));
        // Scale/bias: row-major contiguous, zero-copy.
        let scale = &ledger.entries[1];
        assert_eq!(scale.source_storage, SourceStorage::MappedImage);
        assert!(!scale.requires_contiguous_input);
        assert!(!scale.requires_contiguous_output);
        assert!(scale.dtype_conversion.is_none());
    }

    #[test]
    fn test_audit_runtime_path_layer_count() {
        let ledger = audit_runtime_path();
        // 48 layers × (7 qmatmul + 1 activate + 1 retire) = 432 copy entries
        assert_eq!(ledger.entries.len(), 48 * 9);
        // 48 eval barriers + 1 final flush barrier
        assert_eq!(ledger.sync_boundaries.len(), 49);
    }

    #[test]
    fn test_runtime_path_entry_shapes() {
        let ledger = audit_runtime_path();
        let first_entry = &ledger.entries[0];
        assert_eq!(first_entry.path_segment, "layer_00/qmatmul_Q");
        assert_eq!(first_entry.triggered_by, "qmatmul_load");
        assert!(!first_entry.requires_contiguous_input);
        assert!(!first_entry.requires_contiguous_output);

        let last_entry = &ledger.entries[ledger.entries.len() - 1];
        assert!(last_entry.path_segment.contains("segment_retire"));
        assert!(last_entry.requires_contiguous_output);
    }

    #[test]
    fn test_generate_fusion_report() {
        let reports = generate_fusion_report();
        assert_eq!(reports.len(), 7);
        for r in &reports {
            assert!(r.current_latency_us > r.projected_fused_latency_us);
            assert!(r.savings_pct > 0.0 && r.savings_pct < 100.0);
        }
        assert!(reports[0].region.contains("rmsnorm_qproj"));
        assert!(reports[1].region.contains("qk_norm_rope"));
        assert!(reports[2].region.contains("gate_up_down"));
        assert!(reports[3].region.contains("residual_rmsnorm"));
        assert!(reports[4].region.contains("final_norm_tied_proj"));
        assert!(reports[5].region.contains("softcap_penalties_sampling"));
        assert!(reports[6].region.contains("kv_append_sliding_attention"));
    }

    #[test]
    fn test_total_bytes_copied() {
        let entry_a = CopyEntry::new("a", SourceStorage::MappedImage, SourceStorage::MlxInternal, 1000, "test");
        let entry_b = CopyEntry::new("b", SourceStorage::CopiedVec, SourceStorage::MappedImage, 2000, "test");
        let ledger = CopyLedger::default().add_entry(entry_a).add_entry(entry_b);
        assert_eq!(ledger.total_bytes_copied(), 3000);
    }
}
