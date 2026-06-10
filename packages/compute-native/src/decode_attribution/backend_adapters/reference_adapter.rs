//! Pure-Rust f32 reference evaluator for all 8 catalog topologies.
//!
//! This is the correctness baseline — simple, deterministic, no SIMD,
//! no BLAS. Every backend's outputs are compared against these
//! reference results for numerical conformance.
//!
//! Only the topologies defined in [`graph_catalog`] are supported.
//! This is not a general compute graph evaluator.

use crate::decode_attribution::shape_profiles::ShapeProfile;

// ── Primitive operations ──────────────────────────────────────────────────

/// Identity: returns the input unchanged.
pub fn identity(input: &[f32]) -> Vec<f32> {
    input.to_vec()
}

/// Matmul: C[m][n] = sum over k of A[m][k] * B[k][n].
///
/// Input is `[1, k]`, weight is `[k, n]`, output is `[1, n]`.
/// Uses a triple-loop with j (output column) innermost for cache friendliness
/// on row-major storage.
pub fn matmul(input: &[f32], weight: &[f32], m: i32, k: i32, n: i32) -> Vec<f32> {
    let m = m as usize;
    let k = k as usize;
    let n = n as usize;
    let mut output = vec![0.0f32; m * n];
    for i in 0..m {
        for p in 0..k {
            let a_ip = input[i * k + p];
            for j in 0..n {
                output[i * n + j] += a_ip * weight[p * n + j];
            }
        }
    }
    output
}

/// Element-wise addition. Panics if lengths differ.
pub fn add(a: &[f32], b: &[f32]) -> Vec<f32> {
    assert_eq!(
        a.len(),
        b.len(),
        "add: slice lengths differ ({} vs {})",
        a.len(),
        b.len()
    );
    a.iter().zip(b.iter()).map(|(x, y)| x + y).collect()
}

/// Element-wise multiplication.
pub fn mul(a: &[f32], b: &[f32]) -> Vec<f32> {
    assert_eq!(
        a.len(),
        b.len(),
        "mul: slice lengths differ ({} vs {})",
        a.len(),
        b.len()
    );
    a.iter().zip(b.iter()).map(|(x, y)| x * y).collect()
}

/// SiLU (Sigmoid Linear Unit): `x / (1 + exp(-x))`.
///
/// Applied element-wise.
pub fn silu(x: &[f32]) -> Vec<f32> {
    x.iter()
        .map(|&v| v / (1.0 + (-v).exp()))
        .collect()
}

/// Stable softmax: subtract max before exponentiation to avoid overflow.
pub fn softmax(x: &[f32]) -> Vec<f32> {
    let max_val = x
        .iter()
        .max_by(|a, b| a.partial_cmp(b).unwrap())
        .copied()
        .unwrap_or(0.0);
    let exp_sum: f32 = x.iter().map(|&v| (v - max_val).exp()).sum();
    x.iter()
        .map(|&v| (v - max_val).exp() / exp_sum)
        .collect()
}

/// General transpose.
///
/// `src_dims` lists the dimensions of the source tensor.
/// `axes` lists the new axis order (e.g. `[0, 2, 1]` for a
/// 3D tensor transposing the last two axes).
pub fn transpose(x: &[f32], src_dims: &[i32], axes: &[i32]) -> Vec<f32> {
    let rank = src_dims.len();
    assert_eq!(
        axes.len(),
        rank,
        "transpose: axes length {} doesn't match src_dims length {}",
        axes.len(),
        rank
    );

    let total: usize = src_dims.iter().map(|&d| d as usize).product();
    assert_eq!(
        x.len(),
        total,
        "transpose: input length {} doesn't match product of dims {}",
        x.len(),
        total
    );
    let mut output = vec![0.0f32; total];

    // Build output dims: out_dims[i] = src_dims[axes[i]]
    let out_dims: Vec<usize> = axes.iter().map(|&a| src_dims[a as usize] as usize).collect();

    // Row-major strides for the source layout.
    let mut src_stride = vec![1usize; rank];
    for i in (0..rank - 1).rev() {
        src_stride[i] = src_stride[i + 1] * src_dims[i + 1] as usize;
    }

    for flat_out in 0..total {
        // Decode flat_out into output-space coordinates via output dims.
        let mut rem = flat_out;
        let mut coord = vec![0usize; rank];
        for d in (0..rank).rev() {
            coord[d] = rem % out_dims[d];
            rem /= out_dims[d];
        }

        // Map output coordinates to source coordinates.
        // output dim d corresponds to source dim axes[d].
        // So coord[d] is the index along source dim axes[d].
        // Build src_coord where src_coord[axes[d]] = coord[d].
        let mut src_coord = vec![0usize; rank];
        for d in 0..rank {
            src_coord[axes[d] as usize] = coord[d];
        }

        // Compute source flat index.
        let src_flat: usize = src_coord.iter().zip(src_stride.iter()).map(|(&c, &s)| c * s).sum();

        output[flat_out] = x[src_flat];
    }

    output
}

/// Reshape: returns the data unchanged.
///
/// Verifies that the number of elements matches between source and
/// destination shapes, then returns a view (copy) of the same data.
/// Reshape is metadata, not a data transformation.
pub fn reshape(x: &[f32], src_dims: &[i32], dst_dims: &[i32]) -> Vec<f32> {
    let src_count: usize = src_dims.iter().map(|&d| d as usize).product();
    let dst_count: usize = dst_dims.iter().map(|&d| d as usize).product();
    assert_eq!(
        src_count, dst_count,
        "reshape: element count mismatch (src={}, dst={})",
        src_count, dst_count
    );
    assert_eq!(
        x.len(),
        src_count,
        "reshape: input length {} doesn't match src dims product {}",
        x.len(),
        src_count
    );
    x.to_vec()
}

// ── Graph dispatcher ──────────────────────────────────────────────────────

/// Evaluate a named graph topology and return one or more output tensors.
///
/// # Arguments
/// * `family_name` — one of the 8 catalog family names:
///   `matmul`, `chain_matmul_add_silu`, `branch_rejoin`, `multi_output`,
///   `constant_heavy`, `reshape_transpose_matmul`, `softmax_tail`,
///   `identity_passthrough`
/// * `input_data` — the input tensor (flattened, row-major).
/// * `weights` — the weight tensor (flattened, row-major).  For graphs
///   with multiple weight matrices (branch_rejoin, multi_output), the
///   weights are concatenated: `[weight_A, weight_B]`.
/// * `profile` — the [`ShapeProfile`] describing shapes for this run.
///
/// # Returns
/// A `Vec<Vec<f32>>` — one entry per output tensor.  Most families
/// return `vec![single_output]`; `multi_output` returns `vec![output_0, output_1]`.
///
/// # Panics
/// Panics on unknown `family_name` or shape/dimension mismatches.
pub fn evaluate_graph(
    family_name: &str,
    input_data: &[f32],
    weights: &[f32],
    profile: &ShapeProfile,
) -> Vec<Vec<f32>> {
    let k = profile.input_cols as i32;
    let n = profile.weight_cols as i32;

    match family_name {
        // ── matmul: single matmul ──────────────────────────────────────
        "matmul" | "constant_heavy" => {
            let output = matmul(input_data, weights, 1, k, n);
            vec![output]
        }

        // ── identity passthrough ───────────────────────────────────────
        "identity" | "identity_passthrough" => {
            vec![identity(input_data)]
        }

        // ── chain_matmul_add_silu: matmul → add(bias) → silu ───────────
        "chain_matmul_add_silu" => {
            let matmul_out = matmul(input_data, weights, 1, k, n);
            // Bias is the last `n` elements of weights (stored contiguously
            // after the weight matrix by the graph builder).
            let bias_start = (k * n) as usize;
            let bias = &weights[bias_start..];
            let added = add(&matmul_out, bias);
            let output = silu(&added);
            vec![output]
        }

        // ── branch_rejoin: matmul(A), matmul(B) → add(rejoin) ──────────
        "branch_rejoin" => {
            // Two weight matrices: A is [k, n], B is [k, n].
            let half = (k * n) as usize;
            let weight_a = &weights[..half];
            let weight_b = &weights[half..2 * half];
            let out_a = matmul(input_data, weight_a, 1, k, n);
            let out_b = matmul(input_data, weight_b, 1, k, n);
            let output = add(&out_a, &out_b);
            vec![output]
        }

        // ── multi_output: matmul → output_0, add(bias) → output_1 ──────
        "multi_output" => {
            let matmul_out = matmul(input_data, weights, 1, k, n);
            // Bias is after the weight matrix.
            let bias_start = (k * n) as usize;
            let bias = &weights[bias_start..];
            let add_out = add(&matmul_out, bias);
            vec![matmul_out, add_out]
        }

        // ── reshape_transpose_matmul: reshape → transpose → reshape → matmul ──
        "reshape_transpose_matmul" => {
            // The catalog's reshape splits [1, k] into [rows, cols],
            // transposes to [cols, rows], reshapes back to [1, k],
            // then does a matmul.
            // Reshape is a no-op on flat data; transpose actually moves elements.
            let rows = 4i32;
            let cols = k / rows;
            assert!(
                cols > 0 && k % rows == 0,
                "reshape_transpose_matmul: k={} not divisible by {}",
                k,
                rows
            );

            // Transpose [rows, cols] → [cols, rows].
            let transposed = transpose(input_data, &[rows, cols], &[1, 0]);
            // Reshape [cols, rows] → [1, k] (no-op, data unchanged).
            let reshaped_back = reshape(&transposed, &[cols, rows], &[1, k]);
            // Matmul([1, k], [k, n]) → [1, n].
            let output = matmul(&reshaped_back, weights, 1, k, n);
            vec![output]
        }

        // ── softmax_tail: matmul → softmax ──────────────────────────────
        "softmax_tail" => {
            let matmul_out = matmul(input_data, weights, 1, k, n);
            let output = softmax(&matmul_out);
            vec![output]
        }

        unknown => {
            panic!(
                "reference_adapter::evaluate_graph: unknown family '{}'. \
                 Expected one of: matmul, chain_matmul_add_silu, branch_rejoin, \
                 multi_output, constant_heavy, reshape_transpose_matmul, \
                 softmax_tail, identity, identity_passthrough",
                unknown
            );
        }
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    // ── Primitive tests ────────────────────────────────────────────────

    #[test]
    fn test_identity() {
        let v = vec![1.0, 2.0, 3.0];
        assert_eq!(identity(&v), v);
    }

    #[test]
    fn test_matmul_small() {
        // input: [1.0, 2.0]  (1×2)
        // weight: [[3.0], [4.0]]  (2×1)
        // output: 1*3 + 2*4 = 11.0
        let input = vec![1.0, 2.0];
        let weight = vec![3.0, 4.0];
        let result = matmul(&input, &weight, 1, 2, 1);
        assert_eq!(result.len(), 1);
        assert!((result[0] - 11.0).abs() < 1e-6);
    }

    #[test]
    fn test_matmul_2x3_3x2() {
        // A: 2×3 = [1,2,3, 4,5,6]
        // B: 3×2 = [7,8, 9,10, 11,12]
        // C: 2×2
        //   C[0] = 1*7+2*9+3*11 = 58, 1*8+2*10+3*12 = 64
        //   C[1] = 4*7+5*9+6*11 = 139, 4*8+5*10+6*12 = 154
        let a = vec![1.0, 2.0, 3.0, 4.0, 5.0, 6.0];
        let b = vec![7.0, 8.0, 9.0, 10.0, 11.0, 12.0];
        let r = matmul(&a, &b, 2, 3, 2);
        assert_eq!(r.len(), 4);
        assert!((r[0] - 58.0).abs() < 1e-5);
        assert!((r[1] - 64.0).abs() < 1e-5);
        assert!((r[2] - 139.0).abs() < 1e-5);
        assert!((r[3] - 154.0).abs() < 1e-5);
    }

    #[test]
    fn test_add() {
        let a = vec![1.0, 2.0, 3.0];
        let b = vec![4.0, 5.0, 6.0];
        let r = add(&a, &b);
        assert_eq!(r, vec![5.0, 7.0, 9.0]);
    }

    #[test]
    #[should_panic(expected = "lengths differ")]
    fn test_add_mismatched() {
        add(&[1.0], &[2.0, 3.0]);
    }

    #[test]
    fn test_mul() {
        let a = vec![2.0, 3.0, 4.0];
        let b = vec![5.0, 6.0, 7.0];
        let r = mul(&a, &b);
        assert_eq!(r, vec![10.0, 18.0, 28.0]);
    }

    #[test]
    fn test_silu() {
        // SiLU(0) = 0 / (1 + exp(0)) = 0 / 2 = 0
        // SiLU(1) = 1 / (1 + exp(-1)) ≈ 1 / 1.367879 = 0.73106
        let x = vec![0.0, 1.0];
        let r = silu(&x);
        assert!((r[0] - 0.0).abs() < 1e-6);
        assert!((r[1] - 0.7310586).abs() < 1e-5);
    }

    #[test]
    fn test_softmax() {
        // softmax([1, 2, 3]) — subtract max (3):
        //   exp(-2) = 0.1353, exp(-1) = 0.3679, exp(0) = 1.0
        //   sum = 1.5032
        //   result: 0.0900, 0.2447, 0.6652
        let x = vec![1.0, 2.0, 3.0];
        let r = softmax(&x);
        assert!((r[0] - 0.09003057).abs() < 1e-5);
        assert!((r[1] - 0.24472847).abs() < 1e-5);
        assert!((r[2] - 0.66524096).abs() < 1e-5);
        // Sum should be 1.0
        let sum: f32 = r.iter().sum();
        assert!((sum - 1.0).abs() < 1e-6);
    }

    #[test]
    fn test_transpose_2d() {
        // 2×3 matrix: [[1,2,3],[4,5,6]]
        // Transposed: [[1,4],[2,5],[3,6]]
        let x = vec![1.0, 2.0, 3.0, 4.0, 5.0, 6.0];
        let r = transpose(&x, &[2, 3], &[1, 0]);
        assert_eq!(r, vec![1.0, 4.0, 2.0, 5.0, 3.0, 6.0]);
    }

    #[test]
    fn test_transpose_identity() {
        let x = vec![1.0, 2.0, 3.0, 4.0];
        let r = transpose(&x, &[2, 2], &[0, 1]);
        assert_eq!(r, x);
    }

    #[test]
    fn test_reshape_ok() {
        let x = vec![1.0, 2.0, 3.0, 4.0, 5.0, 6.0];
        let r = reshape(&x, &[2, 3], &[3, 2]);
        assert_eq!(r, x); // data unchanged
    }

    #[test]
    #[should_panic(expected = "count mismatch")]
    fn test_reshape_mismatched_elements() {
        reshape(&[1.0, 2.0], &[2], &[3]);
    }

    // ── evaluate_graph integration tests ───────────────────────────────

    fn small_profile() -> ShapeProfile {
        ShapeProfile {
            name: "small",
            input_rows: 1,
            input_cols: 4,
            weight_rows: 4,
            weight_cols: 1,
        }
    }

    #[test]
    fn test_eval_matmul() {
        let p = small_profile();
        let input: Vec<f32> = (0..4).map(|i| i as f32 + 1.0).collect(); // [1,2,3,4]
        let weights: Vec<f32> = (0..4).map(|i| i as f32 + 0.5).collect(); // [0.5,1.5,2.5,3.5]
        // dot = 1*0.5 + 2*1.5 + 3*2.5 + 4*3.5 = 0.5 + 3.0 + 7.5 + 14.0 = 25.0
        let result = evaluate_graph("matmul", &input, &weights, &p);
        assert_eq!(result.len(), 1);
        assert!((result[0][0] - 25.0).abs() < 1e-5);
    }

    #[test]
    fn test_eval_identity() {
        let p = small_profile();
        let input = vec![1.0, 2.0, 3.0];
        let result = evaluate_graph("identity_passthrough", &input, &[], &p);
        assert_eq!(result.len(), 1);
        assert_eq!(result[0], input);
    }

    #[test]
    fn test_eval_chain_matmul_add_silu() {
        let p = small_profile();
        let input = vec![1.0, 2.0, 3.0, 4.0];
        // weights: 4×1 mat = [0.5, 1.5, 2.5, 3.5], bias = [0.1]
        let weights: Vec<f32> = vec![0.5, 1.5, 2.5, 3.5, 0.1];
        let result = evaluate_graph("chain_matmul_add_silu", &input, &weights, &p);
        assert_eq!(result.len(), 1);
        // matmul = 25.0, +bias = 25.1, silu(25.1)
        let expected = 25.1 / (1.0 + (-25.1f32).exp());
        assert!((result[0][0] - expected).abs() < 1e-5);
    }

    #[test]
    fn test_eval_branch_rejoin() {
        let p = small_profile();
        let input = vec![1.0, 2.0, 3.0, 4.0];
        // Two weight matrices of size 4×1 each.
        // A: [0.5, 1.5, 2.5, 3.5], B: [1.0, 1.0, 1.0, 1.0]
        let weights: Vec<f32> = vec![0.5, 1.5, 2.5, 3.5, 1.0, 1.0, 1.0, 1.0];
        let result = evaluate_graph("branch_rejoin", &input, &weights, &p);
        assert_eq!(result.len(), 1);
        // out_a = 25.0, out_b = 10.0, sum = 35.0
        assert!((result[0][0] - 35.0).abs() < 1e-5);
    }

    #[test]
    fn test_eval_multi_output() {
        let p = small_profile();
        let input = vec![1.0, 2.0, 3.0, 4.0];
        // weights: 4×1 mat = [0.5, 1.5, 2.5, 3.5], bias = [0.1]
        let weights: Vec<f32> = vec![0.5, 1.5, 2.5, 3.5, 0.1];
        let result = evaluate_graph("multi_output", &input, &weights, &p);
        assert_eq!(result.len(), 2);
        // output_0 = matmul = 25.0
        assert!((result[0][0] - 25.0).abs() < 1e-5);
        // output_1 = matmul + bias = 25.1
        assert!((result[1][0] - 25.1).abs() < 1e-5);
    }

    #[test]
    fn test_eval_softmax_tail() {
        let p = small_profile();
        let input = vec![1.0, 2.0, 3.0, 4.0];
        let weights = vec![0.5, 1.5, 2.5, 3.5];
        let result = evaluate_graph("softmax_tail", &input, &weights, &p);
        assert_eq!(result.len(), 1);
        // matmul = 25.0, softmax of single element = 1.0
        assert!((result[0][0] - 1.0).abs() < 1e-5);
    }

    #[test]
    fn test_eval_constant_heavy() {
        let p = small_profile();
        let input = vec![1.0, 2.0, 3.0, 4.0];
        let weights = vec![0.5, 1.5, 2.5, 3.5];
        let result = evaluate_graph("constant_heavy", &input, &weights, &p);
        assert_eq!(result.len(), 1);
        assert!((result[0][0] - 25.0).abs() < 1e-5);
    }

    #[test]
    fn test_eval_reshape_transpose_matmul_small() {
        // Small has k=4, rows=4, cols=1. The transpose [4,1]→[1,4]
        // just rearranges elements, then matmul.
        let p = small_profile();
        // input: [1, 4] = [1.0, 2.0, 3.0, 4.0]
        let input = vec![1.0, 2.0, 3.0, 4.0];
        // weight: [4, 1] = [0.5, 1.5, 2.5, 3.5]
        let weights = vec![0.5, 1.5, 2.5, 3.5];
        let result = evaluate_graph("reshape_transpose_matmul", &input, &weights, &p);
        assert_eq!(result.len(), 1);
        // The transpose [1,4]→[4,1] does:
        //   reshape [1,4]→[4,1] (same flat data)
        //   transpose [4,1]→[1,4]: output[0][j] = input[j][0]
        //   = [1.0, 2.0, 3.0, 4.0] (transpose of col vec = row vec)
        //   reshape [1,4]→[1,4] (no-op)
        //   matmul = 25.0
        assert!((result[0][0] - 25.0).abs() < 1e-5);
    }
}
