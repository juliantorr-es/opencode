import { readFileSync, readdirSync, statSync } from "fs";
import { basename, join } from "path";

export interface ComparisonObservation extends Record<string, unknown> {
  readonly stage?: string;
  readonly durationMs?: number;
  readonly memoryBytes?: number;
  readonly sourceKind: "receipt" | "event";
}

export interface ComparisonDataset {
  readonly sourceKind: "receipt" | "event";
  readonly records: ComparisonObservation[];
}

export function loadComparisonDataset(runDir: string): ComparisonDataset {
  const receipts = readStructuredReceipts(runDir);
  if (receipts.length > 0) {
    return { sourceKind: "receipt", records: receipts };
  }

  return { sourceKind: "event", records: readEvents(runDir) };
}

function readStructuredReceipts(runDir: string): ComparisonObservation[] {
  const receiptsDir = join(runDir, "receipts");
  try {
    if (!statSync(receiptsDir).isDirectory()) {
      return [];
    }
  } catch {
    return [];
  }

  const files = walkJsonFiles(receiptsDir);
  const records: ComparisonObservation[] = [];

  for (const file of files) {
    const raw = readJsonFile(file);
    if (raw == null) continue;
    const entries = Array.isArray(raw) ? raw : [raw];
    for (const entry of entries) {
      if (entry == null || typeof entry !== "object" || Array.isArray(entry)) {
        continue;
      }
      const record = entry as Record<string, unknown>;
      records.push({
        ...record,
        stage: deriveStageLabel(record, file),
        durationMs: deriveDurationMs(record),
        memoryBytes: deriveMemoryBytes(record),
        sourceKind: "receipt",
      });
    }
  }

  return records;
}

function readEvents(runDir: string): ComparisonObservation[] {
  const path = join(runDir, "events.jsonl");
  try {
    const raw = readFileSync(path, "utf-8");
    return raw
      .trim()
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .flatMap((line) => {
        try {
          const event = JSON.parse(line) as Record<string, unknown>;
          return [
            {
              ...event,
              stage: deriveEventStage(event),
              durationMs: deriveEventDurationMs(event),
              memoryBytes: deriveEventMemoryBytes(event),
              sourceKind: "event" as const,
            },
          ];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

function walkJsonFiles(dir: string): string[] {
  const results: string[] = [];
  const entries = readdirSync(dir);
  for (const entry of entries) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      results.push(...walkJsonFiles(full));
    } else if (st.isFile() && entry.endsWith(".json")) {
      results.push(full);
    }
  }
  results.sort();
  return results;
}

function readJsonFile(path: string): unknown | null {
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as unknown;
  } catch {
    return null;
  }
}

function deriveStageLabel(record: Record<string, unknown>, path: string): string {
  const candidates = [
    record.pipeline_phase,
    record.graph_family,
    record.backend,
    record.execution_kind,
    record.status,
    record.predict_status,
    record.load_status,
    record.compile_status,
    record.warmup_status,
    record.steady_status,
    basename(path, ".json"),
  ];
  for (const value of candidates) {
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return basename(path, ".json");
}

function deriveDurationMs(record: Record<string, unknown>): number | undefined {
  const nanos = firstNumber(
    record.steady_mean_ns,
    record.steady_p50_ns,
    record.load_duration_ns,
    record.compile_duration_ns,
    record.materialize_duration_ns,
    record.backend_prepare_duration_ns,
    record.cold_first_predict_ns,
    record.mlx_graph_build_ns,
    record.mlx_eval_only_ns,
    record.mlx_readback_ns,
    record.coreml_mil_build_ns,
    record.coreml_package_write_ns,
    record.coreml_compiler_ns,
    record.coreml_model_load_ns,
    record.accelerate_duration_ns,
  );
  return nanos == null ? undefined : nanos / 1_000_000;
}

function deriveMemoryBytes(record: Record<string, unknown>): number | undefined {
  const candidates: Array<[unknown, number]> = [
    [record.expected_resident_bytes, 1],
    [record.mapped_virtual_bytes, 1],
    [record.file_read_bytes, 1],
    [record.process_rss_after_steady_kb, 1024],
    [record.process_rss_after_load_kb, 1024],
    [record.process_rss_after_cold_predict_kb, 1024],
    [record.process_rss_before_load_kb, 1024],
    [record.process_rss_before_materialize_kb, 1024],
    [record.mlx_active_delta, 1],
    [record.mlx_cache_delta, 1],
    [record.observed_rss_delta, 1],
  ];
  const values = candidates
    .map(([value, multiplier]) => toBytes(value, multiplier))
    .filter((value): value is number => value != null);
  if (values.length === 0) {
    return undefined;
  }
  return Math.max(...values);
}

function deriveEventStage(record: Record<string, unknown>): string | undefined {
  const stage = record.stage;
  if (typeof stage === "string") {
    return stage;
  }
  const event = record.event;
  if (typeof event === "string" && event.length > 0) {
    return event;
  }
  return undefined;
}

function deriveEventDurationMs(record: Record<string, unknown>): number | undefined {
  return toNumber(record.durationMs);
}

function deriveEventMemoryBytes(record: Record<string, unknown>): number | undefined {
  return toBytes(record.memoryBytes);
}

function firstNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    const numeric = toNumber(value);
    if (numeric != null) {
      return numeric;
    }
  }
  return undefined;
}

function toNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function toBytes(value: unknown, multiplier = 1): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return value * multiplier;
}
