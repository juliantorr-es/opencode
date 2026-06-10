// === PGlite Coordination Store — Migration Runner ===
// Loads .sql files from migrations/ in version order, checks schema_migrations
// table for already-applied versions, runs unapplied migrations in a transaction,
// and records each applied migration. Fully idempotent.
//
// Enforces migration integrity: if a previously applied migration's stored
// checksum differs from the current file checksum, initialization fails.

import { readdirSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { createHash } from "node:crypto"
import type { PGliteLike } from "./pglite-runtime.js"

const MIGRATIONS_DIR = resolve(new URL(".", import.meta.url).pathname, "migrations")

async function ensureTrackingTable(db: PGliteLike): Promise<void> {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version     TEXT PRIMARY KEY,
      applied_at  TEXT NOT NULL DEFAULT (to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
      checksum    TEXT
    )
  `)
}

function discoverMigrations(): Array<{ version: string; path: string; checksum: string }> {
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql"))
  files.sort()
  return files.map((f) => {
    const fullPath = resolve(MIGRATIONS_DIR, f)
    const content = readFileSync(fullPath, "utf-8")
    const checksum = createHash("sha256").update(content, "utf-8").digest("hex")
    return { version: f.replace(/\.sql$/, ""), path: fullPath, checksum }
  })
}

async function getAppliedVersions(db: PGliteLike): Promise<Map<string, string>> {
  try {
    const result = await db.query<{ version: string; checksum?: string }>(
      "SELECT version, checksum FROM schema_migrations ORDER BY version",
    )
    return new Map(result.rows.map((r) => [r.version, r.checksum ?? ""]))
  } catch {
    return new Map()
  }
}

export async function runMigrations(db: PGliteLike): Promise<void> {
  await ensureTrackingTable(db)
  const migrations = discoverMigrations()
  const applied = await getAppliedVersions(db)

  // Check integrity: already-applied migrations must have matching checksums
  for (const m of migrations) {
    const storedChecksum = applied.get(m.version)
    if (storedChecksum === undefined) continue // not yet applied
    if (storedChecksum !== m.checksum) {
      throw new Error(
        `Migration integrity error: version ${m.version} has a different checksum than when it was applied.\n` +
        `  File: ${m.path}\n` +
        `  Stored: ${storedChecksum}\n` +
        `  Current: ${m.checksum}`,
      )
    }
  }

  for (const m of migrations) {
    if (applied.has(m.version)) continue
    const sql = readFileSync(m.path, "utf-8")
    await db.exec("BEGIN")
    try {
      await db.exec(sql)
      await db.query(
        "INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)",
        [m.version, m.checksum],
      )
      await db.exec("COMMIT")
    } catch (e) {
      await db.exec("ROLLBACK")
      throw e
    }
  }
}

export async function listAppliedMigrations(
  db: PGliteLike,
): Promise<Array<{ version: string; applied_at: string; checksum?: string }>> {
  try {
    const result = await db.query<{ version: string; applied_at: string; checksum?: string }>(
      "SELECT version, applied_at, checksum FROM schema_migrations ORDER BY version",
    )
    return result.rows
  } catch {
    return []
  }
}
