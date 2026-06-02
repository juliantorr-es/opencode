import { Database } from "./db"

// ── Projection Metadata Table ────────────────────────

export async function ensureProjectionMeta(): Promise<void> {
  const db = Database.Client()
  db.execute(`
    CREATE TABLE IF NOT EXISTS _projection_meta (
      name TEXT PRIMARY KEY,
      version INTEGER NOT NULL DEFAULT 1,
      last_built_at BIGINT,
      last_checked_at BIGINT,
      is_stale INTEGER NOT NULL DEFAULT 0
    )
  `)
}
