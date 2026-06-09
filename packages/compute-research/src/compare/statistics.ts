/**
 * Statistical functions for comparing benchmark runs.
 *
 * Provides bootstrap confidence intervals, Cohen's d effect size,
 * paired-difference summaries, and outlier detection — all using
 * Bun-native APIs with no runtime dependencies.
 */

// ── Seeded PRNG (mulberry32) ────────────────────────────────────────────────

/**
 * Create a deterministic pseudo-random number generator from a seed.
 * Uses the mulberry32 algorithm. Returns a function that yields values in [0, 1).
 */
function seededRandom(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── Bootstrap confidence intervals ──────────────────────────────────────────

/**
 * Compute a bootstrap percentile confidence interval for the difference
 * of means between two **independent** groups.
 *
 * For each replicate:
 *   1. Resample `a` with replacement → `a*`
 *   2. Resample `b` with replacement → `b*`
 *   3. Compute `mean(a*) - mean(b*)`
 *
 * The replicate differences are sorted and percentile bounds extracted.
 *
 * @param a            Baseline group observations.
 * @param b            Treatment group observations.
 * @param confidence   Confidence level, e.g. 0.95 for 95 % CI.
 * @param nBootstrap   Number of bootstrap resamples (default 10_000).
 * @param seed         Optional seed for reproducible random resampling.
 * @returns            `{ lower, upper }` percentile bounds.
 */
export function bootstrapIndependentCI(
  a: number[],
  b: number[],
  confidence: number,
  nBootstrap = 10_000,
  seed?: number,
): { lower: number; upper: number } {
  if (a.length < 2 || b.length < 2) {
    throw new Error(
      `bootstrapIndependentCI requires ≥2 samples per group, got ${a.length} and ${b.length}`,
    );
  }
  if (confidence <= 0 || confidence >= 1) {
    throw new RangeError(`confidence must be in (0,1), got ${confidence}`);
  }

  const rng: () => number =
    seed !== undefined ? seededRandom(seed) : Math.random;
  const nA = a.length;
  const nB = b.length;
  const diffs = new Float64Array(nBootstrap);

  for (let i = 0; i < nBootstrap; i++) {
    let sumA = 0;
    for (let j = 0; j < nA; j++) {
      sumA += a[Math.floor(rng() * nA)]!;
    }
    const meanA = sumA / nA;

    let sumB = 0;
    for (let j = 0; j < nB; j++) {
      sumB += b[Math.floor(rng() * nB)]!;
    }
    const meanB = sumB / nB;

    diffs[i] = meanB - meanA; // treatment - baseline
  }

  diffs.sort();

  const tail = (1 - confidence) / 2;
  const lowerIdx = Math.floor(nBootstrap * tail);
  const upperIdx = Math.floor(nBootstrap * (1 - tail)) - 1;

  return {
    lower: diffs[lowerIdx]!,
    upper: diffs[upperIdx]!,
  };
}

/**
 * Compute a bootstrap percentile confidence interval for the mean of
 * **paired** differences.
 *
 * The caller is responsible for computing `treatment[i] - baseline[i]`
 * upfront and passing the result as `differences`.
 *
 * Each bootstrap replicate resamples the paired differences with
 * replacement and computes the mean. The replicate means are sorted
 * and percentile bounds extracted.
 *
 * @param differences  Paired differences (treatment - baseline).
 * @param confidence   Confidence level, e.g. 0.95 for 95 % CI.
 * @param nBootstrap   Number of bootstrap resamples (default 10_000).
 * @param seed         Optional seed for reproducible random resampling.
 * @returns            `{ lower, upper }` percentile bounds.
 */
export function bootstrapPairedCI(
  differences: number[],
  confidence: number,
  nBootstrap = 10_000,
  seed?: number,
): { lower: number; upper: number } {
  if (differences.length < 2) {
    throw new Error(
      `bootstrapPairedCI requires ≥2 differences, got ${differences.length}`,
    );
  }
  if (confidence <= 0 || confidence >= 1) {
    throw new RangeError(`confidence must be in (0,1), got ${confidence}`);
  }

  const rng: () => number =
    seed !== undefined ? seededRandom(seed) : Math.random;
  const n = differences.length;
  const means = new Float64Array(nBootstrap);

  for (let i = 0; i < nBootstrap; i++) {
    let sum = 0;
    for (let j = 0; j < n; j++) {
      sum += differences[Math.floor(rng() * n)]!;
    }
    means[i] = sum / n;
  }

  means.sort();

  const tail = (1 - confidence) / 2;
  const lowerIdx = Math.floor(nBootstrap * tail);
  const upperIdx = Math.floor(nBootstrap * (1 - tail)) - 1;

  return {
    lower: means[lowerIdx]!,
    upper: means[upperIdx]!,
  };
}

// ── Cohen's d (pooled) ───────────────────────────────────────────────────────

/**
 * Compute Cohen's d (pooled standard deviation) between two independent groups.
 *
 * Positive values indicate `a` > `b`; negative values indicate `b` > `a`.
 */
export function cohensD(a: number[], b: number[]): number {
  if (a.length < 2 || b.length < 2) {
    throw new Error("cohensD requires ≥2 samples per group");
  }

  const meanA = mean(a);
  const meanB = mean(b);
  const varA = variance(a, meanA);
  const varB = variance(b, meanB);

  const pooled = Math.sqrt(
    ((a.length - 1) * varA + (b.length - 1) * varB) /
      (a.length + b.length - 2),
  );

  return pooled === 0 ? 0 : (meanA - meanB) / pooled;
}

// ── Paired difference ────────────────────────────────────────────────────────

export interface PairedDifference {
  mean: number;
  median: number;
  p50: number;
  p95: number;
}

/**
 * Compute paired differences between two same-length arrays.
 *
 * Each element is `b[i] - a[i]` (treatment minus baseline), so a positive
 * value means the treatment increased the metric.
 */
export function pairedDifference(a: number[], b: number[]): PairedDifference {
  if (a.length !== b.length) {
    throw new Error(
      `pairedDifference requires equal-length arrays, got ${a.length} vs ${b.length}`,
    );
  }
  if (a.length === 0) {
    throw new Error("pairedDifference requires non-empty arrays");
  }

  const diffs = new Float64Array(a.length);
  for (let i = 0; i < a.length; i++) {
    diffs[i] = b[i]! - a[i]!;
  }
  diffs.sort();

  const m = mean(diffs);
  const med = median(diffs);
  const p50Val = percentile(diffs, 0.5);
  const p95Val = percentile(diffs, 0.95);

  return { mean: m, median: med, p50: p50Val, p95: p95Val };
}

// ── Outlier detection ────────────────────────────────────────────────────────

/**
 * Return the indices of observations flagged as outliers.
 *
 * - `iqr`: values outside [Q1 - 1.5*IQR, Q3 + 1.5*IQR]
 * - `mad`: values more than 3 * MAD from the median
 */
export function outlierDetect(
  values: number[],
  method: "iqr" | "mad",
): number[] {
  if (values.length < 4) return [];

  const sorted = Float64Array.from(values).sort();
  const indices: number[] = [];

  if (method === "iqr") {
    const q1 = percentile(sorted, 0.25);
    const q3 = percentile(sorted, 0.75);
    const iqr = q3 - q1;
    const lower = q1 - 1.5 * iqr;
    const upper = q3 + 1.5 * iqr;
    for (let i = 0; i < values.length; i++) {
      if (values[i]! < lower || values[i]! > upper) indices.push(i);
    }
  } else {
    const med = median(sorted);
    const diffs = new Float64Array(values.length);
    for (let i = 0; i < values.length; i++) {
      diffs[i] = Math.abs(values[i]! - med);
    }
    diffs.sort();
    const mad = median(diffs) * 1.4826; // scaled MAD for normal consistency
    const threshold = 3 * mad;
    for (let i = 0; i < values.length; i++) {
      if (Math.abs(values[i]! - med) > threshold) indices.push(i);
    }
  }

  return indices;
}

// ── Internal helpers ─────────────────────────────────────────────────────────

function mean(arr: Float64Array | number[]): number {
  let sum = 0;
  for (let i = 0; i < arr.length; i++) sum += arr[i]!;
  return sum / arr.length;
}

function variance(arr: number[], m: number): number {
  let sumSq = 0;
  for (let i = 0; i < arr.length; i++) {
    const d = arr[i]! - m;
    sumSq += d * d;
  }
  return sumSq / (arr.length - 1);
}

function median(sorted: Float64Array): number {
  const n = sorted.length;
  if (n === 0) return 0;
  if (n % 2 === 1) return sorted[Math.floor(n / 2)]!;
  return (sorted[n / 2 - 1]! + sorted[n / 2]!) / 2;
}

function percentile(sorted: Float64Array, p: number): number {
  const n = sorted.length;
  if (n === 0) return 0;
  const idx = p * (n - 1);
  const lo = Math.floor(idx);
  const hi = Math.min(lo + 1, n - 1);
  const frac = idx - lo;
  return sorted[lo]! * (1 - frac) + sorted[hi]! * frac;
}
