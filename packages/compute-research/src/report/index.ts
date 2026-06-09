/**
 * Report generation for comparison records.
 *
 * Produces a human-readable Markdown report with correctness gates,
 * primary & secondary metrics, bottleneck migration, stage shares,
 * and a recommendation summary.
 */

import type { ComparisonRecord } from "../compare/index.js";
import { writeFileSync, mkdirSync } from "fs";
import { join, resolve } from "path";

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Generate a Markdown comparison report and write it to `outputPath`.
 */
export async function generateComparisonReport(
  comparison: ComparisonRecord,
  outputPath: string,
): Promise<void> {
  const lines: string[] = [];

  // ── Header ──────────────────────────────────────────────────────────────
  lines.push(`# Comparison Report`);
  lines.push("");
  lines.push(`**Date:** ${comparison.timestamp}`);
  lines.push(`**Baseline Run:** \`${comparison.baselineRunId}\``);
  lines.push(`**Treatment Run:** \`${comparison.treatmentRunId}\``);
  lines.push("");
  lines.push(`- **Workload:** ${comparison.workload}`);
  lines.push(`- **Machine:** ${comparison.machine}`);
  lines.push(`- **Instrumentation:** ${comparison.instrumentation}`);
  lines.push(`- **Warmup Class:** ${comparison.warmupClass}`);
  lines.push(`- **Primary Metric:** \`${comparison.primaryMetric}\``);
  lines.push(`- **Recommendation:** **${recommendationBadge(comparison.recommendation)}**`);
  lines.push("");

  // ── Correctness gates ───────────────────────────────────────────────────
  lines.push(`## Correctness Gates`);
  lines.push("");
  lines.push("| Gate | Pass | Detail |");
  lines.push("|------|------|--------|");
  for (const [gate, result] of Object.entries(comparison.correctness)) {
    const passMark = result.pass ? "✅ Pass" : "❌ Fail";
    lines.push(`| ${gate} | ${passMark} | ${result.detail} |`);
  }
  lines.push("");

  // ── Evidence completeness ───────────────────────────────────────────────
  lines.push(`**Evidence Complete:** ${comparison.evidenceComplete ? "✅ Yes" : "❌ No"}`);
  lines.push("");

  // ── Primary metric summary ──────────────────────────────────────────────
  lines.push(`## Primary Metric: \`${comparison.primaryMetric}\``);
  lines.push("");

  // Summary table
  lines.push("### Summary Statistics");
  lines.push("");
  lines.push("| Statistic | Baseline | Treatment |");
  lines.push("|-----------|----------|-----------|");
  lines.push(`| n | ${comparison.baselineSummary.n} | ${comparison.treatmentSummary.n} |`);
  lines.push(`| Mean | ${fmt(comparison.baselineSummary.mean)} | ${fmt(comparison.treatmentSummary.mean)} |`);
  lines.push(`| Median | ${fmt(comparison.baselineSummary.median)} | ${fmt(comparison.treatmentSummary.median)} |`);
  lines.push(`| Std Dev | ${fmt(comparison.baselineSummary.stddev)} | ${fmt(comparison.treatmentSummary.stddev)} |`);
  lines.push(`| Min | ${fmt(comparison.baselineSummary.min)} | ${fmt(comparison.treatmentSummary.min)} |`);
  lines.push(`| Max | ${fmt(comparison.baselineSummary.max)} | ${fmt(comparison.treatmentSummary.max)} |`);
  lines.push(`| IQR | ${fmt(comparison.baselineSummary.iqr)} | ${fmt(comparison.treatmentSummary.iqr)} |`);
  lines.push(`| MAD | ${fmt(comparison.baselineSummary.mad)} | ${fmt(comparison.treatmentSummary.mad)} |`);
  lines.push(`| P25 | ${fmt(comparison.baselineSummary.percentile25)} | ${fmt(comparison.treatmentSummary.percentile25)} |`);
  lines.push(`| P75 | ${fmt(comparison.baselineSummary.percentile75)} | ${fmt(comparison.treatmentSummary.percentile75)} |`);
  lines.push(`| P95 | ${fmt(comparison.baselineSummary.percentile95)} | ${fmt(comparison.treatmentSummary.percentile95)} |`);
  lines.push("");

  // Differences
  lines.push("### Differences");
  lines.push("");
  lines.push(`- **Absolute Difference (T − B):** ${fmt(comparison.absoluteDifference)}`);
  lines.push(`- **Percentage Difference:** ${fmt(comparison.percentageDifference)}%`);
  lines.push(`- **Effect Size (Cohen's d):** ${fmt(comparison.effectSize)}`);
  lines.push("");

  // Paired difference
  lines.push("### Paired Difference (Treatment − Baseline)");
  lines.push("");
  lines.push(`- **Mean:** ${fmt(comparison.pairedDiff.mean)}`);
  lines.push(`- **Median:** ${fmt(comparison.pairedDiff.median)}`);
  lines.push(`- **P50:** ${fmt(comparison.pairedDiff.p50)}`);
  lines.push(`- **P95:** ${fmt(comparison.pairedDiff.p95)}`);
  lines.push("");

  // Confidence interval
  lines.push("### Bootstrap Confidence Interval");
  lines.push("");
  lines.push(`- **Lower:** ${fmt(comparison.ci.lower)}`);
  lines.push(`- **Upper:** ${fmt(comparison.ci.upper)}`);
  lines.push("");

  // Outliers
  lines.push("### Outliers");
  lines.push("");
  if (comparison.outlierIndices.length > 0) {
    lines.push(`- **Outlier count:** ${comparison.outlierIndices.length}`);
    lines.push(`- **Outlier indices:** ${comparison.outlierIndices.join(", ")}`);
  } else {
    lines.push("- No outliers detected via IQR method");
  }
  lines.push("");

  // ── Secondary metrics ───────────────────────────────────────────────────
  if (comparison.secondaryMetrics.length > 0) {
    lines.push("## Secondary Metrics");
    lines.push("");
    lines.push("| Metric | Baseline Mean | Treatment Mean | Difference | % Change |");
    lines.push("|--------|---------------|----------------|------------|----------|");
    // Secondary metrics are compared per-metric by re-reading events —
    // the ComparisonRecord doesn't pre-compute them, so we enumerate the table
    // from any available data. Here we mark them as requiring detail.
    for (const metric of comparison.secondaryMetrics) {
      lines.push(
        `| ${metric} | — | — | — | — |`,
      );
    }
    lines.push("");
  }

  // ── Bottleneck migration ────────────────────────────────────────────────
  lines.push("## Bottleneck Migration");
  lines.push("");
  lines.push(
    `- **Baseline dominant stage:** \`${comparison.bottleneckLedger.baselineDominant}\``,
  );
  lines.push(
    `- **Treatment dominant stage:** \`${comparison.bottleneckLedger.treatmentDominant}\``,
  );
  lines.push(
    `- **Dominance changed:** ${comparison.bottleneckLedger.dominanceChanged ? "Yes" : "No"}`,
  );
  lines.push("");

  // Stage share breakdown — baseline
  lines.push("### Stage Share: Baseline");
  lines.push("");
  lines.push("| Stage | Total (ms) | Share |");
  lines.push("|-------|------------|-------|");
  for (const s of comparison.bottleneckLedger.baseline) {
    lines.push(`| ${s.stage} | ${fmt(s.totalMs)} | ${fmtPercent(s.share)} |`);
  }
  lines.push("");

  // Stage share breakdown — treatment
  lines.push("### Stage Share: Treatment");
  lines.push("");
  lines.push("| Stage | Total (ms) | Share |");
  lines.push("|-------|------------|-------|");
  for (const s of comparison.bottleneckLedger.treatment) {
    lines.push(`| ${s.stage} | ${fmt(s.totalMs)} | ${fmtPercent(s.share)} |`);
  }
  lines.push("");

  // Delta
  lines.push("### Share Change (Treatment − Baseline)");
  lines.push("");
  const deltas = Object.entries(comparison.bottleneckLedger.delta).sort(
    (a, b) => Math.abs(b[1]) - Math.abs(a[1]),
  );
  lines.push("| Stage | Δ Share |");
  lines.push("|-------|---------|");
  for (const [stage, delta] of deltas) {
    const sign = delta > 0 ? "+" : "";
    lines.push(`| ${stage} | ${sign}${fmtPercent(delta)} |`);
  }
  lines.push("");

  // ── Recommendation details ──────────────────────────────────────────────
  lines.push("## Recommendation");
  lines.push("");
  lines.push(`**${recommendationBadge(comparison.recommendation)}**`);
  lines.push("");
  const recExplanations: Record<string, string> = {
    promoted:
      "The treatment shows a statistically significant improvement over the baseline. All correctness gates pass and evidence is complete.",
    rejected:
      "The treatment is worse than the baseline or fails correctness gates. It should not be adopted.",
    deferred:
      "The treatment shows a non-trivial effect but does not meet the threshold for promotion. Further investigation is recommended.",
    research_only:
      "The treatment shows no meaningful difference from the baseline. Results are filed for reference.",
    inconclusive:
      "Evidence is incomplete or corrupted. No determination can be made.",
  };
  const explanation =
    recExplanations[comparison.recommendation] ?? "No explanation available.";
  lines.push(explanation);
  lines.push("");

  // ── Write ───────────────────────────────────────────────────────────────
  const resolvedPath = resolve(outputPath);
  const dir = resolvedPath.substring(0, resolvedPath.lastIndexOf("/"));
  if (dir && dir !== resolvedPath) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(resolvedPath, lines.join("\n"), "utf-8");
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmt(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  if (Math.abs(n) >= 10_000) return n.toFixed(1);
  if (Math.abs(n) >= 1) return n.toFixed(3);
  if (Math.abs(n) >= 0.001) return n.toFixed(6);
  return n.toExponential(4);
}

function fmtPercent(share: number): string {
  return `${(share * 100).toFixed(1)}%`;
}

function recommendationBadge(rec: string): string {
  switch (rec) {
    case "promoted":
      return "🚀 Promoted";
    case "rejected":
      return "❌ Rejected";
    case "deferred":
      return "⏳ Deferred";
    case "research_only":
      return "📓 Research Only";
    case "inconclusive":
      return "❓ Inconclusive";
    default:
      return rec;
  }
}
