import { test, expect } from "bun:test"
import { Effect } from "effect"
import { DatabaseAdapter } from "@/storage/adapter"
import {
  ensureCoordinationTables,
  getClaim,
  checkPathReserved,
  getFanOutGroup,
  getWaveClaims,
  getSessionClaims,
  formatStructuredResult,
  type TaskClaim,
} from "@/tool/coordination"
import { testEffect } from "../lib/effect"

const it = testEffect(DatabaseAdapter.defaultLayer)

function makeClaim(overrides: Record<string, unknown> = {}): TaskClaim {
  return {
    taskId: "task-test",
    sessionId: "session-test",
    wave: 1,
    waveType: "learning",
    subagentType: "agent",
    description: "Test task",
    status: "claimed",
    result: null as string | null,
    error: null as string | null,
    createdAt: Date.now(),
    releasedAt: null as number | null,
    ...overrides,
  } as TaskClaim
}

// ═══════════════════════════════════════════════════════════
// T5: formatStructuredResult
// ═══════════════════════════════════════════════════════════
it.live("formats XML with escaped special characters", () =>
  Effect.sync(() => {
    const claim = makeClaim({
      description: 'task with <script>alert("xss")</script> & more',
      result: 'output with <tag> & "quotes"',
      error: 'error: x < 1 && y > 2',
      subagentType: 'agent<evil>',
    })
    const output = formatStructuredResult(claim)
    expect(output).toContain("&lt;script&gt;")
    expect(output).toContain("&amp;")
    expect(output).toContain("&quot;xss&quot;")
    expect(output).toContain("&lt;tag&gt;")
    expect(output).toContain("&lt;evil&gt;")
    expect(output).not.toContain("<script>")
  }),
)

it.live("formats minimal task without wave info", () =>
  Effect.sync(() => {
    const claim = makeClaim({ wave: 0, waveType: "" })
    const output = formatStructuredResult(claim)
    expect(output).toContain(`<task id="task-test"`)
    expect(output).toContain("<description>Test task</description>")
    expect(output).toContain("</task>")
    expect(output).not.toContain("<wave>")
    expect(output).not.toContain("<wave_type>")
  }),
)

it.live("formats includes wave info when wave > 0", () =>
  Effect.sync(() => {
    const claim = makeClaim({ wave: 2, waveType: "execution" })
    const output = formatStructuredResult(claim)
    expect(output).toContain("<wave>2</wave>")
    expect(output).toContain("<wave_type>execution</wave_type>")
  }),
)

it.live("formats includes result and error when present", () =>
  Effect.sync(() => {
    const claim = makeClaim({ status: "released" as const, result: "success output", error: null as string | null })
    const output = formatStructuredResult(claim)
    expect(output).toContain("<task_result>success output</task_result>")
    expect(output).not.toContain("<error>")
    const errorClaim = makeClaim({ status: "failed" as const, result: null as string | null, error: "something broke" })
    expect(formatStructuredResult(errorClaim)).toContain("<error>something broke</error>")
  }),
)

// ═══════════════════════════════════════════════════════════
// T1: Path reservation
// ═══════════════════════════════════════════════════════════
const init = Effect.gen(function* () {
  yield* ensureCoordinationTables().pipe(Effect.orDie)
})

it.live("T1: checkPathReserved finds reserved paths", () =>
  Effect.gen(function* () {
    yield* init
    const adapter = yield* DatabaseAdapter.Service
    yield* adapter.query((db: any) =>
      db.run("INSERT INTO coordination_reservation (path, task_id, session_id, status, created_at) VALUES ('t1-path', 't1-task', 't1-sess', 'reserved', 1)"),
    )
    const r = yield* checkPathReserved("t1-path")
    expect(r).not.toBeNull()
    expect(r!.taskId).toBe("t1-task")
  }),
)

it.live("T1b: after release, the path is no longer reserved", () =>
  Effect.gen(function* () {
    yield* init
    const adapter = yield* DatabaseAdapter.Service
    yield* adapter.query((db: any) =>
      db.run("INSERT INTO coordination_reservation (path, task_id, session_id, status, created_at) VALUES ('t1b-path', 't1b-task', 't1b-sess', 'reserved', 1)"),
    )
    const before = yield* checkPathReserved("t1b-path")
    expect(before).not.toBeNull()

    yield* adapter.query((db: any) =>
      db.run("UPDATE coordination_reservation SET status = 'released' WHERE path = 't1b-path'"),
    )
    const after = yield* checkPathReserved("t1b-path")
    expect(after).toBeNull()
  }),
)

// ═══════════════════════════════════════════════════════════
// T2: Stale claim handling
// ═══════════════════════════════════════════════════════════
it.live("T2: claims are independent across sessions", () =>
  Effect.gen(function* () {
    yield* init
    const adapter = yield* DatabaseAdapter.Service
    yield* adapter.query((db: any) =>
      db.run("INSERT INTO coordination_claim (task_id, session_id, wave, wave_type, subagent_type, description, status, created_at) VALUES ('t2-crash', 't2-sess-a', 0, '', 'agent', 'crashed', 'claimed', 1)"),
    )
    yield* adapter.query((db: any) =>
      db.run("INSERT INTO coordination_claim (task_id, session_id, wave, wave_type, subagent_type, description, status, created_at) VALUES ('t2-new1', 't2-sess-b', 0, '', 'agent', 'new', 'claimed', 2)"),
    )
    expect((yield* getClaim("t2-crash"))!.sessionId).toBe("t2-sess-a")
    expect((yield* getClaim("t2-new1"))!.sessionId).toBe("t2-sess-b")
    expect((yield* getSessionClaims("t2-sess-b")).length).toBe(1)
  }),
)

// ═══════════════════════════════════════════════════════════
// T3: Fan-out membership
// ═══════════════════════════════════════════════════════════
it.live("T3: getFanOutGroup returns correct membership", () =>
  Effect.gen(function* () {
    yield* init
    const adapter = yield* DatabaseAdapter.Service
    yield* adapter.query((db: any) =>
      db.run("INSERT INTO coordination_fan_out (session_id, wave, wave_type, task_ids, complete_count) VALUES ('t3-fs', 1, 'learning', '[\"a\",\"b\"]', 1)"),
    )
    const g = yield* getFanOutGroup("t3-fs", 1, "learning")
    expect(g).not.toBeNull()
    expect(g!.taskIds).toEqual(["a", "b"])
    expect(g!.completeCount).toBe(1)
  }),
)

// ═══════════════════════════════════════════════════════════
// T4: Wave status correctness
// ═══════════════════════════════════════════════════════════
it.live("T4: wave claims report released, failed, and claimed statuses", () =>
  Effect.gen(function* () {
    yield* init
    const adapter = yield* DatabaseAdapter.Service
    yield* adapter.query((db: any) =>
      db.run("INSERT INTO coordination_claim (task_id, session_id, wave, wave_type, subagent_type, description, status, result, created_at, released_at) VALUES ('t4-t1', 't4-ws', 1, 'learning', 'agent', 'done', 'released', 'ok', 1, 2)"),
    )
    yield* adapter.query((db: any) =>
      db.run("INSERT INTO coordination_claim (task_id, session_id, wave, wave_type, subagent_type, description, status, error, created_at) VALUES ('t4-t2', 't4-ws', 1, 'learning', 'agent', 'fail', 'failed', 'err', 3)"),
    )
    yield* adapter.query((db: any) =>
      db.run("INSERT INTO coordination_claim (task_id, session_id, wave, wave_type, subagent_type, description, status, created_at) VALUES ('t4-t3', 't4-ws', 1, 'learning', 'agent', 'run', 'claimed', 4)"),
    )
    const claims = yield* getWaveClaims("t4-ws", 1, "learning")
    expect(claims.length).toBe(3)
    expect(claims.find((c: TaskClaim) => c.taskId === "t4-t1")!.status).toBe("released")
    expect(claims.find((c: TaskClaim) => c.taskId === "t4-t2")!.status).toBe("failed")
    expect(claims.find((c: TaskClaim) => c.taskId === "t4-t3")!.status).toBe("claimed")
  }),
)

it.live("T4b: wave claims are scoped to their wave", () =>
  Effect.gen(function* () {
    yield* init
    const adapter = yield* DatabaseAdapter.Service
    yield* adapter.query((db: any) =>
      db.run("INSERT INTO coordination_claim (task_id, session_id, wave, wave_type, subagent_type, description, status, created_at) VALUES ('t4b-w1', 't4b-s', 1, 'learning', 'agent', 't1', 'claimed', 1)"),
    )
    yield* adapter.query((db: any) =>
      db.run("INSERT INTO coordination_claim (task_id, session_id, wave, wave_type, subagent_type, description, status, created_at) VALUES ('t4b-w2', 't4b-s', 2, 'execution', 'agent', 't2', 'claimed', 2)"),
    )
    expect((yield* getWaveClaims("t4b-s", 1, "learning")).length).toBe(1)
    expect((yield* getWaveClaims("t4b-s", 2, "execution")).length).toBe(1)
  }),
)

// ═══════════════════════════════════════════════════════════
// T6: Path reservation lifecycle
// ═══════════════════════════════════════════════════════════
it.live("T6a: reserved path is reported by checkPathReserved", () =>
  Effect.gen(function* () {
    yield* init
    const adapter = yield* DatabaseAdapter.Service
    yield* adapter.query((db: any) =>
      db.run("INSERT INTO coordination_reservation (path, task_id, session_id, status, created_at) VALUES ('t6a-path', 't6a-task', 't6a-sess', 'reserved', 100)"),
    )
    const r = yield* checkPathReserved("t6a-path")
    expect(r).not.toBeNull()
    expect(r!.path).toBe("t6a-path")
    expect(r!.taskId).toBe("t6a-task")
  }),
)

it.live("T6b: stale reservation is found (no auto-release in checkPathReserved)", () =>
  Effect.gen(function* () {
    yield* init
    const adapter = yield* DatabaseAdapter.Service
    yield* adapter.query((db: any) =>
      db.run("INSERT INTO coordination_reservation (path, task_id, session_id, status, created_at) VALUES ('t6b-path', 't6b-task', 't6b-sess', 'reserved', 999)"),
    )
    const r = yield* checkPathReserved("t6b-path")
    expect(r).not.toBeNull()
    expect(r!.createdAt).toBe(999)
  }),
)

// ═══════════════════════════════════════════════════════════
// Edge cases
// ═══════════════════════════════════════════════════════════
it.live("returns null for unreserved path", () =>
  Effect.gen(function* () {
    yield* init
    expect(yield* checkPathReserved("nonexistent")).toBeNull()
  }),
)

it.live("returns null for non-existent task", () =>
  Effect.gen(function* () {
    yield* init
    expect(yield* getClaim("nonexistent")).toBeNull()
  }),
)

it.live("returns null for non-existent fan-out group", () =>
  Effect.gen(function* () {
    yield* init
    expect(yield* getFanOutGroup("nonexistent", 1, "learning")).toBeNull()
  }),
)
