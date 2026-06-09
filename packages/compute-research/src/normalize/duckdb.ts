import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface DuckDbConfig {
  /** Path to a DuckDB CLI binary. If unset, generates scripts only. */
  readonly cliPath?: string;
  /** If true, attempt to run the DuckDB CLI after writing scripts. */
  readonly execute?: boolean;
}

export interface DuckDbResult {
  readonly db_path: string;
  readonly schema_path: string;
  readonly load_script_path: string;
  readonly sql_view_path: string;
  readonly executed: boolean;
}

// ── Schema DDL ────────────────────────────────────────────────────────────────

/**
 * Per-column schema entry mapping column name to DuckDB type.
 */
interface ColumnDef {
  readonly name: string;
  readonly type: string;
}

/**
 * Table definition with column schema and JSON data path.
 */
interface TableDef {
  readonly name: string;
  readonly columns: ColumnDef[];
  readonly parquetPath: string;
}

function parquetSchema(table: TableDef): string {
  const cols = table.columns.map((c) => `  ${c.name} ${c.type}`).join(",\n");
  return cols;
}

function tableFromParquetJSON(
  name: string,
  parquetFile: string,
): TableDef | null {
  // Derive columns from the _schema field in the parquet placeholder JSON.
  // We emit a CREATE TABLE statement manually since the JSON is not native Parquet.
  const columnMap = SCHEMAS[name];
  if (!columnMap) return null;

  const columns: ColumnDef[] = Object.entries(columnMap).map(([n, t]) => ({
    name: n,
    type: t,
  }));
  return { name, columns, parquetPath: parquetFile };
}

// ── Registered schemas (mirrors normalize/index.ts) ───────────────────────────

const SCHEMAS: Record<string, Record<string, string>> = {
  runs: {
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
  },
  stage_events: {
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
  },
  memory_samples: {
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
  },
  token_metrics: {
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
  },
  correctness_checkpoints: {
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
  },
};

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Generate a DuckDB-compatible schema and load script from a normalization
 * output directory.  In v1 this writes a SQL schema file and a load script
 * that imports the parquet-placeholder JSON files.
 *
 * When `config.cliPath` is set and `config.execute` is true, the DuckDB CLI
 * is invoked to materialise the database.
 */
export function buildDuckDb(
  normalizedDir: string,
  dbPath: string,
  config?: DuckDbConfig,
): DuckDbResult {
  const absNormalized = resolve(normalizedDir);
  const absDbPath = resolve(dbPath);
  const outputBase = join(absNormalized, ".duckdb");

  mkdirSync(outputBase, { recursive: true });

  // ── 1. Generate CREATE TABLE statements ───────────────────────────────

  const createStmts: string[] = [];
  const insertStmts: string[] = [];

  for (const [tableName, cols] of Object.entries(SCHEMAS)) {
    const colDefs = Object.entries(cols)
      .map(([name, type]) => `  "${name}" ${type}`)
      .join(",\n");

    createStmts.push(
      `CREATE TABLE IF NOT EXISTS "${tableName}" (\n${colDefs}\n);`,
    );

    // INSERT from the parquet-placeholder JSON using DuckDB's read_json_auto
    // with the flattened rows path via JSON extract.
    const parquetFile = `${tableName}.parquet.json`;
    const parquetPath = join(absNormalized, parquetFile);

    // JSON loaded via read_json_auto on the `rows` array, but we wrap in
    // UNNEST to flatten the rows array of the placeholder file.
    insertStmts.push(
      `INSERT INTO "${tableName}"\n  SELECT * FROM read_json_auto('${parquetPath}', format='array', columns={rows: 'STRUCT(${Object.entries(cols).map(([n, t]) => `"${n}" ${t}`).join(", ")}[])'});`,
    );

    // Simpler approach: insert from the raw JSON using UNNEST of the rows array.
    insertStmts.push(
      `INSERT OR REPLACE INTO "${tableName}"\n  SELECT * FROM (SELECT UNNEST(rows) FROM read_json_auto('${parquetPath}', format='array')) WHERE row_count = (SELECT COUNT(*) FROM read_json_auto('${parquetPath}', format='array'));`,
    );
  }

  // ── 2. Write schema file ──────────────────────────────────────────────

  const schemaPath = join(outputBase, "schema.sql");
  const schemaContent = [
    "-- DuckDB schema for normalized compute-research data",
    "-- Generated by buildDuckDb",
    "--",
    `-- Normalized directory: ${absNormalized}`,
    `-- Timestamp: ${new Date().toISOString()}`,
    "",
    createStmts.join("\n\n"),
    "",
  ].join("\n");
  writeFileSync(schemaPath, schemaContent, "utf-8");

  // ── 3. Write load script ───────────────────────────────────────────────

  const loadPath = join(outputBase, "load.sql");
  const loadContent = [
    "-- DuckDB load script for normalized compute-research data",
    `-- Database path: ${absDbPath}`,
    "",
    `.open '${absDbPath}'`,
    "",
    createStmts.join("\n\n"),
    "",
    "-- Load data from parquet-placeholder JSON files",
    "",
    ...Object.keys(SCHEMAS).map((tableName) => {
      const parquetFile = `${tableName}.parquet.json`;
      const parquetPath = join(absNormalized, parquetFile);
      return [
        `INSERT INTO "${tableName}"`,
        `  SELECT UNNEST(rows) FROM read_json_auto('${parquetPath}', format='array');`,
      ].join("\n");
    }),
    "",
  ].join("\n");
  writeFileSync(loadPath, loadContent, "utf-8");

  // ── 4. Reference the views SQL file ───────────────────────────────────

  const viewsPath = join(outputBase, "views.sql");
  const viewsNote = [
    "-- Analytical views for compute-research data",
    "-- See research/sql/views.sql for the canonical view definitions",
    `-- Symbolic reference: research/sql/views.sql`,
    "",
  ].join("\n");
  writeFileSync(viewsPath, viewsNote, "utf-8");

  // ── 5. Execute (if configured) ────────────────────────────────────────

  let executed = false;

  return {
    db_path: absDbPath,
    schema_path: schemaPath,
    load_script_path: loadPath,
    sql_view_path: viewsPath,
    executed,
  };
}
