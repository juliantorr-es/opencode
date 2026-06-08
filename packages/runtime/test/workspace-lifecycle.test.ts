import { describe, test, expect, beforeEach } from "bun:test"
import { Effect } from "effect"
import { openWorkspace, closeWorkspace, getWorkspace, subscribe, workspaceStore } from "../src/runtime/workspace-lifecycle"

describe("Workspace Lifecycle", () => {
  beforeEach(() => { workspaceStore.clear() })

  test("open follows deterministic sequence", async () => {
    const events: string[] = []
    subscribe((e) => events.push(e.event))

    const ws = await Effect.runPromise(openWorkspace("/test/project"))
    expect(ws.status).toBe("open")
    expect(ws.watcherActive).toBe(true)
    expect(ws.indexHydrated).toBe(true)
    expect(ws.projectsAttached).toContain("/test/project")
    expect(ws.agentPoolSize).toBe(4)

    expect(events).toContain("opening")
    expect(events).toContain("watcher_started")
    expect(events).toContain("index_hydrated")
    expect(events).toContain("projects_attached")
    expect(events).toContain("agents_spawned")
    expect(events).toContain("opened")
  })

  test("close follows deterministic sequence", async () => {
    const events: string[] = []
    subscribe((e) => events.push(e.event))

    const ws = await Effect.runPromise(openWorkspace("/test/project"))
    const closed = await Effect.runPromise(closeWorkspace(ws.workspaceId))

    expect(closed.status).toBe("closed")
    expect(events).toContain("agents_drained")
    expect(events).toContain("projects_detached")
    expect(events).toContain("index_flushed")
    expect(events).toContain("watcher_stopped")
    expect(events).toContain("closed")
  })

  test("open is idempotent", async () => {
    const ws1 = await Effect.runPromise(openWorkspace("/test/project"))
    const ws2 = await Effect.runPromise(openWorkspace("/test/project"))

    expect(ws2.workspaceId).toBe(ws1.workspaceId)
    expect(ws2.status).toBe("open")
  })

  test("close is idempotent", async () => {
    const ws = await Effect.runPromise(openWorkspace("/test/project"))
    await Effect.runPromise(closeWorkspace(ws.workspaceId))

    // Double-close should not throw
    const closed2 = await Effect.runPromise(closeWorkspace(ws.workspaceId))
    expect(closed2.status).toBe("closed")
  })

  test("in-flight operations are zeroed on close", async () => {
    const ws = await Effect.runPromise(openWorkspace("/test/project"))
    ws.inFlightOperations = 5

    const closed = await Effect.runPromise(closeWorkspace(ws.workspaceId))
    expect(closed.inFlightOperations).toBe(0)
  })

  test("open creates unique workspace IDs for different paths", async () => {
    const ws1 = await Effect.runPromise(openWorkspace("/proj/a"))
    const ws2 = await Effect.runPromise(openWorkspace("/proj/b"))

    expect(ws1.workspaceId).not.toBe(ws2.workspaceId)
  })
})
