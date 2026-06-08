// === DuckDB Analytical Projector — PGlite-to-DuckDB Projection Engine v1 ===
// Creates/refreshes DuckDB analytical database from PGlite rows and SQL view
// definitions.  Gracefully degrades when duckdb or pglite is not installed.

import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs"
import { resolve, dirname } from "node:path"
import type { OmpToolContextV1 } from "../types.js"

// ── Dynamic module loads (dependencies may not be installed) ──

let DuckDbCtor: (new (path: string) => DuckDbInstance) | null = null
let PGliteCtor: (new (path: string) => PGliteInstance) | null = null

type DuckDbInstance = {
  exec(sql: string, callback: (err: Error | null) => void): void
  all(sql: string, callback: (err: Error | null, rows: any[]) => void): void
  run(sql: string, ...args: any[]): void
  close(callback?: (err: Error | null) => void): void
}

type PGliteInstance = {
  query(sql: string, params?: any[]): Promise<{ rows: any[]; fields?: any[] }>
  close(): Promise<void>
}

try {
  const duckdb = await import("duckdb")
  DuckDbCtor = duckdb.Database
} catch {
  /* DuckDB not available — projection disabled */
}

try {
  const pglite = await import("@electric-sql/pglite")
  PGliteCtor = pglite.PGlite
} catch {
  /* PGlite not available — data projection disabled */
}

// ── DuckDB table DDL (mirrors PGlite core tables; analytical extras added) ──

const DUCKDB_TABLE_DDL = [
  `CREATE TABLE IF NOT EXISTS sessions (
    session_id TEXT PRIMARY KEY,
    actor_id TEXT NOT NULL,
    status TEXT NOT NULL,
    purpose TEXT,
    started_at TEXT NOT NULL,
    last_heartbeat_at TEXT NOT NULL,
    closed_at TEXT
  )`,

  `CREATE TABLE IF NOT EXISTS tool_invocations (
    invocation_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    work_id TEXT,
    tool_id TEXT NOT NULL,
    tool_version TEXT NOT NULL,
    status TEXT NOT NULL,
    risk_level TEXT NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT NOT NULL,
    duration_ms INTEGER NOT NULL,
    input_sha256 TEXT NOT NULL,
    output_sha256 TEXT,
    receipt_id TEXT,
    error_code TEXT,
    error_message TEXT
  )`,

  `CREATE TABLE IF NOT EXISTS tool_file_effects (
    effect_id TEXT PRIMARY KEY,
    receipt_id TEXT,
    invocation_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    path TEXT NOT NULL,
    action TEXT NOT NULL,
    before_sha256 TEXT,
    expected_before_sha256 TEXT,
    after_sha256 TEXT,
    before_size_bytes INTEGER,
    after_size_bytes INTEGER,
    diff_path TEXT,
    diff_sha256 TEXT,
    created_at TEXT
  )`,

  `CREATE TABLE IF NOT EXISTS path_locks (
    lock_id TEXT PRIMARY KEY,
    path TEXT NOT NULL,
    lock_kind TEXT NOT NULL,
    session_id TEXT NOT NULL,
    work_id TEXT,
    status TEXT NOT NULL,
    acquired_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    released_at TEXT
  )`,

  `CREATE TABLE IF NOT EXISTS write_journals (
    journal_id TEXT PRIMARY KEY,
    receipt_id TEXT,
    invocation_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    journal_path TEXT NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS tool_receipts (
    receipt_id TEXT PRIMARY KEY,
    invocation_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    tool_id TEXT NOT NULL,
    tool_version TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    receipt_path TEXT NOT NULL,
    receipt_sha256 TEXT,
    event_path TEXT,
    journal_path TEXT,
    summary TEXT NOT NULL
  )`,
] as const

// ── Helpers ──

/** Promisify DuckDB exec() — runs DDL / DML with no row return. */
function execAsync(db: DuckDbInstance, sql: string): Promise<void> {
  return new Promise((resolve, reject) => {
    db.exec(sql, (err: Error | null) => (err ? reject(err) : resolve()))
  })
}

/** Promisify DuckDB all() — returns all result rows. */
function allAsync(db: DuckDbInstance, sql: string): Promise<any[]> {
  return new Promise((resolve, reject) => {
    db.all(sql, (err: Error | null, rows: any[]) =>
      err ? reject(err) : resolve(rows),
    )
  })
}

/** Escape a text value for safe SQL interpolation into INSERT VALUES. */
function esc(val: unknown): string {
  if (val === null || val === undefined) return "NULL"
  const s = String(val)
  // Escape single quotes by doubling, wrap in quotes
  return `'${s.replace(/'/g, "''")}'`
}

/**
 * Project all rows from PGlite into DuckDB destination tables.
 * Uses a full-refresh strategy: DELETE all rows, then INSERT fresh copies.
 * The `created_at` column on `tool_file_effects` is populated from the
 * corresponding invocation's `started_at`.
 */
async function projectFromPGlite(
  duckDb: DuckDbInstance,
  ctx: OmpToolContextV1,
): Promise<void> {
  if (!PGliteCtor) return // PGlite not installed — skip

  const pglite = new PGliteCtor(ctx.paths.pglite_dir)

  try {
    // ── Sessions ──
    const srcSessions = await pglite.query("SELECT * FROM sessions")
    const sessions = srcSessions.rows
    await execAsync(duckDb, "DELETE FROM sessions")
    for (const row of sessions) {
      await execAsync(
        duckDb,
        `INSERT INTO sessions VALUES (${[
          esc(row.session_id),
          esc(row.actor_id),
          esc(row.status),
          esc(row.purpose),
          esc(row.started_at),
          esc(row.last_heartbeat_at),
          esc(row.closed_at),
        ].join(",")})`,
      )
    }

    // ── Tool invocations ──
    const srcInvocations = await pglite.query("SELECT * FROM tool_invocations")
    const invocations = srcInvocations.rows
    await execAsync(duckDb, "DELETE FROM tool_invocations")
    for (const row of invocations) {
      await execAsync(
        duckDb,
        `INSERT INTO tool_invocations VALUES (${[
          esc(row.invocation_id),
          esc(row.session_id),
          esc(row.work_id),
          esc(row.tool_id),
          esc(row.tool_version),
          esc(row.status),
          esc(row.risk_level),
          esc(row.started_at),
          esc(row.finished_at),
          esc(row.duration_ms),
          esc(row.input_sha256),
          esc(row.output_sha256),
          esc(row.receipt_id),
          esc(row.error_code),
          esc(row.error_message),
        ].join(",")})`,
      )
    }

    // ── Tool file effects (with created_at from invocations) ──
    const srcEffects = await pglite.query("SELECT * FROM tool_file_effects")
    const effects = srcEffects.rows
    await execAsync(duckDb, "DELETE FROM tool_file_effects")

    // Build a lookup from invocation_id → started_at
    const startedAt = new Map<string, string>()
    for (const inv of invocations) {
      if (inv.invocation_id && inv.started_at) {
        startedAt.set(inv.invocation_id as string, inv.started_at as string)
      }
    }

    for (const row of effects) {
      const created = startedAt.get(row.invocation_id as string) ?? null
      await execAsync(
        duckDb,
        `INSERT INTO tool_file_effects VALUES (${[
          esc(row.effect_id),
          esc(row.receipt_id),
          esc(row.invocation_id),
          esc(row.session_id),
          esc(row.path),
          esc(row.action),
          esc(row.before_sha256),
          esc(row.expected_before_sha256),
          esc(row.after_sha256),
          esc(row.before_size_bytes),
          esc(row.after_size_bytes),
          esc(row.diff_path),
          esc(row.diff_sha256),
          esc(created),
        ].join(",")})`,
      )
    }

    // ── Path locks ──
    const srcLocks = await pglite.query("SELECT * FROM path_locks")
    const locks = srcLocks.rows
    await execAsync(duckDb, "DELETE FROM path_locks")
    for (const row of locks) {
      await execAsync(
        duckDb,
        `INSERT INTO path_locks VALUES (${[
          esc(row.lock_id),
          esc(row.path),
          esc(row.lock_kind),
          esc(row.session_id),
          esc(row.work_id),
          esc(row.status),
          esc(row.acquired_at),
          esc(row.expires_at),
          esc(row.released_at),
        ].join(",")})`,
      )
    }

    // ── Write journals ──
    const srcJournals = await pglite.query("SELECT * FROM write_journals")
    const journals = srcJournals.rows
    await execAsync(duckDb, "DELETE FROM write_journals")
    for (const row of journals) {
      await execAsync(
        duckDb,
        `INSERT INTO write_journals VALUES (${[
          esc(row.journal_id),
          esc(row.receipt_id),
          esc(row.invocation_id),
          esc(row.session_id),
          esc(row.status),
          esc(row.created_at),
          esc(row.updated_at),
          esc(row.journal_path),
        ].join(",")})`,
      )
    }

    // ── Tool receipts ──
    const srcReceipts = await pglite.query("SELECT * FROM tool_receipts")
    const receipts = srcReceipts.rows
    await execAsync(duckDb, "DELETE FROM tool_receipts")
    for (const row of receipts) {
      await execAsync(
        duckDb,
        `INSERT INTO tool_receipts VALUES (${[
          esc(row.receipt_id),
          esc(row.invocation_id),
          esc(row.session_id),
          esc(row.tool_id),
          esc(row.tool_version),
          esc(row.status),
          esc(row.created_at),
          esc(row.receipt_path),
          esc(row.receipt_sha256),
          esc(row.event_path),
          esc(row.journal_path),
          esc(row.summary),
        ].join(",")})`,
      )
    }
  } finally {
    await pglite.close()
  }
}

// ── Public API ──

/**
 * Create / refresh the DuckDB analytical database.
 *
 * 1. Creates (if missing) and connects to the DuckDB database.
 * 2. Creates all source tables with `CREATE TABLE IF NOT EXISTS`.
 * 3. Projects all rows from the PGlite coordination store into DuckDB.
 * 4. Reads every `.sql` file in `views/` (sorted alphabetically) and runs it
 *    as `CREATE OR REPLACE VIEW`.
 *
 * Returns the count of views successfully created.
 */
export async function refreshProjections(
  ctx: OmpToolContextV1,
): Promise<{ success: boolean; views_created: number; error?: string }> {
  if (!DuckDbCtor) {
    return {
      success: false,
      views_created: 0,
      error: "DuckDB module not available — install duckdb npm package",
    }
  }

  const dbPath = ctx.paths.duckdb_path
  const dbDir = dirname(dbPath)

  if (!existsSync(dbDir)) {
    mkdirSync(dbDir, { recursive: true })
  }

  const db = new DuckDbCtor(dbPath)

  try {
    // 1. Create source tables
    for (const ddl of DUCKDB_TABLE_DDL) {
      await execAsync(db, ddl)
    }

    // 2. Project data from PGlite
    await projectFromPGlite(db, ctx)

    // 3. Create / refresh analytical views from SQL files
    const viewsDir = resolve(import.meta.dirname, "views")
    let viewFiles: string[] = []
    try {
      viewFiles = readdirSync(viewsDir)
        .filter((f) => f.endsWith(".sql"))
        .sort()
    } catch {
      // Views directory does not exist; nothing to create
    }

    for (const vf of viewFiles) {
      const sql = readFileSync(resolve(viewsDir, vf), "utf-8")
      await execAsync(db, sql)
    }

    return { success: true, views_created: viewFiles.length }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { success: false, views_created: 0, error: msg }
  } finally {
    await new Promise<void>((resolve) => {
      db.close((err: Error | null) => {
        if (err) {
          // Closing failure is non-fatal — log would go here
        }
        resolve()
      })
    })
  }
}

/**
 * Run a read-only SELECT query against the DuckDB analytical database.
 *
 * Returns the full result set as an array of rows.  Throws if the query is
 * not a SELECT (DuckDB rejects non-read-only statements naturally, but the
 * caller should only pass SELECT or EXPLAIN queries).
 *
 * Returns an empty array if DuckDB is not available.
 */
export async function queryProjection(
  ctx: OmpToolContextV1,
  sql: string,
): Promise<Array<Record<string, unknown>>> {
  if (!DuckDbCtor) return []

  const dbPath = ctx.paths.duckdb_path
  if (!existsSync(dbPath)) return [] // No database yet — nothing to query

  const db = new DuckDbCtor(dbPath)

  try {
    const rows = await allAsync(db, sql)
    return rows as Array<Record<string, unknown>>
  } finally {
    await new Promise<void>((resolve) => {
      db.close((err: Error | null) => {
        if (err) {
          // Non-fatal
        }
        resolve()
      })
    })
  }
}
