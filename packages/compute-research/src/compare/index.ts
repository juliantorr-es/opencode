/**
 * Comparison module — reads two finalized run directories and produces
 * a structured `ComparisonRecord` with statistical, correctness, and
 * bottleneck-evidence summaries.
 */

import type { StageShare, BottleneckLedger } from "./bottleneck.js";
import { buildBottleneckLedger } from "./bottleneck.js";
import {
  bootstrapIndependentCI,
  bootstrapPairedCI,
  cohensD,
  pairedDifference,
  outlierDetect,
} from "./statistics.js";
import type { PairedDifference } from "./statistics.js";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { join, resolve } from "path";

// ── Types ─────────────────────────────────────────────────────────────────────

/** An event logged during a run (one line of the events JSONL file). */
export interface Event {
  /** Event category or stage label, e.g. `"inference"`, `"tokenize"`. */
  stage?: string;
  /** Wall-clock duration in milliseconds (when applicable). */
  durationMs?: number;
  /** Arbitrary metadata attached at record time. */
  [key: string]: unknown;
}

/** Configuration for a comparison operation. */
export interface ComparisonConfig {
  /** Path to the directory containing finalized baseline runs. */
  readonly baselineRoot: string;
  /** Path to the directory containing finalized treatment runs. */
  readonly treatmentRoot: string;
  /** Path under which comparison results are written. */
  readonly outputRoot: string;
  /** Primary metric key extracted from events/metrics. */
  readonly primaryMetric: string;
  /** Secondary metric keys to include in the report. */
  readonly secondaryMetrics?: string[];
  /** Wall-clock budget in ms — runs exceeding this are flagged. */
  readonly wallClockBudgetMs?: number;
  /** Memory ceiling in bytes — runs exceeding this are flagged. */
  readonly memoryCeilingBytes?: number;
  /** Confidence level for bootstrap CIs (default 0.95). */
  readonly confidence?: number;
  /** Number of bootstrap resamples (default 10_000). */
  readonly nBootstrap?: number;
  /** Force paired analysis (default: auto-detect when lengths match). */
  readonly paired?: boolean;
  /** Seed for reproducible bootstrap resampling. */
  readonly randomSeed?: number;
}

export type ComparisonRecommendation =
  | "promoted"
  | "rejected"
  | "deferred"
  | "research_only"
  | "inconclusive";

export interface CorrectnessGateResult {
  /** Did the treatment run pass this gate? */
  pass: boolean;
  /** Human-readable detail when the gate fails. */
  detail: string;
}

export interface SummaryStats {
  /** Number of observations. */
  readonly n: number;
  readonly mean: number;
  readonly median: number;
  readonly min: number;
  readonly max: number;
  readonly stddev: number;
  readonly iqr: number;
  readonly mad: number;
  readonly percentile25: number;
  readonly percentile75: number;
  readonly percentile95: number;
  readonly percentile50: number;
}

export interface ComparisonRecord {
  /** ISO 8601 timestamp of comparison creation. */
  readonly timestamp: string;
  readonly baselineRunId: string;
  readonly treatmentRunId: string;
  readonly workload: string;
  readonly machine: string;
  readonly instrumentation: string;
  readonly warmupClass: string;

  readonly primaryMetric: string;
  readonly secondaryMetrics: readonly string[];

  readonly baselineSummary: SummaryStats;
  readonly treatmentSummary: SummaryStats;

  readonly absoluteDifference: number;
  readonly percentageDifference: number;

  readonly ci: { lower: number; upper: number };
  readonly effectSize: number;

  readonly analysis_method: "paired" | "independent";
  readonly bootstrap_statistic: "mean_difference";
  readonly bootstrap_count: number;
  readonly confidence_level: number;
  readonly random_seed: number | undefined;
  readonly ci_method: "percentile";

  readonly pairedDiff: PairedDifference;
  readonly outlierIndices: readonly number[];

  readonly bottleneckLedger: BottleneckLedger;
  readonly correctness: Record<string, CorrectnessGateResult>;
  readonly evidenceComplete: boolean;

  readonly recommendation: ComparisonRecommendation;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Run a full comparison between a baseline and a treatment run directory.
 *
 * Reads the finalized run manifest, provenance, workload, and events from
 * each directory, computes paired statistics and a bootstrap CI, checks
 * correctness gates, and saves a `comparison.json` under `outputRoot`.
 */
export async function runComparison(
  baselineRunId: string,
  treatmentRunId: string,
  config: ComparisonConfig,
): Promise<ComparisonRecord> {
  // 1. Load run manifests & metadata
  const baselineDir = resolve(config.baselineRoot, baselineRunId);
  const treatmentDir = resolve(config.treatmentRoot, treatmentRunId);

  const baselineManifest = readJsonFile<Record<string, unknown>>(
    join(baselineDir, "run-manifest.json"),
  );
  const treatmentManifest = readJsonFile<Record<string, unknown>>(
    join(treatmentDir, "run-manifest.json"),
  );
  const baselineWorkload = readJsonFile<Record<string, unknown>>(
    join(baselineDir, "workload.json"),
  );
  const treatmentWorkload = readJsonFile<Record<string, unknown>>(
    join(treatmentDir, "workload.json"),
  );
  const baselineEvents = readEvents(baselineDir);
  const treatmentEvents = readEvents(treatmentDir);
  const baselineProvenance = readJsonFile<Record<string, unknown>>(
    join(baselineDir, "provenance.json"),
  );
  const treatmentProvenance = readJsonFile<Record<string, unknown>>(
    join(treatmentDir, "provenance.json"),
  );

  // 2. Extract metadata
  const workload = String(
    baselineWorkload?.name ?? treatmentWorkload?.name ?? "unknown",
  );
  const machine = extractMachine(baselineProvenance, treatmentProvenance);
  const instrumentation = String(
    baselineManifest?.instrumentation ?? treatmentManifest?.instrumentation ?? "unknown",
  );
  const warmupClass = String(
    baselineManifest?.warmupClass ?? baselineManifest?.warmup_class ?? treatmentManifest?.warmupClass ?? "none",
  );

  // 3. Extract primary metric values
  const primaryMetric = config.primaryMetric;
  const baselineValues = extractMetric(baselineEvents, primaryMetric);
  const treatmentValues = extractMetric(treatmentEvents, primaryMetric);

  // 4. Compute summary statistics
  const baselineSummary = computeSummaryStats(baselineValues);
  const treatmentSummary = computeSummaryStats(treatmentValues);

  // 5. Compute differences
  const absoluteDifference = treatmentSummary.mean - baselineSummary.mean;
  const percentageDifference =
    baselineSummary.mean !== 0
      ? (absoluteDifference / Math.abs(baselineSummary.mean)) * 100
      : 0;

  // 6. Bootstrap CI on the difference of means (treatment - baseline)
  const isPaired =
    config.paired ?? (baselineValues.length === treatmentValues.length);
  const nBootstrap = config.nBootstrap ?? 10_000;
  const confidenceLevel = config.confidence ?? 0.95;

  let ci: { lower: number; upper: number };
  if (baselineValues.length < 2 || treatmentValues.length < 2) {
    ci = { lower: 0, upper: 0 };
  } else if (isPaired) {
    const diffs = baselineValues.map((b, i) => treatmentValues[i]! - b);
    ci = bootstrapPairedCI(
      diffs,
      confidenceLevel,
      nBootstrap,
      config.randomSeed,
    );
  } else {
    ci = bootstrapIndependentCI(
      baselineValues,
      treatmentValues,
      confidenceLevel,
      nBootstrap,
      config.randomSeed,
    );
  }

  const analysisMethod: "paired" | "independent" = isPaired
    ? "paired"
    : "independent";

  // 7. Effect size
  const effectSize =
    baselineValues.length >= 2 && treatmentValues.length >= 2
      ? cohensD(baselineValues, treatmentValues)
      : 0;

  // 8. Paired differences (treat paired samples as treatment - baseline)
  const pairedDiff =
    baselineValues.length === treatmentValues.length
      ? pairedDifference(baselineValues, treatmentValues)
      : {
          mean: absoluteDifference,
          median: treatmentSummary.median - baselineSummary.median,
          p50: treatmentSummary.percentile50 - baselineSummary.percentile50,
          p95: treatmentSummary.percentile95 - baselineSummary.percentile95,
        };

  // 9. Outlier detection (on treatment values)
  const outlierIndices = outlierDetect(treatmentValues, "iqr");

  // 10. Bottleneck analysis
  const bottleneckLedger = buildBottleneckLedger(baselineEvents, treatmentEvents);

  // 11. Correctness gates
  const correctness = checkCorrectnessGates(
    treatmentEvents,
    treatmentManifest,
    config,
  );

  // 12. Evidence completeness
  const evidenceComplete = checkEvidenceComplete(
    { manifest: baselineManifest, workload: baselineWorkload, provenance: baselineProvenance, events: baselineEvents.length },
    { manifest: treatmentManifest, workload: treatmentWorkload, provenance: treatmentProvenance, events: treatmentEvents.length },
  );

  // 13. Recommendation
  const recommendation = deriveRecommendation(
    correctness,
    evidenceComplete,
    effectSize,
    ci,
  );

  const record: ComparisonRecord = {
    timestamp: new Date().toISOString(),
    baselineRunId,
    treatmentRunId,
    workload,
    machine,
    instrumentation,
    warmupClass,
    primaryMetric,
    secondaryMetrics: config.secondaryMetrics ?? [],
    baselineSummary,
    treatmentSummary,
    absoluteDifference,
    percentageDifference,
    ci,
    effectSize,
    analysis_method: analysisMethod,
    bootstrap_statistic: "mean_difference",
    bootstrap_count: nBootstrap,
    confidence_level: confidenceLevel,
    random_seed: config.randomSeed,
    ci_method: "percentile",
    pairedDiff,
    outlierIndices,
    bottleneckLedger,
    correctness,
    evidenceComplete,
    recommendation,
  };

  // 14. Persist comparison.json
  const compDir = resolve(config.outputRoot, "comparisons");
  mkdirSync(compDir, { recursive: true });
  const compPath = join(compDir, "comparison.json");
  writeFileSync(compPath, JSON.stringify(record, null, 2) + "\n");

  return record;
}

// ── Correctness gates ─────────────────────────────────────────────────────────

function checkCorrectnessGates(
  events: Event[],
  manifest: Record<string, unknown> | null,
  config: ComparisonConfig,
): Record<string, CorrectnessGateResult> {
  const gates: Record<string, CorrectnessGateResult> = {};

  // Token match: check for tokenization events that match expected counts
  gates.tokenMatch = checkGate(
    events.some((e) => {
      const stage = (e as Record<string, unknown>).stage;
      return stage != null && String(stage).includes("token");
    }),
    "No token events found; token match not verifiable",
  );

  // Numerical tolerance: flag if any value is NaN or Infinity
  const metric = config.primaryMetric;
  const values = extractMetric(events, metric);
  const hasInvalid = values.some((v) => !Number.isFinite(v));
  gates.numericalTolerance = checkGate(
    !hasInvalid,
    hasInvalid
      ? `Primary metric "${metric}" contains NaN or infinite values`
      : "All metric values are finite",
  );

  // Handle cleanup: check for start/finish events
  const hasStart = events.some(
    (e) => (e as Record<string, unknown>).event === "start" || (e as Record<string, unknown>).stage === "start",
  );
  const hasFinish = events.some(
    (e) => (e as Record<string, unknown>).event === "finish" || (e as Record<string, unknown>).stage === "finish",
  );
  gates.handleCleanup = checkGate(
    hasStart && hasFinish,
    hasStart
      ? "Run started but no finish event found"
      : hasFinish
        ? "Run has finish event but no start event"
        : "No start or finish events — handle lifecycle incomplete",
  );

  // Wall-clock budget
  if (config.wallClockBudgetMs != null) {
    // Sum durations from timed events as a proxy for wall clock
    const totalTime = events.reduce(
      (sum, e) => sum + ((e as Record<string, unknown>).durationMs as number ?? 0),
      0,
    );
    gates.wallClockBudget = checkGate(
      totalTime <= config.wallClockBudgetMs,
      `Total event time ${totalTime.toFixed(1)}ms exceeds budget ${config.wallClockBudgetMs}ms`,
    );
  } else {
    gates.wallClockBudget = { pass: true, detail: "No wall-clock budget configured" };
  }

  // Memory ceiling
  if (config.memoryCeilingBytes != null) {
    const maxMem = Math.max(
      ...events.map((e) => (e as Record<string, unknown>).memoryBytes as number ?? 0),
    );
    gates.memoryCeiling = checkGate(
      maxMem <= config.memoryCeilingBytes,
      `Peak memory ${maxMem}B exceeds ceiling ${config.memoryCeilingBytes}B`,
    );
  } else {
    gates.memoryCeiling = { pass: true, detail: "No memory ceiling configured" };
  }

  // Worker containment: check for worker-related events
  const workerCount = events.filter(
    (e) => String((e as Record<string, unknown>).stage ?? "").includes("worker"),
  ).length;
  gates.workerContainment = checkGate(
    workerCount > 0,
    workerCount === 0
      ? "No worker events — worker containment not verified"
      : `${workerCount} worker events recorded`,
  );

  // File I/O: check for I/O events
  const ioEvents = events.filter(
    (e) =>
      String((e as Record<string, unknown>).stage ?? "").includes("io") ||
      String((e as Record<string, unknown>).stage ?? "").includes("file"),
  );
  gates.fileIO = checkGate(
    ioEvents.length > 0,
    ioEvents.length === 0
      ? "No file I/O events recorded"
      : `${ioEvents.length} file I/O events recorded`,
  );

  return gates;
}

// ── Evidence completeness ─────────────────────────────────────────────────────

function checkEvidenceComplete(
  baseline: {
    manifest: Record<string, unknown> | null;
    workload: Record<string, unknown> | null;
    provenance: Record<string, unknown> | null;
    events: number;
  },
  treatment: {
    manifest: Record<string, unknown> | null;
    workload: Record<string, unknown> | null;
    provenance: Record<string, unknown> | null;
    events: number;
  },
): boolean {
  return (
    baseline.manifest != null &&
    baseline.workload != null &&
    baseline.provenance != null &&
    baseline.events > 0 &&
    treatment.manifest != null &&
    treatment.workload != null &&
    treatment.provenance != null &&
    treatment.events > 0
  );
}

// ── Recommendation ────────────────────────────────────────────────────────────

function deriveRecommendation(
  correctness: Record<string, CorrectnessGateResult>,
  evidenceComplete: boolean,
  effectSize: number,
  ci: { lower: number; upper: number },
): ComparisonRecommendation {
  const allGatesPass = Object.values(correctness).every((g) => g.pass);

  if (!evidenceComplete) return "inconclusive";
  if (!allGatesPass) return "rejected";

  // Effect not distinguishable from zero — CI straddles zero
  if (ci.lower <= 0 && ci.upper >= 0) {
    return "research_only";
  }

  // Effect size guidelines (Cohen): small≈0.2, medium≈0.5, large≈0.8
  const absD = Math.abs(effectSize);

  if (absD < 0.2) {
    return "research_only";
  }
  // baseline - treatment: positive = improvement (lower latency/memory), negative = regression
  const improved = effectSize > 0;
  if (absD >= 0.5 && improved && ci.upper < 0) {
    return "promoted";
  }
  if (absD >= 0.5 && !improved && ci.lower > 0) {
    return "rejected";
  }
  if (absD >= 0.2) {
    return "deferred";
  }

  return "research_only";
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function readJsonFile<T>(path: string): T | null {
  try {
    const raw = readFileSync(path, "utf-8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function readEvents(runDir: string): Event[] {
  try {
    const raw = readFileSync(join(runDir, "events.jsonl"), "utf-8");
    const lines = raw.trim().split("\n");
    const events: Event[] = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed) {
        try {
          events.push(JSON.parse(trimmed) as Event);
        } catch {
          // skip malformed lines
        }
      }
    }
    return events;
  } catch {
    return [];
  }
}

/** Extract numeric values for a named metric from the event stream. */
function extractMetric(events: Event[], metric: string): number[] {
  const values: number[] = [];
  for (const ev of events) {
    const v = (ev as Record<string, unknown>)[metric];
    if (typeof v === "number" && Number.isFinite(v)) {
      values.push(v);
    }
  }
  // Also check for a nested `metrics` object
  for (const ev of events) {
    const metrics = (ev as Record<string, unknown>).metrics as Record<string, unknown> | undefined;
    if (metrics && typeof metrics[metric] === "number") {
      values.push(metrics[metric] as number);
    }
  }
  return values;
}

function computeSummaryStats(values: number[]): SummaryStats {
  if (values.length === 0) {
    return {
      n: 0, mean: 0, median: 0, min: 0, max: 0,
      stddev: 0, iqr: 0, mad: 0,
     percentile25: 0, percentile75: 0, percentile95: 0, percentile50: 0,
    };
  }

  const sorted = Float64Array.from(values).sort();
  const n = sorted.length;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += sorted[i]!;
  const meanVal = sum / n;

  // Variance / stddev
  let sumSq = 0;
  for (let i = 0; i < n; i++) {
    const d = sorted[i]! - meanVal;
    sumSq += d * d;
  }
  const stddev = n > 1 ? Math.sqrt(sumSq / (n - 1)) : 0;

  // Median
  const medianVal =
    n % 2 === 1
      ? sorted[Math.floor(n / 2)]!
      : (sorted[n / 2 - 1]! + sorted[n / 2]!) / 2;

  // Percentiles
  const p25 = percentileSorted(sorted, 0.25);
  const p75 = percentileSorted(sorted, 0.75);
  const p95 = percentileSorted(sorted, 0.95);

  // IQR
  const iqr = p75 - p25;

  // MAD (median absolute deviation)
  const diffs = new Float64Array(n);
  for (let i = 0; i < n; i++) diffs[i] = Math.abs(sorted[i]! - medianVal);
  diffs.sort();
  const mad =
    n % 2 === 1
      ? diffs[Math.floor(n / 2)]!
      : (diffs[n / 2 - 1]! + diffs[n / 2]!) / 2;

  return {
    n,
    mean: meanVal,
    median: medianVal,
    min: sorted[0]!,
    max: sorted[n - 1]!,
    stddev,
    iqr,
    mad,
    percentile25: p25,
   percentile50: medianVal,
    percentile75: p75,
    percentile95: p95,
  };
}

function percentileSorted(sorted: Float64Array, p: number): number {
  const n = sorted.length;
  if (n === 0) return 0;
  const idx = p * (n - 1);
  const lo = Math.floor(idx);
  const hi = Math.min(lo + 1, n - 1);
  const frac = idx - lo;
  return sorted[lo]! * (1 - frac) + sorted[hi]! * frac;
}

function checkGate(
  pass: boolean,
  detail: string,
): CorrectnessGateResult {
  return { pass, detail };
}

/** Safely extract a machine identifier from provenance records. */
function extractMachine(
  baseline: Record<string, unknown> | null,
  treatment: Record<string, unknown> | null,
): string {
  const bMachine = (baseline?.machine ?? {}) as Record<string, unknown>;
  const tMachine = (treatment?.machine ?? {}) as Record<string, unknown>;
  return String(
    bMachine.model_identifier ??
      bMachine.anon_id ??
      tMachine.model_identifier ??
      "unknown",
  );
}

// ── Re-exports ────────────────────────────────────────────────────────────────

export type { BottleneckLedger, StageShare } from "./bottleneck.js";
