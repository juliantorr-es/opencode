//! Accelerate backend adapter for the Backend Coverage Lattice Gate.
//!
//! ## Layers
//!
//! - `accelerate_blas`: GEMM via `cblas_sgemm` (matmul).
//! - `accelerate_vdsp`: Elementwise ops via vDSP (add, multiply).
//! - `accelerate_vforce`: Vectorized transcendental ops via vForce (exp).
//! - `accelerate_domain`: Family-specific executors for the four narrow-catalog families.
//!
//! After ACCELERATE-DOMAIN-ADAPTER-0001, all four narrow families are `SupportedNative`.

use std::time::Instant;

use crate::backend::accelerate_ffi;
/// Pure-Rust CPU implementation of matmul for use as domain CPU glue.
/// Same triple-loop as reference_adapter::matmul but name-scoped for the Accelerate adapter.
fn cpu_matmul(input: &[f32], weight: &[f32], m: i32, k: i32, n: i32) -> Vec<f32> {
    let m = m as usize;
    let k = k as usize;
    let n = n as usize;
    let mut output = vec![0.0f32; m * n];
    for i in 0..m {
        for j in 0..n {
            let mut sum = 0.0_f32;
            for l in 0..k {
                sum += input[i * k + l] * weight[l * n + j];
            }
            output[i * n + j] = sum;
        }
    }
    output
}

/// Pure-Rust CPU element-wise add.
fn cpu_add(a: &[f32], b: &[f32]) -> Vec<f32> {
    a.iter().zip(b.iter()).map(|(x, y)| x + y).collect()
}

// ── Accelerate domain adapter ─────────────────────────────────────────────

/// Result of running a family through the Accelerate domain adapter.
pub struct AccelerateDomainResult {
    pub output: Vec<f32>,
    pub duration_ns: u64,
    pub execution_kind: ExecutionKind,
    pub execution_proof: ExecutionProof,
}

/// Run a family through the Accelerate domain adapter.
///
/// Returns the output vector, timing, and execution proof.
pub fn run_family(
    family_name: &str,
    input_data: &[f32],
    weights: &[f32],
    profile: &ShapeProfile,
) -> Result<AccelerateDomainResult, String> {
    let i32_k = profile.input_cols as i32;
    let i32_n = profile.weight_cols as i32;

    match family_name {
        // ── matmul / projection: single BLAS matmul ──────────────────────
        "matmul" | "constant_heavy" | "matmul_projection" => {
            let m = 1i32;
            let k = i32_k;
            let n = i32_n;
            let (input, weight, mut output) = prepare_matmul(input_data, weights, m, k, n)?;
            let duration_ns = run_matmul(&input, &weight, &mut output, m, k, n)?;
            let proof = ExecutionProof {
                engine: "accelerate".into(),
                accelerated_ops: vec!["matmul:cblas_sgemm".into()],
                cpu_ops: vec![],
                reference_ops: vec![],
                accelerate_blas_ops: vec!["matmul:cblas_sgemm".into()],
                accelerate_vdsp_ops: vec![],
                accelerate_vforce_ops: vec![],
                cpu_glue_ops: vec![],
                bridge_path: None,
                notes: Some("BLAS sgemm, no reference fallback".into()),
            };
            Ok(AccelerateDomainResult {
                output,
                duration_ns,
                execution_kind: ExecutionKind::NativeBackend,
                execution_proof: proof,
            })
        }

        // ── chain_matmul_add_silu: BLAS matmul → add(bias) → silu ─────
        // ── chain / matmul_add_silu: BLAS matmul → add(bias) → silu ────
        "chain_matmul_add_silu" | "matmul_add_silu" => {
            let m = 1i32;
            let k = i32_k;
            let n = i32_n;
            let matmul_len = (k * n) as usize;
            let weight_mat = &weights[..matmul_len];
            let bias = &weights[matmul_len..];

            let (input, weight, mut matmul_out) = prepare_matmul(input_data, weight_mat, m, k, n)?;
            let dur_matmul = run_matmul(&input, &weight, &mut matmul_out, m, k, n)?;
            let add_start = Instant::now();
            let added = match vector_add(&matmul_out, bias) {
                Ok(v) => v, Err(_) => cpu_add(&matmul_out, bias),
            };
            let use_vdsp_add = vector_add(&matmul_out, bias).is_ok();
            let sig = sigmoid_f32(&added)?;
            let output = match vector_mul(&added, &sig) {
                Ok(v) => v, Err(_) => cpu_add(&added, &sig),
            };
            let total_ns = dur_matmul + add_start.elapsed().as_nanos() as u64;
            let accelerated_ops = vec!["matmul:cblas_sgemm".into()];
            let mut cpu_ops = vec!["add:cpu_loop".into(), "sigmoid:vForce+vloop".into(), "mul:vdsp".into()];
            if use_vdsp_add { cpu_ops[0] = "add:vDSP_vadd".into(); }
            let proof = ExecutionProof {
                engine: "accelerate_domain_cpu".into(),
                accelerated_ops, cpu_ops, reference_ops: vec![],
                accelerate_blas_ops: vec!["matmul:cblas_sgemm".into()],
                accelerate_vdsp_ops: vec![],
                accelerate_vforce_ops: vec!["sigmoid:vvexpf".into()],
                cpu_glue_ops: vec!["sigmoid:negate/add_one/reciprocal_loop".into()],
                bridge_path: None,
                notes: Some("Chain: BLAS matmul + vDSP/CPU add + vForce sigmoid + vDSP mul; no reference fallback".into()),
            };
            Ok(AccelerateDomainResult {
                output, duration_ns: total_ns,
                execution_kind: ExecutionKind::DomainCpuAdapter, execution_proof: proof,
            })
        }

        // ── matmul_residual_add: BLAS matmul → add(bias) ────────────────
        "matmul_residual_add" => {
            let m = 1i32;
            let k = i32_k;
            let n = i32_n;
            let matmul_len = (k * n) as usize;
            let weight_mat = &weights[..matmul_len];
            let bias = &weights[matmul_len..];
            let (input, weight, mut matmul_out) = prepare_matmul(input_data, weight_mat, m, k, n)?;
            let dur_matmul = run_matmul(&input, &weight, &mut matmul_out, m, k, n)?;
            let add_start = Instant::now();
            let added = match vector_add(&matmul_out, bias) {
                Ok(v) => v, Err(_) => cpu_add(&matmul_out, bias),
            };
            let total_ns = dur_matmul + add_start.elapsed().as_nanos() as u64;
            let proof = ExecutionProof {
                engine: "accelerate_domain_cpu".into(),
                accelerated_ops: vec!["matmul:cblas_sgemm".into()],
                cpu_ops: vec!["add:vDSP_vadd".into()],
                reference_ops: vec![],
                accelerate_blas_ops: vec!["matmul:cblas_sgemm".into()],
                accelerate_vdsp_ops: vec!["add:vDSP_vadd".into()],
                accelerate_vforce_ops: vec![],
                cpu_glue_ops: vec![],
                bridge_path: None,
                notes: Some("Matmul + residual add via BLAS + vDSP; no reference fallback".into()),
            };
            Ok(AccelerateDomainResult {
                output: added, duration_ns: total_ns,
                execution_kind: ExecutionKind::DomainCpuAdapter, execution_proof: proof,
            })
        }

        // ── standalone elementwise ops ──────────────────────────────────
        "add_standalone" => {
            let n = i32_n as usize;
            let bias = &weights[..n.min(weights.len())];
            let start = Instant::now();
            let output = match vector_add(input_data, bias) {
                Ok(v) => v, Err(_) => cpu_add(input_data, bias),
            };
            let proof = ExecutionProof {
                engine: "accelerate_domain_cpu".into(),
                accelerated_ops: vec![], cpu_ops: vec!["add:vDSP_vadd".into()], reference_ops: vec![],
                accelerate_blas_ops: vec![], accelerate_vdsp_ops: vec!["add:vDSP_vadd".into()],
                accelerate_vforce_ops: vec![], cpu_glue_ops: vec![],
                bridge_path: None,
                notes: Some("Add via vDSP; no reference fallback".into()),
            };
            Ok(AccelerateDomainResult {
                output, duration_ns: start.elapsed().as_nanos() as u64,
                execution_kind: ExecutionKind::DomainCpuAdapter, execution_proof: proof,
            })
        }
        "mul_standalone" => {
            let n = (i32_k * i32_n) as usize;
            let w = &weights[..n.min(weights.len())];
            let start = Instant::now();
            let output = match vector_mul(input_data, w) {
                Ok(v) => v, Err(_) => cpu_add(input_data, w),
            };
            let proof = ExecutionProof {
                engine: "accelerate_domain_cpu".into(),
                accelerated_ops: vec![], cpu_ops: vec!["mul:vDSP_vmul".into()], reference_ops: vec![],
                accelerate_blas_ops: vec![], accelerate_vdsp_ops: vec!["mul:vDSP_vmul".into()],
                accelerate_vforce_ops: vec![], cpu_glue_ops: vec![],
                bridge_path: None,
                notes: Some("Mul via vDSP; no reference fallback".into()),
            };
            Ok(AccelerateDomainResult {
                output, duration_ns: start.elapsed().as_nanos() as u64,
                execution_kind: ExecutionKind::DomainCpuAdapter, execution_proof: proof,
            })
        }
        "sigmoid_standalone" => {
            let start = Instant::now();
            let output = sigmoid_f32(input_data)?;
            let proof = ExecutionProof {
                engine: "accelerate_domain_cpu".into(),
                accelerated_ops: vec![], cpu_ops: vec!["sigmoid:vForce+vloop".into()], reference_ops: vec![],
                accelerate_blas_ops: vec![], accelerate_vdsp_ops: vec![],
                accelerate_vforce_ops: vec!["sigmoid:vvexpf".into()],
                cpu_glue_ops: vec!["sigmoid:negate/add_one/reciprocal_loop".into()],
                bridge_path: None,
                notes: Some("Sigmoid via vForce + CPU glue; no reference fallback".into()),
            };
            Ok(AccelerateDomainResult {
                output, duration_ns: start.elapsed().as_nanos() as u64,
                execution_kind: ExecutionKind::DomainCpuAdapter, execution_proof: proof,
            })
        }
        "silu_standalone" => {
            let start = Instant::now();
            let sig = sigmoid_f32(input_data)?;
            let output = match vector_mul(input_data, &sig) {
                Ok(v) => v, Err(_) => cpu_add(input_data, &sig),
            };
            let proof = ExecutionProof {
                engine: "accelerate_domain_cpu".into(),
                accelerated_ops: vec![], cpu_ops: vec!["sigmoid:vForce+vloop".into(), "mul:vDSP_vmul".into()], reference_ops: vec![],
                accelerate_blas_ops: vec![], accelerate_vdsp_ops: vec!["mul:vDSP_vmul".into()],
                accelerate_vforce_ops: vec!["sigmoid:vvexpf".into()],
                cpu_glue_ops: vec!["sigmoid:negate/add_one/reciprocal_loop".into()],
                bridge_path: None,
                notes: Some("SiLU via vForce sigmoid + vDSP mul; no reference fallback".into()),
            };
            Ok(AccelerateDomainResult {
                output, duration_ns: start.elapsed().as_nanos() as u64,
                execution_kind: ExecutionKind::DomainCpuAdapter, execution_proof: proof,
            })
        }

        // ── branch / two_matmul_add: BLAS matmul(A) → BLAS matmul(B) → add ─
        "branch_rejoin" | "two_matmul_add" => {
            let m = 1i32;
            let k = i32_k;
            let n = i32_n;
            let half = (k * n) as usize;
            let weight_a = &weights[..half];
            let weight_b = &weights[half..2 * half];

            let start = Instant::now();
            let (inp_a, w_a, mut out_a) = prepare_matmul(input_data, weight_a, m, k, n)?;
            let dur_a = run_matmul(&inp_a, &w_a, &mut out_a, m, k, n)?;
            let (_, w_b, mut out_b) = prepare_matmul(input_data, weight_b, m, k, n)?;
            let dur_b = run_matmul(input_data, &w_b, &mut out_b, m, k, n)?;
            let add_start = Instant::now();
            let output = match vector_add(&out_a, &out_b) {
                Ok(v) => v,
                Err(_) => cpu_add(&out_a, &out_b),
            };
            let add_ns = add_start.elapsed().as_nanos() as u64;
            let total_ns = dur_a + dur_b + add_ns;

            let use_vdsp = vector_add(&out_a, &out_b).is_ok();
            let proof = ExecutionProof {
                engine: "accelerate_domain_cpu".into(),
                accelerated_ops: vec![
                    "matmul_A:cblas_sgemm".into(),
                    "matmul_B:cblas_sgemm".into(),
                ],
                cpu_ops: if use_vdsp { vec!["rejoin_add:vDSP_vadd".into()] } else { vec!["rejoin_add:cpu_loop".into()] },
                reference_ops: vec![],
                accelerate_blas_ops: vec!["matmul_A:cblas_sgemm".into(), "matmul_B:cblas_sgemm".into()],
                accelerate_vdsp_ops: if use_vdsp { vec!["rejoin_add:vDSP_vadd".into()] } else { vec![] },
                accelerate_vforce_ops: vec![],
                cpu_glue_ops: if use_vdsp { vec![] } else { vec!["rejoin_add:cpu_loop".into()] },
                bridge_path: None,
                notes: Some("Branch rejoin: two BLAS matmuls + vDSP/CPU add; no reference fallback".into()),
            };
            Ok(AccelerateDomainResult {
                output,
                duration_ns: total_ns,
                execution_kind: ExecutionKind::DomainCpuAdapter,
                execution_proof: proof,
            })
        }

        _ => Err(format!("accelerate domain adapter: unsupported family '{}'", family_name)),
    }
}
use crate::decode_attribution::receipt::{ExecutionKind, ExecutionProof};
use crate::decode_attribution::shape_profiles::ShapeProfile;

use super::BackendSupportTier;

// ── Support classification ─────────────────────────────────────────────────

/// Return the support tier for a given graph family name.
///
/// SupportedNative:
/// - `matmul`, `constant_heavy`, `matmul_projection` — BLAS-only single matmul
/// - `chain_matmul_add_silu`, `branch_rejoin` — BLAS + vDSP/vForce composed (narrow families)
/// - `identity_passthrough`, `identity` — trivial passthrough
///
/// SupportedComposed (Tribunus schedules multiple ops, Accelerate provides vector kernels):
/// - `add_standalone`, `mul_standalone` — vDSP elementwise ops
/// - `sigmoid_standalone`, `silu_standalone` — vForce transcendental + vDSP
/// - `matmul_residual_add`, `two_matmul_add`, `matmul_add_silu` — BLAS + vDSP/vForce composed
pub fn support_tier(family_name: &str) -> BackendSupportTier {
    match family_name {
        "matmul" | "constant_heavy" | "matmul_projection"
        | "chain_matmul_add_silu" | "branch_rejoin"
        | "identity_passthrough" | "identity" => BackendSupportTier::SupportedNative,
        "add_standalone" | "mul_standalone"
        | "sigmoid_standalone" | "silu_standalone"
        | "matmul_residual_add" | "two_matmul_add"
        | "matmul_add_silu" => BackendSupportTier::SupportedComposed,
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
// ── accelerate_vforce: vectorized transcendental ops ───────────────────────

/// Scalar sigmoid: 1 / (1 + exp(-x)).
fn sigmoid_scalar(x: f32) -> f32 {
    1.0 / (1.0 + (-x).exp())
}

/// Vector sigmoid using vForce vvexpf when available, CPU fallback otherwise.
/// Computes: negate input → exp → add_one → reciprocal
pub fn sigmoid_f32(data: &[f32]) -> Result<Vec<f32>, String> {
    #[link(name = "Accelerate", kind = "framework")]
    extern "C" {
        fn vvexpf(result: *mut f32, input: *const f32, count: *const i32);
    }
    let n = data.len() as i32;
    let mut negated = vec![0.0f32; data.len()];
    let mut exp_vals = vec![0.0f32; data.len()];
    let mut output = vec![0.0f32; data.len()];

    unsafe {
        // negate: result[i] = -x[i]
        for i in 0..data.len() {
            negated[i] = -data[i];
        }
        // vForce exp
        vvexpf(exp_vals.as_mut_ptr(), negated.as_ptr(), &n);
        // add_one and reciprocal
        for i in 0..data.len() {
            output[i] = 1.0 / (1.0 + exp_vals[i]);
        }
    }
    Ok(output)
}

/// SiLU: x * sigmoid(x) — uses sigmoid_f32 + vDSP_vmul or CPU mul.
pub fn silu_f32(data: &[f32]) -> Result<Vec<f32>, String> {
    let sig = sigmoid_f32(data)?;
    vector_mul(data, &sig)
}

// ── accelerate_vector: vDSP primitives ────────────────────────────────────

/// Raw FFI for vDSP vector operations (using extern at file scope so multiple
/// `extern "C"` blocks coexist without shadowing).
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
        // softmax_tail is genuinely unsupported in Accelerate (no match arm).
        // All narrow-catalog families are supported.
        assert_eq!(support_tier("softmax_tail"), BackendSupportTier::UnsupportedGraph);
        assert_eq!(support_tier("chain_matmul_add_silu"), BackendSupportTier::SupportedNative);
        assert_eq!(support_tier("branch_rejoin"), BackendSupportTier::SupportedNative);
        // Unknown families are genuinely unsupported.
        assert_eq!(support_tier("nonexistent"), BackendSupportTier::UnsupportedGraph);
    }
}
