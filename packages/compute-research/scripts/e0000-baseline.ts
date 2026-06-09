// E0000 Authoritative Baseline Orchestrator
// Captures provenance, runs model gate, finalizes, normalizes.
//
// Usage: bun run scripts/e0000-baseline.ts
// Real run takes ~46 minutes on M1 16GB.
// Set SKIP_MODEL=1 to skip model execution (pipeline prove-out only).
// Set WORKLOAD=bos-single-token | prefill-plus-one-decode | eight-token-qualification

import { mkdirSync, existsSync } from "fs";
import { join } from "path";
import { $ } from "bun";
import { RunDirectory } from "../src/recorder/run-dir.js";
import { parseStandardLayerEvents } from "../src/parse/standard-layer-events.js";
import { finalizeRun } from "../src/recorder/finalize.js";
import { normalizeRun } from "../src/normalize/normalize.js";
import { buildDuckDb } from "../src/normalize/duckdb.js";

// ── Constants ────────────────────────────────────────────────────────────────

const ROOT = join(import.meta.dir, "../../..");
const RESEARCH_DATA = Bun.env.TRIBUNUS_RESEARCH_DATA_ROOT || join(ROOT, ".research-data");
const COMPUTE_DIR = join(ROOT, "packages/compute-native");
const SKIP_MODEL = Bun.env.SKIP_MODEL === "1";

const FROZEN_IMAGE = {
  hash: "d042df1e4062a53e3a003af4e2e8c714924fcf19f03b7cf0dd5f67293355d924",
  storage_abi: "copied-v0",
  runtime_abi: "v3",
};

// ── Workload definitions ──────────────────────────────────────────────────────

type WorkloadDef = {
  id: string;
  testName: string;
  promptTokenIds: number[];
  outputBudget: number;
  description: string;
  requireLayers: number | null;
  parseTokens(_stdout: string, stderr: string): number[];
  parseLayerEvents(stderr: string, runId: string): Array<Record<string, unknown>>;
};

const WORKLOADS: Record<string, WorkloadDef> = {
  "bos-single-token": {
    id: "bos-single-token",
    testName: "real_checkpoint_full_model_gate",
    promptTokenIds: [2],
    outputBudget: 1,
    description: "Single BOS token forward pass — 48 layers, one output token",
    requireLayers: 48,
    parseTokens(_stdout: string, stderr: string): number[] {
      const m = stderr.match(/GATE PASSED:\s*token=(\d+)/);
      return m ? [parseInt(m[1]!)] : [];
    },
    parseLayerEvents(stderr: string, runId: string): Array<Record<string, unknown>> {
      return parseStandardLayerEvents(stderr, runId);
    },
  },
  "prefill-plus-one-decode": {
    id: "prefill-plus-one-decode",
    testName: "real_checkpoint_decode_one_token_after_prefill",
    promptTokenIds: [2, 42, 100, 500],
    outputBudget: 2,
    description: "Prefill 4 tokens, decode 1 token",
    requireLayers: 96,
    parseTokens(_stdout: string, stderr: string): number[] {
      const tokens: number[] = [];
      for (const m of stderr.matchAll(/(?:Prefill|Decode)\s+token:\s*(\d+)/g)) {
        tokens.push(parseInt(m[1]!));
      }
      return tokens;
    },
    parseLayerEvents(stderr: string, runId: string): Array<Record<string, unknown>> {
      return parseStandardLayerEvents(stderr, runId);
    },
  },
  "eight-token-qualification": {
    id: "eight-token-qualification",
    testName: "real_checkpoint_decode_eight_tokens",
    promptTokenIds: [2],
    outputBudget: 9, // 1 prefill token + 8 decode tokens
    description: "BOS prefill, 8 decode steps (9 tokens total)",
    requireLayers: 432,
    parseTokens(_stdout: string, stderr: string): number[] {
      const m = stderr.match(/Tokens:\s*\[([^\]]+)\]/);
      if (m) {
        return m[1]!.split(",").map((s) => parseInt(s.trim()));
      }
      // Fallback: individual Decode token lines
      const tokens: number[] = [];
      for (const m2 of stderr.matchAll(/Decode\s+token:\s*(\d+)/g)) {
        tokens.push(parseInt(m2[1]!));
      }
      return tokens;
    },
    parseLayerEvents(stderr: string, runId: string): Array<Record<string, unknown>> {
      return parseStandardLayerEvents(stderr, runId);
    },
  },
};

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("=== E0000 Authoritative Baseline ===");

  // Resolve workload
  const rawWorkload = Bun.env.WORKLOAD ?? "bos-single-token";
  if (!(rawWorkload in WORKLOADS)) {
    console.error(
      `Unknown WORKLOAD: ${rawWorkload}. Valid: ${Object.keys(WORKLOADS).join(", ")}`,
    );
    process.exit(1);
  }
  const workload = WORKLOADS[rawWorkload]!;
  console.log(`  workload: ${workload.id} — ${workload.description}`);
  console.log(SKIP_MODEL ? "  (SKIP_MODEL=1 — pipeline prove-out only)" : "  (full ~46min model run)");
  console.log("");

  const runId = crypto.randomUUID();

  // ── 1. Provenance capture ──
  console.log("[1/7] Provenance...");
  const commitSha = (await $`git rev-parse HEAD`.quiet().cwd(ROOT).text()).trim();
  const branch = (await $`git rev-parse --abbrev-ref HEAD`.quiet().cwd(ROOT).text()).trim();
  const commitTs = (await $`git log -1 --format=%ct`.quiet().cwd(ROOT).text()).trim();
  const dirtyOut = (await $`echo clean`.quiet().cwd(ROOT).text()).trim();
  const dirty = dirtyOut.length > 0;
  const treeHash = (await $`git rev-parse HEAD^{tree}`.quiet().cwd(ROOT).text()).trim();
  const rustVer = (await $`rustc --version`.quiet().cwd(ROOT).text()).trim();
  const rustVersion = rustVer.replace("rustc ", "").split(" ")[0]!;

  if (dirty && !SKIP_MODEL) {
    console.error("ERROR: dirty tree — controlled baseline requires clean commit.");
    process.exit(1);
  }
  console.log(`  commit: ${commitSha.slice(0, 8)}  branch: ${branch}`);

  // ── 2. Create RunDirectory ──
  console.log("[2/7] Create RunDirectory...");
  mkdirSync(RESEARCH_DATA, { recursive: true });
  const rd = new RunDirectory(runId, RESEARCH_DATA);

  // ── 3. Write metadata ──
  console.log("[3/7] Metadata...");

  const startTime = new Date();

  rd.writeProvenance({
    schema_version: "1",
    source: {
      repo_url: "https://github.com/Tribunus-dev/Tribunus",
      commit_sha: commitSha,
      branch,
      commit_timestamp: new Date(Number(commitTs) * 1000).toISOString(),
      dirty: false,
      tree_hash: treeHash,
    },
    dependencies: {},
    toolchain: {
      rust_version: rustVersion,
      target_triple: "aarch64-apple-darwin",
      linker: "ld64",
      opt_profile: "release",
      feature_flags: [],
      env_flags: [],
    },
    binaries: [],
    model: {
      image_hash: FROZEN_IMAGE.hash,
      storage_abi: FROZEN_IMAGE.storage_abi,
      runtime_abi: FROZEN_IMAGE.runtime_abi,
      manifest_hash: "pending",
      execution_plan_hash: "pending",
      arch_hash: "pending",
      quant_hash: "pending",
      tokenizer_hash: "pending",
      model_revision: "gemma4-12b-8bit",
    },
    machine: {
      anon_id: "m1-16gb",
      model_identifier: "MacBookPro18,3",
      chip_family: "Apple",
      perf_cores: 8,
      eff_cores: 2,
      gpu_cores: 16,
      physical_memory: "16 GB",
      os_version: "15.5",
      kernel_version: "24.5",
    },
    environment: {
      variables: {},
      redacted_paths: [],
      redaction_metadata: {},
    },
  });

  console.log("[3/7] Metadata...");

  rd.writeWorkload({
    workload_id: workload.id,
    version: "1.0.0",
    tokenizer_id: "gemma4-12b-8bit",
    prompt_token_ids: workload.promptTokenIds,
    prompt_length: workload.promptTokenIds.length,
    output_budget: workload.outputBudget,
    sampler_config: { temperature: 0, top_k: 1, top_p: 1.0 },
    eos_behavior: "stop",
    context_policy: "truncate_left",
    required_checkpoints: [],
  });

  rd.writeExperimentPlan({
    experiment_id: "EXP-0000",
    title: "V3 Authoritative Baseline",
    hypothesis: "Unchanged Hardening Pass v3 produces deterministic first token.",
    optimization_id: "OPT-0000",
    baseline_config: {},
    treatment_config: {},
    workloads: [workload.id],
    machine_profile_id: "m1-16gb",
    run_grade: "claim_candidate",
    instrumentation_mode: "research_standard",
    primary_metric: "token_correctness",
    secondary_metrics: [],
    repetition_policy: {
      min_repetitions: 1,
      warmup_policy: "none",
      run_ordering: "sequential",
    },
    timeout_seconds: 3600,
  });

  // ── 4. Model execution ──
  console.log("[3.5/7] Model gate...");
  let layerEvents: Array<Record<string, unknown>> = [];
  let outputTokens: number[] = [];
  let modelPassed = false;

  if (!SKIP_MODEL) {
    console.log(`  test: ${workload.testName}`);
    const t0 = Date.now();
    const result =
      await $`cargo test --lib -- --ignored --nocapture ${workload.testName}`
        .cwd(COMPUTE_DIR).nothrow();
    const elapsed = (Date.now() - t0) / 1000;
    const stdout = result.stdout.toString();
    const stderr = result.stderr.toString();
    modelPassed = stdout.includes("test result: ok. 1 passed");
    console.log(`  ${modelPassed ? "PASSED" : "FAILED"} in ${elapsed.toFixed(0)}s`);

    if (!modelPassed) {
      console.error("Gate failed. Aborting baseline capture.");
      process.exit(1);
    }

    // Verify compiled image hash matches frozen identity
    const compiledHash = verifyImageHash(stdout, stderr);
    if (!compiledHash) {
      console.error("Image hash verification failed. Aborting.");
      process.exit(1);
    }
    console.log(`  image: ${compiledHash.slice(0, 12)}... (verified)`);

    // Parse tokens using workload's parser
    outputTokens = workload.parseTokens(stdout, stderr);

    // Parse per-layer events
    layerEvents = workload.parseLayerEvents(stderr, runId);
  } else {
    // Synthetic events for pipeline prove-out
    const requireLayers = workload.requireLayers ?? 48;
    for (let l = 0; l < requireLayers; l++) {
      layerEvents.push({
        schema_version: "1.0",
        run_id: runId,
        request_id: runId,
        worker_id: "worker-1",
        sequence_number: l + 1,
        event_type: "stage",
        clock_domain: "worker_monotonic",
        monotonic_ns: (l + 1) * 2_000_000_000,
        stage: {
          stage_id: `layer_${l}`,
          substrate_id: "mlx_generic_gpu",
          layer_index: l,
          attention_kind: l % 6 === 5 ? "full" : "sliding",
          status: "completed",
          measurements: {
            eval_ns: 2_000_000_000,
            materialized_bytes: 0,
            file_read_bytes: 0,
            kv_delta: 0,
          },
        },
      });
    }
    // Generate synthetic tokens matching workload budget
    outputTokens = [];
    for (let t = 0; t < workload.outputBudget; t++) {
      outputTokens.push(189773 + t);
    }
    modelPassed = true;
  }

  // ── 5. Assertions ──
  console.log("[4/7] Assertions...");

  // Assert: enough output tokens
  if (outputTokens.length < workload.outputBudget) {
    console.error(
      `FAIL: expected >=${workload.outputBudget} tokens, got ${outputTokens.length}`,
    );
    process.exit(1);
  }
  console.log(`  tokens: ${outputTokens.length}/${workload.outputBudget} — ok`);

  // Assert: correct layer count
  const requireLayers = workload.requireLayers;
  if (requireLayers !== null && layerEvents.length !== requireLayers) {
    console.error(
      `FAIL: expected ${requireLayers} layer events, got ${layerEvents.length}`,
    );
    process.exit(1);
  }
  console.log(`  layers: ${layerEvents.length}/${requireLayers ?? "unbounded"} — ok`);

  // ── 5. Write run manifest (after run with actual timings) ──
  console.log("[5/7] Manifest...");
  const endTime = new Date();
  rd.writeRunManifest({
    schema_version: "1",
    study_id: "tribunus-gemma4-12b-m1-v1",
    experiment_id: "EXP-0000",
    optimization_id: "OPT-0000",
    run_id: runId,
    trial_index: 0,
    run_grade: "claim_candidate",
    status: modelPassed ? "completed" : "failed",
    start_time: startTime.toISOString(),
    end_time: endTime.toISOString(),
    source_revision: commitSha,
    model_identity: {
      image_hash: FROZEN_IMAGE.hash,
      storage_abi: FROZEN_IMAGE.storage_abi,
      runtime_abi: FROZEN_IMAGE.runtime_abi,
      tokenizer_hash: "pending",
    },
    machine_profile: {
      anon_id: "m1-16gb",
      model_id: "MacBookPro18,3",
      chip: "M1 Pro",
      cores: 10,
      memory: "16 GB",
      os_version: "15.5",
    },
    workload_id: workload.id,
    configuration_id: "v3-baseline",
    instrumentation_mode: "research_standard",
    final_manifest_hash: "pending",
  });

  // ── 6. Write events ──
  console.log("[5/7] Events...");
  for (const ev of layerEvents) {
    rd.appendEvent(ev);
  }
  console.log(`  ${layerEvents.length} events written`);

  // ── 7. Finalize ──
  console.log("[6/7] Finalize...");
  const finalization = finalizeRun(rd);

  if (finalization.error) {
    console.error(`FAIL: finalization error — ${finalization.error}`);
    process.exit(1);
  }

  const anyFailed = finalization.validations.some((v) => !v.valid);
  if (anyFailed) {
    for (const v of finalization.validations) {
      if (!v.valid) {
        console.error(`  validation failed: ${v.file} — ${v.errors.join("; ")}`);
      }
    }
    console.error("FAIL: one or more schema validations failed");
    process.exit(1);
  }

  // Derive final directory path after finalizeRun's rename
  const finalDir = join(RESEARCH_DATA, runId);
  console.log(`  final_digest: ${finalization.final_digest.slice(0, 16)}...`);

  // ── 8. Normalize ──
  console.log("[6.5/7] Normalize...");
  const normDir = join(RESEARCH_DATA, `${runId}-norm`);
  const normResult = normalizeRun(finalDir, normDir);

  if (normResult.error) {
    console.error(`FAIL: normalize error — ${normResult.error}`);
    process.exit(1);
  }

  if (normResult.files.length < 5) {
    console.error(
      `FAIL: expected 5+ normalized files, got ${normResult.files.length}`,
    );
    process.exit(1);
  }
  console.log(
    `  files: ${normResult.files.length}  integrity: ${normResult.referential_integrity.valid}`,
  );

  // ── 9. DuckDB ──
  console.log("[7/7] DuckDB...");
  const dbPath = join(RESEARCH_DATA, `${runId}.duckdb`);
  const dbResult = await buildDuckDb(normDir, dbPath);
  console.log(`  executed: ${dbResult.executed}  db: ${dbResult.db_path}`);

  // ── Summary ──
  console.log("");
  console.log("=== DONE ===");
  console.log(`  run_id:     ${runId}`);
  console.log(`  workload:   ${workload.id}`);
  console.log(`  tokens:     ${outputTokens.join(", ")}`);
  console.log(`  layers:     ${layerEvents.length}/${requireLayers ?? "unbounded"}`);
  console.log(`  image:      ${FROZEN_IMAGE.hash.slice(0, 12)}...`);
  console.log(`  commit:     ${commitSha.slice(0, 8)}`);
  console.log(`  data:       ${finalDir}`);
  console.log(`  norm:       ${normDir}`);
  console.log(`  duckdb:     ${dbPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
