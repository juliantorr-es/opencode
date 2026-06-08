import { describe, test, expect, beforeEach } from "bun:test"
import { Effect } from "effect"
import { openSession, createCheckpoint, resumeSession, closeSession, getSession, listActiveSessions, sessionStore } from "../src/runtime/session-lifecycle"

describe("Session Lifecycle", () => {
  // Reset shared store between tests
  beforeEach(() => sessionStore.clear())
  test("session open creates durable record with unique ID and timestamp", async () => {
    const session = await Effect.runPromise(openSession({ workspace: "/test" }))
    expect(session.sessionId).toBeDefined()
    expect(session.status).toBe("open")
    expect(session.openedAt).toBeGreaterThan(0)
    expect(session.metadata).toEqual({ workspace: "/test" })

    const record = getSession(session.sessionId)
    expect(record).toBeDefined()
    expect(record!.session.sessionId).toBe(session.sessionId)
  })

  test("checkpoint captures full state and is retrievable", async () => {
    const session = await Effect.runPromise(openSession())
    const checkpoint = await Effect.runPromise(
      createCheckpoint(session.sessionId, { todos: ["item1"], cursor: { line: 42, col: 7 } })
    )

    expect(checkpoint.id).toBeDefined()
    expect(checkpoint.timestamp).toBeGreaterThan(0)
    expect(checkpoint.state).toEqual({ todos: ["item1"], cursor: { line: 42, col: 7 } })
    expect(checkpoint.predecessorCheckpointId).toBeNull()

    const record = getSession(session.sessionId)
    expect(record!.checkpoints.length).toBe(1)
  })

  test("resume from checkpoint restores exact state", async () => {
    const session = await Effect.runPromise(openSession())
    const state = { files: ["a.ts", "b.ts"], selection: { file: "a.ts", range: [1, 10] } }
    await Effect.runPromise(createCheckpoint(session.sessionId, state))

    const { session: resumed, state: restored } = await Effect.runPromise(
      resumeSession(session.sessionId)
    )

    expect(resumed.status).toBe("active")
    expect(restored).toEqual(state)
  })

  test("close consolidates state and cleans up", async () => {
    const session = await Effect.runPromise(openSession())
    await Effect.runPromise(createCheckpoint(session.sessionId, { data: "checkpoint1" }))
    await Effect.runPromise(createCheckpoint(session.sessionId, { data: "checkpoint2" }))

    const closed = await Effect.runPromise(closeSession(session.sessionId))
    expect(closed.status).toBe("closed")
    expect(closed.closedAt).toBeGreaterThan(0)

    const record = getSession(session.sessionId)
    // Close creates a final checkpoint
    expect(record!.checkpoints.length).toBeGreaterThanOrEqual(2)
  })

  test("double-close is idempotent", async () => {
    const session = await Effect.runPromise(openSession())
    await Effect.runPromise(createCheckpoint(session.sessionId, {}))

    const firstClose = await Effect.runPromise(closeSession(session.sessionId))
    const secondClose = await Effect.runPromise(closeSession(session.sessionId))

    // Both should succeed
    expect(firstClose.status).toBe("closed")
    expect(secondClose.status).toBe("closed")

    // Second close should return same state
    expect(secondClose.closedAt).toBe(firstClose.closedAt)
  })

  test("checkpoint chain preserves history", async () => {
    const session = await Effect.runPromise(openSession())
    const cp1 = await Effect.runPromise(createCheckpoint(session.sessionId, { seq: 1 }))
    const cp2 = await Effect.runPromise(createCheckpoint(session.sessionId, { seq: 2 }))

    expect(cp1.predecessorCheckpointId).toBeNull()
    expect(cp2.predecessorCheckpointId).toBe(cp1.id)

    const record = getSession(session.sessionId)
    expect(record!.checkpoints.length).toBe(2)
  })

  test("listActiveSessions returns only non-closed sessions", async () => {
    const s1 = await Effect.runPromise(openSession())
    const s2 = await Effect.runPromise(openSession())
    await Effect.runPromise(closeSession(s1.sessionId))

    const active = listActiveSessions()
    expect(active.length).toBe(1)
    expect(active[0].session.sessionId).toBe(s2.sessionId)
  })
})
