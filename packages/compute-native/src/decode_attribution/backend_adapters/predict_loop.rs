//! Backend-neutral cold/warmup/steady timing loops.
//!
//! Each function accepts an `execute` closure that runs a backend prediction
//! and returns `(duration_ns, output_hashes, output_f32_arrays)`.  The loops
//! handle timing, side-effect suppression via `std::hint::black_box`, and
//! aggregation — the backend only needs to provide the execution primitive.

use crate::decode_attribution::statistics::{compute_distribution_stats, DistributionStats};
use std::hint::black_box;

/// Run cold prediction: exactly one execution, timed.
///
/// Returns `(duration_ns, output_hashes, output_arrays)`.
pub fn run_cold<F>(mut execute: F) -> Result<(u64, Vec<String>, Vec<Vec<f32>>), String>
where
    F: FnMut() -> Result<(u64, Vec<String>, Vec<Vec<f32>>), String>,
{
    let (cold_ns, output_hashes, outputs) = execute()?;
    // Prevent the compiler from discarding outputs as dead.
    for out in &outputs {
        black_box(out.as_ptr());
    }
    Ok((cold_ns, output_hashes, outputs))
}

/// Run warmup iterations.
///
/// Executes `n` predictions, discards per-iteration samples, records total
/// wall time and the final output.
///
/// Returns `(iterations, total_duration_ns, last_outputs)`.
pub fn run_warmup<F>(mut execute: F, n: u32) -> Result<(u32, u64, Vec<Vec<f32>>), String>
where
    F: FnMut() -> Result<(u64, Vec<String>, Vec<Vec<f32>>), String>,
{
    let mut total_ns: u64 = 0;
    let mut last_outputs: Vec<Vec<f32>> = vec![];

    for _ in 0..n {
        let (dur, _hashes, outputs) = execute()?;
        total_ns = total_ns.wrapping_add(dur);
        // Consume at least one element per output to signal side-effect liveness.
        for out in &outputs {
            black_box(out.first().copied().unwrap_or(0.0_f32));
        }
        last_outputs = outputs;
    }

    Ok((n, total_ns, last_outputs))
}

/// Run steady-state timed iterations.
///
/// Executes `m` predictions, preserves every raw sample for distribution
/// analysis, and computes summary statistics.
///
/// Returns `(iterations, samples_ns, total_duration_ns, stats, last_outputs)`.
pub fn run_steady<F>(
    mut execute: F,
    m: u32,
) -> Result<
    (
        u32,               // iterations (always m)
        Vec<u64>,          // samples_ns — raw per-iteration latencies
        u64,               // total_ns — sum of all samples
        DistributionStats, // distribution statistics
        Vec<Vec<f32>>,     // last_outputs
    ),
    String,
>
where
    F: FnMut() -> Result<(u64, Vec<String>, Vec<Vec<f32>>), String>,
{
    let mut samples_ns = Vec::with_capacity(m as usize);
    let mut last_outputs: Vec<Vec<f32>> = vec![];

    for _ in 0..m {
        let (dur, _hashes, outputs) = execute()?;
        samples_ns.push(dur);
        for out in &outputs {
            black_box(out.first().copied().unwrap_or(0.0_f32));
        }
        last_outputs = outputs;
    }

    let total_ns: u64 = samples_ns.iter().copied().sum();
    let stats = compute_distribution_stats(&samples_ns);

    Ok((m, samples_ns, total_ns, stats, last_outputs))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A fake execute that always succeeds and returns known values.
    fn fake_exec(
        dur_ns: u64,
        outputs: Vec<Vec<f32>>,
    ) -> impl FnMut() -> Result<(u64, Vec<String>, Vec<Vec<f32>>), String> {
        let output_hashes: Vec<String> = outputs
            .iter()
            .map(|o| crate::decode_attribution::backend_adapters::conformance::hash_output(o))
            .collect();
        move || Ok((dur_ns, output_hashes.clone(), outputs.clone()))
    }

    #[test]
    fn test_run_cold() {
        let mut exec = fake_exec(1000, vec![vec![1.0_f32, 2.0]]);
        let result = run_cold(&mut exec).unwrap();
        assert_eq!(result.0, 1000, "cold duration");
        assert_eq!(result.1.len(), 1, "one output hash");
        assert_eq!(result.2.len(), 1, "one output tensor");
    }

    #[test]
    fn test_run_cold_propagates_error() {
        let mut exec = || Err::<(u64, Vec<String>, Vec<Vec<f32>>), _>("broken".to_string());
        let result = run_cold(&mut exec);
        assert!(result.is_err());
    }

    #[test]
    fn test_run_warmup_count_and_total() {
        let mut exec = fake_exec(500, vec![vec![3.0_f32]]);
        let (n, total_ns, outputs) = run_warmup(&mut exec, 10).unwrap();
        assert_eq!(n, 10);
        assert_eq!(total_ns, 5000);
        assert_eq!(outputs, vec![vec![3.0_f32]]);
    }

    #[test]
    fn test_run_warmup_zero_iterations() {
        let mut exec = fake_exec(100, vec![vec![0.0_f32]]);
        let (n, total_ns, outputs) = run_warmup(&mut exec, 0).unwrap();
        assert_eq!(n, 0);
        assert_eq!(total_ns, 0);
        assert!(outputs.is_empty());
    }

    #[test]
    fn test_run_steady_samples_and_stats() {
        // Inject varying durations so stats are non-trivial.
        let mut call_count = 0u32;
        let mut exec = move || {
            call_count += 1;
            let dur = 1000 * call_count as u64; // 1000, 2000, 3000, ...
            Ok::<_, String>((
                dur,
                vec![
                    crate::decode_attribution::backend_adapters::conformance::hash_output(&[
                        call_count as f32,
                    ]),
                ],
                vec![vec![call_count as f32]],
            ))
        };

        let (m, samples, total, stats, last) = run_steady(&mut exec, 5).unwrap();

        assert_eq!(m, 5);
        assert_eq!(samples.len(), 5);
        assert_eq!(samples, vec![1000, 2000, 3000, 4000, 5000]);
        assert_eq!(total, 15000);
        assert_eq!(stats.min_ns, 1000);
        assert_eq!(stats.max_ns, 5000);
        assert_eq!(stats.p50_ns, 3000);
        assert_eq!(last, vec![vec![5.0_f32]]);
    }

    #[test]
    fn test_run_steady_zero_iterations() {
        let mut exec = fake_exec(100, vec![vec![0.0_f32]]);
        let (m, samples, total, stats, last) = run_steady(&mut exec, 0).unwrap();
        assert_eq!(m, 0);
        assert!(samples.is_empty());
        assert_eq!(total, 0);
        assert_eq!(stats.p50_ns, 0);
        assert!(last.is_empty());
    }

    #[test]
    fn test_run_steady_propagates_error() {
        let mut call_count = 0u32;
        let mut exec = move || {
            call_count += 1;
            if call_count == 3 {
                Err::<(u64, Vec<String>, Vec<Vec<f32>>), _>("failed on iteration 3".to_string())
            } else {
                Ok((100, vec![], vec![]))
            }
        };
        let result = run_steady(&mut exec, 5);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("iteration 3"));
    }
}
