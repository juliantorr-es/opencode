//! FFI wrappers for vendored TurboQuant Metal kernel shaders.
//!
//! Dispatches embedded `.metal` shaders through MLX's fast Metal kernel
//! API (`mlx_fast_metal_kernel_*`). Kernels are JIT-compiled on first use
//! and cached per-process via `OnceLock`.
//!
//! Shaders vendored from arozanov/turboquant-mlx (Apache 2.0).

use mlx_rs::error::Result as MlxResult;
use mlx_rs::Array;
use std::ffi::CString;
use std::sync::OnceLock;

const QUANTIZE_SRC: &str = include_str!("quantize.metal");
const DEQUANT_SRC: &str = include_str!("dequant.metal");
const PREROTATE_SRC: &str = include_str!("prerotate.metal");
const FUSED_QK_SRC: &str = include_str!("fused_qk.metal");
const PACKED_DEQUANT_SRC: &str = include_str!("packed_dequant.metal");
const PACKED_FUSED_QK_SRC: &str = include_str!("packed_fused_qk.metal");
const SPARSE_V_SRC: &str = include_str!("sparse_v.metal");

// ── Kernel Registry ────────────────────────────────────────────────────────

struct MetalKernel {
    handle: mlx_sys::mlx_fast_metal_kernel,
}

unsafe impl Send for MetalKernel {}
unsafe impl Sync for MetalKernel {}

impl Drop for MetalKernel {
    fn drop(&mut self) {
        unsafe { mlx_sys::mlx_fast_metal_kernel_free(self.handle) };
    }
}

static QUANTIZE_KERNEL: OnceLock<MetalKernel> = OnceLock::new();
static DEQUANT_KERNEL: OnceLock<MetalKernel> = OnceLock::new();
static PREROTATE_KERNEL: OnceLock<MetalKernel> = OnceLock::new();
static FUSED_QK_KERNEL: OnceLock<MetalKernel> = OnceLock::new();
static PACKED_DEQUANT_KERNEL: OnceLock<MetalKernel> = OnceLock::new();
static PACKED_FUSED_QK_KERNEL: OnceLock<MetalKernel> = OnceLock::new();
static SPARSE_V_KERNEL: OnceLock<MetalKernel> = OnceLock::new();

fn compile_kernel(name: &str, source: &str, input_names: &[&str], output_names: &[&str]) -> MetalKernel {
    let c_name = CString::new(name).unwrap();
    let c_src = CString::new(source).unwrap();
    let c_header = CString::new("").unwrap();
    unsafe {
        let input_vec = mlx_sys::mlx_vector_string_new();
        for n in input_names {
            let cs = CString::new(*n).unwrap();
            mlx_sys::mlx_vector_string_append_value(input_vec, cs.as_ptr());
        }
        let output_vec = mlx_sys::mlx_vector_string_new();
        for n in output_names {
            let cs = CString::new(*n).unwrap();
            mlx_sys::mlx_vector_string_append_value(output_vec, cs.as_ptr());
        }
        let handle = mlx_sys::mlx_fast_metal_kernel_new(
            c_name.as_ptr(),
            input_vec,
            output_vec,
            c_src.as_ptr(),
            c_header.as_ptr(),
            false,
            false,
        );
        MetalKernel { handle }
    }
}

// ── FFI Helpers ────────────────────────────────────────────────────────────

unsafe fn make_input_vector(arrays: &[&Array]) -> mlx_sys::mlx_vector_array {
    let vec = mlx_sys::mlx_vector_array_new();
    for a in arrays {
        mlx_sys::mlx_vector_array_append_value(vec, a.as_ptr());
    }
    vec
}

unsafe fn extract_output(outputs: mlx_sys::mlx_vector_array, index: usize) -> Array {
    let mut arr = mlx_sys::mlx_array {
        ctx: std::ptr::null_mut(),
    };
    mlx_sys::mlx_vector_array_get(&mut arr, outputs, index);
    Array::from_ptr(arr)
}

fn default_stream() -> mlx_sys::mlx_stream {
    mlx_rs::Stream::default().as_ptr()
}

use mlx_sys::{
    mlx_dtype__MLX_FLOAT16 as T_F16, mlx_dtype__MLX_FLOAT32 as T_F32,
    mlx_dtype__MLX_UINT32 as T_U32,
};

// ── Quantize ───────────────────────────────────────────────────────────────

pub fn fused_quantize(
    vectors: &Array,
    signs: &Array,
    boundaries: &Array,
    dim: usize,
    bits: u32,
) -> MlxResult<(Array, Array)> {
    let kernel = QUANTIZE_KERNEL.get_or_init(|| compile_kernel("tq_fused_quantize", QUANTIZE_SRC, &["inp","signs","boundaries","dims"], &["packed_out","norms_out"]));

    let vpw: u32 = 10; // 3-bit
    let p_dim = super::packing::packed_dim(dim, bits);
    let n_centroids = 1u32 << bits;
    let n_vecs = vectors.shape()[0] as usize;

    let dims_data: [u32; 5] = [dim as u32, bits, vpw, p_dim as u32, n_centroids];
    let dims_arr = Array::from_slice(&dims_data, &[5]);

    unsafe {
        let _ = bits; // quiet unused warning
        let config = mlx_sys::mlx_fast_metal_kernel_config_new();
        mlx_sys::mlx_fast_metal_kernel_config_set_grid(config, (n_vecs * dim) as i32, 1, 1);
        mlx_sys::mlx_fast_metal_kernel_config_set_thread_group(config, dim as i32, 1, 1);

        let p_dim_i32 = p_dim as i32;
        mlx_sys::mlx_fast_metal_kernel_config_add_output_arg(config, &p_dim_i32, 1, T_U32);
        mlx_sys::mlx_fast_metal_kernel_config_add_output_arg(config, std::ptr::null(), 0, T_F32);

        let inputs = make_input_vector(&[vectors, signs, boundaries, &dims_arr]);
        let mut outputs = make_input_vector(&[]);
        mlx_sys::mlx_fast_metal_kernel_apply(&mut outputs, kernel.handle, inputs, config, default_stream());
        mlx_sys::mlx_fast_metal_kernel_config_free(config);

        let packed = extract_output(outputs, 0).reshape(&[n_vecs as i32, p_dim as i32])?;
        let norms = extract_output(outputs, 1).reshape(&[n_vecs as i32])?;

        mlx_sys::mlx_vector_array_free(inputs);
        Ok((packed, norms))
    }
}

// ── Dequantize ─────────────────────────────────────────────────────────────

pub fn dequant_fp16(
    packed: &Array,
    norms: &Array,
    centroids: &Array,
    signs: &Array,
    dim: usize,
    bits: u32,
) -> MlxResult<Array> {
    let kernel = DEQUANT_KERNEL.get_or_init(|| compile_kernel("tq_dequant_fp16", DEQUANT_SRC, &["packed","norms","centroids","signs","scale","dims"], &["out"]));

    let vpw: u32 = 10;
    let p_dim = super::packing::packed_dim(dim, bits);
    let n_vecs = packed.shape()[0] as usize;

    let dims_data: [u32; 4] = [dim as u32, bits, vpw, p_dim as u32];
    let dims_arr = Array::from_slice(&dims_data, &[4]);
    let scale = Array::from_f32(1.0 / (dim as f32).sqrt());

    unsafe {
        let _ = bits;
        let config = mlx_sys::mlx_fast_metal_kernel_config_new();
        mlx_sys::mlx_fast_metal_kernel_config_set_grid(config, (n_vecs * dim) as i32, 1, 1);
        mlx_sys::mlx_fast_metal_kernel_config_set_thread_group(config, dim as i32, 1, 1);
        mlx_sys::mlx_fast_metal_kernel_config_add_output_arg(config, std::ptr::null(), 0, T_F16);

        let inputs = make_input_vector(&[packed, norms, centroids, signs, &scale, &dims_arr]);
        let mut outputs = make_input_vector(&[]);
        mlx_sys::mlx_fast_metal_kernel_apply(&mut outputs, kernel.handle, inputs, config, default_stream());
        mlx_sys::mlx_fast_metal_kernel_config_free(config);

        let result = extract_output(outputs, 0).reshape(&[n_vecs as i32, dim as i32])?;
        mlx_sys::mlx_vector_array_free(inputs);
        Ok(result)
    }
}

// ── Pre-rotate Query ───────────────────────────────────────────────────────

pub fn prerotate_query(q: &Array, signs: &Array) -> MlxResult<Array> {
    let kernel =
        PREROTATE_KERNEL.get_or_init(|| compile_kernel("tq_prerotate_query", PREROTATE_SRC, &["q_in","signs","dims"], &["q_out"]));

    let n_heads = q.shape()[0] as usize;
    let dim = q.shape()[1] as usize;
    let dims_data: [u32; 1] = [dim as u32];
    let dims_arr = Array::from_slice(&dims_data, &[1]);

    unsafe {
        let config = mlx_sys::mlx_fast_metal_kernel_config_new();
        mlx_sys::mlx_fast_metal_kernel_config_add_template_arg_dtype(config, c"T".as_ptr(), T_F32);
        mlx_sys::mlx_fast_metal_kernel_config_set_grid(config, (n_heads * dim) as i32, 1, 1);
        mlx_sys::mlx_fast_metal_kernel_config_set_thread_group(config, dim as i32, 1, 1);
        mlx_sys::mlx_fast_metal_kernel_config_add_output_arg(config, std::ptr::null(), 0, T_F32);

        let inputs = make_input_vector(&[q, signs, &dims_arr]);
        let mut outputs = make_input_vector(&[]);
        mlx_sys::mlx_fast_metal_kernel_apply(&mut outputs, kernel.handle, inputs, config, default_stream());
        mlx_sys::mlx_fast_metal_kernel_config_free(config);

        let result = extract_output(outputs, 0).reshape(&[n_heads as i32, dim as i32])?;
        mlx_sys::mlx_vector_array_free(inputs);
        Ok(result)
    }
}

// ── Fused QK Scores ────────────────────────────────────────────────────────

pub fn prerot_fused_qk_scores(
    q_rot: &Array,
    k_packed: &Array,
    k_norms: &Array,
    centroids: &Array,
    dim: usize,
    bits: u32,
    n_rep: u32,
) -> MlxResult<Array> {
    let kernel = FUSED_QK_KERNEL.get_or_init(|| compile_kernel("tq_prerot_fused_qk", FUSED_QK_SRC, &["q_rot","packed","norms","centroids","scale","dims"], &["out"]));

    let vpw: u32 = 10;
    let p_dim = super::packing::packed_dim(dim, bits);
    let n_q_heads = q_rot.shape()[0] as usize;
    let seq_len = k_norms.shape()[1] as usize;

    let dims_data: [u32; 6] = [dim as u32, seq_len as u32, bits, vpw, p_dim as u32, n_rep];
    let dims_arr = Array::from_slice(&dims_data, &[6]);
    let scale = Array::from_f32(1.0 / dim as f32);

    unsafe {
        let config = mlx_sys::mlx_fast_metal_kernel_config_new();
        mlx_sys::mlx_fast_metal_kernel_config_add_template_arg_dtype(config, c"T".as_ptr(), T_F32);
        mlx_sys::mlx_fast_metal_kernel_config_set_grid(
            config,
            (seq_len * dim) as i32,
            n_q_heads as i32,
            1,
        );
        mlx_sys::mlx_fast_metal_kernel_config_set_thread_group(config, dim as i32, 1, 1);
        mlx_sys::mlx_fast_metal_kernel_config_add_output_arg(config, std::ptr::null(), 0, T_F32);

        let inputs = make_input_vector(&[q_rot, k_packed, k_norms, centroids, &scale, &dims_arr]);
        let mut outputs = make_input_vector(&[]);
        mlx_sys::mlx_fast_metal_kernel_apply(&mut outputs, kernel.handle, inputs, config, default_stream());
        mlx_sys::mlx_fast_metal_kernel_config_free(config);

        let result = extract_output(outputs, 0).reshape(&[n_q_heads as i32, seq_len as i32])?;
        mlx_sys::mlx_vector_array_free(inputs);
        Ok(result)
    }
}

// ── Packed Dequant (templated, float32 output) ─────────────────────────────

/// Templated dequant from packed storage to float32.
/// Generic version of dequant_fp16 — same logic, templated output type.
pub fn packed_dequantize(
    packed: &Array,
    norms: &Array,
    centroids: &Array,
    signs: &Array,
    dim: usize,
    bits: u32,
) -> MlxResult<Array> {
    let kernel = PACKED_DEQUANT_KERNEL
        .get_or_init(|| compile_kernel("tq_packed_dequant", PACKED_DEQUANT_SRC, &["packed","norms","centroids","signs","scale","dims"], &["out"]));

    let vpw: u32 = 10;
    let p_dim = super::packing::packed_dim(dim, bits);
    let n_vecs = packed.shape()[0] as usize;
    let scale = Array::from_f32(1.0 / (dim as f32).sqrt());
    let dims_data: [u32; 4] = [dim as u32, bits, vpw, p_dim as u32];
    let dims_arr = Array::from_slice(&dims_data, &[4]);

    unsafe {
        let config = mlx_sys::mlx_fast_metal_kernel_config_new();
        mlx_sys::mlx_fast_metal_kernel_config_add_template_arg_dtype(config, c"T".as_ptr(), T_F32);
        mlx_sys::mlx_fast_metal_kernel_config_set_grid(config, (n_vecs * dim) as i32, 1, 1);
        mlx_sys::mlx_fast_metal_kernel_config_set_thread_group(config, dim as i32, 1, 1);
        mlx_sys::mlx_fast_metal_kernel_config_add_output_arg(config, std::ptr::null(), 0, T_F32);

        let inputs = make_input_vector(&[packed, norms, centroids, signs, &scale, &dims_arr]);
        let mut outputs = make_input_vector(&[]);
        mlx_sys::mlx_fast_metal_kernel_apply(&mut outputs, kernel.handle, inputs, config, default_stream());
        mlx_sys::mlx_fast_metal_kernel_config_free(config);
        let result = extract_output(outputs, 0).reshape(&[n_vecs as i32, dim as i32])?;
        mlx_sys::mlx_vector_array_free(inputs);
        Ok(result)
    }
}

// ── Packed Fused QK (baseline, no pre-rotate) ──────────────────────────────

/// Fused Q@K from packed storage — baseline, no pre-rotate step.
/// One dispatch per (head, position) pair. Runs inverse WHT on K inline.
pub fn packed_fused_qk_scores(
    query: &Array,
    k_packed: &Array,
    k_norms: &Array,
    centroids: &Array,
    signs: &Array,
    dim: usize,
    bits: u32,
) -> MlxResult<Array> {
    let kernel = PACKED_FUSED_QK_KERNEL
        .get_or_init(|| compile_kernel("tq_packed_fused_qk", PACKED_FUSED_QK_SRC, &["query","packed","norms","centroids","signs","scale","dims"], &["out"]));

    let vpw: u32 = 10;
    let p_dim = super::packing::packed_dim(dim, bits);
    let n_heads = k_norms.shape()[0] as usize;
    let seq_len = k_norms.shape()[1] as usize;
    let scale = Array::from_f32(1.0 / (dim as f32).sqrt());
    let dims_data: [u32; 6] = [
        dim as u32,
        seq_len as u32,
        n_heads as u32,
        bits,
        vpw,
        p_dim as u32,
    ];
    let dims_arr = Array::from_slice(&dims_data, &[6]);

    unsafe {
        let config = mlx_sys::mlx_fast_metal_kernel_config_new();
        mlx_sys::mlx_fast_metal_kernel_config_add_template_arg_dtype(config, c"T".as_ptr(), T_F32);
        mlx_sys::mlx_fast_metal_kernel_config_set_grid(
            config,
            (seq_len * dim) as i32,
            n_heads as i32,
            1,
        );
        mlx_sys::mlx_fast_metal_kernel_config_set_thread_group(config, dim as i32, 1, 1);
        mlx_sys::mlx_fast_metal_kernel_config_add_output_arg(config, std::ptr::null(), 0, T_F32);

        let inputs = make_input_vector(&[
            query, k_packed, k_norms, centroids, signs, &scale, &dims_arr,
        ]);
        let mut outputs = make_input_vector(&[]);
        mlx_sys::mlx_fast_metal_kernel_apply(&mut outputs, kernel.handle, inputs, config, default_stream());
        mlx_sys::mlx_fast_metal_kernel_config_free(config);
        let result = extract_output(outputs, 0).reshape(&[n_heads as i32, seq_len as i32])?;
        mlx_sys::mlx_vector_array_free(inputs);
        Ok(result)
    }
}

// ── Sparse V Attention (butterfly-pulled-out) ──────────────────────────────

/// Sparse weighted sum of dequantized V vectors with butterfly-pulled-out.
///
/// Phase 1: accumulate weight * norm * centroid per-element across positions
///          (no barriers — WHT linearity lets us defer the butterfly).
/// Phase 2: one threadgroup-wide butterfly on the accumulated vector.
///
/// GQA-aware. Positions with weight < threshold are skipped entirely.
/// With threshold=0.0, produces identical results to the dense path.
pub fn sparse_v_matvec(
    weights: &Array,
    v_packed: &Array,
    v_norms: &Array,
    centroids: &Array,
    signs: &Array,
    dim: usize,
    bits: u32,
    threshold: f32,
    n_rep: u32,
) -> MlxResult<Array> {
    let kernel = SPARSE_V_KERNEL.get_or_init(|| compile_kernel("tq_sparse_v_matvec", SPARSE_V_SRC, &["weights","v_packed","v_norms","centroids","signs","scale","threshold","dims"], &["out"]));

    let vpw: u32 = 10;
    let p_dim = super::packing::packed_dim(dim, bits);
    let n_q_heads = weights.shape()[0] as usize;
    let seq_len = weights.shape()[1] as usize;
    let scale = Array::from_f32(1.0 / dim as f32);
    let thr = Array::from_f32(threshold.max(0.0));
    let dims_data: [u32; 6] = [dim as u32, seq_len as u32, bits, vpw, p_dim as u32, n_rep];
    let dims_arr = Array::from_slice(&dims_data, &[6]);

    unsafe {
        let config = mlx_sys::mlx_fast_metal_kernel_config_new();
        mlx_sys::mlx_fast_metal_kernel_config_add_template_arg_dtype(config, c"T".as_ptr(), T_F32);
        mlx_sys::mlx_fast_metal_kernel_config_set_grid(config, (n_q_heads * dim) as i32, 1, 1);
        mlx_sys::mlx_fast_metal_kernel_config_set_thread_group(config, dim as i32, 1, 1);
        mlx_sys::mlx_fast_metal_kernel_config_add_output_arg(config, std::ptr::null(), 0, T_F32);

        let inputs = make_input_vector(&[
            weights, v_packed, v_norms, centroids, signs, &scale, &thr, &dims_arr,
        ]);
        let mut outputs = make_input_vector(&[]);
        mlx_sys::mlx_fast_metal_kernel_apply(&mut outputs, kernel.handle, inputs, config, default_stream());
        mlx_sys::mlx_fast_metal_kernel_config_free(config);
        let result = extract_output(outputs, 0).reshape(&[n_q_heads as i32, dim as i32])?;
        mlx_sys::mlx_vector_array_free(inputs);
        Ok(result)
    }
}
