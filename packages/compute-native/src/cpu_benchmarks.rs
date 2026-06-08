//! CPU benchmarks measuring throughput of various vector operations.
//!
//! All benchmarks use [`std::time::Instant`], run 10 warmup iterations, then
//! measure 50 timed iterations.  Standard shapes (caller is expected to supply
//! data of these lengths): 3840 (hidden), 15360 (intermediate), 256128 (vocab).

use serde::{Deserialize, Serialize};
use std::hint::black_box;
use std::time::Instant;

const WARMUP: u32 = 10;
const MEASURE: u32 = 50;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/// Implementation backend label.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum Implementation {
    MlxCpu,
    Accelerate,
    RustPortable,
    RustNeon,
}

/// A single CPU benchmark measurement.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CpuBenchmark {
    pub benchmark_id: String,
    pub implementation: Implementation,
    pub operation: String,
    pub shape: usize,
    pub warm_runs: u32,
    /// Latency of the first (cold) iteration in microseconds.
    pub cold_us: f64,
    /// Average latency per warm iteration in microseconds.
    pub warm_us: f64,
    /// Total bytes read + written by the operation.
    pub bytes_processed: u64,
    /// Throughput in GB/s (bytes_processed / warm_us).
    pub throughput_gbps: f64,
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

fn bench_id(op: &str, impl_kind: Implementation, shape: usize) -> String {
    let tag = match impl_kind {
        Implementation::MlxCpu => "mlx_cpu",
        Implementation::Accelerate => "accelerate",
        Implementation::RustPortable => "rust_portable",
        Implementation::RustNeon => "rust_neon",
    };
    format!("cpu/{op}/{tag}/{shape}")
}

fn bytes_f32(n: usize) -> u64 {
    (n * 4) as u64
}

/// Time a closure — one cold iteration, then `WARMUP - 1` warmup iterations,
/// then `MEASURE` timed iterations.
///
/// Returns `(cold_us, avg_warm_us)`.
fn measure<F>(mut f: F) -> (f64, f64)
where
    F: FnMut(),
{
    // Cold run (iteration 0 — cache-cold).
    let t0 = Instant::now();
    f();
    let cold = t0.elapsed();

    // Warmup (iterations 1 … WARMUP-1).
    for _ in 1..WARMUP {
        f();
    }

    // Timed iterations.
    let t0 = Instant::now();
    for _ in 0..MEASURE {
        f();
    }
    let elapsed = t0.elapsed();

    let cold_us = cold.as_secs_f64() * 1_000_000.0;
    let warm_us = elapsed.as_secs_f64() * 1_000_000.0 / f64::from(MEASURE);
    (cold_us, warm_us)
}

fn mk_bench(
    id: &str,
    impl_kind: Implementation,
    op: &str,
    shape: usize,
    cold_us: f64,
    warm_us: f64,
    bytes_read: u64,
    bytes_written: u64,
) -> CpuBenchmark {
    let bytes_processed = bytes_read + bytes_written;
    let throughput_gbps = if warm_us > 0.0 {
        bytes_processed as f64 / (warm_us / 1_000_000.0) / 1_000_000_000.0
    } else {
        0.0
    };
    CpuBenchmark {
        benchmark_id: id.to_string(),
        implementation: impl_kind,
        operation: op.to_string(),
        shape,
        warm_runs: WARMUP,
        cold_us,
        warm_us,
        bytes_processed,
        throughput_gbps,
    }
}

// ---------------------------------------------------------------------------
// NEON intrinsics (aarch64 only)
// ---------------------------------------------------------------------------

/// NEON-accelerated routines.  Only compiled on `aarch64` targets.
#[cfg(target_arch = "aarch64")]
mod neon {
    use std::arch::aarch64::*;

    /// `dst[i] = src[i] * factor`  (4-wide unrolled).
    #[inline]
    pub unsafe fn mul_f32(dst: *mut f32, src: *const f32, factor: f32, n: usize) {
        let vf = vdupq_n_f32(factor);
        let mut i = 0usize;
        while i + 4 <= n {
            vst1q_f32(dst.add(i), vmulq_f32(vld1q_f32(src.add(i)), vf));
            i += 4;
        }
        while i < n {
            *dst.add(i) = *src.add(i) * factor;
            i += 1;
        }
    }

    /// `dst[i] = src[i] * factor` — alias for readability when used as
    /// fused `(src[i] / temp) * scale` with `factor = scale / temp`.
    #[inline]
    pub unsafe fn scale_f32(dst: *mut f32, src: *const f32, factor: f32, n: usize) {
        mul_f32(dst, src, factor, n);
    }

    /// `dst[i] = a[i] + b[i]`  (4-wide unrolled).
    #[inline]
    pub unsafe fn add_f32(dst: *mut f32, a: *const f32, b: *const f32, n: usize) {
        let mut i = 0usize;
        while i + 4 <= n {
            vst1q_f32(
                dst.add(i),
                vaddq_f32(vld1q_f32(a.add(i)), vld1q_f32(b.add(i))),
            );
            i += 4;
        }
        while i < n {
            *dst.add(i) = *a.add(i) + *b.add(i);
            i += 1;
        }
    }

    /// Sum all elements (pairwise-add reduction).
    #[inline]
    pub unsafe fn sum_f32(src: *const f32, n: usize) -> f32 {
        let mut acc = vdupq_n_f32(0.0f32);
        let mut i = 0usize;
        while i + 4 <= n {
            acc = vaddq_f32(acc, vld1q_f32(src.add(i)));
            i += 4;
        }
        let mut sum: f32 = vaddvq_f32(acc);
        while i < n {
            sum += *src.add(i);
            i += 1;
        }
        sum
    }

    /// Maximum of all elements.
    #[inline]
    pub unsafe fn max_f32(src: *const f32, n: usize) -> f32 {
        let mut acc = vdupq_n_f32(f32::NEG_INFINITY);
        let mut i = 0usize;
        while i + 4 <= n {
            acc = vmaxq_f32(acc, vld1q_f32(src.add(i)));
            i += 4;
        }
        let mut maxv: f32 = vmaxvq_f32(acc);
        while i < n {
            if *src.add(i) > maxv {
                maxv = *src.add(i);
            }
            i += 1;
        }
        maxv
    }
}

// ---------------------------------------------------------------------------
// Accelerate FFI (macOS aarch64)
// ---------------------------------------------------------------------------

#[cfg(all(target_arch = "aarch64", target_os = "macos"))]
#[link(name = "Accelerate", kind = "framework")]
extern "C" {
    fn vDSP_vadd(
        a: *const f32,
        ia: isize,
        b: *const f32,
        ib: isize,
        c: *mut f32,
        ic: isize,
        n: isize,
    );
    fn vDSP_vsmul(
        a: *const f32,
        ia: isize,
        b: *const f32,
        c: *mut f32,
        ic: isize,
        n: isize,
    );
    fn vDSP_vsdiv(
        a: *const f32,
        ia: isize,
        b: *const f32,
        c: *mut f32,
        ic: isize,
        n: isize,
    );
    fn vDSP_sve(
        a: *const f32,
        ia: isize,
        result: *mut f32,
        n: isize,
    );
    fn vDSP_maxv(
        a: *const f32,
        ia: isize,
        result: *mut f32,
        n: isize,
    );
}

// ===========================================================================
// Public benchmark functions
// ===========================================================================

/// Time a generic auto-vectorized loop: `out[i] = data[i] * 2.0`.
///
/// `op` is a descriptive label (e.g. `"mul2"`, `"add1"`) stored in the
/// returned benchmark.  Only the `RustPortable` implementation is measured.
pub fn run_generic_vec_benchmark(data: &[f32], op: &str) -> CpuBenchmark {
    let n = data.len();
    let mut out = vec![0.0f32; n];

    let (cold_us, warm_us) = measure(|| {
        for i in 0..n {
            out[i] = data[i] * 2.0f32;
        }
        black_box(&out[..n]);
    });

    mk_bench(
        &bench_id(op, Implementation::RustPortable, n),
        Implementation::RustPortable,
        op,
        n,
        cold_us,
        warm_us,
        bytes_f32(n), // read
        bytes_f32(n), // write
    )
}

/// Benchmark logits scaling: `(logits[i] / temp) * scale`.
///
/// Returns up to three benchmarks:
/// - `RustPortable` — plain for-loop doing `(x / temp) * scale`
/// - `RustNeon` — NEON `vmulq` fused as `x * (scale / temp)` (aarch64)
/// - `Accelerate` — `vDSP_vsdiv` + `vDSP_vsmul` (macOS aarch64)
pub fn bench_logits_scaling(logits: &[f32], temp: f32, scale: f32) -> Vec<CpuBenchmark> {
    let n = logits.len();
    let factor = scale / temp;
    let mut results = Vec::with_capacity(3);

    // --- RustPortable ---
    {
        let mut out = vec![0.0f32; n];
        let (cold, warm) = measure(|| {
            for i in 0..n {
                out[i] = (logits[i] / temp) * scale;
            }
            black_box(&out[..n]);
        });
        let id = bench_id("logits_scaling", Implementation::RustPortable, n);
        results.push(mk_bench(
            &id,
            Implementation::RustPortable,
            "logits_scaling",
            n,
            cold,
            warm,
            bytes_f32(n),
            bytes_f32(n),
        ));
    }

    // --- RustNeon ---
    #[cfg(target_arch = "aarch64")]
    {
        let mut out = vec![0.0f32; n];
        let (cold, warm) = measure(|| unsafe {
            neon::scale_f32(out.as_mut_ptr(), logits.as_ptr(), factor, n);
            black_box(&out[..n]);
        });
        let id = bench_id("logits_scaling", Implementation::RustNeon, n);
        results.push(mk_bench(
            &id,
            Implementation::RustNeon,
            "logits_scaling",
            n,
            cold,
            warm,
            bytes_f32(n),
            bytes_f32(n),
        ));
    }

    // --- Accelerate ---
    #[cfg(all(target_arch = "aarch64", target_os = "macos"))]
    {
        let mut out = vec![0.0f32; n];
        let temp_arr = [temp];
        let scale_arr = [scale];
        let (cold, warm) = measure(|| unsafe {
            vDSP_vsdiv(
                logits.as_ptr(),
                1,
                temp_arr.as_ptr(),
                out.as_mut_ptr(),
                1,
                n as isize,
            );
            vDSP_vsmul(
                out.as_ptr(),
                1,
                scale_arr.as_ptr(),
                out.as_mut_ptr(),
                1,
                n as isize,
            );
            black_box(&out[..n]);
        });
        let id = bench_id("logits_scaling", Implementation::Accelerate, n);
        results.push(mk_bench(
            &id,
            Implementation::Accelerate,
            "logits_scaling",
            n,
            cold,
            warm,
            bytes_f32(n),
            bytes_f32(n),
        ));
    }

    results
}

/// Benchmark element-wise vector add: `c[i] = a[i] + b[i]`.
///
/// Returns up to three benchmarks:
/// - `RustPortable` — plain for-loop
/// - `RustNeon` — NEON `vaddq_f32` (aarch64)
/// - `Accelerate` — `vDSP_vadd` (macOS aarch64)
pub fn bench_residual_add(a: &[f32], b: &[f32]) -> Vec<CpuBenchmark> {
    let n = a.len().min(b.len());
    let mut results = Vec::with_capacity(3);

    // --- RustPortable ---
    {
        let mut c = vec![0.0f32; n];
        let (cold, warm) = measure(|| {
            for i in 0..n {
                c[i] = a[i] + b[i];
            }
            black_box(&c[..n]);
        });
        let id = bench_id("residual_add", Implementation::RustPortable, n);
        results.push(mk_bench(
            &id,
            Implementation::RustPortable,
            "residual_add",
            n,
            cold,
            warm,
            bytes_f32(n) * 2, // two reads
            bytes_f32(n),      // one write
        ));
    }

    // --- RustNeon ---
    #[cfg(target_arch = "aarch64")]
    {
        let mut c = vec![0.0f32; n];
        let (cold, warm) = measure(|| unsafe {
            neon::add_f32(c.as_mut_ptr(), a.as_ptr(), b.as_ptr(), n);
            black_box(&c[..n]);
        });
        let id = bench_id("residual_add", Implementation::RustNeon, n);
        results.push(mk_bench(
            &id,
            Implementation::RustNeon,
            "residual_add",
            n,
            cold,
            warm,
            bytes_f32(n) * 2,
            bytes_f32(n),
        ));
    }

    // --- Accelerate ---
    #[cfg(all(target_arch = "aarch64", target_os = "macos"))]
    {
        let mut c = vec![0.0f32; n];
        let (cold, warm) = measure(|| unsafe {
            vDSP_vadd(a.as_ptr(), 1, b.as_ptr(), 1, c.as_mut_ptr(), 1, n as isize);
            black_box(&c[..n]);
        });
        let id = bench_id("residual_add", Implementation::Accelerate, n);
        results.push(mk_bench(
            &id,
            Implementation::Accelerate,
            "residual_add",
            n,
            cold,
            warm,
            bytes_f32(n) * 2,
            bytes_f32(n),
        ));
    }

    results
}

/// Benchmark three reductions: sum, max, argmax.
///
/// Each reduction is measured for `RustPortable` and, on aarch64, `RustNeon`.
pub fn bench_reductions(data: &[f32]) -> Vec<CpuBenchmark> {
    let n = data.len();
    // 3 reductions × up to 2 implementations
    let mut results = Vec::with_capacity(6);

    // ---- sum ----------------------------------------------------------------
    {
        let (cold, warm) = measure(|| {
            let mut s = 0.0f32;
            for i in 0..n {
                s += data[i];
            }
            black_box(s);
        });
        let id = bench_id("sum", Implementation::RustPortable, n);
        results.push(mk_bench(
            &id,
            Implementation::RustPortable,
            "sum",
            n,
            cold,
            warm,
            bytes_f32(n),
            0,
        ));
    }

    #[cfg(target_arch = "aarch64")]
    {
        let (cold, warm) = measure(|| unsafe {
            let s = neon::sum_f32(data.as_ptr(), n);
            black_box(s);
        });
        let id = bench_id("sum", Implementation::RustNeon, n);
        results.push(mk_bench(
            &id,
            Implementation::RustNeon,
            "sum",
            n,
            cold,
            warm,
            bytes_f32(n),
            0,
        ));
    }

    // ---- max ----------------------------------------------------------------
    {
        let (cold, warm) = measure(|| {
            let mut m = f32::NEG_INFINITY;
            for i in 0..n {
                if data[i] > m {
                    m = data[i];
                }
            }
            black_box(m);
        });
        let id = bench_id("max", Implementation::RustPortable, n);
        results.push(mk_bench(
            &id,
            Implementation::RustPortable,
            "max",
            n,
            cold,
            warm,
            bytes_f32(n),
            0,
        ));
    }

    #[cfg(target_arch = "aarch64")]
    {
        let (cold, warm) = measure(|| unsafe {
            let m = neon::max_f32(data.as_ptr(), n);
            black_box(m);
        });
        let id = bench_id("max", Implementation::RustNeon, n);
        results.push(mk_bench(
            &id,
            Implementation::RustNeon,
            "max",
            n,
            cold,
            warm,
            bytes_f32(n),
            0,
        ));
    }

    // ---- argmax -------------------------------------------------------------
    {
        let (cold, warm) = measure(|| {
            let mut idx = 0usize;
            let mut m = f32::NEG_INFINITY;
            for i in 0..n {
                if data[i] > m {
                    m = data[i];
                    idx = i;
                }
            }
            black_box(idx);
        });
        let id = bench_id("argmax", Implementation::RustPortable, n);
        results.push(mk_bench(
            &id,
            Implementation::RustPortable,
            "argmax",
            n,
            cold,
            warm,
            bytes_f32(n),
            0,
        ));
    }

    // argmax NEON: use neon::max_f32 then linear scan for first occurrence.
    #[cfg(target_arch = "aarch64")]
    {
        let (cold, warm) = measure(|| unsafe {
            let m = neon::max_f32(data.as_ptr(), n);
            let mut idx = 0usize;
            for i in 0..n {
                if *data.as_ptr().add(i) == m {
                    idx = i;
                    break;
                }
            }
            black_box(idx);
        });
        let id = bench_id("argmax", Implementation::RustNeon, n);
        results.push(mk_bench(
            &id,
            Implementation::RustNeon,
            "argmax",
            n,
            cold,
            warm,
            bytes_f32(n),
            0,
        ));
    }

    results
}

/// Benchmark partial sort for top-k selection.
///
/// Copies the data and uses `select_nth_unstable_by` for a descending
/// partial sort (largest k elements bubble to the front).  Only
/// `RustPortable` is benchmarked since NEON / Accelerate do not offer
/// general sort primitives.
pub fn bench_topk_prep(data: &[f32], k: u32) -> Vec<CpuBenchmark> {
    let n = data.len();
    let k = (k as usize).min(n).max(1);
    let mut results = Vec::with_capacity(1);

    let (cold, warm) = measure(|| {
        let mut buf = data.to_vec();
        buf.select_nth_unstable_by(k - 1, |a, b| {
            b.partial_cmp(a).unwrap_or(std::cmp::Ordering::Equal)
        });
        black_box(&buf[..k]);
    });

    let id = bench_id("topk_prep", Implementation::RustPortable, n);
    results.push(mk_bench(
        &id,
        Implementation::RustPortable,
        "topk_prep",
        n,
        cold,
        warm,
        bytes_f32(n), // read original
        bytes_f32(n), // write copy
    ));

    results
}

/// Benchmark bf16 → f32 conversion via left-shift.
///
/// Each bf16 (stored as `u16`) is widened to `u32`, shifted left by 16 bits,
/// then reinterpreted as `f32`.
pub fn bench_bf16_to_f32(bf16: &[u16]) -> CpuBenchmark {
    let n = bf16.len();
    let mut out = vec![0.0f32; n];

    let (cold, warm) = measure(|| {
        for i in 0..n {
            let bits = (bf16[i] as u32) << 16;
            out[i] = f32::from_bits(bits);
        }
        black_box(&out[..n]);
    });

    let id = bench_id("bf16_to_f32", Implementation::RustPortable, n);
    mk_bench(
        &id,
        Implementation::RustPortable,
        "bf16_to_f32",
        n,
        cold,
        warm,
        (n * 2) as u64, // read u16 × n
        (n * 4) as u64, // write f32 × n
    )
}
