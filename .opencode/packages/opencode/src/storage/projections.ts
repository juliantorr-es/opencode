import { Effect } from "effect"
import { Database } from "./db"
import { Client } from "./db.pg"

// ── Projection Registry ──────────────────────────────
// Each projection knows how to rebuild itself from canonical truth.

export interface Projection {
  readonly name: string
  readonly version: number
  /** Rebuild the entire projection from canonical truth. */
  readonly rebuild: () => Effect.Effect<void>
  /** Check projection consistency against canonical truth. */
  readonly check: () => Effect.Effect<{ ok: boolean; drift: number }>
  /** Mark this projection as stale (incremental update needed). */
  readonly markStale: () => Effect.Effect<void>
  /** Get the current lag (ms since last update, or -1 if never built). */
  readonly getLag: () => Effect.Effect<number>
}

// ── Projection Metadata Table ────────────────────────

export const ensureProjectionMeta = () =>
  Effect.sync(() => {
    const db = Client()
    db.exec(`
      CREATE TABLE IF NOT EXISTS _projection_meta (
        name TEXT PRIMARY KEY,
        version INTEGER NOT NULL DEFAULT 1,
        last_built_at BIGINT,
        last_checked_at BIGINT,
        is_stale INTEGER NOT NULL DEFAULT 0
      )
    `)
  })

// ── Rebuild All ──────────────────────────────────────

export const rebuildAll = (projections: Projection[]) =>
  Effect.forEach(projections, (p) =>
    Effect.gen(function* () {
      yield* Effect.logInfo(`Rebuilding projection: ${p.name}`)
      yield* p.rebuild()
    }),
    { concurrency: 1 },
  )

// ── Check All ────────────────────────────────────────

export const checkAll = (projections: Projection[]) =>
  Effect.forEach(projections, (p) => p.check(), { concurrency: "unbounded" })

// ── Projection Table DDL ─────────────────────────────

export const PROJECTION_DDL = [
  `CREATE TABLE IF NOT EXISTS task_board_projection (
    instance_id TEXT NOT NULL,
    lane_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    task_status TEXT NOT NULL,
    task_title TEXT,
    task_priority TEXT,
    assigned_agent TEXT,
    started_at BIGINT,
    completed_at BIGINT,
    blocked_reason TEXT,
    parent_task_id TEXT,
    metadata JSONB,
    updated_at BIGINT NOT NULL,
    PRIMARY KEY (instance_id, lane_id, task_id)
  )`,
  `CREATE TABLE IF NOT EXISTS agent_status_projection (
    instance_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    status TEXT NOT NULL,
    current_task_id TEXT,
    current_lane_id TEXT,
    last_heartbeat_at BIGINT,
    capabilities JSONB,
    error_count INTEGER DEFAULT 0,
    last_error TEXT,
    updated_at BIGINT NOT NULL,
    PRIMARY KEY (instance_id, agent_id)
  )`,
  `CREATE TABLE IF NOT EXISTS context_packet_projection (
    instance_id TEXT NOT NULL,
    packet_id TEXT NOT NULL,
    session_id TEXT,
    scratchpad_state JSONB,
    recent_events JSONB,
    working_set JSONB,
    file_context JSONB,
    tool_invocations JSONB,
    updated_at BIGINT NOT NULL,
    PRIMARY KEY (instance_id, packet_id)
  )`,
  `CREATE TABLE IF NOT EXISTS lane_context_projection (
    lane_id TEXT NOT NULL,
    context TEXT NOT NULL,
    updated_at BIGINT NOT NULL,
    PRIMARY KEY (lane_id)
  )`,
]
