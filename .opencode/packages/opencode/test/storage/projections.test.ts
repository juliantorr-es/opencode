import { describe, expect, it } from "bun:test"
import { Effect } from "effect"
import { Database } from "bun:sqlite"
import {
  PROJECTION_DDL,
  rebuildAll,
  checkAll,
  type Projection,
} from "../../src/storage/projections"

// ── Test Helpers ─────────────────────────────────────────────

/** Create an in-memory DB with canonical tables, projection tables, and metadata. */
function createTestDb(): Database {
  const db = new Database(":memory:")

  // Canonical: lane_agents (truth source for task_board_projection)
  db.exec(`
    CREATE TABLE lane_agents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lane_id TEXT NOT NULL,
      agent TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      delegated_by TEXT,
      delegated_at TEXT,
      started_at TEXT,
      completed_at TEXT,
      task TEXT,
      repair INTEGER DEFAULT 0,
      auto_completed INTEGER DEFAULT 0,
      stale_timeout INTEGER DEFAULT 0,
      advanced_by TEXT,
      summary TEXT,
      files_created TEXT,
      files_modified TEXT,
      findings TEXT,
      blockers TEXT,
      next_steps TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `)

  // Projection tables
  for (const ddl of PROJECTION_DDL) {
    db.exec(ddl)
  }

  // Metadata table (mirrors ensureProjectionMeta DDL)
  db.exec(`
    CREATE TABLE IF NOT EXISTS _projection_meta (
      name TEXT PRIMARY KEY,
      version INTEGER NOT NULL DEFAULT 1,
      last_built_at BIGINT,
      last_checked_at BIGINT,
      is_stale INTEGER NOT NULL DEFAULT 0
    )
  `)

  return db
}

interface LaneAgentSeed {
  lane_id: string
  agent: string
  status?: string
  task?: string | null
  started_at?: string | null
  completed_at?: string | null
  blockers?: string | null
  findings?: string | null
  summary?: string | null
  next_steps?: string | null
  delegated_by?: string | null
}

/** Seed lane_agents rows into the canonical table. */
function seedLaneAgents(db: Database, rows: LaneAgentSeed[]): void {
  const insert = db.prepare(`
    INSERT INTO lane_agents
      (lane_id, agent, status, delegated_by, task,
       started_at, completed_at, blockers, findings, summary, next_steps)
    VALUES
      ($lane_id, $agent, $status, $delegated_by, $task,
       $started_at, $completed_at, $blockers, $findings, $summary, $next_steps)
  `)
  for (const r of rows) {
    insert.run({
      $lane_id: r.lane_id,
      $agent: r.agent,
      $status: r.status ?? "pending",
      $delegated_by: r.delegated_by ?? null,
      $task: r.task ?? null,
      $started_at: r.started_at ?? null,
      $completed_at: r.completed_at ?? null,
      $blockers: r.blockers ?? null,
      $findings: r.findings ?? null,
      $summary: r.summary ?? null,
      $next_steps: r.next_steps ?? null,
    })
  }
}

/** Snapshot all rows from task_board_projection ordered by task_id. */
function snapshotProjection(db: Database): unknown[] {
  return db
    .query("SELECT * FROM task_board_projection ORDER BY task_id")
    .all()
}

/**
 * Build a task_board projection that reads lane_agents → task_board_projection.
 * The projection owns its DB reference, updates metadata on rebuild, and supports
 * drift detection and staleness marking.
 */
function makeTaskBoardProjection(db: Database, version = 1): Projection {
  const name = "task_board"

  return {
    name,
    version,

    rebuild: () =>
      Effect.sync(() => {
        // Truncate projection
        db.exec(`DELETE FROM task_board_projection`)

        // Rebuild from canonical truth
        db.exec(`
          INSERT INTO task_board_projection (
            instance_id, lane_id, task_id, task_status, task_title,
            task_priority, assigned_agent, started_at, completed_at,
            blocked_reason, parent_task_id, metadata, updated_at
          )
          SELECT
            'default' AS instance_id,
            la.lane_id,
            CAST(la.id AS TEXT) AS task_id,
            la.status AS task_status,
            la.task AS task_title,
            NULL AS task_priority,
            la.agent AS assigned_agent,
            CASE WHEN la.started_at IS NOT NULL
              THEN CAST(strftime('%s', la.started_at) * 1000 AS INTEGER)
              ELSE NULL END AS started_at,
            CASE WHEN la.completed_at IS NOT NULL
              THEN CAST(strftime('%s', la.completed_at) * 1000 AS INTEGER)
              ELSE NULL END AS completed_at,
            la.blockers AS blocked_reason,
            NULL AS parent_task_id,
            json_object(
              'delegated_by', la.delegated_by,
              'findings', la.findings,
              'summary', la.summary,
              'next_steps', la.next_steps,
              'files_created', la.files_created,
              'files_modified', la.files_modified,
              'auto_completed', la.auto_completed,
              'repair', la.repair
            ) AS metadata,
            CAST(strftime('%s', 'now') * 1000 AS INTEGER) AS updated_at
          FROM lane_agents la
        `)

        // Record rebuild in metadata
        db.exec(
          `INSERT OR REPLACE INTO _projection_meta
             (name, version, last_built_at, is_stale)
           VALUES (?, ?, ?, 0)`,
          [name, version, Date.now()],
        )
      }),

    check: () =>
      Effect.sync(() => {
        const canonical = db
          .query("SELECT COUNT(*) as c FROM lane_agents")
          .get() as { c: number }
        const proj = db
          .query("SELECT COUNT(*) as c FROM task_board_projection")
          .get() as { c: number }
        const drift = canonical.c - proj.c
        return { ok: drift === 0, drift }
      }),

    markStale: () =>
      Effect.sync(() => {
        db.exec(`UPDATE _projection_meta SET is_stale = 1 WHERE name = ?`, [
          name,
        ])
      }),

    getLag: () =>
      Effect.sync(() => {
        const row = db
          .query(
            "SELECT last_built_at FROM _projection_meta WHERE name = ?",
          )
          .get(name) as { last_built_at: number | null } | undefined
        if (!row?.last_built_at) return -1
        return Date.now() - row.last_built_at
      }),
  }
}

// ── Tests ───────────────────────────────────────────────────

describe("Projection contract", () => {
  // 1 ────────────────────────────────────────────────────────
  it("rebuild from empty DB produces empty projection", () => {
    const db = createTestDb()
    const proj = [makeTaskBoardProjection(db)]

    Effect.runSync(rebuildAll(proj))

    const rows = db
      .query("SELECT COUNT(*) as c FROM task_board_projection")
      .get() as { c: number }
    expect(rows.c).toBe(0)
  })

  // 2 ────────────────────────────────────────────────────────
  it("rebuild from existing events produces matching projection", () => {
    const db = createTestDb()
    seedLaneAgents(db, [
      { lane_id: "lane-1", agent: "alice", status: "pending", task: "Fix login" },
      { lane_id: "lane-1", agent: "bob", status: "completed", task: "Add tests" },
      { lane_id: "lane-2", agent: "carol", status: "pending", task: "Refactor auth" },
    ])
    const proj = [makeTaskBoardProjection(db)]

    Effect.runSync(rebuildAll(proj))

    const rows = db
      .query("SELECT task_title, task_status FROM task_board_projection ORDER BY task_id")
      .all() as { task_title: string; task_status: string }[]
    expect(rows.length).toBe(3)
    expect(rows[0]).toEqual({ task_title: "Fix login", task_status: "pending" })
    expect(rows[1]).toEqual({ task_title: "Add tests", task_status: "completed" })
    expect(rows[2]).toEqual({ task_title: "Refactor auth", task_status: "pending" })
  })

  // 3 ────────────────────────────────────────────────────────
  it("incremental update matches full rebuild", () => {
    // Path A: partial seed → rebuild → more seed → rebuild
    const dbA = createTestDb()
    seedLaneAgents(dbA, [
      { lane_id: "L1", agent: "a", task: "T1", status: "pending" },
      { lane_id: "L1", agent: "b", task: "T2", status: "completed" },
    ])
    const projA = [makeTaskBoardProjection(dbA)]
    Effect.runSync(rebuildAll(projA))

    seedLaneAgents(dbA, [
      { lane_id: "L2", agent: "c", task: "T3", status: "pending" },
    ])
    Effect.runSync(rebuildAll(projA))
    const incremental = snapshotProjection(dbA)

    // Path B: full seed → rebuild
    const dbB = createTestDb()
    seedLaneAgents(dbB, [
      { lane_id: "L1", agent: "a", task: "T1", status: "pending" },
      { lane_id: "L1", agent: "b", task: "T2", status: "completed" },
      { lane_id: "L2", agent: "c", task: "T3", status: "pending" },
    ])
    const projB = [makeTaskBoardProjection(dbB)]
    Effect.runSync(rebuildAll(projB))
    const full = snapshotProjection(dbB)

    expect(incremental.length).toBe(3)
    // Compare after dropping volatile timestamp columns
    expect(
      (incremental as Record<string, unknown>[]).map(
        ({ updated_at: _, metadata: __, ...rest }) => rest,
      ),
    ).toEqual(
      (full as Record<string, unknown>[]).map(
        ({ updated_at: _, metadata: __, ...rest }) => rest,
      ),
    )
  })

  // 4 ────────────────────────────────────────────────────────
  it("projection detects staleness after canonical write", () => {
    const db = createTestDb()
    seedLaneAgents(db, [
      { lane_id: "L1", agent: "a", task: "T1", status: "pending" },
    ])
    const proj = [makeTaskBoardProjection(db)]

    Effect.runSync(rebuildAll(proj))

    // Before any new writes, check should show no drift
    const before = Effect.runSync(checkAll(proj))
    expect(before[0].ok).toBe(true)
    expect(before[0].drift).toBe(0)

    // Write new canonical data without rebuilding
    seedLaneAgents(db, [
      { lane_id: "L2", agent: "b", task: "T2", status: "completed" },
    ])

    // markStale sets the is_stale flag
    Effect.runSync(proj[0].markStale())

    // Check should now detect drift
    const after = Effect.runSync(checkAll(proj))
    expect(after[0].ok).toBe(false)
    expect(after[0].drift).toBeGreaterThan(0)

    // Verify metadata records staleness
    const meta = db
      .query("SELECT is_stale FROM _projection_meta WHERE name = ?")
      .get("task_board") as { is_stale: number }
    expect(meta.is_stale).toBe(1)
  })

  // 5 ────────────────────────────────────────────────────────
  it("deleting projection and rebuilding restores same state", () => {
    const db = createTestDb()
    seedLaneAgents(db, [
      { lane_id: "L1", agent: "a", task: "T1", status: "pending" },
      { lane_id: "L1", agent: "b", task: "T2", status: "completed" },
    ])
    const proj = [makeTaskBoardProjection(db)]

    Effect.runSync(rebuildAll(proj))
    const original = snapshotProjection(db)

    // Delete the projection table and recreate it
    db.exec("DROP TABLE task_board_projection")
    const taskBoardDDL = PROJECTION_DDL.find((d) =>
      d.includes("task_board_projection"),
    )!
    db.exec(taskBoardDDL)

    // Rebuild should restore the same logical rows
    Effect.runSync(rebuildAll(proj))
    const restored = snapshotProjection(db)

    expect(
      (restored as Record<string, unknown>[]).map(
        ({ updated_at: _, metadata: __, ...rest }) => rest,
      ),
    ).toEqual(
      (original as Record<string, unknown>[]).map(
        ({ updated_at: _, metadata: __, ...rest }) => rest,
      ),
    )
  })

  // 6 ────────────────────────────────────────────────────────
  it("projection metadata table tracks version", () => {
    const db = createTestDb()
    const version = 2
    const proj = [makeTaskBoardProjection(db, version)]

    Effect.runSync(rebuildAll(proj))

    const meta = db
      .query("SELECT version, name, is_stale FROM _projection_meta WHERE name = ?")
      .get("task_board") as { version: number; name: string; is_stale: number }

    expect(meta.name).toBe("task_board")
    expect(meta.version).toBe(version)
    expect(meta.is_stale).toBe(0) // rebuilt, not stale
  })
})

describe("DuckDB boundary", () => {
  // Kept as todo stubs — out of scope for this task
  it.todo("no canonical decision reads from DuckDB", () => {})
  it.todo("DuckDB projections are rebuildable from Postgres export", () => {})
  it.todo("DuckDB stale detection works", () => {})
})

describe("Guardrails", () => {
  // Kept as todo stubs — out of scope for this task
  it.todo("projection tables use _projection suffix or prefix", () => {})
  it.todo("projection writes go through projection module", () => {})
  it.todo("no projection table treated as source of truth in authority checks", () => {})
})
