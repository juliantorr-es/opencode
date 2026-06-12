/**
 * Bottleneck analysis for comparing event-stage profiles between two runs.
 *
 * Computes per-stage time share, identifies dominant stages, and reports
 * whether the bottleneck migrated between baseline and treatment.
 */

import type { ComparisonObservation } from "./receipts.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface StageShare {
  /** Stage label, e.g. `"load"`, `"inference"`, `"tokenize"`. */
  readonly stage: string;
  /** Total wall-clock ms consumed by this stage. */
  readonly totalMs: number;
  /** Fraction of total run time (0–1). */
  readonly share: number;
}

export interface BottleneckLedger {
  /** Per-stage breakdown for the baseline run. */
  readonly baseline: readonly StageShare[];
  /** Per-stage breakdown for the treatment run. */
  readonly treatment: readonly StageShare[];
  /** Dominant stage in baseline (largest share). */
  readonly baselineDominant: string;
  /** Dominant stage in treatment (largest share). */
  readonly treatmentDominant: string;
  /** Whether the dominant stage changed between baseline and treatment. */
  readonly dominanceChanged: boolean;
  /** Absolute change in share for each stage, keyed by stage name. */
  readonly delta: Record<string, number>;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Build a bottleneck ledger by comparing the stage-time breakdown of
 * two event sequences.
 *
 * Events are grouped by their `stage` property (if present); events
 * without a stage are ignored. Each event contributes its `durationMs`
 * to that stage's total. Stages are ordered by descending share.
 */
export function buildBottleneckLedger(
  baselineEvents: ComparisonObservation[],
  treatmentEvents: ComparisonObservation[],
): BottleneckLedger {
  const baselineShares = computeStageShares(baselineEvents);
  const treatmentShares = computeStageShares(treatmentEvents);

  const baselineDominant = dominantStage(baselineShares);
  const treatmentDominant = dominantStage(treatmentShares);

  // Build delta map — union of all stage names
  const allStages = new Set<string>();
  for (const s of baselineShares) allStages.add(s.stage);
  for (const s of treatmentShares) allStages.add(s.stage);

  const baselineMap = mapByStage(baselineShares);
  const treatmentMap = mapByStage(treatmentShares);

  const delta: Record<string, number> = {};
  for (const stage of allStages) {
    const b = baselineMap.get(stage)?.share ?? 0;
    const t = treatmentMap.get(stage)?.share ?? 0;
    delta[stage] = t - b;
  }

  return {
    baseline: baselineShares,
    treatment: treatmentShares,
    baselineDominant,
    treatmentDominant,
    dominanceChanged: baselineDominant !== treatmentDominant,
    delta,
  };
}

// ── Internal ─────────────────────────────────────────────────────────────────

function computeStageShares(events: ComparisonObservation[]): StageShare[] {
  const totals = new Map<string, number>();
  let totalMs = 0;

  for (const ev of events) {
    const stage = (ev as Record<string, unknown>).stage;
    const dur = (ev as Record<string, unknown>).durationMs;
    if (typeof stage !== "string" || typeof dur !== "number") continue;
    if (dur <= 0) continue;

    totals.set(stage, (totals.get(stage) ?? 0) + dur);
    totalMs += dur;
  }

  if (totalMs <= 0) return [];

  const shares: StageShare[] = [];
  for (const [stage, ms] of totals) {
    shares.push({ stage, totalMs: ms, share: ms / totalMs });
  }

  shares.sort((a, b) => b.share - a.share);
  return shares;
}

function dominantStage(shares: StageShare[]): string {
  if (shares.length === 0) return "(no stages)";
  return shares[0]!.stage;
}

function mapByStage(shares: StageShare[]): Map<string, StageShare> {
  const map = new Map<string, StageShare>();
  for (const s of shares) map.set(s.stage, s);
  return map;
}
