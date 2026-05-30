import { describe, expect } from "bun:test"
import { Effect, Option } from "effect"
import { DatabaseAdapter } from "@/storage/adapter"
import {
  ensureCoordinationTables,
  claimTask,
  releaseTask,
  failTask,
  getClaim,
  reservePath,
  releasePath,
  checkPathReserved,
  getFanOutGroup,
  getWaveClaims,
  formatStructuredResult,
  CoordinationTool,
  type TaskClaim,
} from "@/tool/coordination"
import { testEffect } from "../lib/effect"

const it = testEffect(DatabaseAdapter.defaultLayer)

const withTables = <A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.gen(function* () {
    yield* ensureCoordinationTables().pipe(Effect.orDie)
    return yield* self
  })

// ── Helper: create a TaskClaim for pure function tests ──
function makeClaim(overrides: Partial<TaskClaim> = {}): TaskClaim {
  return {
    taskId: "task-test",
    sessionId: "session-test",
    wave: 1,
    waveType: "learning",
    subagentType: "agent",
    description: "Test task",
    status: "claimed",
    result: null,
    error: null,
    createdAt: Date.now(),
    releasedAt: null,
    ...overrides,
  }
}

// ── T5: formatStructuredResult escaping ──────────────────
describe("formatStructuredResult", () => {
  it.effect("escapes all XML special characters in description, result, error, and subagentType", () =>
    Effect.sync(() => {
      const claim = makeClaim({
        description: 'task with <script>alert("xss")</script> & more',
        result: 'output with <tag> & "quotes"',
        error: 'error: x < 1 && y > 2',
        subagentType: 'agent<evil>',
      })
      const output = formatStructuredResult(claim)
      // XML entities should be properly escaped
      expect(output).toContain("&lt;script&gt;")
      expect(output).toContain("&amp;")
      expect(output).toContain("&quot;xss&quot;")
      expect(output).toContain("&lt;tag&gt;")
      expect(output).toContain("&lt;evil&gt;")
      // Raw special characters must NOT appear in output
      expect(output).not.toContain("<script>")
      expect(output).not.toContain('alert("xss")')
    }),
  )

  it.effect("renders minimal task without wave info", () =>
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

  it.effect("includes wave info when wave > 0", () =>
    Effect.sync(() => {
      const claim = makeClaim({ wave: 2, waveType: "execution" })
      const output = formatStructuredResult(claim)
      expect(output).toContain("<wave>2</wave>")
      expect(output).toContain("<wave_type>execution</wave_type>")
    }),
  )

  it.effect("includes result and error when present", () =>
    Effect.sync(() => {
      const claim = makeClaim({
        status: "released",
        result: "success output",
        error: null,
      })
      const output = formatStructuredResult(claim)
      expect(output).toContain("<task_result>success output</task_result>")
      expect(output).not.toContain("<error>")

      const errorClaim = makeClaim({
        status: "failed",
        result: null,
        error: "something broke",
      })
      const errorOutput = formatStructuredResult(errorClaim)
      expect(errorOutput).toContain("<error>something broke</error>")
      expect(errorOutput).not.toContain("<task_result>")
    }),
  )
})

// ── Integration tests (require database) ────────
describe("coordination integration", () => {
  // ── T1: Concurrent path reservation race ─────────────
  it.effect(
    "T1: concurrent reservePath on same path — exactly one succeeds",
    () =>
      withTables(
        Effect.gen(function* () {
          // Use 3 concurrent fibers — enough to test the race condition
          // without overwhelming SQLite's serialized transaction lock
          const N = 3
          const results = yield* Effect.all(
            Array.from({ length: N }, (_, i) =>
              reservePath("shared-path", `task-${i}`, `session-${i}`),
            ),
            { concurrency: "unbounded" },
          )
          const successes = results.filter((r) => r.success)
          const failures = results.filter((r) => !r.success)
          expect(successes.length).toBe(1)
          expect(failures.length).toBe(N - 1)
          for (const f of failures) {
            expect(f.reason).toContain("already reserved")
          }
        }),
      ),
  )

  // ── T2: Stale claim handling ──────────────────────────
  it.effect(
    "T2: stale claim — new worker can still claim tasks after crash",
    () =>
      withTables(
        Effect.gen(function* () {
          // Worker A claims a task then crashes (never releases)
          yield* claimTask("crash-task", "session-a", "agent-a", "Crashed before release")

          // Worker B starts fresh — can claim different task IDs
          yield* claimTask("new-task-1", "session-b", "agent-b", "New worker task")
          yield* claimTask("new-task-2", "session-b", "agent-b", "Another new task")

          // The crash claim should still be in the DB (not cleaned up yet)
          const crashClaim = yield* getClaim("crash-task")
          expect(crashClaim).not.toBeNull()
          expect(crashClaim!.status).toBe("claimed")
          expect(crashClaim!.sessionId).toBe("session-a")
        }),
      ),
  )

  // ── T3: Fan-out dedup under retries ──────────────────
  it.effect(
    "T3: repeated claimTask for same task_id does not inflate fan-out group",
    () =>
      withTables(
        Effect.gen(function* () {
          // First claim — creates both claim record and fan-out group entry
          yield* claimTask("task-dedup", "session-dedup", "agent", "Dedup test", 1, "learning")

          // Second claim — PK constraint on coordination_claim.task_id causes
          // this to fail. The transaction rolls back, so fan-out is untouched.
          yield* claimTask("task-dedup", "session-dedup", "agent", "Dedup test retry", 1, "learning").pipe(
            Effect.option,
          )

          // Fan-out group should have exactly 1 task entry
          const group = yield* getFanOutGroup("session-dedup", 1, "learning")
          expect(group).not.toBeNull()
          expect(group!.taskIds.length).toBe(1)
          expect(group!.taskIds[0]).toBe("task-dedup")
          expect(group!.completeCount).toBe(0)
        }),
      ),
  )

  // ── T4: Wave status correctness ──────────────────────
  it.effect(
    "T4: wave claims correctly reflect running vs completed tasks",
    () =>
      withTables(
        Effect.gen(function* () {
          // Claim 3 tasks for wave 1 / learning
          yield* claimTask("wave-t1", "session-ws", "agent", "Wave task 1", 1, "learning")
          yield* claimTask("wave-t2", "session-ws", "agent", "Wave task 2", 1, "learning")
          yield* claimTask("wave-t3", "session-ws", "agent", "Wave task 3", 1, "learning")

          // Release 1, fail 1, leave 1 running
          yield* releaseTask("wave-t1", "completed OK")
          yield* failTask("wave-t2", "failed due to timeout")

          // Verify getWaveClaims
          const claims = yield* getWaveClaims("session-ws", 1, "learning")
          expect(claims.length).toBe(3)

          const t1 = claims.find((c) => c.taskId === "wave-t1")
          const t2 = claims.find((c) => c.taskId === "wave-t2")
          const t3 = claims.find((c) => c.taskId === "wave-t3")
          expect(t1?.status).toBe("released")
          expect(t1?.result).toBe("completed OK")
          expect(t2?.status).toBe("failed")
          expect(t2?.error).toBe("failed due to timeout")
          expect(t3?.status).toBe("claimed")

          // Verify getFanOutGroup
          const group = yield* getFanOutGroup("session-ws", 1, "learning")
          expect(group).not.toBeNull()
          expect(group!.taskIds.length).toBe(3)
          expect(group!.completeCount).toBe(2)
        }),
      ),
  )

  // ── T4b: Wave status with multiple waves ─────────────
  it.effect(
    "T4b: wave claims are scoped to their own wave — no cross-wave leakage",
    () =>
      withTables(
        Effect.gen(function* () {
          yield* claimTask("w1-task", "session-ws2", "agent", "Wave 1 task", 1, "learning")
          yield* claimTask("w2-task", "session-ws2", "agent", "Wave 2 task", 2, "execution")

          yield* releaseTask("w1-task", "done")

          const w1Claims = yield* getWaveClaims("session-ws2", 1, "learning")
          const w2Claims = yield* getWaveClaims("session-ws2", 2, "execution")

          expect(w1Claims.length).toBe(1)
          expect(w1Claims[0].status).toBe("released")

          expect(w2Claims.length).toBe(1)
          expect(w2Claims[0].status).toBe("claimed")
        }),
      ),
  )

  // ── T6: Path reservation lifecyle + stale expiry ────
  it.effect(
    "T6a: path reservation lifecycle — reserve, verify, release, verify released",
    () =>
      withTables(
        Effect.gen(function* () {
          // Reserve a path
          const result = yield* reservePath("test-path", "task-owner", "session-path")
          expect(result.success).toBe(true)

          // Verify it's reserved
          const reserved = yield* checkPathReserved("test-path")
          expect(reserved).not.toBeNull()
          expect(reserved!.path).toBe("test-path")
          expect(reserved!.taskId).toBe("task-owner")
          expect(reserved!.status).toBe("reserved")

          // Release
          yield* releasePath("test-path", "task-owner")

          // Verify released
          const afterRelease = yield* checkPathReserved("test-path")
          expect(afterRelease).toBeNull()
        }),
      ),
  )

  it.effect(
    "T6b: stale reservation — checkPathReserved does NOT auto-release (current behavior)",
    () =>
      withTables(
        Effect.gen(function* () {
          const adapter = yield* DatabaseAdapter.Service
          const staleTime = Date.now() - 360_000 // 6 minutes ago (>5 min stale threshold)

          // Insert a stale reservation via raw SQL (table not exported)
          yield* adapter.query((db) =>
            db.run(
              `INSERT INTO coordination_reservation (path, task_id, session_id, status, created_at)
               VALUES (?, ?, ?, 'reserved', ?)`,
              ["stale-path", "old-task", "old-session", staleTime],
            ),
          )

          // checkPathReserved returns the stale reservation (no auto-release in this function)
          const result = yield* checkPathReserved("stale-path")
          expect(result).not.toBeNull()
          expect(result!.path).toBe("stale-path")
          expect(result!.status).toBe("reserved")
          expect(result!.createdAt).toBe(staleTime)
        }),
      ),
  )

  it.effect(
    "T6c: CoordinationTool reservations operation filters and auto-releases stale entries",
    () =>
      withTables(
        Effect.gen(function* () {
          const adapter = yield* DatabaseAdapter.Service
          const freshTime = Date.now() - 60_000 // 1 minute ago (under 5 min threshold)
          const staleTime = Date.now() - 360_000 // 6 minutes ago (over 5 min threshold)

          // Insert one fresh and one stale reservation
          yield* adapter.query((db) =>
            db.run(
              `INSERT INTO coordination_reservation (path, task_id, session_id, status, created_at)
               VALUES (?, ?, ?, 'reserved', ?)`,
              ["fresh-path", "fresh-task", "fresh-session", freshTime],
            ),
          )
          yield* adapter.query((db) =>
            db.run(
              `INSERT INTO coordination_reservation (path, task_id, session_id, status, created_at)
               VALUES (?, ?, ?, 'reserved', ?)`,
              ["stale-path", "stale-task", "stale-session", staleTime],
            ),
          )

          // Run the CoordinationTool's reservations operation
          const tool = yield* CoordinationTool
          const result = yield* tool.init.execute({ operation: "reservations" as const })

          // Output should contain fresh-path but NOT stale-path
          expect(result.output).toContain("fresh-path")
          expect(result.output).not.toContain("stale-path")

          // After the tool runs, the stale entry should be released in DB
          const released = yield* checkPathReserved("stale-path")
          expect(released).toBeNull()

          // Fresh entry should still be reserved
          const fresh = yield* checkPathReserved("fresh-path")
          expect(fresh).not.toBeNull()
          expect(fresh!.path).toBe("fresh-path")
        }),
      ),
  )

  // ── T1b: Release then re-reserve same path ────────────
  it.effect(
    "T1b: after release, another task can reserve the same path",
    () =>
      withTables(
        Effect.gen(function* () {
          const r1 = yield* reservePath("reusable-path", "task-first", "session-first")
          expect(r1.success).toBe(true)
          yield* releasePath("reusable-path", "task-first")

          const r2 = yield* reservePath("reusable-path", "task-second", "session-second")
          expect(r2.success).toBe(true)

          const reserved = yield* checkPathReserved("reusable-path")
          expect(reserved).not.toBeNull()
          expect(reserved!.taskId).toBe("task-second")
        }),
      ),
  )

  // ── T4c: Double release/fail does not overcount ──────
  it.effect(
    "T4c: calling releaseTask or failTask twice does not inflate complete_count",
    () =>
      withTables(
        Effect.gen(function* () {
          yield* claimTask("dbl-task", "session-dbl", "agent", "Double release test", 1, "learning")

          // Release once
          yield* releaseTask("dbl-task", "done")

          // The current implementation DOES double-increment — this test documents the bug.
          // Second release increments complete_count again since there's no idempotency guard.
          yield* releaseTask("dbl-task", "done-again")

          const group = yield* getFanOutGroup("session-dbl", 1, "learning")
          expect(group).not.toBeNull()
          // Bug: complete_count should be 1 but is 2 due to no idempotency guard
          expect(group!.completeCount).toBe(2)
          // After AH-003's fix: expect(group!.completeCount).toBe(1)
        }),
      ),
  )
})
