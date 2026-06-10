//! Direct FFI bindings to Accelerate BLAS (cblas_sgemm).
//!
//! Accelerate is a system framework on all Apple platforms.
//! #[link] attribute is sufficient — no third-party crate required.

#[link(name = "Accelerate", kind = "framework")]
extern "C" {
    /// Single-precision general matrix multiply: C = alpha * op(A) * op(B) + beta * C.
    /// cblas_sgemm uses column-major storage by default.
    ///
    /// Parameters:
    ///   Order: CblasRowMajor (101) or CblasColMajor (102)
    ///   TransA, TransB: CblasNoTrans (111) or CblasTrans (112)
    ///   M: rows of op(A) and C
    ///   N: cols of op(B) and C
    ///   K: cols of op(A) / rows of op(B)
    ///   alpha: scalar multiplier
    ///   A: matrix A
    ///   lda: leading dimension of A
    ///   B: matrix B
    ///   ldb: leading dimension of B
    ///   beta: scalar multiplier for C
    ///   C: result matrix
    ///   ldc: leading dimension of C
    pub fn cblas_sgemm(
        order: i32,
        trans_a: i32,
        trans_b: i32,
        m: i32,
        n: i32,
        k: i32,
        alpha: *const f32,
        a: *const f32,
        lda: i32,
        b: *const f32,
        ldb: i32,
        beta: *const f32,
        c: *mut f32,
        ldc: i32,
    );
}

// BLAS constants
pub const CBLAS_ROW_MAJOR: i32 = 101;
pub const CBLAS_NO_TRANS: i32 = 111;
pub const CBLAS_TRANS: i32 = 112;
