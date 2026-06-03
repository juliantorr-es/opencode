import { Database } from "./db"

// ── Projection Metadata Table ────────────────────────

export async function ensureProjectionMeta(): Promise<void> {
  const db = Database.Client() as any
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

// ── Projection Health Type ───────────────────────────────

export type ProjectionHealthStatus = "current" | "stale" | "missing" | "rebuilding" | "failed"

export interface ProjectionHealth {
  name: string
  status: ProjectionHealthStatus
  version: number
  lastBuiltAt: number | null
  lastCheckedAt: number | null
  isStale: boolean
  /** When stale or missing, whether fallback to canonical read path is used */
  fallback: "used" | "disabled" | "none"
  /** Human-readable reason when not current */
  reason?: string
}

/**
 * Query projection health from the _projection_meta table.
 * Returns health for all registered projections or a specific one by name.
 */
export async function getProjectionHealth(name?: string): Promise<ProjectionHealth[]> {
  const db = Database.Client() as any
  await ensureProjectionMeta()

  const query = name
    ? `SELECT name, version, last_built_at, last_checked_at, is_stale FROM _projection_meta WHERE name = ?`
    : `SELECT name, version, last_built_at, last_checked_at, is_stale FROM _projection_meta`

  const params: any[] = name ? [name] : []
  const rows = db.query(query, params).all() as any[]

  if (rows.length === 0 && name) {
    return [{
      name,
      status: "missing" as const,
      version: 0,
      lastBuiltAt: null,
      lastCheckedAt: null,
      isStale: true,
      fallback: "used",
      reason: `Projection "${name}" has not been built`,
    }]
  }

  return rows.map((row: any) => {
    const status: ProjectionHealthStatus = row.is_stale
      ? "stale"
      : "current"
    return {
      name: row.name,
      status,
      version: row.version,
      lastBuiltAt: row.last_built_at ? Number(row.last_built_at) : null,
      lastCheckedAt: row.last_checked_at ? Number(row.last_checked_at) : null,
      isStale: Boolean(row.is_stale),
      fallback: row.is_stale ? "used" as const : "none" as const,
      reason: row.is_stale ? `Projection "${row.name}" is stale (v${row.version})` : undefined,
    }
  })
}

/**
 * Mark a projection as rebuilt and current.
 * Call after a successful rebuild.
 */
export async function markProjectionCurrent(name: string, version: number = 1): Promise<void> {
  const db = Database.Client() as any
  const now = Date.now()
  db.execute(
    `INSERT INTO _projection_meta (name, version, last_built_at, last_checked_at, is_stale)
     VALUES (?, ?, ?, ?, 0)
     ON CONFLICT (name) DO UPDATE SET
       version = excluded.version,
       last_built_at = excluded.last_built_at,
       last_checked_at = excluded.last_checked_at,
       is_stale = 0`,
    [name, version, now, now]
  )
}

/**
 * Mark a projection as stale (needs rebuild).
 */
export async function markProjectionStale(name: string): Promise<void> {
  const db = Database.Client() as any
  const now = Date.now()
  db.execute(
    `UPDATE _projection_meta SET is_stale = 1, last_checked_at = ? WHERE name = ?`,
    [now, name]
  )
}
