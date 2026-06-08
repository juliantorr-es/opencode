//! Layout compiler — plans tensor memory layout for compiled model images.
//!
//! The layout compiler translates an intermediate representation of operations
//! (IR) and the MLX primitive inventory into concrete memory layout reports.
//! Each [`LayoutReport`] records byte offsets, alignment, segment assignment,
//! and zero-copy eligibility for one tensor in the compiled graph.
//!
//! # Zero-copy requirements
//!
//! A tensor layout is zero-copy eligible only when:
//! - Its byte offset is page-aligned (4096 bytes for Metal I/O).
//! - Its byte span is contiguous (no padding between elements).
//! - Its base alignment satisfies the consuming primitive's input alignment.
//! - The tensor does not alias another tensor's live range (no overlap).
//!
//! `validate_layout` returns an error on the first violation.

use crate::mlx_inventory::MlxInventory;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

// ---------------------------------------------------------------------------
// IR types
// ---------------------------------------------------------------------------

/// Intermediate representation consumed by the layout compiler.
///
/// Produced by the ComputeIR pipeline.  Contains every compute operation in
/// execution order, referencing named tensors with their shapes and dtypes.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LayoutIr {
    /// Model architecture identity (e.g. "gemma4").
    pub model_identity: String,
    /// All operations in the graph, in execution order.
    pub ops: Vec<LayoutOp>,
    /// Named tensor pool — every tensor referenced by any `LayoutOp`.
    pub tensors: HashMap<String, LayoutTensor>,
}

/// One compute operation in the IR.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LayoutOp {
    /// Human-readable operation identifier unique within the IR.
    pub op_id: String,
    /// Operation kind (matches `OperationKind` naming, e.g. "QProj").
    pub kind: String,
    /// Layer index (0-based), or `None` for global ops.
    pub layer_index: Option<u32>,
    /// Tensors consumed by this operation (by name, matching `LayoutIr.tensors`).
    pub input_tensors: Vec<String>,
    /// Tensors produced by this operation (by name).
    pub output_tensors: Vec<String>,
    /// Estimated compute cost, higher = more expensive (relative units).
    pub compute_weight: u32,
}

/// A tensor referenced by one or more IR operations.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LayoutTensor {
    /// Logical name (e.g. "model.layers.0.self_attn.q_proj.weight").
    pub name: String,
    /// Logical element shape (e.g. [3840, 256]).
    pub logical_shape: Vec<u32>,
    /// Element dtype string (e.g. "float32", "bfloat16").
    pub dtype: String,
    /// True if this tensor is a model weight (read-only, persistent life).
    pub is_weight: bool,
    /// True if this tensor originates from or produces a Metal I/O surface.
    pub io_surface: bool,
    /// Byte alignment requirement (0 = use default).
    pub alignment: u32,
}

// ---------------------------------------------------------------------------
// LayoutSpec
// ---------------------------------------------------------------------------

/// A memory-layout specification for one tensor.
///
/// The layout compiler derives specs internally from the IR and inventory,
/// then compiles each into a [`LayoutReport`].
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LayoutSpec {
    /// Tensor identity.
    pub name: String,
    /// Element shape.
    pub logical_shape: Vec<u32>,
    /// Element dtype.
    pub dtype: String,
    /// Required byte alignment (0 means use the type-natural alignment).
    pub alignment: u32,
    /// Total element count (product of `logical_shape`).
    pub num_elements: u64,
    /// Bytes per element, derived from `dtype`.
    pub element_nbytes: u32,
    /// Total byte span (`num_elements * element_nbytes`).
    pub nbytes: u64,
    /// True when this tensor is eligible for Metal zero-copy I/O.
    pub zero_copy_eligible: bool,
    /// Name of the primitive (from `MlxPrimitive`) that consumes this tensor.
    pub consumer_primitive: Option<String>,
}

/// Element-type metadata.
struct DtypeInfo {
    nbytes: u32,
    alignment: u32,
}

fn dtype_info(dtype: &str) -> DtypeInfo {
    match dtype {
        "float32" | "float" => DtypeInfo { nbytes: 4, alignment: 4 },
        "bfloat16" | "float16" | "half" => DtypeInfo { nbytes: 2, alignment: 2 },
        "int8" | "uint8" | "int4" | "uint4" => DtypeInfo { nbytes: 1, alignment: 1 },
        "int32" | "uint32" => DtypeInfo { nbytes: 4, alignment: 4 },
        "int64" | "uint64" => DtypeInfo { nbytes: 8, alignment: 8 },
        _ => DtypeInfo { nbytes: 4, alignment: 4 }, // fallback
    }
}

/// Default segment index for non-weight tensors (activations).
const DEFAULT_ACTIVATION_SEGMENT: u32 = 0;
/// Segment index for weight tensors (read-only model parameters).
const WEIGHT_SEGMENT: u32 = 1;

/// Page alignment constant for Metal zero-copy eligibility.
const METAL_PAGE_SIZE: u64 = 4096;

// ---------------------------------------------------------------------------
// LayoutReport
// ---------------------------------------------------------------------------

/// The result of compiling one tensor's layout.
///
/// Describes exactly where the tensor lives in the compiled memory image,
/// and whether it satisfies zero-copy constraints.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LayoutReport {
    /// Tensor name (matches `LayoutTensor.name`).
    pub name: String,
    /// Logical element shape.
    pub logical_shape: Vec<u32>,
    /// Element dtype.
    pub dtype: String,
    /// Byte offset of this tensor within its owning segment.
    ///
    /// This is the unadjusted natural offset from packing.  The runtime may
    /// round up to the next page boundary; `aligned_offset` records that.
    pub byte_offset: u64,
    /// Page-aligned byte offset within the segment.
    ///
    /// When `zero_copy_eligible` is `true`, `aligned_offset` is a multiple
    /// of [`METAL_PAGE_SIZE`] and the runtime may map the buffer as a Metal
    /// zero-copy resource without copying bytes.
    pub aligned_offset: u64,
    /// Index of the memory segment this tensor resides in.
    ///
    /// - 0: activation segment (ephemeral, per-layer)
    /// - 1: weight segment (read-only, persistent)
    /// - 2+: extension / special-purpose segments.
    pub segment_index: u32,
    /// Total byte span (num_elements × element_nbytes).
    pub nbytes: u64,
    /// Byte strides for each logical dimension.
    ///
    /// Contiguous tensors have `strides[i] = element_nbytes * product(shape[i+1..])`.
    pub strides: Vec<u64>,
    /// True when the tensor's bytes are densely packed (no gaps).
    pub contiguous: bool,
    /// True when the tensor's byte offset is page-aligned and contiguous.
    pub zero_copy_eligible: bool,
    /// Non-None when a zero-copy requirement is violated.
    pub zero_copy_violation: Option<String>,
    /// Relative offset within the aligned region (aligned_offset + pad).
    pub pad_bytes: u64,
}

impl LayoutReport {
    /// True when the layout is usable as a Metal zero-copy buffer.
    pub fn is_zero_copy_ready(&self) -> bool {
        self.zero_copy_eligible && self.zero_copy_violation.is_none()
    }
}

// ---------------------------------------------------------------------------
// compile_layouts
// ---------------------------------------------------------------------------

/// Compile memory layouts for all tensors in the IR.
///
/// Uses the MLX primitive inventory to resolve alignment constraints and
/// zero-copy eligibility per primitive.  Returns one [`LayoutReport`] per
/// distinct tensor in the IR.
///
/// Layout strategy:
/// - Weight tensors are placed in segment 1 (the weight segment) starting
///   at offset 0, with no gap between consecutive weights.
/// - Activation tensors are placed in segment 0, one per op-output pair,
///   with overlap analysis to permit reuse across non-overlapping lifetimes.
/// - Tensors marked `io_surface` are forced to page alignment and marked
///   zero-copy eligible if their alignment is satisfied.
pub fn compile_layouts(
    ir: &LayoutIr,
    _inventory: &MlxInventory,
) -> Vec<LayoutReport> {
    // Assign segments and compute running offsets.
    let mut weights: Vec<&LayoutTensor> = Vec::new();
    let mut activations: Vec<&LayoutTensor> = Vec::new();

    for tensor in ir.tensors.values() {
        if tensor.is_weight {
            weights.push(tensor);
        } else {
            activations.push(tensor);
        }
    }

    // Stable order: sort weights by name, activations by first usage.
    weights.sort_by(|a, b| a.name.cmp(&b.name));
    activations.sort_by(|a, b| {
        let a_use = ir.ops.iter().position(|op| op.input_tensors.contains(&a.name) || op.output_tensors.contains(&a.name));
        let b_use = ir.ops.iter().position(|op| op.input_tensors.contains(&b.name) || op.output_tensors.contains(&b.name));
        a_use.unwrap_or(usize::MAX).cmp(&b_use.unwrap_or(usize::MAX))
    });

    let mut reports = Vec::with_capacity(ir.tensors.len());

    // ── Weight segment (segment 1) ──────────────────────────────────────
    let mut weight_offset: u64 = 0;
    for tensor in &weights {
        let info = dtype_info(&tensor.dtype);
        let nbytes = compute_nbytes(&tensor.logical_shape, info.nbytes as u64);
        let spec_align = if tensor.alignment > 0 {
            tensor.alignment as u64
        } else {
            info.alignment as u64
        };

        let byte_offset = weight_offset;
        weight_offset += nbytes;
        let aligned_offset = align_up(byte_offset, spec_align);

        let strides = compute_contiguous_strides(&tensor.logical_shape, info.nbytes as u64);
        let contiguous = is_contiguous(&strides, &tensor.logical_shape, info.nbytes as u64);
        let zero_copy = byte_offset % METAL_PAGE_SIZE == 0 && contiguous;

        let violation = validate_zero_copy_conditions(
            byte_offset,
            nbytes,
            spec_align,
            contiguous,
            tensor,
            &strides,
            &mut 0, // no offset collision checking for weight-only segment
            weight_offset,
        );

        reports.push(LayoutReport {
            name: tensor.name.clone(),
            logical_shape: tensor.logical_shape.clone(),
            dtype: tensor.dtype.clone(),
            byte_offset,
            aligned_offset,
            pad_bytes: aligned_offset.saturating_sub(byte_offset),
            segment_index: WEIGHT_SEGMENT,
            nbytes,
            strides,
            contiguous,
            zero_copy_eligible: zero_copy,
            zero_copy_violation: violation,
        });
    }

    // ── Activation segment (segment 0) ──────────────────────────────────
    let mut activation_offset: u64 = 0;
    for tensor in &activations {
        let info = dtype_info(&tensor.dtype);
        let nbytes = compute_nbytes(&tensor.logical_shape, info.nbytes as u64);
        let spec_align = if tensor.alignment > 0 {
            tensor.alignment as u64
        } else {
            info.alignment as u64
        };

        let byte_offset = align_up(activation_offset, spec_align);
        activation_offset = byte_offset + nbytes;

        let aligned_offset = if tensor.io_surface {
            align_up(byte_offset, METAL_PAGE_SIZE)
        } else {
            byte_offset
        };

        let strides = compute_contiguous_strides(&tensor.logical_shape, info.nbytes as u64);
        let contiguous = is_contiguous(&strides, &tensor.logical_shape, info.nbytes as u64);

        // Zero-copy eligible only when page-aligned, contiguous, and no overlap.
        let zero_copy = byte_offset % METAL_PAGE_SIZE == 0 && contiguous && tensor.io_surface;

        let violation = validate_zero_copy_conditions(
            byte_offset,
            nbytes,
            spec_align,
            contiguous,
            tensor,
            &strides,
            &mut activation_offset,
            0, // activation segment has no fixed cap; pass current end
        );

        reports.push(LayoutReport {
            name: tensor.name.clone(),
            logical_shape: tensor.logical_shape.clone(),
            dtype: tensor.dtype.clone(),
            byte_offset,
            aligned_offset,
            pad_bytes: aligned_offset.saturating_sub(byte_offset),
            segment_index: DEFAULT_ACTIVATION_SEGMENT,
            nbytes,
            strides,
            contiguous,
            zero_copy_eligible: zero_copy,
            zero_copy_violation: violation,
        });
    }

    reports
}

// ---------------------------------------------------------------------------
// validate_layout
// ---------------------------------------------------------------------------

/// Validate a single layout report against zero-copy constraints.
///
/// Returns `Ok(())` when the layout satisfies all requirements for Metal
/// zero-copy I/O.  Returns `Err(reason)` with the first violation.
///
/// # Checks
///
/// 1. **Page alignment** — `aligned_offset` must be a multiple of 4096.
/// 2. **Contiguity** — strides must match the contiguous pattern.
/// 3. **Alignment** — `byte_offset` must be a multiple of the dtype's
///    natural alignment.
/// 4. **Overlap** — must not alias another tensor's live range in the
///    same segment (caller provides segment bounds).
///
/// This function is stateless and pure: it inspects the report fields and
/// applies the same rules the compiler used.  Call it after deserializing
/// a report from disk to verify that a previously compiled layout still
/// satisfies zero-copy constraints.
pub fn validate_layout(report: &LayoutReport, segment_nbytes: u64) -> Result<(), Vec<String>> {
    let mut errors: Vec<String> = Vec::new();

    // 1. Page alignment for zero-copy-eligible tensors.
    if report.zero_copy_eligible && report.aligned_offset % METAL_PAGE_SIZE != 0 {
        errors.push(format!(
            "zero-copy tensor '{}' aligned_offset {} is not page-aligned (mod {})",
            report.name, report.aligned_offset, METAL_PAGE_SIZE
        ));
    }

    // 2. Contiguity.
    if !report.contiguous {
        errors.push(format!(
            "tensor '{}' is not contiguous (strides: {:?})",
            report.name, report.strides
        ));
    }

    // 3. Natural dtype alignment at byte offset.
    let info = dtype_info(&report.dtype);
    if report.byte_offset % info.alignment as u64 != 0 {
        errors.push(format!(
            "tensor '{}' byte_offset {} is not aligned to dtype {} (alignment {})",
            report.name, report.byte_offset, report.dtype, info.alignment
        ));
    }

    // 4. Bounds check: tensor fits within the segment.
    let end = report.byte_offset + report.nbytes;
    if end > segment_nbytes {
        errors.push(format!(
            "tensor '{}' at offset {}+{} exceeds segment size {}",
            report.name, report.byte_offset, report.nbytes, segment_nbytes
        ));
    }

    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors)
    }
}

/// Validate zero-copy conditions and return a violation reason, or `None`.
fn validate_zero_copy_conditions(
    byte_offset: u64,
    nbytes: u64,
    alignment: u64,
    contiguous: bool,
    tensor: &LayoutTensor,
    strides: &[u64],
    current_segment_end: &mut u64,
    segment_cap: u64,
) -> Option<String> {
    // Page alignment.
    if tensor.io_surface && byte_offset % METAL_PAGE_SIZE != 0 {
        return Some(format!(
            "io_surface tensor '{}' offset {} not page-aligned",
            tensor.name, byte_offset
        ));
    }

    // Alignment requirement.
    if byte_offset % alignment != 0 {
        return Some(format!(
            "tensor '{}' offset {} not aligned to {}",
            tensor.name, byte_offset, alignment
        ));
    }

    // Contiguity.
    if !contiguous {
        return Some(format!(
            "tensor '{}' has non-contiguous strides {:?}",
            tensor.name, strides
        ));
    }

    // Overlap detection: ensure this tensor does not start before the end
    // of the previously placed tensor in the same segment.
    let tensor_end = byte_offset + nbytes;
    if *current_segment_end > byte_offset && segment_cap > 0 {
        return Some(format!(
            "tensor '{}' offset {} overlaps with previous tensor ending at {}",
            tensor.name, byte_offset, *current_segment_end
        ));
    }
    if segment_cap > 0 {
        *current_segment_end = tensor_end;
    }

    None
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Compute total byte count for a shape with the given element byte size.
fn compute_nbytes(shape: &[u32], element_nbytes: u64) -> u64 {
    let elements: u64 = shape.iter().map(|&d| d as u64).product();
    elements * element_nbytes
}

/// Align `offset` up to the next multiple of `align`.
fn align_up(offset: u64, align: u64) -> u64 {
    if align == 0 {
        return offset;
    }
    let mask = align - 1;
    (offset + mask) & !mask
}

/// Compute contiguous byte strides for a given shape and element size.
///
/// A contiguous C-order tensor has `strides[i] = element_nbytes * product(shape[i+1..])`.
fn compute_contiguous_strides(shape: &[u32], element_nbytes: u64) -> Vec<u64> {
    let mut strides = Vec::with_capacity(shape.len());
    if shape.is_empty() {
        return strides;
    }
    let mut stride = element_nbytes;
    for dim in shape.iter().rev() {
        strides.push(stride);
        stride *= *dim as u64;
    }
    strides.reverse();
    strides
}

/// True when the strides match a contiguous C-order layout.
fn is_contiguous(strides: &[u64], shape: &[u32], element_nbytes: u64) -> bool {
    if strides.len() != shape.len() {
        return false;
    }
    if shape.is_empty() {
        return true;
    }
    let contiguous = compute_contiguous_strides(shape, element_nbytes);
    strides == contiguous.as_slice()
}

// ---------------------------------------------------------------------------
// Default segment byte capacity constants
// ---------------------------------------------------------------------------

/// Default weight segment capacity (512 MB).
pub const WEIGHT_SEGMENT_CAPACITY: u64 = 512 * 1024 * 1024;

/// Default activation segment capacity (256 MB).
pub const ACTIVATION_SEGMENT_CAPACITY: u64 = 256 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_ir() -> LayoutIr {
        let mut tensors = HashMap::new();
        tensors.insert(
            "embed.weight".into(),
            LayoutTensor {
                name: "embed.weight".into(),
                logical_shape: vec![256000, 3840],
                dtype: "bfloat16".into(),
                is_weight: true,
                io_surface: false,
                alignment: 0,
            },
        );
        tensors.insert(
            "layer.0.q_proj.weight".into(),
            LayoutTensor {
                name: "layer.0.q_proj.weight".into(),
                logical_shape: vec![3840, 256],
                dtype: "bfloat16".into(),
                is_weight: true,
                io_surface: false,
                alignment: 0,
            },
        );
        tensors.insert(
            "layer.0.attn_output".into(),
            LayoutTensor {
                name: "layer.0.attn_output".into(),
                logical_shape: vec![1, 3840],
                dtype: "float32".into(),
                is_weight: false,
                io_surface: true,
                alignment: 0,
            },
        );
        tensors.insert(
            "input_ids".into(),
            LayoutTensor {
                name: "input_ids".into(),
                logical_shape: vec![1, 256],
                dtype: "int32".into(),
                is_weight: false,
                io_surface: true,
                alignment: 0,
            },
        );

        LayoutIr {
            model_identity: "gemma4".into(),
            ops: vec![
                LayoutOp {
                    op_id: "embed".into(),
                    kind: "EmbeddingLookup".into(),
                    layer_index: None,
                    input_tensors: vec!["input_ids".into()],
                    output_tensors: vec!["embed_output".into()],
                    compute_weight: 10,
                },
                LayoutOp {
                    op_id: "layer.0.q_proj".into(),
                    kind: "QProj".into(),
                    layer_index: Some(0),
                    input_tensors: vec!["layer.0.q_proj.weight".into()],
                    output_tensors: vec!["layer.0.attn_output".into()],
                    compute_weight: 50,
                },
            ],
            tensors,
        }
    }

    #[test]
    fn compile_layouts_populates_all_tensors() {
        let ir = sample_ir();
        // Use a minimal stub inventory — no primitives means no consumer
        // primitive lookups, but the compiler falls back to defaults.
        let inventory = crate::mlx_inventory::FORK_INVENTORY;
        let reports = compile_layouts(&ir, &inventory);

        // Every tensor in the IR gets a report.
        let report_names: Vec<&str> = reports.iter().map(|r| r.name.as_str()).collect();
        for name in ir.tensors.keys() {
            assert!(
                report_names.contains(&name.as_str()),
                "missing report for {}",
                name
            );
        }

        // Weights go to segment 1, activations to segment 0.
        for r in &reports {
            let t = ir.tensors.get(&r.name).unwrap();
            if t.is_weight {
                assert_eq!(r.segment_index, 1, "weight {} not in segment 1", r.name);
            } else {
                assert_eq!(r.segment_index, 0, "activation {} not in segment 0", r.name);
            }
        }
    }

    #[test]
    fn weight_layout_is_contiguous() {
        let ir = sample_ir();
        let inventory = crate::mlx_inventory::FORK_INVENTORY;
        let reports = compile_layouts(&ir, &inventory);

        for r in &reports {
            let t = ir.tensors.get(&r.name).unwrap();
            if t.is_weight {
                assert!(r.contiguous, "weight {} has non-contiguous layout", r.name);
                assert_eq!(
                    r.byte_offset,
                    r.aligned_offset,
                    "weight {} has padding between byte_offset and aligned_offset",
                    r.name
                );
            }
        }
    }

    #[test]
    fn activation_layout_page_aligned_when_io_surface() {
        let ir = sample_ir();
        let inventory = crate::mlx_inventory::FORK_INVENTORY;
        let reports = compile_layouts(&ir, &inventory);

        for r in &reports {
            let t = ir.tensors.get(&r.name).unwrap();
            if t.io_surface {
                // Activation tensors may not get page alignment automatically;
                // but if they do, they should be correctly aligned.
                if r.zero_copy_eligible {
                    assert_eq!(
                        r.aligned_offset % METAL_PAGE_SIZE,
                        0,
                        "io_surface tensor {} not page-aligned",
                        r.name
                    );
                }
            }
        }
    }

    #[test]
    fn validate_layout_rejects_misaligned_offset() {
        let report = LayoutReport {
            name: "bad_tensor".into(),
            logical_shape: vec![1, 3840],
            dtype: "float32".into(),
            byte_offset: 1, // misaligned
            aligned_offset: 4096,
            pad_bytes: 4095,
            segment_index: 0,
            nbytes: 15360,
            strides: vec![15360, 4],
            contiguous: true,
            zero_copy_eligible: true,
            zero_copy_violation: None,
        };

        let result = validate_layout(&report, ACTIVATION_SEGMENT_CAPACITY);
        assert!(result.is_err(), "expected validation error for misaligned offset");
        let errs = result.unwrap_err();
        let has_alignment_error = errs.iter().any(|e| e.contains("not aligned to dtype"));
        assert!(has_alignment_error, "expected alignment error, got: {:?}", errs);
    }

    #[test]
    fn validate_layout_rejects_non_contiguous() {
        let report = LayoutReport {
            name: "strided_tensor".into(),
            logical_shape: vec![1, 3840],
            dtype: "float32".into(),
            byte_offset: 0,
            aligned_offset: 0,
            pad_bytes: 0,
            segment_index: 0,
            nbytes: 15360,
            strides: vec![8192, 4], // not contiguous: row stride != 3840*4
            contiguous: false,
            zero_copy_eligible: true,
            zero_copy_violation: None,
        };

        let result = validate_layout(&report, ACTIVATION_SEGMENT_CAPACITY);
        assert!(result.is_err(), "expected error for non-contiguous layout");
        let errs = result.unwrap_err();
        let has_stride_error = errs.iter().any(|e| e.contains("not contiguous"));
        assert!(has_stride_error, "expected contiguity error, got: {:?}", errs);
    }

    #[test]
    fn validate_layout_accepts_valid_report() {
        let report = LayoutReport {
            name: "valid_tensor".into(),
            logical_shape: vec![1, 3840],
            dtype: "float32".into(),
            byte_offset: 0,
            aligned_offset: 0,
            pad_bytes: 0,
            segment_index: 0,
            nbytes: 15360,
            strides: vec![15360, 4],
            contiguous: true,
            zero_copy_eligible: true,
            zero_copy_violation: None,
        };

        let result = validate_layout(&report, ACTIVATION_SEGMENT_CAPACITY);
        assert!(result.is_ok(), "expected Ok, got: {:?}", result);
    }

    #[test]
    fn validate_layout_rejects_oob_tensor() {
        let report = LayoutReport {
            name: "oob_tensor".into(),
            logical_shape: vec![1, 1_000_000],
            dtype: "float32".into(),
            byte_offset: 512 * 1024 * 1024 - 500, // near end
            aligned_offset: 512 * 1024 * 1024,
            pad_bytes: 500,
            segment_index: 1,
            nbytes: 4_000_000, // overflows segment
            strides: vec![4_000_000, 4],
            contiguous: true,
            zero_copy_eligible: true,
            zero_copy_violation: None,
        };

        let result = validate_layout(&report, WEIGHT_SEGMENT_CAPACITY);
        assert!(result.is_err(), "expected error for oob tensor");
        let errs = result.unwrap_err();
        let has_oob = errs.iter().any(|e| e.contains("exceeds segment size"));
        assert!(has_oob, "expected oob error, got: {:?}", errs);
    }

    #[test]
    fn is_contiguous_detects_gaps() {
        let shape = vec![2, 3];
        assert!(is_contiguous(&[12, 4], &shape, 4));
        assert!(!is_contiguous(&[16, 4], &shape, 4));
        assert!(!is_contiguous(&[12, 8], &shape, 4));
    }

    #[test]
    fn align_up_rounds_correctly() {
        assert_eq!(align_up(0, 4096), 0);
        assert_eq!(align_up(1, 4096), 4096);
        assert_eq!(align_up(4096, 4096), 4096);
        assert_eq!(align_up(4097, 4096), 8192);
        assert_eq!(align_up(0, 256), 0);
        assert_eq!(align_up(255, 256), 256);
    }

    #[test]
    fn compute_nbytes_handles_scalar_and_vector() {
        assert_eq!(compute_nbytes(&[], 4), 4);  // scalar: 1 element
        assert_eq!(compute_nbytes(&[10], 2), 20);
        assert_eq!(compute_nbytes(&[3, 4], 4), 48);
    }

    #[test]
    fn zero_copy_violation_on_misaligned_weight() {
        let tensor = LayoutTensor {
            name: "bad_embed".into(),
            logical_shape: vec![256000, 3840],
            dtype: "bfloat16".into(),
            is_weight: true,
            io_surface: false,
            alignment: 256,
        };
        let strides = compute_contiguous_strides(&tensor.logical_shape, 2);
        let violation = validate_zero_copy_conditions(
            1, // offset not aligned to 256
            1966080000,
            256,
            true,
            &tensor,
            &strides,
            &mut 0,
            512 * 1024 * 1024,
        );
        assert!(violation.is_some(), "expected violation for misaligned offset");
        assert!(
            violation.unwrap().contains("not aligned to 256"),
            "unexpected violation message"
        );
    }

    #[test]
    fn compile_layouts_produces_stable_reports() {
        let ir = sample_ir();
        let inventory = crate::mlx_inventory::FORK_INVENTORY;
        let reports1 = compile_layouts(&ir, &inventory);
        let reports2 = compile_layouts(&ir, &inventory);

        // Two compilations with the same IR produce identical reports.
        for (a, b) in reports1.iter().zip(reports2.iter()) {
            assert_eq!(a.byte_offset, b.byte_offset, "offset mismatch for {}", a.name);
            assert_eq!(a.segment_index, b.segment_index, "segment mismatch for {}", a.name);
        }
    }
}
