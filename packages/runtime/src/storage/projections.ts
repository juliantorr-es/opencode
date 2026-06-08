import { Database } from "./db"

// ── Projection Metadata Table ────────────────────────

// ── Raw-client helper ──────────────────────────────────
// Database.Client() returns a Drizzle wrapper; the native PGlite
// client lives under $client for raw .exec()/.query() calls.
function getRawClient() {
  const db = Database.Client() as unknown as { $client?: { exec(sql: string): void; query(sql: string, params?: unknown[]): { rows: Record<string, unknown>[] } } }
  return db.$client ?? (db as unknown as { exec(sql: string): void; query(sql: string, params?: unknown[]): { rows: Record<string, unknown>[] } })
}

export async function ensureProjectionMeta(): Promise<void> {
  const raw = getRawClient()
  await raw.exec(`
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
  await ensureProjectionMeta()
  const raw = getRawClient()

  const query = name
    ? `SELECT name, version, last_built_at, last_checked_at, is_stale FROM _projection_meta WHERE name = $1`
    : `SELECT name, version, last_built_at, last_checked_at, is_stale FROM _projection_meta`

  const params: unknown[] = name ? [name] : []
  const result = await raw.query(query, params)
  const rows = result.rows as ProjectionMetaRow[]

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

  return rows.map((row) => {
    const status: ProjectionHealthStatus = row.is_stale ? "stale" : "current"
    return {
      name: row.name,
      status,
      version: row.version,
      lastBuiltAt: row.last_built_at,
      lastCheckedAt: row.last_checked_at,
      isStale: Boolean(row.is_stale),
      fallback: "none",
    }
  })
}

type ProjectionMetaRow = {
  name: string
  version: number
  last_built_at: number | null
  last_checked_at: number | null
  is_stale: number
}

/**
 * Mark a projection as rebuilt and current.
 * Call after a successful rebuild.
 */
export async function markProjectionCurrent(name: string, version: number = 1): Promise<void> {
  await ensureProjectionMeta()
  const raw = getRawClient()
  const now = Date.now()
  await raw.query(
    `INSERT INTO _projection_meta (name, version, last_built_at, last_checked_at, is_stale)
     VALUES ($1, $2, $3, $4, 0)
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
  await ensureProjectionMeta()
  const raw = getRawClient()
  const now = Date.now()
  await raw.query(
    `UPDATE _projection_meta SET is_stale = 1, last_checked_at = $1 WHERE name = $2`,
    [now, name]
  )
}
