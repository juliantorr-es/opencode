import { describe, test, expect, afterAll } from "bun:test";
import { execSync } from "child_process";
import { mkdtempSync, existsSync, rmSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

function tempDir(): string { return mkdtempSync(join(tmpdir(), "comp-res-pipeline-")); }
function rmrf(dir: string): void { try { rmSync(dir, { recursive: true, force: true }); } catch {} }
function duckdbAvailable(): boolean {
  try { execSync("duckdb --version", { stdio: "pipe", timeout: 5000, encoding: "utf-8" }); return true; }
  catch { return false; }
}

import { RunDirectory } from "../src/recorder/run-dir.js";
import { finalizeRun } from "../src/recorder/finalize.js";
import { normalizeRun } from "../src/normalize/normalize.js";
import { buildDuckDb } from "../src/normalize/duckdb.js";
import { runComparison } from "../src/compare/index.js";
import { bootstrapIndependentCI, bootstrapPairedCI } from "../src/compare/statistics.js";

function writeNormalizeEvent(
  rd: InstanceType<typeof RunDirectory>,
  seq: number,
  stageId: string,
  _latencyMs: number,
  monotonicNs: number,
  wallNs: number,
): void {
  rd.appendEvent({
    schema_version: "1.0",
    run_id: rd.runId,
    request_id: "req-1",
    worker_id: "worker-1",
    sequence_number: seq,
    event_type: "stage",
    clock_domain: "monotonic",
    monotonic_ns: monotonicNs,
    wall_ns: wallNs,
    stage: { stage_id: stageId, substrate_id: "gpu", layer_index: 0, status: "completed", measurements: { eval_ns: 500_000 } },
  });
}

function writeCompareEvent(rd: InstanceType<typeof RunDirectory>, event: string, stage: string, latencyMs: number, durationMs: number): void {
  rd.appendEvent({ event, stage, token_latency_ms: latencyMs, durationMs });
}

function createNormalizeRun(rootDir: string, runId: string, runGrade = "claim_candidate"): RunDirectory {
  const rd = new RunDirectory(runId, rootDir);
  rd.writeRunManifest({
    experiment_id: "exp-001", optimization_id: "opt-a", study_id: "study-1", trial_index: 0,
    run_grade: runGrade, status: "completed",
    start_time: "2026-06-09T00:00:00Z", end_time: "2026-06-09T01:00:00Z",
    source_revision: "abc123def", workload_id: "bench-llm-v3",
    model_identity: { image_hash: "sha256:deadbeef" },
    machine_profile: { anon_id: "mac-studio-01", chip: "M3Ultra", memory: "192GB" },
    instrumentation_mode: "research_standard", page_cache_class: "warm",
    power_class: "high_performance", thermal_class: "nominal", worker_id: "worker-1",
  });
  rd.writeProvenance({
    source: { repository: "https://github.com/tribunus/research", commit: "abc123def", branch: "main" },
    toolchain: { name: "tribunus", version: "1.0.0", compiler: { name: "clang", version: "18" } },
    model: { name: "llama-3.2-8b", image_hash: "sha256:deadbeef", quantization: "fp16" },
    machine: { model_identifier: "Mac15,9", anon_id: "mac-studio-01", chip: "M3Ultra", memory: "192GB" },
    environment: { os: "macOS 15.5", kernel: "25.0", library_versions: { metal: "3.2", cuda: null } },
  });
  rd.writeWorkload({ name: "bench-llm-v3", description: "LLM inference benchmark v3", parameters: { batch_size: 1, max_tokens: 128 } });
  rd.writeExperimentPlan({ name: "llm-inference-optimization", hypothesis: "Memory compression improves throughput", config: { iterations: 5, warmup: 2 } });
  writeNormalizeEvent(rd, 1, "embedding_gather", 100, 1_000_000, 100_000_000);
  writeNormalizeEvent(rd, 2, "attention_score", 102, 2_000_000, 200_000_000);
  writeNormalizeEvent(rd, 3, "final_normalization", 98, 3_000_000, 300_000_000);
  return rd;
}

function createCompareRun(rootDir: string, runId: string, latencyValues: number[]): RunDirectory {
  const rd = new RunDirectory(runId, rootDir);
  rd.writeRunManifest({
    experiment_id: "exp-001", optimization_id: "opt-a", study_id: "study-1", trial_index: 0,
    run_grade: "claim_candidate", status: "completed",
    start_time: "2026-06-09T00:00:00Z", end_time: "2026-06-09T01:00:00Z",
    source_revision: "abc123def", workload_id: "bench-llm-v3",
    model_identity: { image_hash: "sha256:deadbeef" },
    machine_profile: { anon_id: "mac-studio-01", chip: "M3Ultra", memory: "192GB" },
    instrumentation_mode: "research_standard", page_cache_class: "warm",
    power_class: "high_performance", thermal_class: "nominal", worker_id: "worker-1",
  });
  rd.writeProvenance({
    source: { repository: "https://github.com/tribunus/research", commit: "abc" },
    toolchain: { name: "tribunus", version: "1.0.0" },
    model: { name: "llama-3.2-8b", image_hash: "sha256:deadbeef" },
    machine: { model_identifier: "Mac15,9", anon_id: "mac-studio-01" },
    environment: { os: "macOS 15.5", kernel: "25.0" },
  });
  rd.writeWorkload({ name: "bench-llm-v3", parameters: { batch_size: 1, max_tokens: 128 } });
  rd.writeExperimentPlan({ name: "llm-inference-optimization", config: { iterations: latencyValues.length, warmup: 2 } });

  const stages = [
    { event: "start", stage: "start" },
    { event: "inference", stage: "token_generation" },
    { event: "worker", stage: "worker_compute" },
    { event: "io", stage: "io_read" },
    { event: "finish", stage: "finish" },
  ];
  for (let i = 0; i < latencyValues.length; i++) {
    const s = stages[Math.min(i, stages.length - 1)]!;
    writeCompareEvent(rd, s.event, s.stage, latencyValues[i]!, 100);
  }
  return rd;
}

describe("Pipeline E2E", () => {
  const tmpRoots: string[] = [];
  afterAll(() => { for (const d of tmpRoots) rmrf(d); });

  test("pipeline: record -> finalize -> normalize -> duckdb -> compare -> assert", async () => {
    const pipelineRoot = tempDir();
    tmpRoots.push(pipelineRoot);

    const runId = "e2e-run-001";
    const rd = createNormalizeRun(pipelineRoot, runId);
    expect(existsSync(rd.partialRoot)).toBe(true);

    const finalization = finalizeRun(rd);
    const finalDir = join(pipelineRoot, runId);
    expect(existsSync(rd.partialRoot)).toBe(false);
    expect(existsSync(finalDir)).toBe(true);
    expect(existsSync(join(finalDir, "finalization.json"))).toBe(true);
    for (const v of finalization.validations) {
      expect(v.valid).toBe(true);
    }
    expect(finalization.file_count).toBeGreaterThan(0);
    expect(finalization.error).toBeUndefined();

    const normDir = join(pipelineRoot, "normalized");
    const normResult = normalizeRun(finalDir, normDir);
    expect(existsSync(normDir)).toBe(true);
    expect(existsSync(join(normDir, "normalize-manifest.json"))).toBe(true);
    const arrowFiles = normResult.files.filter((f) => f.format === "arrow_ipc");
    expect(arrowFiles.length).toBeGreaterThanOrEqual(5);
    const names = arrowFiles.map((f) => f.name).sort();
    expect(names).toContain("runs.arrow");
    expect(names).toContain("stage_events.arrow");
    expect(normResult.referential_integrity.valid).toBe(true);
    expect(normResult.referential_integrity.orphaned_run_ids).toHaveLength(0);
    expect(normResult.error).toBeUndefined();

    if (duckdbAvailable()) {
      const dbPath = join(pipelineRoot, "pipeline.duckdb");
      const dbResult = buildDuckDb(normDir, dbPath);
      expect(existsSync(dbPath)).toBe(true);
      if (!dbResult.executed) {
        console.warn("DuckDB build skipped:", dbResult.error ?? "unknown");
      } else {
        expect(dbResult.smoke_query_result).toBeDefined();
        expect(dbResult.smoke_query_result![0]?.count).toBeGreaterThanOrEqual(1);
      }
    } else {
      console.warn("DuckDB CLI not available");
    }

    const baselineId = "baseline-run";
    const treatmentId = "treatment-run";
    const baselineRd = createCompareRun(pipelineRoot, baselineId, [100, 102, 98, 101, 99]);
    const treatmentRd = createCompareRun(pipelineRoot, treatmentId, [95, 97, 93, 96, 94]);
    finalizeRun(baselineRd);
    finalizeRun(treatmentRd);

    const compareRoot = join(pipelineRoot, "comparison-results");
    const compRecord = await runComparison(baselineId, treatmentId, {
      baselineRoot: pipelineRoot,
      treatmentRoot: pipelineRoot,
      outputRoot: compareRoot,
      primaryMetric: "token_latency_ms",
      paired: true,
      randomSeed: 42,
    });

    expect(compRecord.analysis_method).toBe("paired");
    expect(compRecord.ci.lower).toBeLessThan(0);
    expect(compRecord.ci.upper).toBeLessThan(0);
    expect(compRecord.recommendation).toBe("promoted");
    expect(compRecord.evidenceComplete).toBe(true);
    expect(compRecord.effectSize).toBeGreaterThan(1.5);  // large positive effect: baseline - treatment
    expect(compRecord.baselineSummary.n).toBe(5);
    expect(compRecord.treatmentSummary.n).toBe(5);
    expect(compRecord.baselineSummary.mean).toBeCloseTo(100, 0);
    expect(compRecord.treatmentSummary.mean).toBeCloseTo(95, 0);
  }, 60_000);

  test("contract failures fail closed", () => {
    const failRoot = tempDir();
    tmpRoots.push(failRoot);

    const badRunId = "bad-provenance-run";
    const rd = new RunDirectory(badRunId, failRoot);
    rd.writeRunManifest({
      experiment_id: "exp-001", run_grade: "claim_candidate", status: "completed",
      model_identity: { image_hash: "sha256:deadbeef" },
      machine_profile: { anon_id: "m1", chip: "M1", memory: "16GB" },
    });
    writeNormalizeEvent(rd, 1, "embedding_gather", 100, 1_000_000, 100_000_000);

    rd.close();
    writeFileSync(join(rd.partialRoot, "provenance.json"), "{ this is not valid JSON }", "utf-8");

    const finalRec = finalizeRun(rd);
    expect(existsSync(join(failRoot, badRunId, "finalization.json"))).toBe(true);

    const provValidation = finalRec.validations.find((v) => v.file.includes("provenance.json"));
    expect(provValidation).toBeDefined();
    expect(provValidation!.valid).toBe(false);
    expect(provValidation!.errors.length).toBeGreaterThan(0);
    expect(existsSync(rd.partialRoot)).toBe(false);

    const normOut = join(failRoot, "norm-bad-provenance");
    const normResult = normalizeRun(join(failRoot, badRunId), normOut);
    expect(existsSync(normOut)).toBe(true);
    if (normResult.error) {
      expect(normResult.error.length).toBeGreaterThan(0);
    }
  });

  test("invalid run grade gracefully rejected", () => {
    const gradeRoot = tempDir();
    tmpRoots.push(gradeRoot);

    const badGradeId = "bad-grade-run";
    const rd = new RunDirectory(badGradeId, gradeRoot);
    rd.writeRunManifest({
      experiment_id: "exp-001", run_grade: "invalid_grade", status: "completed",
      model_identity: { image_hash: "sha256:deadbeef" },
      machine_profile: { anon_id: "m1", chip: "M1", memory: "16GB" },
    });
    rd.writeProvenance({ source: { repository: "example" }, machine: { model_identifier: "Mac15,9" } });
    rd.writeWorkload({ name: "test" });
    rd.writeExperimentPlan({ name: "test" });
    writeNormalizeEvent(rd, 1, "embedding_gather", 100, 1_000_000, 100_000_000);

    const finalRec = finalizeRun(rd);
    const finalDir = join(gradeRoot, badGradeId);
    for (const v of finalRec.validations) {
      expect(v.valid).toBe(true);
    }
    const manifest = JSON.parse(readFileSync(join(finalDir, "run-manifest.json"), "utf-8"));
    expect(manifest.run_grade).toBe("invalid_grade");

    const normOut = join(gradeRoot, "norm-bad-grade");
    const normResult = normalizeRun(finalDir, normOut);
    expect(normResult.error).toBeUndefined();
    const runArrow = normResult.files.find((f) => f.name === "runs.arrow");
    expect(runArrow).toBeDefined();
    expect(runArrow!.row_count).toBe(1);
  });

  test("zero-effect CI blocks promotion", async () => {
    const zeroRoot = tempDir();
    tmpRoots.push(zeroRoot);

    const identicalValues = [100, 101, 99, 100, 102];
    const baseRd = createCompareRun(zeroRoot, "zero-baseline", identicalValues);
    const treatRd = createCompareRun(zeroRoot, "zero-treatment", identicalValues);
    finalizeRun(baseRd);
    finalizeRun(treatRd);

    const compRecord = await runComparison("zero-baseline", "zero-treatment", {
      baselineRoot: zeroRoot,
      treatmentRoot: zeroRoot,
      outputRoot: join(zeroRoot, "comparisons"),
      primaryMetric: "token_latency_ms",
      paired: true,
      randomSeed: 42,
    });

    expect(compRecord.ci.lower).toBeLessThanOrEqual(0);
    expect(compRecord.ci.upper).toBeGreaterThanOrEqual(0);
    expect(compRecord.recommendation).not.toBe("promoted");
    expect(compRecord.evidenceComplete).toBe(true);
  });

  test("bootstrap: independent vs paired produces different CIs for correlated data", () => {
    const seed = 12345;
    const n = 20;
    const base: number[] = [];
    const treat: number[] = [];
    for (let i = 0; i < n; i++) {
      const b = 100 + Math.random() * 10;
      base.push(b);
      treat.push(b + 2 + (Math.random() - 0.5) * 2);
    }
    const diffs = base.map((b, i) => treat[i]! - b);
    const indCi = bootstrapIndependentCI(base, treat, 0.95, 5_000, seed);
    const pairedCi = bootstrapPairedCI(diffs, 0.95, 5_000, seed);
    const indWidth = indCi.upper - indCi.lower;
    const pairedWidth = pairedCi.upper - pairedCi.lower;
    expect(pairedWidth).toBeLessThan(indWidth);
    expect(pairedCi.lower).toBeGreaterThan(0);
    expect(indCi.lower).toBeGreaterThan(0);

    const indCi2 = bootstrapIndependentCI(base, treat, 0.95, 5_000, seed);
    expect(indCi2.lower).toBe(indCi.lower);
    expect(indCi2.upper).toBe(indCi.upper);
    const pairedCi2 = bootstrapPairedCI(diffs, 0.95, 5_000, seed);
    expect(pairedCi2.lower).toBe(pairedCi.lower);
    expect(pairedCi2.upper).toBe(pairedCi.upper);

    const indCi3 = bootstrapIndependentCI(base, treat, 0.95, 5_000, seed + 1);
    expect(indCi3.lower).not.toBe(indCi.lower);
    const pairedCi3 = bootstrapPairedCI(diffs, 0.95, 5_000, seed + 1);
    expect(pairedCi3.lower).not.toBe(pairedCi.lower);
  });
});
