// === PGlite Coordination Store — Migration Runner ===
// Loads .sql files from migrations/ in version order, checks schema_migrations
// table for already-applied versions, runs unapplied migrations in a transaction,
// and records each applied migration. Fully idempotent.

import { readdirSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { createHash } from "node:crypto"
import type { PGliteLike } from "./pglite-runtime.js"

const MIGRATIONS_DIR = resolve(import.meta.dirname, "migrations")

/**
 * Ensure the schema_migrations tracking table exists.
 */
async function ensureTrackingTable(db: PGliteLike): Promise<void> {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      checksum   TEXT
    )
  `)
}

/**
 * Discover SQL migration files, sorted by version (filename prefix).
 * Returns `[{ version, path, checksum }]`.
 */
function discoverMigrations(): Array<{ version: string; path: string; checksum: string }> {
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql"))
  files.sort() // lexical sort by filename prefix (0001_*, 0002_*, ...)

  return files.map((f) => {
    const version = f.replace(/\.sql$/, "")
    const fullPath = resolve(MIGRATIONS_DIR, f)
    const content = readFileSync(fullPath, "utf-8")
    const checksum = createHash("sha256").update(content, "utf-8").digest("hex")
    return { version, path: fullPath, checksum }
  })
}

/**
 * Return the set of already-applied migration versions from the DB.
 */
async function getAppliedVersions(db: PGliteLike): Promise<Set<string>> {
  try {
    const result = await db.query<{ version: string }>("SELECT version FROM schema_migrations ORDER BY version")
    return new Set(result.rows.map((r) => r.version))
  } catch {
    // Table might not exist yet — return empty set; callers should ensureTrackingTable first
    return new Set()
  }
}

/**
 * Run all pending migrations. Idempotent — safe to call multiple times.
 *
 * Steps:
 *  1. Ensure schema_migrations table exists
 *  2. Read applied migration versions
 *  3. For each unapplied migration, run it in a transaction
 *  4. Record the migration in schema_migrations
 */
export async function runMigrations(db: PGliteLike): Promise<void> {
  await ensureTrackingTable(db)

  const applied = await getAppliedVersions(db)
  const pending = discoverMigrations().filter((m) => !applied.has(m.version))

  if (pending.length === 0) return

  for (const migration of pending) {
    const sql = readFileSync(migration.path, "utf-8")

    // Run each migration in its own transaction
    await db.exec("BEGIN")
    try {
      await db.exec(sql)
      await db.query(
        "INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)",
        [migration.version, migration.checksum],
      )
      await db.exec("COMMIT")
    } catch (err) {
      await db.exec("ROLLBACK")
      throw new Error(
        `Migration ${migration.version} failed: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }
}

/**
 * List all applied migrations with their checksums.
 */
export async function listAppliedMigrations(db: PGliteLike): Promise<Array<{ version: string; applied_at: string; checksum?: string }>> {
  await ensureTrackingTable(db)
  const result = await db.query<{ version: string; applied_at: string; checksum: string | null }>(
    "SELECT version, applied_at, checksum FROM schema_migrations ORDER BY version",
  )
  return result.rows.map((r) => ({
    version: r.version,
    applied_at: r.applied_at,
    checksum: r.checksum ?? undefined,
  }))
}
