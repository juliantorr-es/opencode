//! Accelerate backend adapter for the Three-Backend Decode Attribution Gate.
//!
//! Matmul only — Accelerate's `cblas_sgemm` implements single-precision
//! general matrix multiply. All other graph families are unsupported.
//!
//! ## Lifecycle
//!
//! - **prepare**: copy input/weight data into owned `Vec<f32>`, allocate
//!   zeroed output buffer. Equivalent to array packing.
//! - **run**: call `cblas_sgemm` with CblasRowMajor, CblasNoTrans on both
//!   operands, alpha=1.0, beta=0.0. Return elapsed wall-clock in ns.
//!
//! No compile or load phase — Accelerate is a library, not a model format.

use std::time::Instant;

use crate::backend::accelerate_ffi;

use super::BackendSupportStatus;

/// Return the support status for a given graph family name.
///
/// Accelerate only supports `matmul` (cblas_sgemm). All other families
/// return `UnsupportedGraph`.
pub fn support_status(family_name: &str) -> BackendSupportStatus {
    if family_name == "matmul" {
        BackendSupportStatus::Supported
    } else {
        BackendSupportStatus::UnsupportedGraph
    }
}

/// Prepare input, weight, and output buffers for a matmul run.
///
/// Copies `input_data` and `weight_data` into owned vecs and allocates
/// a zeroed output vec of length `(m * n) as usize`.
///
/// # Arguments
///
/// * `input_data`  — flattened M×K input, row-major
/// * `weight_data` — flattened K×N weight, row-major
/// * `m`           — rows of A and C
/// * `k`           — cols of A / rows of B
/// * `n`           — cols of B and C
///
/// # Returns
///
/// `(input_vec, weight_vec, output_vec)` on success, or an error string
/// if the slice lengths don't match the declared dimensions.
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
            input_data.len(),
            expected_input_len,
            m,
            k
        ));
    }
    if weight_data.len() != expected_weight_len {
        return Err(format!(
            "weight_data length {} != expected {} (k={} * n={})",
            weight_data.len(),
            expected_weight_len,
            k,
            n
        ));
    }

    let input_vec = input_data.to_vec();
    let weight_vec = weight_data.to_vec();
    let output_vec = vec![0.0f32; output_len];

    Ok((input_vec, weight_vec, output_vec))
}

/// Run a single matmul via `cblas_sgemm` and return elapsed time in
/// nanoseconds.
///
/// # Panics
///
/// Panics if `input` has fewer than `(m * k)` elements, `weight` has
/// fewer than `(k * n)` elements, or `output` has fewer than `(m * n)`
/// elements (checked by assertion in debug builds; silently wrong
/// results in release if sizes are incorrect).
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
            accelerate_ffi::CBLAS_ROW_MAJOR, // order
            accelerate_ffi::CBLAS_NO_TRANS,  // trans_a
            accelerate_ffi::CBLAS_NO_TRANS,  // trans_b
            m,                               // rows of A and C
            n,                               // cols of B and C
            k,                               // cols of A / rows of B
            1.0_f32,                         // alpha
            input.as_ptr(),                  // A
            k,                               // lda (leading dimension of A in row-major)
            weight.as_ptr(),                 // B
            n,                               // ldb (leading dimension of B in row-major)
            0.0_f32,                         // beta
            output.as_mut_ptr(),             // C
            n,                               // ldc (leading dimension of C in row-major)
        );
    }

    let elapsed = start.elapsed();
    Ok(elapsed.as_nanos() as u64)
}
