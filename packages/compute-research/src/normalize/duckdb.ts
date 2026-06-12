import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { NORMALIZED_TABLE_SCHEMAS } from "./schema.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface DuckDbConfig {
  /** Path to a DuckDB CLI binary.  Defaults to "duckdb" (PATH lookup). */
  readonly cliPath?: string;
  /** Path to views.sql.  If unset, searched relative to CWD and known locations. */
  readonly viewsPath?: string;
}

export interface DuckDbResult {
  readonly db_path: string;
  readonly executed: boolean;
  readonly error?: string;
  readonly smoke_query_result?: { count: number }[];
}

// ── Arrow → NDJSON ───────────────────────────────────────────────────────────

/**
 * Read an Arrow IPC file and produce NDJSON rows.
 *
 * apache-arrow is used here because DuckDB CLI v1.5.x does not have a built-in
 * `arrow_ipc_scan` function (the arrow extension was added in v1.6+).  We
 * convert the Arrow data to NDJSON and use DuckDB's native `read_json_auto`.
 *
 * Once DuckDB v1.6+ is available system-wide, this conversion can be removed
 * and tables created directly via:
 *   CREATE TABLE t AS SELECT * FROM arrow_ipc_scan('t.arrow');
 */
function arrowFileToNdjson(arrowPath: string, columns: Record<string, string>): string {
  let tableFromIPC: (buf: ArrayBufferLike) => unknown;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const arrow = require("apache-arrow");
    tableFromIPC = arrow.tableFromIPC;
  } catch {
    // apache-arrow not available; try .ndjson fallback
    const ndjsonPath = arrowPath.replace(/\.arrow$/, ".ndjson");
    if (existsSync(ndjsonPath)) {
      return readFileSync(ndjsonPath, "utf-8");
    }
    throw new Error(
      `Cannot read ${arrowPath}: apache-arrow not available and no .ndjson fallback found`,
    );
  }

  const raw = readFileSync(arrowPath);
  const ab = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
  const table = tableFromIPC(ab) as {
    numRows: number;
    schema: { fields: Array<{ name: string }> };
    getChild: (name: string) => { get: (i: number) => unknown } | null;
  };
  const colNames = Object.keys(columns);
  const lines: string[] = new Array(table.numRows);

  for (let i = 0; i < table.numRows; i++) {
    const row: Record<string, unknown> = {};
    for (const col of colNames) {
      const colVec = table.getChild(col);
      row[col] = colVec ? colVec.get(i) : null;
    }
    lines[i] = JSON.stringify(row);
  }

  return lines.join("\n") + "\n";
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Build a DuckDB database from normalized Arrow IPC files.
 *
 * Steps:
 *   1. Convert each `.arrow` file to NDJSON (DuckDB CLI v1.5.x needs NDJSON)
 *   2. Shell out to `duckdb` CLI to CREATE TABLE + load data
 *   3. Execute analytical views from research/sql/views.sql
 *   4. Run smoke query: SELECT COUNT(*) FROM valid_claim_runs
 *
 * Returns DuckDbResult with `executed: true` on success, including smoke-query
 * results.  If DuckDB CLI is unavailable, sets `executed: false` and writes an
 * error message.
 */
export function buildDuckDb(
  normalizedDir: string,
  dbPath: string,
  config?: DuckDbConfig,
): DuckDbResult {
  const absNormalized = resolve(normalizedDir);
  const absDbPath = resolve(dbPath);

  // ── 1. Validate DuckDB CLI availability ────────────────────────────────

  const cli = config?.cliPath ?? "duckdb";
  let cliAvailable = false;
  try {
    execSync(`${cli} --version`, { stdio: "pipe", timeout: 5000 });
    cliAvailable = true;
  } catch {
    return {
      db_path: absDbPath,
      executed: false,
      error: `DuckDB CLI ("${cli}") not found or not executable. Install DuckDB via 'brew install duckdb' or set config.cliPath.`,
    };
  }

  // ── 2. Convert .arrow → NDJSON and emit CREATE TABLE statements ────────

  const outputBase = join(absNormalized, ".duckdb");
  mkdirSync(outputBase, { recursive: true });

  const createStmts: string[] = [];
  const ndjsonDir = join(outputBase, "ndjson");
  mkdirSync(ndjsonDir, { recursive: true });

  for (const [tableName, cols] of Object.entries(NORMALIZED_TABLE_SCHEMAS)) {
    const colDefs = Object.entries(cols)
      .map(([name, type]) => `  "${name}" ${type}`)
      .join(",\n");

    createStmts.push(
      `CREATE TABLE IF NOT EXISTS "${tableName}" (\n${colDefs}\n);`,
    );

    const arrowFile = `${tableName}.arrow`;
    const arrowPath = join(absNormalized, arrowFile);
    const ndjsonFile = `${tableName}.ndjson`;
    const ndjsonPath = join(ndjsonDir, ndjsonFile);

    if (existsSync(arrowPath)) {
      try {
        const ndjson = arrowFileToNdjson(arrowPath, cols);
        writeFileSync(ndjsonPath, ndjson, "utf-8");
      } catch (err) {
        return {
          db_path: absDbPath,
          executed: false,
          error: `Failed to convert ${arrowPath} to NDJSON: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    } else {
      // Table may be empty; write empty NDJSON
      writeFileSync(ndjsonPath, "", "utf-8");
    }
  }

  // ── 3. Write load SQL script ───────────────────────────────────────────

  const loadPath = join(outputBase, "load.sql");
  const loadLines: string[] = [
    "-- DuckDB load script for normalized compute-research data",
    "-- Generated by buildDuckDb",
    "--",
    `-- Normalized directory: ${absNormalized}`,
    `-- Timestamp: ${new Date().toISOString()}`,
    "",
    createStmts.join("\n\n"),
    "",
    "-- Load data from NDJSON files",
    "",
  ];

  for (const [tableName, cols] of Object.entries(NORMALIZED_TABLE_SCHEMAS)) {
    const ndjsonPath = join(ndjsonDir, `${tableName}.ndjson`);
    // Only INSERT if there are rows; otherwise the empty NDJSON causes
    // read_json_auto to infer 0 columns (DuckDB issue with empty files).
    const ndjsonContent = readFileSync(ndjsonPath, "utf-8").trim();
    if (ndjsonContent.length > 0) {
      const columnList = Object.keys(cols)
        .map((name) => `"${name}"`)
        .join(", ");
      loadLines.push(
        `INSERT INTO "${tableName}" (${columnList}) SELECT ${columnList} FROM read_json_auto('${ndjsonPath}');`,
      );
    }
  }

  loadLines.push("");
  writeFileSync(loadPath, loadLines.join("\n"), "utf-8");

  // ── 4. Locate and copy views.sql ───────────────────────────────────────

  // Use explicit path, or search relative to CWD and other known locations
  const viewsCandidates: string[] = [];
  if (config?.viewsPath) {
    viewsCandidates.push(resolve(config.viewsPath));
  }
  // Search relative to CWD (repo root via multiple parent depths)
  const cwd = process.cwd();
  viewsCandidates.push(
    resolve(join(cwd, "research", "sql", "views.sql")),
    resolve(join(cwd, "..", "research", "sql", "views.sql")),
    resolve(join(cwd, "..", "..", "research", "sql", "views.sql")),
    resolve(join(cwd, "..", "..", "..", "research", "sql", "views.sql")),
    resolve(join(__dirname, "..", "..", "..", "..", "..", "research", "sql", "views.sql")),
    resolve(join(absNormalized, "..", "..", "..", "..", "research", "sql", "views.sql")),
    resolve(join(absNormalized, "..", "..", "..", "research", "sql", "views.sql")),
    resolve(join(absNormalized, "..", "..", "research", "sql", "views.sql")),
  );

  const viewsPath = join(outputBase, "views.sql");
  let viewsFound = false;
  for (const candidate of viewsCandidates) {
    const resolved = resolve(candidate);
    if (existsSync(resolved)) {
      const viewsContent = readFileSync(resolved, "utf-8");
      writeFileSync(viewsPath, viewsContent, "utf-8");
      viewsFound = true;
      break;
    }
  }

  if (!viewsFound) {
    writeFileSync(
      viewsPath,
      "-- views.sql not found at canonical path\n",
      "utf-8",
    );
  }

  // ── 5. Execute via DuckDB CLI ───────────────────────────────────────────

  // Step A: Pipe SQL init commands into the DuckDB CLI with the DB path.
  const initSql = [
    `.read '${loadPath}'`,
    `.read '${viewsPath}'`,
  ].join("\n");

  try {
    execSync(`${cli} '${absDbPath}'`, {
      input: initSql,
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 30000,
      encoding: "utf-8",
    });

    // Step B: Parseable smoke query with -csv -noheader
    const stdout = execSync(`${cli} -csv -noheader '${absDbPath}' "SELECT COUNT(*) FROM valid_claim_runs;"`, {
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 10000,
      encoding: "utf-8",
    });

    // Smoke query result is a single CSV value
    const countStr = stdout.trim();
    const count = Number.parseInt(countStr, 10);
    const smokeResult = Number.isFinite(count) ? count : 0;

    return {
      db_path: absDbPath,
      executed: true,
      smoke_query_result: [{ count: smokeResult }],
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      db_path: absDbPath,
      executed: false,
      error: `DuckDB execution failed: ${msg}`,
    };
  }
}
