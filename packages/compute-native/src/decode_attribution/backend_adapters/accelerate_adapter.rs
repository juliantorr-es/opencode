//! Accelerate backend adapter for the Backend Coverage Lattice Gate.
//!
//! ## Layers
//!
//! - `accelerate_blas`: GEMM via `cblas_sgemm` (matmul). Native.
//! - `accelerate_vector`: Elementwise ops via vDSP (add, multiply). Primitive validation
//!   only — NOT wired into the graph lattice, since no standalone add/multiply graph
//!   families exist in the 8-family catalog.
//!
//! Only `matmul` and `identity_passthrough` produce lattice rows. All other families
//! are `UnsupportedGraph`.

use std::time::Instant;

use crate::backend::accelerate_ffi;

use super::BackendSupportTier;

// ── Support classification ─────────────────────────────────────────────────

/// Return the support tier for a given graph family name.
///
/// - `matmul` → `SupportedNative` (cblas_sgemm)
/// - `identity_passthrough` | `identity` → `SupportedNative` (trivial memcpy)
/// - All other families → `UnsupportedGraph`
pub fn support_tier(family_name: &str) -> BackendSupportTier {
    match family_name {
        "matmul" | "identity_passthrough" | "identity" => BackendSupportTier::SupportedNative,
        _ => BackendSupportTier::UnsupportedGraph,
    }
}

// ── accelerate_blas: GEMM ──────────────────────────────────────────────────

/// Prepare input, weight, and output buffers for a matmul run.
pub fn prepare_matmul(
    input_data: &[f32],
    weight_data: &[f32],
    m: i32,
    k: i32,
    n: i32,
) -> Result<(Vec<f32>, Vec<f32>, Vec<f32>), String> {
    let expected_input_len = (m as usize).checked_mul(k as usize).ok_or_else(|| {
        format!("overflow computing input length: m={} * k={}", m, k)
    })?;
    let expected_weight_len = (k as usize).checked_mul(n as usize).ok_or_else(|| {
        format!("overflow computing weight length: k={} * n={}", k, n)
    })?;
    let output_len = (m as usize).checked_mul(n as usize).ok_or_else(|| {
        format!("overflow computing output length: m={} * n={}", m, n)
    })?;

    if input_data.len() != expected_input_len {
        return Err(format!(
            "input_data length {} != expected {} (m={} * k={})",
            input_data.len(), expected_input_len, m, k
        ));
    }
    if weight_data.len() != expected_weight_len {
        return Err(format!(
            "weight_data length {} != expected {} (k={} * n={})",
            weight_data.len(), expected_weight_len, k, n
        ));
    }

    let input_vec = input_data.to_vec();
    let weight_vec = weight_data.to_vec();
    let output_vec = vec![0.0f32; output_len];

    Ok((input_vec, weight_vec, output_vec))
}

/// Run a single matmul via `cblas_sgemm` and return elapsed time in nanoseconds.
pub fn run_matmul(
    input: &[f32],
    weight: &[f32],
    output: &mut [f32],
    m: i32,
    k: i32,
    n: i32,
) -> Result<u64, String> {
    let start = Instant::now();

    unsafe {
        accelerate_ffi::cblas_sgemm(
            accelerate_ffi::CBLAS_ROW_MAJOR,
            accelerate_ffi::CBLAS_NO_TRANS,
            accelerate_ffi::CBLAS_NO_TRANS,
            m,
            n,
            k,
            1.0_f32,
            input.as_ptr(),
            k,
            weight.as_ptr(),
            n,
            0.0_f32,
            output.as_mut_ptr(),
            n,
        );
    }

    let elapsed = start.elapsed();
    Ok(elapsed.as_nanos() as u64)
}

// ── accelerate_vector: vDSP primitives (validation tests only) ────────────

/// Raw FFI for vDSP vector operations.
#[link(name = "Accelerate", kind = "framework")]
extern "C" {
    fn vDSP_vadd(
        a: *const f32, a_stride: isize,
        b: *const f32, b_stride: isize,
        result: *mut f32, r_stride: isize,
        n: usize,
    );
    fn vDSP_vmul(
        a: *const f32, a_stride: isize,
        b: *const f32, b_stride: isize,
        result: *mut f32, r_stride: isize,
        n: usize,
    );
}

/// Vector add via `vDSP_vadd`. Primitive validation — NOT a lattice row.
pub fn vector_add(a: &[f32], b: &[f32]) -> Result<Vec<f32>, String> {
    if a.len() != b.len() {
        return Err(format!("vector_add: length mismatch {} != {}", a.len(), b.len()));
    }
    let mut result = vec![0.0f32; a.len()];
    unsafe {
        vDSP_vadd(a.as_ptr(), 1, b.as_ptr(), 1, result.as_mut_ptr(), 1, a.len());
    }
    Ok(result)
}

/// Vector multiply via `vDSP_vmul`. Primitive validation — NOT a lattice row.
pub fn vector_mul(a: &[f32], b: &[f32]) -> Result<Vec<f32>, String> {
    if a.len() != b.len() {
        return Err(format!("vector_mul: length mismatch {} != {}", a.len(), b.len()));
    }
    let mut result = vec![0.0f32; a.len()];
    unsafe {
        vDSP_vmul(a.as_ptr(), 1, b.as_ptr(), 1, result.as_mut_ptr(), 1, a.len());
    }
    Ok(result)
}

// ── Legacy API (backward compat) ──────────────────────────────────────────

pub use support_tier as support_status;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vdsp_add_known_values() {
        let a = vec![1.0, 2.0, 3.0];
        let b = vec![4.0, 5.0, 6.0];
        let result = vector_add(&a, &b).unwrap();
        assert_eq!(result, vec![5.0, 7.0, 9.0]);
    }

    #[test]
    fn vdsp_mul_known_values() {
        let a = vec![2.0, 3.0, 4.0];
        let b = vec![5.0, 6.0, 7.0];
        let result = vector_mul(&a, &b).unwrap();
        assert_eq!(result, vec![10.0, 18.0, 28.0]);
    }

    #[test]
    fn vdsp_add_mismatched_lengths() {
        let a = vec![1.0, 2.0];
        let b = vec![3.0];
        assert!(vector_add(&a, &b).is_err());
    }

    #[test]
    fn support_tier_matmul() {
        assert_eq!(support_tier("matmul"), BackendSupportTier::SupportedNative);
    }

    #[test]
    fn support_tier_identity() {
        assert_eq!(support_tier("identity_passthrough"), BackendSupportTier::SupportedNative);
        assert_eq!(support_tier("identity"), BackendSupportTier::SupportedNative);
    }

    #[test]
    fn support_tier_unsupported() {
        assert_eq!(support_tier("softmax_tail"), BackendSupportTier::UnsupportedGraph);
        assert_eq!(support_tier("chain_matmul_add_silu"), BackendSupportTier::UnsupportedGraph);
        assert_eq!(support_tier("branch_rejoin"), BackendSupportTier::UnsupportedGraph);
    }
}
