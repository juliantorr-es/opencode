/// Distribution statistics for decode attribution.
///
/// All functions assume non-empty input where documented.
/// Functions taking `sorted` parameters require ascending order.

/// Compute nearest-rank percentile from sorted samples (1-indexed).
///
/// The rank is computed as `ceil(percentile/100.0 * N)`, then clamped to
/// `[1, N]`. The value at 0-indexed position `rank - 1` is returned.
pub fn nearest_rank_percentile(sorted: &[f64], percentile: f64) -> f64 {
    let n = sorted.len();
    if n == 0 {
        return f64::NAN;
    }
    let rank = ((percentile / 100.0) * n as f64).ceil() as usize;
    let rank = rank.max(1).min(n);
    sorted[rank - 1]
}

/// Compute median from sorted samples.
///
/// For even-length slices, returns the average of the two middle values.
pub fn median(sorted: &[f64]) -> f64 {
    let n = sorted.len();
    if n == 0 {
        return f64::NAN;
    }
    if n % 2 == 0 {
        (sorted[n / 2 - 1] + sorted[n / 2]) / 2.0
    } else {
        sorted[n / 2]
    }
}

/// Compute population standard deviation (ddof = 0) from unsorted samples.
///
/// Uses the population formula: sqrt(sum((x_i - mean)^2) / N).
/// Returns 0 for samples with 0 or 1 elements.
pub fn stddev(samples: &[f64], mean: f64) -> f64 {
    let n = samples.len();
    if n <= 1 {
        return 0.0;
    }
    let variance = samples.iter().map(|&x| (x - mean).powi(2)).sum::<f64>() / n as f64;
    variance.sqrt()
}

/// Compute median absolute deviation from sorted samples.
///
/// MAD = median(|x_i - median(x)|).
pub fn mad(sorted: &[f64], median_val: f64) -> f64 {
    if sorted.is_empty() {
        return f64::NAN;
    }
    let mut abs_devs: Vec<f64> = sorted.iter().map(|&x| (x - median_val).abs()).collect();
    abs_devs.sort_by(|a, b| a.partial_cmp(b).unwrap());
    median(&abs_devs)
}

/// Compute interquartile range (p75 - p25) from sorted samples,
/// using nearest-rank percentiles.
pub fn iqr(sorted: &[f64]) -> f64 {
    if sorted.is_empty() {
        return f64::NAN;
    }
    let q75 = nearest_rank_percentile(sorted, 75.0);
    let q25 = nearest_rank_percentile(sorted, 25.0);
    q75 - q25
}

/// Compute arithmetic mean from unsorted samples.
pub fn mean(samples: &[f64]) -> f64 {
    let n = samples.len();
    if n == 0 {
        return f64::NAN;
    }
    samples.iter().sum::<f64>() / n as f64
}

/// Count values exceeding mean + 3σ (one-sided upper 3-sigma outlier rule).
///
/// Returns the number of samples strictly greater than `mean + 3 * stddev`.
pub fn outlier_count_3sigma(samples: &[f64], mean: f64, stddev: f64) -> u32 {
    let threshold = mean + 3.0 * stddev;
    samples.iter().filter(|&&x| x > threshold).count() as u32
}

/// Full distribution statistics result for latency samples.
#[derive(Debug, Clone, PartialEq)]
pub struct DistributionStats {
    pub p50_ns: u64,
    pub p90_ns: u64,
    pub p99_ns: u64,
    pub min_ns: u64,
    pub max_ns: u64,
    pub mean_ns: f64,
    pub stddev_ns: f64,
    pub mad_ns: f64,
    pub iqr_ns: f64,
    pub outlier_count: u32,
}

/// Compute all distribution statistics from a set of sample latencies
/// in nanoseconds.
///
/// Returns a zeroed `DistributionStats` for an empty input.
pub fn compute_distribution_stats(samples_ns: &[u64]) -> DistributionStats {
    if samples_ns.is_empty() {
        return DistributionStats {
            p50_ns: 0,
            p90_ns: 0,
            p99_ns: 0,
            min_ns: 0,
            max_ns: 0,
            mean_ns: 0.0,
            stddev_ns: 0.0,
            mad_ns: 0.0,
            iqr_ns: 0.0,
            outlier_count: 0,
        };
    }

    let samples_f64: Vec<f64> = samples_ns.iter().map(|&x| x as f64).collect();
    let mut sorted = samples_f64.clone();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap());

    let m = mean(&samples_f64);
    let sd = stddev(&samples_f64, m);
    let med = median(&sorted);
    let mad_val = mad(&sorted, med);
    let iqr_val = iqr(&sorted);

    DistributionStats {
        p50_ns: nearest_rank_percentile(&sorted, 50.0) as u64,
        p90_ns: nearest_rank_percentile(&sorted, 90.0) as u64,
        p99_ns: nearest_rank_percentile(&sorted, 99.0) as u64,
        min_ns: sorted.first().copied().unwrap_or(0.0) as u64,
        max_ns: sorted.last().copied().unwrap_or(0.0) as u64,
        mean_ns: m,
        stddev_ns: sd,
        mad_ns: mad_val,
        iqr_ns: iqr_val,
        outlier_count: outlier_count_3sigma(&samples_f64, m, sd),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_statistics_with_known_values() {
        // Feed known values and verify median, p50, and outlier detection.
        let data = vec![1.0, 2.0, 3.0, 4.0, 100.0];
        let mut sorted = data.clone();
        sorted.sort_by(|a, b| a.partial_cmp(b).unwrap());

        // Median of 5 elements: middle value at index 2 → 3.0
        assert_eq!(median(&sorted), 3.0);

        // Nearest-rank p50: ceil(0.5 * 5) = ceil(2.5) = 3 → index 2 → 3.0
        assert_eq!(nearest_rank_percentile(&sorted, 50.0), 3.0);
        assert_eq!(nearest_rank_percentile(&sorted, 90.0), 100.0);

        // Mean: (1 + 2 + 3 + 4 + 100) / 5 = 22.0
        let m = mean(&data);
        assert!((m - 22.0).abs() < 1e-12, "expected mean 22.0, got {}", m);

        // Population stddev for [1,2,3,4,100]:
        //   variance = (441 + 400 + 361 + 324 + 6084) / 5 = 1522.0
        let sd = stddev(&data, m);
        assert!(
            (sd.powi(2) - 1522.0).abs() < 1e-9,
            "expected variance 1522, got {}",
            sd.powi(2)
        );

        // MAD from median 3.0:
        //   absolute deviations: [2, 1, 0, 1, 97], sorted: [0, 1, 1, 2, 97]
        //   median of abs deviations = 1.0
        let med = median(&sorted);
        assert!(
            (mad(&sorted, med) - 1.0).abs() < 1e-12,
            "expected MAD 1.0, got {}",
            mad(&sorted, med)
        );

        // IQR: p75 - p25
        //   p25 = ceil(0.25 * 5) = 2 → index 1 → 2.0
        //   p75 = ceil(0.75 * 5) = 4 → index 3 → 4.0
        //   IQR = 4.0 - 2.0 = 2.0
        assert!(
            (iqr(&sorted) - 2.0).abs() < 1e-12,
            "expected IQR 2.0, got {}",
            iqr(&sorted)
        );
    }

    #[test]
    fn test_outlier_detection() {
        // Concentrated data where 100.0 is >3σ from mean.
        // 15 copies of 1.0 + one 100.0 → mean pulled to ~7.19,
        // stddev ~23.96, so mean+3σ ≈ 79.1 and 100.0 exceeds it.
        let mut tight = vec![1.0_f64; 15];
        tight.push(100.0);
        let m = mean(&tight);
        let sd = stddev(&tight, m);
        let outliers = outlier_count_3sigma(&tight, m, sd);
        assert!(
            outliers > 0,
            "100.0 should be a >3σ outlier in concentrated data; mean={}, sd={}, threshold={}",
            m,
            sd,
            m + 3.0 * sd
        );

        // No outliers in uniform data
        let uniform = vec![10.0, 10.0, 10.0, 10.0, 10.0];
        let mu = mean(&uniform);
        let sdu = stddev(&uniform, mu);
        assert_eq!(outlier_count_3sigma(&uniform, mu, sdu), 0);
    }

    #[test]
    fn test_percentile_edge_cases() {
        let sorted = vec![10.0, 20.0, 30.0, 40.0, 50.0];

        // P0 clamped to rank 1 → first element
        assert_eq!(nearest_rank_percentile(&sorted, 0.0), 10.0);

        // P100 clamped to rank N → last element
        assert_eq!(nearest_rank_percentile(&sorted, 100.0), 50.0);

        // Single element always returns it
        assert_eq!(nearest_rank_percentile(&[42.0], 0.0), 42.0);
        assert_eq!(nearest_rank_percentile(&[42.0], 50.0), 42.0);
        assert_eq!(nearest_rank_percentile(&[42.0], 100.0), 42.0);

        // Empty → NaN
        assert!(nearest_rank_percentile(&[], 50.0).is_nan());
    }

    #[test]
    fn test_even_length_median() {
        // Even count → average of two middle values
        let sorted = vec![1.0, 2.0, 3.0, 4.0];
        assert!((median(&sorted) - 2.5).abs() < 1e-12);
    }

    #[test]
    fn test_compute_distribution_stats_round_trip() {
        let ns_samples = vec![1000, 2000, 3000, 4000, 5000];
        let stats = compute_distribution_stats(&ns_samples);

        assert_eq!(stats.p50_ns, 3000);
        assert_eq!(stats.p90_ns, 5000);
        assert_eq!(stats.p99_ns, 5000);
        assert_eq!(stats.min_ns, 1000);
        assert_eq!(stats.max_ns, 5000);
        assert!((stats.mean_ns - 3000.0).abs() < 1e-9);
        assert_eq!(stats.outlier_count, 0);
    }

    #[test]
    fn test_empty_inputs() {
        assert!(mean(&[]).is_nan());
        assert!(median(&[]).is_nan());
        assert!(iqr(&[]).is_nan());
        let stats = compute_distribution_stats(&[]);
        assert_eq!(stats.p50_ns, 0);
        assert_eq!(stats.outlier_count, 0);
    }

    #[test]
    fn test_stddev_single_element() {
        assert_eq!(stddev(&[42.0], 42.0), 0.0);
    }
}
