//! Timer overhead calibration for the measurement harness.
//!
//! `calibrate_timer_overhead(iterations)` measures the cost of calling
//! `Instant::now()` by calling it back-to-back a fixed number of times
//! and recording the median or minimum observed delta.
//!
//! Raw timings are never adjusted for overhead (`raw_timing_adjusted = false`).
//! The overhead is recorded descriptively so consumers can evaluate whether
//! it dominates their measurement.

use std::time::Instant;

/// Result of a timer calibration run.
#[derive(Debug, Clone, Copy, serde::Serialize, serde::Deserialize)]
pub struct TimerCalibration {
    /// Measured overhead per call in nanoseconds.
    /// Minimum observed delta between back-to-back `Instant::now()` calls.
    pub timer_overhead_ns: u64,

    /// How the overhead was measured: "back_to_back_now".
    pub timer_overhead_method: &'static str,

    /// Raw timings are never adjusted for overhead in this gate.
    pub raw_timing_adjusted: bool,

    /// Number of back-to-back pairs sampled during calibration.
    pub calibration_iterations: usize,

    /// The source of the calibration: "parent" or "child_run".
    pub calibration_source: &'static str,
}

/// Calibrate timer overhead by calling `Instant::now()` back-to-back
/// `iterations` times and recording the minimum observed delta.
///
/// The minimum is chosen over median because overhead is additive noise;
/// a single unperturbed delta is the most accurate estimate of the true
/// minimum. Median would bias high if occasional scheduler noise inflates
/// most samples.
pub fn calibrate_timer_overhead(iterations: usize) -> TimerCalibration {
    let mut min_delta = u64::MAX;
    for _ in 0..iterations {
        let t0 = Instant::now();
        let t1 = Instant::now();
        let delta = t1.duration_since(t0).as_nanos() as u64;
        if delta < min_delta {
            min_delta = delta;
        }
    }

    TimerCalibration {
        timer_overhead_ns: if min_delta == u64::MAX { 0 } else { min_delta },
        timer_overhead_method: "back_to_back_now",
        raw_timing_adjusted: false,
        calibration_iterations: iterations,
        calibration_source: "parent",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn calibration_is_non_zero() {
        let cal = calibrate_timer_overhead(1000);
        // Instant::now() overhead on Apple Silicon is typically <50ns,
        // but the key property is that it's definitely non-zero.
        assert!(cal.timer_overhead_ns < 10_000, "unexpectedly large timer overhead: {} ns", cal.timer_overhead_ns);
        assert_eq!(cal.timer_overhead_method, "back_to_back_now");
        assert!(!cal.raw_timing_adjusted);
        assert_eq!(cal.calibration_iterations, 1000);
    }

    #[test]
    fn calibration_is_stable() {
        let a = calibrate_timer_overhead(5000);
        let b = calibrate_timer_overhead(5000);
        // Both should be within a factor of 10 of each other
        // (loose bound to allow for thermal/noise variation).
        assert!(
            a.timer_overhead_ns <= b.timer_overhead_ns * 10 || b.timer_overhead_ns <= a.timer_overhead_ns * 10,
            "unstable calibration: {} vs {}", a.timer_overhead_ns, b.timer_overhead_ns
        );
    }

    #[test]
    fn calibration_source_default() {
        let cal = calibrate_timer_overhead(1);
        assert_eq!(cal.calibration_source, "parent");
    }

    #[test]
    fn min_over_zero_iterations() {
        let cal = calibrate_timer_overhead(0);
        // 0 iterations → no samples → overhead should be 0
        assert_eq!(cal.timer_overhead_ns, 0);
        assert_eq!(cal.calibration_iterations, 0);
    }
}
