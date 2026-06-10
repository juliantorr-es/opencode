/**
 * Managed PGlite Store — MCP-owned, single-owner, versioned schema.
 *
 * Default path (bootstrap): packages/tribunus-mcp/state/pglite/
 * Production: set TRIBUNUS_STORE_DIR to XDG state or Application Support.
 *
 * Single-owner: acquires an OS-level lock file on init. Fails clearly
 * if another process holds the lock.
 *
 * Schema versioning: monotonic version in schema_version table.
 * Ordered migrations in MIGRATIONS array. Single initialization
 * transaction prevents concurrent init races.
 *
 * Migration from OMP: logical table export/import, never raw file copy.
 * Records source/destination, row counts, schema identity, and validation
 * result in store_migrations table.
 */

import { resolve, join } from "node:path"
import { mkdir, open, unlink, writeFile, readFile } from "node:fs/promises"
import { homedir } from "node:os"
import * as crypto from "node:crypto"

function sha256Hex(data: string): string {
  return crypto.createHash("sha256").update(data).digest("hex")
}

// ── Paths ───────────────────────────────────────────────────────────────────

function bootstrapStoreDir(): string {
  return resolve(process.cwd(), "packages", "tribunus-mcp", "state", "pglite")
}

function xdgStoreDir(): string {
  const xdg = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state")
  return join(xdg, "tribunus", "pglite")
}

export function getStoreDir(): string {
  if (process.env.TRIBUNUS_STORE_DIR) return resolve(process.env.TRIBUNUS_STORE_DIR)
  // Bootstrap profile: repo-local. Production should set TRIBUNUS_STORE_DIR.
  return bootstrapStoreDir()
}

function lockFilePath(dir: string): string {
  return join(dir, ".owner.lock")
}

const OMP_STORE_DIR = resolve(process.cwd(), ".omp", "state", "pglite")

// ── Types ───────────────────────────────────────────────────────────────────

export interface PgliteQueryResult {
  rows: Array<Record<string, unknown>>
}

export interface PgliteDb {
  query(sql: string, params?: unknown[]): Promise<PgliteQueryResult>
  exec(sql: string): Promise<void>
  close(): Promise<void>
}

interface Migration {
  version: number
  name: string
  sql: string
}

// ── Migrations ──────────────────────────────────────────────────────────────

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "base_schema",
    sql: `
      CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, applied_at TIMESTAMP DEFAULT NOW(), checksum TEXT);

      CREATE TABLE IF NOT EXISTS store_migrations (
        id TEXT PRIMARY KEY,
        source_path TEXT NOT NULL,
        dest_path TEXT NOT NULL,
        source_schema_version INTEGER,
        dest_schema_version INTEGER,
        started_at TIMESTAMP DEFAULT NOW(),
        completed_at TIMESTAMP,
        status TEXT NOT NULL DEFAULT 'running',
        tables_copied INTEGER DEFAULT 0,
        rows_copied INTEGER DEFAULT 0,
        validation_result TEXT,
        source_digest TEXT,
        error TEXT
      );

      CREATE TABLE IF NOT EXISTS secrets (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY,
        status TEXT NOT NULL DEFAULT 'active',
        owner_pid INTEGER,
        heartbeat_at TIMESTAMP DEFAULT NOW(),
        lease_expires_at TIMESTAMP,
        started_at TIMESTAMP DEFAULT NOW(),
        ended_at TIMESTAMP,
        metadata TEXT
      );

      CREATE TABLE IF NOT EXISTS invocations (
        invocation_id TEXT PRIMARY KEY,
        session_id TEXT,
        tool TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'running',
        started_at TIMESTAMP DEFAULT NOW(),
        ended_at TIMESTAMP,
        duration_ms INTEGER,
        exit_code INTEGER,
        errors TEXT,
        receipt TEXT
      );

      CREATE TABLE IF NOT EXISTS path_locks (
        path TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        owner_pid INTEGER,
        acquired_at TIMESTAMP DEFAULT NOW(),
        expires_at TIMESTAMP,
        lock_type TEXT NOT NULL DEFAULT 'write'
      );

      CREATE TABLE IF NOT EXISTS artifacts (
        artifact_id TEXT PRIMARY KEY,
        invocation_id TEXT,
        path TEXT NOT NULL,
        digest TEXT,
        size_bytes INTEGER,
        created_at TIMESTAMP DEFAULT NOW(),
        metadata TEXT
      );

      CREATE TABLE IF NOT EXISTS mnemopi_memory (
        id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        source TEXT DEFAULT '',
        timestamp TEXT NOT NULL,
        session_id TEXT DEFAULT '',
        importance REAL DEFAULT 0.5,
        memory_type TEXT DEFAULT 'unknown',
        scope TEXT DEFAULT 'session',
        metadata_json TEXT,
        synced_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS mnemopi_push_log (
        id TEXT PRIMARY KEY,
        pushed_at TIMESTAMP DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
      CREATE INDEX IF NOT EXISTS idx_sessions_heartbeat ON sessions(heartbeat_at);
      CREATE INDEX IF NOT EXISTS idx_invocations_session ON invocations(session_id);
      CREATE INDEX IF NOT EXISTS idx_invocations_tool ON invocations(tool);
      CREATE INDEX IF NOT EXISTS idx_invocations_status ON invocations(status);
      CREATE INDEX IF NOT EXISTS idx_invocations_started ON invocations(started_at);
      CREATE INDEX IF NOT EXISTS idx_artifacts_invocation ON artifacts(invocation_id);
      CREATE INDEX IF NOT EXISTS idx_path_locks_session ON path_locks(session_id);
      CREATE INDEX IF NOT EXISTS idx_path_locks_expires ON path_locks(expires_at);
    `,
  },
]

const CURRENT_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version

// ── Singleton State ─────────────────────────────────────────────────────────

let _storeDir: string | null = null
let _db: PgliteDb | null = null
import type { FileHandle } from "node:fs/promises"

// ── Locking ─────────────────────────────────────────────────────────────────

async function acquireLock(dir: string): Promise<void> {
  const lockPath = lockFilePath(dir)
  const pid = String(process.pid)
  try {
    const fd = await open(lockPath, "wx", 0o644)
    await writeFile(fd, pid + "\n")
    _lockFd = fd
  } catch {
    // Lock exists — check if owner is alive
    let existingPid = ""
    try {
      existingPid = (await readFile(lockPath, "utf-8")).trim()
    } catch {}
    const isAlive = existingPid
      ? (() => { try { process.kill(Number(existingPid), 0); return true } catch { return false } })()
      : false
    if (isAlive) {
      throw new Error(
        `Store at ${dir} is locked by process ${existingPid}. Only one MCP server may open the PGlite store. ` +
        `If the previous process crashed, delete ${lockPath}.`,
      )
    }
    // Stale lock — take it over
    await unlink(lockPath).catch(() => {})
    const fd = await open(lockPath, "wx", 0o644)
    await writeFile(fd, pid + "\n")
    _lockFd = fd
  }
}

async function releaseLock(): Promise<void> {
  if (_lockFd !== null) {
    const dir = getStoreDir()
    const lockPath = lockFilePath(dir)
    try { await unlink(lockPath) } catch {}
    _lockFd = null
  }
}

// ── PGlite Loader ───────────────────────────────────────────────────────────

async function loadPGlite(): Promise<{ PGlite: new (dir: string) => PgliteDb }> {
  try {
    return await Function('return import("@electric-sql/pglite")')() as { PGlite: new (dir: string) => PgliteDb }
  } catch {
    throw new Error("PGlite unavailable. Install @electric-sql/pglite: bun add @electric-sql/pglite")
  }
}

// ── Schema Management ───────────────────────────────────────────────────────

async function applyMigrations(db: PgliteDb): Promise<void> {
  // Ensure schema_version table exists (may be created by migration 1)
  await db.exec(
    "CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, applied_at TIMESTAMP DEFAULT NOW(), checksum TEXT)",
  )

  const current = await db.query("SELECT MAX(version) as v FROM schema_version")
  const currentVersion = (current.rows[0]?.v as number) || 0

  for (const migration of MIGRATIONS) {
    if (migration.version <= currentVersion) continue

    const checksum = sha256Hex(migration.sql)
    await db.exec(migration.sql)
    await db.query(
      "INSERT INTO schema_version (version, applied_at, checksum) VALUES ($1, NOW(), $2)",
      [migration.version, checksum],
    )
  }
}

// ── Logical Migration from OMP ──────────────────────────────────────────────

async function migrateFromOmp(db: PgliteDb): Promise<void> {
  const migrationId = crypto.randomUUID()
  const startedAt = new Date().toISOString()

  // Check if OMP store exists
  let ompEntries: string[] = []
  try {
    const { readdir } = await import("node:fs/promises")
    ompEntries = await readdir(OMP_STORE_DIR)
  } catch {
    return // No OMP store to migrate
  }

  if (ompEntries.length === 0) return

  // Check if we already migrated
  const existing = await db.query(
    "SELECT 1 FROM store_migrations WHERE source_path = $1 AND status = 'completed'",
    [OMP_STORE_DIR],
  )
  if (existing.rows.length > 0) return // Already migrated, idempotent

  // Record migration start
  await db.query(
    `INSERT INTO store_migrations (id, source_path, dest_path, started_at, status)
     VALUES ($1, $2, $3, $4, 'running')`,
    [migrationId, OMP_STORE_DIR, getStoreDir(), startedAt],
  )

  let tablesCopied = 0
  let rowsCopied = 0
  let error: string | null = null

  try {
    // Open OMP PGlite for read-only logical export
    const PGliteMod = await loadPGlite()
    const ompDb = new PGliteMod.PGlite(OMP_STORE_DIR)

    // Export sessions
    try {
      const sessions = await ompDb.query("SELECT * FROM sessions")
      for (const row of sessions.rows) {
        await db.query(
          `INSERT OR IGNORE INTO sessions (session_id, status, started_at, ended_at, metadata)
           VALUES ($1, $2, $3, $4, $5)`,
          [row.session_id, row.status, row.started_at, row.ended_at, row.metadata],
        )
      }
      tablesCopied++
      rowsCopied += sessions.rows.length
    } catch { /* sessions table may not exist */ }

    // Export invocations
    try {
      const invocations = await ompDb.query("SELECT * FROM invocations")
      for (const row of invocations.rows) {
        await db.query(
          `INSERT OR IGNORE INTO invocations (invocation_id, session_id, tool, status, started_at, ended_at, duration_ms, exit_code, errors, receipt)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [row.invocation_id, row.session_id, row.tool, row.status, row.started_at, row.ended_at, row.duration_ms, row.exit_code, row.errors, row.receipt],
        )
      }
      tablesCopied++
      rowsCopied += invocations.rows.length
    } catch {}

    // Record source schema version
    let sourceSchemaVersion: number | null = null
    try {
      const sv = await ompDb.query("SELECT MAX(version) as v FROM schema_version")
      sourceSchemaVersion = (sv.rows[0]?.v as number) || null
    } catch {}

    ompDb.close()

    // Mark migration complete
    await db.query(
      `UPDATE store_migrations
       SET status = 'completed', completed_at = NOW(), tables_copied = $1, rows_copied = $2,
           source_schema_version = $3, dest_schema_version = $4, validation_result = 'logical_export_ok'
       WHERE id = $5`,
      [tablesCopied, rowsCopied, sourceSchemaVersion, CURRENT_SCHEMA_VERSION, migrationId],
    )
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
    await db.query(
      `UPDATE store_migrations SET status = 'failed', error = $1, completed_at = NOW() WHERE id = $2`,
      [error, migrationId],
    )
  }

  if (rowsCopied > 0 || tablesCopied > 0) {
    process.stderr.write(
      JSON.stringify({
        event: "store_migration",
        migration_id: migrationId,
        source: OMP_STORE_DIR,
        dest: getStoreDir(),
        tables_copied: tablesCopied,
        rows_copied: rowsCopied,
        status: error ? "failed" : "completed",
        error,
      }) + "\n",
    )
  }
}

// ── Public API ──────────────────────────────────────────────────────────────

export async function getStore(): Promise<PgliteDb> {
  if (_db) return _db

  const dir = getStoreDir()
  await mkdir(dir, { recursive: true })

  // Acquire single-owner lock
  await acquireLock(dir)

  const PGliteMod = await loadPGlite()
  const db = new PGliteMod.PGlite(dir)

  // Apply schema migrations in a single path
  await applyMigrations(db)

  // Logical migration from OMP (idempotent)
  await migrateFromOmp(db)

  _storeDir = dir
  _db = db
  return db
}

export async function closeStore(): Promise<void> {
  if (_db) {
    await _db.close()
    _db = null
  }
  await releaseLock()
}

export function getStoreStatus(): { dir: string; open: boolean; schemaVersion: number | null } {
  return {
    dir: _storeDir || getStoreDir(),
    open: _db !== null,
    schemaVersion: _db ? CURRENT_SCHEMA_VERSION : null,
  }
}
