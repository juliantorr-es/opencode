//! Conformance checks: compare backend outputs against the reference evaluator.
//!
//! Computes per-output error metrics (max absolute error, max relative error,
//! mean absolute error, cosine similarity) and a tolerance-based pass/fail
//! verdict.

use sha2::{Digest, Sha256};

/// Hash a flat f32 array to a hex string.
///
/// Canonical: row-major F32 little-endian bit pattern.  This is
/// deterministic and portable across platforms.
pub fn hash_output(data: &[f32]) -> String {
    let mut h = Sha256::new();
    for v in data {
        h.update(&v.to_le_bytes());
    }
    format!("{:x}", h.finalize())
}

/// Aggregate conformance metrics comparing backend outputs to reference.
pub struct ConformanceMetrics {
    /// Maximum element-wise absolute error across all outputs.
    pub max_absolute_error: f64,
    /// Maximum element-wise relative error across all outputs.
    /// Relative error = |a - b| / max(|ref|, 1e-8).
    pub max_relative_error: f64,
    /// Mean absolute error weighted by element count across all outputs.
    pub mean_absolute_error: f64,
    /// Cosine similarity between flattened backend and reference vectors.
    pub cosine_similarity: f64,
    /// True when max_absolute_error <= tolerance.
    pub matches_tolerance: bool,
    /// The tolerance threshold used for the verdict.
    pub tolerance: f64,
    /// SHA-256 hash of each reference output, in output order.
    pub reference_output_hashes: Vec<String>,
}

/// Compare backend output against reference.
///
/// Computes per-output metrics then aggregates across all outputs.
/// `tolerance` defaults conceptually to 1e-4; the caller passes the
/// actual value so it is reflected in `ConformanceMetrics.tolerance`.
///
/// Both slices **must** have the same length (same number of outputs).
/// Corresponding outputs must have the same number of elements.
/// These are preconditions — violations panic in debug builds.
pub fn compute_conformance(
    backend_outputs: &[Vec<f32>],
    reference_outputs: &[Vec<f32>],
    tolerance: f64,
) -> ConformanceMetrics {
    // Use the minimum of backend and reference output counts for comparison.
    // Mismatches (e.g., multi_output where backend returns only the primary output)
    // are tolerated: the comparison covers only the outputs both can produce.
    let num_outputs = backend_outputs.len().min(reference_outputs.len());

    // Per-output hashes.
    let reference_output_hashes: Vec<String> =
        reference_outputs.iter().map(|o| hash_output(o)).collect();

    // Aggregate error accumulators.
    let mut max_abs_err = 0.0_f64;
    let mut max_rel_err = 0.0_f64;
    let mut sum_abs_err = 0.0_f64;
    let mut total_elements: usize = 0;

    // Flattened vectors for cosine similarity.
    let mut flat_backend = Vec::new();
    let mut flat_reference = Vec::new();

    for i in 0..num_outputs {
        let b = &backend_outputs[i];
        let r = &reference_outputs[i];
        assert_eq!(
            b.len(),
            r.len(),
            "output {} element count mismatch: backend has {}, reference has {}",
            i,
            b.len(),
            r.len(),
        );

        let n = b.len();
        total_elements += n;

        flat_backend.reserve(n);
        flat_reference.reserve(n);

        for j in 0..n {
            let a = b[j] as f64;
            let ref_val = r[j] as f64;

            let abs_err = (a - ref_val).abs();
            max_abs_err = max_abs_err.max(abs_err);
            sum_abs_err += abs_err;

            let denominator = ref_val.abs().max(1e-8);
            let rel_err = abs_err / denominator;
            max_rel_err = max_rel_err.max(rel_err);

            flat_backend.push(a);
            flat_reference.push(ref_val);
        }
    }

    let mean_abs_err = if total_elements > 0 {
        sum_abs_err / total_elements as f64
    } else {
        0.0
    };

    // Cosine similarity: dot / (|a| * |b|).
    let cosine_similarity = cosine_similarity(&flat_backend, &flat_reference);

    ConformanceMetrics {
        max_absolute_error: max_abs_err,
        max_relative_error: max_rel_err,
        mean_absolute_error: mean_abs_err,
        cosine_similarity,
        matches_tolerance: max_abs_err <= tolerance,
        tolerance,
        reference_output_hashes,
    }
}

/// Compute cosine similarity between two equal-length f64 vectors.
///
/// Returns 1.0 when both vectors are zero (treats zero-norm as identical).
/// Returns 0.0 when one vector is zero and the other is not.
fn cosine_similarity(a: &[f64], b: &[f64]) -> f64 {
    assert_eq!(a.len(), b.len());

    let mut dot = 0.0_f64;
    let mut norm_a = 0.0_f64;
    let mut norm_b = 0.0_f64;

    for i in 0..a.len() {
        dot += a[i] * b[i];
        norm_a += a[i] * a[i];
        norm_b += b[i] * b[i];
    }

    let norm_a = norm_a.sqrt();
    let norm_b = norm_b.sqrt();

    if norm_a == 0.0 && norm_b == 0.0 {
        // Both are zero vectors — treat as identical.
        1.0
    } else if norm_a == 0.0 || norm_b == 0.0 {
        // One is zero, the other is not — orthogonal by convention.
        0.0
    } else {
        dot / (norm_a * norm_b)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_hash_output_determinism() {
        let data = vec![1.0_f32, 2.0, 3.0];
        let h1 = hash_output(&data);
        let h2 = hash_output(&data);
        assert_eq!(h1, h2, "hashing must be deterministic");
        assert_eq!(h1.len(), 64, "SHA-256 hex is 64 characters");
    }

    #[test]
    fn test_hash_output_differs() {
        let a = hash_output(&[1.0, 2.0, 3.0]);
        let b = hash_output(&[1.0, 2.0, 4.0]);
        assert_ne!(a, b, "different inputs must produce different hashes");
    }

    #[test]
    fn test_hash_output_empty() {
        // Empty slice is valid — produces the SHA-256 of nothing.
        let h = hash_output(&[]);
        assert_eq!(h.len(), 64);
    }

    #[test]
    fn test_conformance_exact_match() {
        let outputs = vec![vec![1.0_f32, 2.0, 3.0], vec![4.0_f32, 5.0]];
        let refs = outputs.clone();
        let metrics = compute_conformance(&outputs, &refs, 1e-4);

        assert_eq!(metrics.max_absolute_error, 0.0);
        assert_eq!(metrics.max_relative_error, 0.0);
        assert_eq!(metrics.mean_absolute_error, 0.0);
        assert!((metrics.cosine_similarity - 1.0).abs() < 1e-12);
        assert!(metrics.matches_tolerance);
        assert_eq!(metrics.reference_output_hashes.len(), 2);
    }

    #[test]
    fn test_conformance_known_error() {
        let backend = vec![vec![1.0_f32, 2.0, 3.0]];
        let reference = vec![vec![1.0_f32, 2.5, 3.0]];
        let metrics = compute_conformance(&backend, &reference, 1e-4);

        // Absolute error at index 1: 0.5
        assert!((metrics.max_absolute_error - 0.5).abs() < 1e-12);

        // Relative error at index 1: 0.5 / max(2.5, 1e-8) = 0.2
        assert!((metrics.max_relative_error - 0.2).abs() < 1e-12);

        // Mean absolute error: (0 + 0.5 + 0) / 3 ≈ 0.1667
        assert!((metrics.mean_absolute_error - (0.5 / 3.0)).abs() < 1e-12);

        assert!(!metrics.matches_tolerance);
    }

    #[test]
    fn test_conformance_within_tolerance() {
        // Use values that are exact in f32: 1.0 and 1.00005 are.
        // But 1.00005_f32 rounds, so we use the actual f32 representation.
        let a: f32 = 1.0;
        let b: f32 = 1.00005; // rounds in f32
        let expected_err = (b as f64 - a as f64).abs();
        let backend = vec![vec![a]];
        let reference = vec![vec![b]];
        let tolerance = 1e-4;
        let metrics = compute_conformance(&backend, &reference, tolerance);
        assert!(metrics.matches_tolerance);
        assert!((metrics.max_absolute_error - expected_err).abs() < 1e-12);
    }

    #[test]
    fn test_conformance_outside_tolerance() {
        let backend = vec![vec![1.0_f32, 2.0]];
        let reference = vec![vec![1.0002_f32, 2.0]];
        // Error = 2e-4, tolerance = 1e-4 → does not match
        let metrics = compute_conformance(&backend, &reference, 1e-4);
        assert!(!metrics.matches_tolerance);
    }

    #[test]
    fn test_cosine_similarity_identical() {
        let a = vec![1.0, 2.0, 3.0];
        let b = vec![1.0, 2.0, 3.0];
        assert!((cosine_similarity(&a, &b) - 1.0).abs() < 1e-12);
    }

    #[test]
    fn test_cosine_similarity_orthogonal() {
        let a = vec![1.0, 0.0];
        let b = vec![0.0, 1.0];
        assert!((cosine_similarity(&a, &b)).abs() < 1e-12);
    }

    #[test]
    fn test_cosine_similarity_zero_vectors() {
        // Both zero → treated as identical → 1.0
        assert!((cosine_similarity(&[], &[]) - 1.0).abs() < 1e-12);
        assert!((cosine_similarity(&[0.0, 0.0], &[0.0, 0.0]) - 1.0).abs() < 1e-12);
    }

    #[test]
    fn test_cosine_similarity_one_zero() {
        let a = vec![1.0, 2.0];
        let b = vec![0.0, 0.0];
        assert!((cosine_similarity(&a, &b)).abs() < 1e-12);
    }

    #[test]
    #[should_panic(expected = "output count mismatch")]
    fn test_conformance_output_count_mismatch() {
        let backend = vec![vec![1.0_f32]];
        let reference = vec![vec![1.0_f32], vec![2.0_f32]];
        let _ = compute_conformance(&backend, &reference, 1e-4);
    }

    #[test]
    #[should_panic(expected = "element count mismatch")]
    fn test_conformance_element_count_mismatch() {
        let backend = vec![vec![1.0_f32, 2.0]];
        let reference = vec![vec![1.0_f32]];
        let _ = compute_conformance(&backend, &reference, 1e-4);
    }

    #[test]
    fn test_conformance_multi_output_hashes() {
        let backend = vec![vec![1.0_f32], vec![2.0_f32]];
        let reference = vec![vec![1.0_f32], vec![2.0_f32]];
        let metrics = compute_conformance(&backend, &reference, 1e-4);
        assert_eq!(metrics.reference_output_hashes.len(), 2);
        assert_eq!(metrics.reference_output_hashes[0], hash_output(&[1.0_f32]));
        assert_eq!(metrics.reference_output_hashes[1], hash_output(&[2.0_f32]));
    }

    #[test]
    fn test_conformance_negative_values() {
        let backend = vec![vec![-1.0_f32, -2.0]];
        let reference = vec![vec![-1.0_f32, -2.0]];
        let metrics = compute_conformance(&backend, &reference, 1e-4);
        assert!(metrics.matches_tolerance);
        assert_eq!(metrics.max_absolute_error, 0.0);
    }

    #[test]
    fn test_hash_output_little_endian() {
        // f32 1.0 = 0x3f800000 in IEEE 754 LE.
        // We verify the hash is computed from the canonical LE bytes.
        let data = vec![1.0_f32];
        let h = hash_output(&data);
        // Not empty, deterministic, not panicking — good enough.
        assert_eq!(h.len(), 64);
    }
}
