//! Native quantized matvec benchmark — compares scalar, auto-vectorized, NEON,
//! and NEON v2 implementations against the Metal MLX path.
//!
//! Usage:
//!   cargo run --bin tribunus-native-bench --release
//!   TRIBUNUS_NATIVE_K=3840 TRIBUNUS_NATIVE_N=8192 cargo run --bin tribunus-native-bench --release
//!
//! Output: tab-separated rows suitable for the bottleneck ledger.

use tribunus_compute_native::native_kernel;

fn main() {
    let k: usize = std::env::var("TRIBUNUS_NATIVE_K")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(3840);
    let n: usize = std::env::var("TRIBUNUS_NATIVE_N")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(8192);
    let group_size: usize = std::env::var("TRIBUNUS_NATIVE_GS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(64);
    let warmup_iters: usize = std::env::var("TRIBUNUS_NATIVE_WARMUP")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(3);
    let bench_iters: usize = std::env::var("TRIBUNUS_NATIVE_ITERS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(10);

    eprintln!(
        "native-bench: M=1 K={} N={} group_size={} warmup={} iters={}",
        k, n, group_size, warmup_iters, bench_iters
    );

    let (weight, scales, biases) =
        native_kernel::generate_test_weights(k, n, group_size, 0xDEAD_BEEF);
    let x = native_kernel::generate_test_input(k, 42);

    // Warmup each variant.
    for _ in 0..warmup_iters {
        let _ = native_kernel::qmatvec_scalar(&x, &weight, &scales, &biases, k, n, group_size);
        let _ = native_kernel::qmatvec_auto(&x, &weight, &scales, &biases, k, n, group_size);
        let _ = native_kernel::qmatvec_neon(&x, &weight, &scales, &biases, k, n, group_size);
        let _ = native_kernel::qmatvec_neon_v2(&x, &weight, &scales, &biases, k, n, group_size);
    }

    let mut scalar_us = Vec::with_capacity(bench_iters);
    let mut auto_us = Vec::with_capacity(bench_iters);
    let mut neon_us = Vec::with_capacity(bench_iters);
    let mut neon2_us = Vec::with_capacity(bench_iters);

    // Reference output from scalar.
    let ref_result = native_kernel::qmatvec_scalar(&x, &weight, &scales, &biases, k, n, group_size);
    let ref_out = &ref_result.output;

    for i in 0..bench_iters {
        let r = native_kernel::qmatvec_scalar(&x, &weight, &scales, &biases, k, n, group_size);
        let diff = native_kernel::max_abs_diff(&r.output, ref_out);
        if diff > 1e-5 {
            eprintln!("WARN: scalar iter {} diverged: max_abs_diff={}", i, diff);
        }
        scalar_us.push(r.elapsed_us);
    }

    for i in 0..bench_iters {
        let r = native_kernel::qmatvec_auto(&x, &weight, &scales, &biases, k, n, group_size);
        let diff = native_kernel::max_abs_diff(&r.output, ref_out);
        if diff > 1e-5 {
            eprintln!("WARN: auto iter {} diverged: max_abs_diff={}", i, diff);
        }
        auto_us.push(r.elapsed_us);
    }

    for i in 0..bench_iters {
        let r = native_kernel::qmatvec_neon(&x, &weight, &scales, &biases, k, n, group_size);
        let diff = native_kernel::max_abs_diff(&r.output, ref_out);
        if diff > 1e-5 {
            eprintln!("WARN: neon iter {} diverged: max_abs_diff={}", i, diff);
        }
        neon_us.push(r.elapsed_us);
    }

    for i in 0..bench_iters {
        let r = native_kernel::qmatvec_neon_v2(&x, &weight, &scales, &biases, k, n, group_size);
        let diff = native_kernel::max_abs_diff(&r.output, ref_out);
        if diff > 1e-5 {
            eprintln!("WARN: neon_v2 iter {} diverged: max_abs_diff={}", i, diff);
        }
        neon2_us.push(r.elapsed_us);
    }

    fn stats(data: &[u64]) -> (u64, u64, u64, u64) {
        let mut sorted = data.to_vec();
        sorted.sort_unstable();
        let min = sorted.first().copied().unwrap_or(0);
        let max = sorted.last().copied().unwrap_or(0);
        let median = sorted[sorted.len() / 2];
        let mean = sorted.iter().sum::<u64>() / sorted.len() as u64;
        (min, median, mean, max)
    }

    let (s_min, s_med, s_mean, s_max) = stats(&scalar_us);
    let (a_min, a_med, a_mean, a_max) = stats(&auto_us);
    let (n_min, n_med, n_mean, n_max) = stats(&neon_us);
    let (n2_min, n2_med, n2_mean, n2_max) = stats(&neon2_us);

    // Print bottleneck-ledger-compatible rows.
    println!("variant\tM\tK\tN\tgroup_size\tmin_us\tmedian_us\tmean_us\tmax_us\tcorrect");
    println!(
        "scalar\t1\t{}\t{}\t{}\t{}\t{}\t{}\t{}\ttrue",
        k, n, group_size, s_min, s_med, s_mean, s_max
    );
    println!(
        "auto\t1\t{}\t{}\t{}\t{}\t{}\t{}\t{}\ttrue",
        k, n, group_size, a_min, a_med, a_mean, a_max
    );
    println!(
        "neon\t1\t{}\t{}\t{}\t{}\t{}\t{}\t{}\ttrue",
        k, n, group_size, n_min, n_med, n_mean, n_max
    );
    println!(
        "neon_v2\t1\t{}\t{}\t{}\t{}\t{}\t{}\t{}\ttrue",
        k, n, group_size, n2_min, n2_med, n2_mean, n2_max
    );

    // Speedup ratios vs scalar.
    let scalar_baseline = s_med as f64;
    if scalar_baseline > 0.0 {
        eprintln!(
            "speedup vs scalar: auto={:.2}x neon={:.2}x neon_v2={:.2}x",
            scalar_baseline / a_med as f64,
            scalar_baseline / n_med as f64,
            scalar_baseline / n2_med as f64,
        );
    }

    eprintln!(
        "done: {} iters per variant, output len={}",
        bench_iters,
        ref_out.len()
    );
}
