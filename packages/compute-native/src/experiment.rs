//! F32 matmul canonical operation contract (E0008-F32-MATMUL-3WAY-v1).
//!
//! Every tested shape receives a descriptor that is SHA-256 hashed.
//! All backend receipts and correctness checkpoints reference the
//! contract digest.

use crate::backend::routing::*;
use crate::backend::DType;

/// Canonical F32 matmul operation contract.
#[derive(Debug, Clone)]
pub struct F32MatmulContract {
    pub operation_id: OperationId,
    pub schema_version: u32,
    pub m: u32,
    pub n: u32,
    pub k: u32,
    pub transpose_a: bool,
    pub transpose_b: bool,
    pub input_a_dtype: DType,
    pub input_b_dtype: DType,
    pub output_dtype: DType,
    pub input_a_layout: PhysicalLayout,
    pub input_b_layout: PhysicalLayout,
    pub output_layout: PhysicalLayout,
}

impl F32MatmulContract {
    pub fn new(
        operation_id: OperationId,
        m: u32, n: u32, k: u32,
    ) -> Self {
        Self {
            operation_id,
            schema_version: 1,
            m, n, k,
            transpose_a: false,
            transpose_b: false,
            input_a_dtype: DType::F32,
            input_b_dtype: DType::F32,
            output_dtype: DType::F32,
            input_a_layout: PhysicalLayout::RowMajor,
            input_b_layout: PhysicalLayout::RowMajor,
            output_layout: PhysicalLayout::RowMajor,
        }
    }

    /// SHA-256 digest of the canonical serialized contract.
    pub fn digest(&self) -> EvidenceDigest {
        use sha2::{Sha256, Digest};
        let mut buf = Vec::new();
        buf.push(self.schema_version as u8);
        buf.extend_from_slice(&self.m.to_le_bytes());
        buf.extend_from_slice(&self.n.to_le_bytes());
        buf.extend_from_slice(&self.k.to_le_bytes());
        buf.push(self.transpose_a as u8);
        buf.push(self.transpose_b as u8);
        // dtype discriminant: F32=0
        buf.push(0u8);
        // layout discriminant: RowMajor=0
        buf.push(0u8);
        EvidenceDigest(format!("{:x}", Sha256::digest(&buf)))
    }
}

/// Small conformance matrix — complete F64 scalar verification.
pub fn conformance_shapes() -> Vec<(u32, u32, u32)> {
    vec![
        (2, 3, 4),
        (4, 4, 4),
        (3, 5, 2),
        (1, 7, 9),
    ]
}

/// Model-representative shape matrix.
/// For each distinct K/N projection signature, test M=1 (decode),
/// M=4 (short prefill), M=16 (transition to compute-intensive).
///
/// These are placeholder values — actual signatures must be extracted
/// from the frozen ComputeImage manifest by the experiment compiler.
pub fn representative_shapes() -> Vec<(u32, u32, u32)> {
    // Example: a single projection with K=3840, N=4096
    // Real shapes come from the ComputeImage manifest.
    let projections = vec![(3840u32, 4096u32)];
    let m_classes = vec![1u32, 4u32, 16u32];

    let mut shapes = Vec::new();
    for &(k, n) in &projections {
        for &m in &m_classes {
            shapes.push((m, k, n));
        }
    }
    shapes
}

/// Correctness tolerance artifact for F32 matmul.
#[derive(Debug, Clone)]
pub struct F32MatmulTolerance {
    pub atol: f64,
    pub rtol: f64,
    pub near_zero_threshold: f64,
    pub min_cosine: f64,
    pub min_relative_error: f64,
}

impl Default for F32MatmulTolerance {
    fn default() -> Self {
        Self {
            atol: 1e-3,
            rtol: 1e-3,
            near_zero_threshold: 1e-6,
            min_cosine: 0.999999,
            min_relative_error: 5e-4,
        }
    }
}

/// Correctness result for one backend trial.
#[derive(Debug, Clone)]
pub struct CorrectnessResult {
    pub output_sha256: String,
    pub element_count: usize,
    pub finite_count: usize,
    pub nan_count: usize,
    pub inf_count: usize,
    pub max_abs_error: f64,
    pub mean_abs_error: f64,
    pub max_rel_error: f64,
    pub cosine_similarity: f64,
    pub passed: bool,
}
