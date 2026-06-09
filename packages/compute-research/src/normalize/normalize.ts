import { createHash } from "node:crypto";
import { readFileSync, readdirSync, mkdirSync, writeFileSync } from "node:fs";
import { join, basename } from "node:path";

// ── Public Types ─────────────────────────────────────────────────────────────

/** Result returned by normalizeRun. */
export interface NormalizeResult {
  readonly run_id: string;
  readonly normalized_dir: string;
  readonly files: NormalizedFile[];
  readonly referential_integrity: ReferentialIntegrity;
  readonly error?: string;
}

/** Metadata about one emitted parquet-placeholder file. */
export interface NormalizedFile {
  readonly name: string;
  readonly row_count: number;
  readonly sha256: string;
  readonly byte_size: number;
}

/** Result of referential integrity validation. */
export interface ReferentialIntegrity {
  readonly valid: boolean;
  readonly run_ids_in_events: number;
  readonly run_ids_in_runs: string[];
  readonly orphaned_run_ids: string[];
}

// ── Event Types ──────────────────────────────────────────────────────────────

/** Raw event line parsed from events.jsonl. */
export interface RawEvent {
  readonly schema_version: string;
  readonly run_id: string;
  readonly request_id: string;
  readonly worker_id: string;
  readonly sequence_number: number;
  readonly event_type: string;
  readonly clock_domain: string;
  readonly monotonic_ns?: number;
  readonly wall_ns?: number;
  readonly stage?: StagePayload;
}

interface StagePayload {
  readonly stage_id: string;
  readonly substrate_id?: string;
  readonly layer_index?: number;
  readonly attention_kind?: string;
  readonly graph_region_id?: string;
  readonly kernel_id?: string;
  readonly status: string;
  readonly measurements?: Record<string, unknown>;
}

// ─── Typed event records ─────

export interface StageEventRecord {
  readonly run_id: string;
  readonly request_id: string;
  readonly worker_id: string;
  readonly sequence_number: number;
  readonly event_type: string;
  readonly clock_domain: string;
  readonly monotonic_ns: number;
  readonly wall_ns: number;
  readonly stage_id: string;
  readonly substrate_id: string;
  readonly layer_index: number;
  readonly attention_kind: string;
  readonly graph_region_id: string;
  readonly kernel_id: string;
  readonly stage_status: string;
  readonly measurements: string; // JSON-encoded
}

export interface MemorySampleRecord {
  readonly run_id: string;
  readonly request_id: string;
  readonly worker_id: string;
  readonly sequence_number: number;
  readonly event_type: string;
  readonly clock_domain: string;
  readonly monotonic_ns: number;
  readonly wall_ns: number;
  readonly stage_id: string;
  readonly substrate_id: string;
  readonly layer_index: number;
  readonly resident_bytes: number;
  readonly wired_bytes: number;
  readonly active_bytes: number;
  readonly compressed_bytes: number;
}

export interface TokenMetricRecord {
  readonly run_id: string;
  readonly request_id: string;
  readonly worker_id: string;
  readonly sequence_number: number;
  readonly event_type: string;
  readonly clock_domain: string;
  readonly monotonic_ns: number;
  readonly wall_ns: number;
  readonly token_index: number;
  readonly token_id: number;
  readonly decode_ns: number;
  readonly attention_ns: number;
  readonly mlp_ns: number;
  readonly norm_ns: number;
  readonly sample_ns: number;
}

export interface CorrectnessCheckpointRecord {
  readonly run_id: string;
  readonly request_id: string;
  readonly checkpoint_id: string;
  readonly layer_or_stage: string;
  readonly tensor_name: string;
  readonly comparison_method: string;
  readonly reference_hash: string;
  readonly treatment_hash: string;
  readonly max_abs_error: number;
  readonly mean_abs_error: number;
  readonly max_rel_error: number;
  readonly mean_rel_error: number;
  readonly cosine_similarity: number;
  readonly tolerance: number;
  readonly passed: boolean;
}

// ── Parquet Placeholder Schema ────────────────────────────────────────────────

interface ParquetFile<T> {
  _format: "parquet_placeholder";
  _schema_version: string;
  _schema: Record<string, string>;
  rows: T[];
}

function makeParquet<T>(
  schema: Record<string, string>,
  rows: T[],
): ParquetFile<T> {
  return {
    _format: "parquet_placeholder",
    _schema_version: "1",
    _schema: schema,
    rows,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function safeInt(n: unknown): number {
  if (typeof n === "number" && Number.isFinite(n)) return Math.floor(n);
  return 0;
}

function safeStr(s: unknown): string {
  if (typeof s === "string") return s;
  return "";
}

function safeBool(b: unknown): boolean {
  return b === true;
}

function safeNum(n: unknown): number {
  if (typeof n === "number" && Number.isFinite(n)) return n;
  return 0;
}

function safeObj(o: unknown): Record<string, unknown> | null {
  if (o !== null && typeof o === "object" && !Array.isArray(o)) {
    return o as Record<string, unknown>;
  }
  return null;
}

function sha256Bytes(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

function readJsonFile<T>(filePath: string): T | null {
  try {
    const raw = readFileSync(filePath, "utf-8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/**
 * Read all lines from events.jsonl, returning parsed objects.
 * Skips malformed lines and returns partial results.
 */
function readEvents(eventPath: string): RawEvent[] {
  let raw: string;
  try {
    raw = readFileSync(eventPath, "utf-8");
  } catch {
    return [];
  }
  const events: RawEvent[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      const ev: RawEvent = {
        schema_version: safeStr(parsed.schema_version),
        run_id: safeStr(parsed.run_id),
        request_id: safeStr(parsed.request_id),
        worker_id: safeStr(parsed.worker_id),
        sequence_number: safeInt(parsed.sequence_number),
        event_type: safeStr(parsed.event_type),
        clock_domain: safeStr(parsed.clock_domain),
        monotonic_ns: safeInt(parsed.monotonic_ns) || undefined,
        wall_ns: safeInt(parsed.wall_ns) || undefined,
      };
      const stageRaw = safeObj(parsed.stage);
      if (stageRaw) {
        (ev as unknown as Record<string, unknown>).stage = {
          stage_id: safeStr(stageRaw.stage_id),
          substrate_id: safeStr(stageRaw.substrate_id) || undefined,
          layer_index: safeInt(stageRaw.layer_index) || undefined,
          attention_kind: safeStr(stageRaw.attention_kind) || undefined,
          graph_region_id: safeStr(stageRaw.graph_region_id) || undefined,
          kernel_id: safeStr(stageRaw.kernel_id) || undefined,
          status: safeStr(stageRaw.status),
          measurements: safeObj(stageRaw.measurements) || undefined,
        };
      }
      events.push(ev);
    } catch {
      // skip malformed line
    }
  }
  return events;
}

// ── Main ──────────────────────────────────────────────────────────────────────

/**
 * Read a finalized run directory and produce normalized parquet-placeholder
 * files in `outputDir`.  Validates referential integrity across all emitted
 * tables and returns a manifest with row counts and content hashes.
 */
export function normalizeRun(
  runDir: string,
  outputDir: string,
): NormalizeResult {
  const runId = basename(runDir);
  const errors: string[] = [];
  const files: NormalizedFile[] = [];

  // 1. Load the run manifest
  const manifestPath = join(runDir, "run-manifest.json");
  const manifest = readJsonFile<Record<string, unknown>>(manifestPath);
  if (!manifest) {
    errors.push("run-manifest.json missing or unreadable");
  }

  // 2. Load events
  const eventsPath = join(runDir, "events.jsonl");
  const events = readEvents(eventsPath);

  // 3. Load checkpoints from receipts/checkpoints/
  const checkpointDir = join(runDir, "checkpoints");
  let checkpointFiles: string[] = [];
  try {
    checkpointFiles = readdirSync(checkpointDir).filter(
      (f) => f.endsWith(".json") || f.endsWith(".jsonl"),
    );
  } catch {
    // no checkpoints directory — optional
  }

  const checkpoints: Record<string, unknown>[] = [];
  for (const cf of checkpointFiles) {
    const full = join(checkpointDir, cf);
    const parsed = readJsonFile<Record<string, unknown>>(full);
    if (parsed) {
      checkpoints.push(parsed);
    }
  }

  // 4. Classify events into typed buckets
  const stageEvents: StageEventRecord[] = [];
  const memorySamples: MemorySampleRecord[] = [];
  const tokenMetrics: TokenMetricRecord[] = [];
  const correctnessRecords: CorrectnessCheckpointRecord[] = [];

  for (const ev of events) {
    const monoTs = ev.monotonic_ns ?? 0;
    const wallTs = ev.wall_ns ?? 0;

    if (ev.event_type === "stage" && ev.stage) {
      const s = ev.stage;
      const meas = s.measurements ?? {};

      stageEvents.push({
        run_id: ev.run_id,
        request_id: ev.request_id,
        worker_id: ev.worker_id,
        sequence_number: ev.sequence_number,
        event_type: ev.event_type,
        clock_domain: ev.clock_domain,
        monotonic_ns: monoTs,
        wall_ns: wallTs,
        stage_id: s.stage_id,
        substrate_id: s.substrate_id ?? "",
        layer_index: s.layer_index ?? 0,
        attention_kind: s.attention_kind ?? "",
        graph_region_id: s.graph_region_id ?? "",
        kernel_id: s.kernel_id ?? "",
        stage_status: s.status,
        measurements: JSON.stringify(meas),
      });
    }

    if (ev.event_type === "memory_sample") {
      const meas = ev.stage?.measurements ?? {};
      memorySamples.push({
        run_id: ev.run_id,
        request_id: ev.request_id,
        worker_id: ev.worker_id,
        sequence_number: ev.sequence_number,
        event_type: ev.event_type,
        clock_domain: ev.clock_domain,
        monotonic_ns: monoTs,
        wall_ns: wallTs,
        stage_id: ev.stage?.stage_id ?? "",
        substrate_id: ev.stage?.substrate_id ?? "",
        layer_index: ev.stage?.layer_index ?? 0,
        resident_bytes: safeNum(meas.resident_bytes) || 0,
        wired_bytes: safeNum(meas.wired_bytes) || 0,
        active_bytes: safeNum(meas.active_bytes) || 0,
        compressed_bytes: safeNum(meas.compressed_bytes) || 0,
      });
    }

    if (ev.event_type === "kv_sample" || ev.event_type === "io_sample") {
      const meas = ev.stage?.measurements ?? {};
      tokenMetrics.push({
        run_id: ev.run_id,
        request_id: ev.request_id,
        worker_id: ev.worker_id,
        sequence_number: ev.sequence_number,
        event_type: ev.event_type,
        clock_domain: ev.clock_domain,
        monotonic_ns: monoTs,
        wall_ns: wallTs,
        token_index: safeInt(meas.token_index) || 0,
        token_id: safeInt(meas.token_id) || 0,
        decode_ns: safeNum(meas.decode_ns) || 0,
        attention_ns: safeNum(meas.attention_ns) || 0,
        mlp_ns: safeNum(meas.mlp_ns) || 0,
        norm_ns: safeNum(meas.norm_ns) || 0,
        sample_ns: safeNum(meas.sample_ns) || 0,
      });
    }
  }

  // Parse checkpoints into correctness records
  for (const cp of checkpoints) {
    const absErr = safeObj(cp.abs_error_summary);
    const relErr = safeObj(cp.rel_error_summary);
    correctnessRecords.push({
      run_id: safeStr(cp.run_id),
      request_id: safeStr(cp.request_id) || "",
      checkpoint_id: safeStr(cp.checkpoint_id),
      layer_or_stage: safeStr(cp.layer_or_stage),
      tensor_name: safeStr(cp.tensor_name),
      comparison_method: safeStr(cp.comparison_method),
      reference_hash: safeStr(cp.reference_hash),
      treatment_hash: safeStr(cp.treatment_hash),
      max_abs_error: absErr ? safeNum(absErr.max) : 0,
      mean_abs_error: absErr ? safeNum(absErr.mean) : 0,
      max_rel_error: relErr ? safeNum(relErr.max) : 0,
      mean_rel_error: relErr ? safeNum(relErr.mean) : 0,
      cosine_similarity: safeNum(cp.cosine_similarity),
      tolerance: safeNum(cp.tolerance),
      passed: safeBool(cp.passed),
    });
  }

  // 5. Build runs table (one row)
  const runsRow: Record<string, unknown> = {
    run_id: runId,
    experiment_id: manifest ? safeStr(manifest.experiment_id) : "",
    optimization_id: manifest ? safeStr(manifest.optimization_id) : "",
    study_id: manifest ? safeStr(manifest.study_id) : "",
    trial_index: manifest ? safeInt(manifest.trial_index) : 0,
    run_grade: manifest ? safeStr(manifest.run_grade) : "",
    status: manifest ? safeStr(manifest.status) : "",
    start_time: manifest ? safeStr(manifest.start_time) : "",
    end_time: manifest ? safeStr(manifest.end_time) : "",
    source_revision: manifest ? safeStr(manifest.source_revision) : "",
    workload_id: manifest ? safeStr(manifest.workload_id) : "",
    machine_anon_id: manifest
      ? safeStr((safeObj(manifest.machine_profile))?.anon_id ?? "")
      : "",
    machine_chip: manifest
      ? safeStr((safeObj(manifest.machine_profile))?.chip ?? "")
      : "",
    machine_memory: manifest
      ? safeStr((safeObj(manifest.machine_profile))?.memory ?? "")
      : "",
    model_image_hash: manifest
      ? safeStr((safeObj(manifest.model_identity))?.image_hash ?? "")
      : "",
    instrumentation_mode: manifest ? safeStr(manifest.instrumentation_mode) : "",
    page_cache_class: manifest ? safeStr(manifest.page_cache_class) : "",
    power_class: manifest ? safeStr(manifest.power_class) : "",
    thermal_class: manifest ? safeStr(manifest.thermal_class) : "",
    worker_id: manifest ? safeStr(manifest.worker_id) : "",
    event_count: events.length,
    stage_event_count: stageEvents.length,
    memory_sample_count: memorySamples.length,
    token_metric_count: tokenMetrics.length,
    checkpoint_count: correctnessRecords.length,
  };

  const runSchema: Record<string, string> = {
    run_id: "VARCHAR",
    experiment_id: "VARCHAR",
    optimization_id: "VARCHAR",
    study_id: "VARCHAR",
    trial_index: "INTEGER",
    run_grade: "VARCHAR",
    status: "VARCHAR",
    start_time: "VARCHAR",
    end_time: "VARCHAR",
    source_revision: "VARCHAR",
    workload_id: "VARCHAR",
    machine_anon_id: "VARCHAR",
    machine_chip: "VARCHAR",
    machine_memory: "VARCHAR",
    model_image_hash: "VARCHAR",
    instrumentation_mode: "VARCHAR",
    page_cache_class: "VARCHAR",
    power_class: "VARCHAR",
    thermal_class: "VARCHAR",
    worker_id: "VARCHAR",
    event_count: "BIGINT",
    stage_event_count: "BIGINT",
    memory_sample_count: "BIGINT",
    token_metric_count: "BIGINT",
    checkpoint_count: "BIGINT",
  };

  const stageSchema: Record<string, string> = {
    run_id: "VARCHAR",
    request_id: "VARCHAR",
    worker_id: "VARCHAR",
    sequence_number: "BIGINT",
    event_type: "VARCHAR",
    clock_domain: "VARCHAR",
    monotonic_ns: "BIGINT",
    wall_ns: "BIGINT",
    stage_id: "VARCHAR",
    substrate_id: "VARCHAR",
    layer_index: "INTEGER",
    attention_kind: "VARCHAR",
    graph_region_id: "VARCHAR",
    kernel_id: "VARCHAR",
    stage_status: "VARCHAR",
    measurements: "VARCHAR",
  };

  const memSchema: Record<string, string> = {
    run_id: "VARCHAR",
    request_id: "VARCHAR",
    worker_id: "VARCHAR",
    sequence_number: "BIGINT",
    event_type: "VARCHAR",
    clock_domain: "VARCHAR",
    monotonic_ns: "BIGINT",
    wall_ns: "BIGINT",
    stage_id: "VARCHAR",
    substrate_id: "VARCHAR",
    layer_index: "INTEGER",
    resident_bytes: "DOUBLE",
    wired_bytes: "DOUBLE",
    active_bytes: "DOUBLE",
    compressed_bytes: "DOUBLE",
  };

  const tokenSchema: Record<string, string> = {
    run_id: "VARCHAR",
    request_id: "VARCHAR",
    worker_id: "VARCHAR",
    sequence_number: "BIGINT",
    event_type: "VARCHAR",
    clock_domain: "VARCHAR",
    monotonic_ns: "BIGINT",
    wall_ns: "BIGINT",
    token_index: "BIGINT",
    token_id: "BIGINT",
    decode_ns: "DOUBLE",
    attention_ns: "DOUBLE",
    mlp_ns: "DOUBLE",
    norm_ns: "DOUBLE",
    sample_ns: "DOUBLE",
  };

  const cpSchema: Record<string, string> = {
    run_id: "VARCHAR",
    request_id: "VARCHAR",
    checkpoint_id: "VARCHAR",
    layer_or_stage: "VARCHAR",
    tensor_name: "VARCHAR",
    comparison_method: "VARCHAR",
    reference_hash: "VARCHAR",
    treatment_hash: "VARCHAR",
    max_abs_error: "DOUBLE",
    mean_abs_error: "DOUBLE",
    max_rel_error: "DOUBLE",
    mean_rel_error: "DOUBLE",
    cosine_similarity: "DOUBLE",
    tolerance: "DOUBLE",
    passed: "BOOLEAN",
  };

  // 6. Validate referential integrity
  const runIdsInEvents = new Set(events.map((e) => e.run_id));
  // For single-run normalization, the expected run_id is runId.
  const orphaned = [...runIdsInEvents].filter((rid) => rid !== runId);

  const integrity: ReferentialIntegrity = {
    valid: orphaned.length === 0,
    run_ids_in_events: runIdsInEvents.size,
    run_ids_in_runs: [runId],
    orphaned_run_ids: orphaned,
  };

  if (!integrity.valid) {
    errors.push(
      `referential integrity violation: event run_ids [${orphaned.join(", ")}] not found in runs`,
    );
  }

  // 7. Write output files
  mkdirSync(outputDir, { recursive: true });

  const rowCounts: Record<string, number> = {
    "runs.parquet.json": 1,
    "stage_events.parquet.json": stageEvents.length,
    "memory_samples.parquet.json": memorySamples.length,
    "token_metrics.parquet.json": tokenMetrics.length,
    "correctness_checkpoints.parquet.json": correctnessRecords.length,
  };

  type FileOutput = { name: string; data: string };
  const dataOutputs: FileOutput[] = [
    { name: "runs.parquet.json", data: JSON.stringify(makeParquet(runSchema, [runsRow])) },
    { name: "stage_events.parquet.json", data: JSON.stringify(makeParquet(stageSchema, stageEvents)) },
    { name: "memory_samples.parquet.json", data: JSON.stringify(makeParquet(memSchema, memorySamples)) },
    { name: "token_metrics.parquet.json", data: JSON.stringify(makeParquet(tokenSchema, tokenMetrics)) },
    { name: "correctness_checkpoints.parquet.json", data: JSON.stringify(makeParquet(cpSchema, correctnessRecords)) },
  ];

  for (const ofile of dataOutputs) {
    const dest = join(outputDir, ofile.name);
    const buf = Buffer.from(ofile.data, "utf-8");
    writeFileSync(dest, buf);
    files.push({
      name: ofile.name,
      row_count: rowCounts[ofile.name] ?? 0,
      sha256: sha256Bytes(buf),
      byte_size: buf.length,
    });
  }

  // Write the normalize manifest
  const manifestResult: Omit<NormalizeResult, "files"> & { files: NormalizedFile[] } = {
    run_id: runId,
    normalized_dir: outputDir,
    files,
    referential_integrity: integrity,
  };
  if (errors.length > 0) {
    (manifestResult as Record<string, unknown>).error = errors.join("; ");
  }

  const manifestJson = JSON.stringify(manifestResult, null, 2) + "\n";
  const outManifestPath = join(outputDir, "normalize-manifest.json");
  writeFileSync(outManifestPath, manifestJson);

  // Update the normalize-manifest entry in files list
  const manifestBuf = Buffer.from(manifestJson, "utf-8");
  const existingIdx = files.findIndex((f) => f.name === "normalize-manifest.json");
  if (existingIdx !== -1) {
    files[existingIdx] = {
      name: "normalize-manifest.json",
      row_count: 0,
      sha256: sha256Bytes(manifestBuf),
      byte_size: manifestBuf.length,
    };
  } else {
    files.push({
      name: "normalize-manifest.json",
      row_count: 0,
      sha256: sha256Bytes(manifestBuf),
      byte_size: manifestBuf.length,
    });
  }

  return {
    run_id: runId,
    normalized_dir: outputDir,
    files,
    referential_integrity: integrity,
    ...(errors.length > 0 ? { error: errors.join("; ") } : {}),
  };
}
