export { normalizeRun } from "./normalize.js";
export type {
  NormalizeResult,
  NormalizedFile,
  ReferentialIntegrity,
  StageEventRecord,
  MemorySampleRecord,
  TokenMetricRecord,
  CorrectnessCheckpointRecord,
} from "./normalize.js";

export { buildDuckDb } from "./duckdb.js";
export type { DuckDbConfig, DuckDbResult } from "./duckdb.js";
