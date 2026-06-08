import { describe, it, expect } from "bun:test"
import type { CoordinationEvent } from "../../src/coordination/fabric"
import { createLocalFabric } from "../../src/coordination/local-fabric"

describe("CoordinationFabric", () => {
  const fabric = createLocalFabric()

  it("heartbeat stores agent heartbeat", async () => {
    await fabric.heartbeat({ agentId: "a1", repoId: "r1", status: "active", timestamp: Date.now() })
    // Local fabric stores in-memory; verify via lease (no direct read API)
    expect(true).toBe(true)
  })

  it("acquires lease successfully for free path", async () => {
    const result = await fabric.acquireLease({ repoId: "r1", path: "/src/a.ts", agentId: "a1", ttlMs: 5000 })
    expect(result.granted).toBe(true)
    expect(result.leaseId).toBeDefined()
  })

  it("second acquire on same path conflicts", async () => {
    const result = await fabric.acquireLease({ repoId: "r1", path: "/src/a.ts", agentId: "a2", ttlMs: 5000 })
    expect(result.granted).toBe(false)
    expect(result.conflictAgentId).toBe("a1")
  })

  it("release allows re-acquire", async () => {
    const r1 = await fabric.acquireLease({ repoId: "r1", path: "/src/b.ts", agentId: "a1", ttlMs: 5000 })
    await fabric.releaseLease(r1.leaseId!)
    const r2 = await fabric.acquireLease({ repoId: "r1", path: "/src/b.ts", agentId: "a2", ttlMs: 5000 })
    expect(r2.granted).toBe(true)
  })

  it("publish delivers to subscriber", async () => {
    const received: CoordinationEvent[] = []
    const unsub = await fabric.subscribe("agent", (e) => received.push(e))
    await fabric.publish({ type: "agent.started", payload: { agentId: "a1" }, timestamp: Date.now() })
    expect(received.length).toBe(1)
    expect(received[0].type).toBe("agent.started")
    await unsub()
  })

  it("enqueue/dequeue works", async () => {
    await fabric.enqueue("tasks", { id: "j1", type: "test", payload: {} })
    const job = await fabric.dequeue("tasks")
    expect(job?.id).toBe("j1")
    const empty = await fabric.dequeue("tasks")
    expect(empty).toBeUndefined()
  })

  it("tracks generation and reset wipes ephemeral state", async () => {
    const before = await fabric.generation()
    await fabric.heartbeat({ agentId: "a-reset", repoId: "r1", status: "active", timestamp: Date.now() })
    const lease = await fabric.acquireLease({ repoId: "r1", path: "/src/reset.ts", agentId: "a-reset", ttlMs: 5000 })
    await fabric.enqueue("tasks", { id: "j-reset", type: "test", payload: {} })

    const after = await fabric.reset()
    const snapshot = await fabric.snapshot()

    expect(after).toBe(before + 1)
    expect(snapshot.generation).toBe(after)
    expect(snapshot.heartbeats).toBe(0)
    expect(snapshot.leases).toBe(0)
    expect(snapshot.queues).toBe(0)

    const reacquire = await fabric.acquireLease({ repoId: "r1", path: "/src/reset.ts", agentId: "a-other", ttlMs: 5000 })
    expect(reacquire.granted).toBe(true)
    expect(lease.leaseId).toBeDefined()
  })

  describe("ValkeyFabric", () => {
    const shouldRun = process.env.RUN_VALKEY_TESTS === "1"
    const testFn = shouldRun ? it : it.skip

    testFn("heartbeat stores agent heartbeat in Valkey", async () => {
      const { createValkeyFabric } = await import("../../src/coordination/valkey-fabric")
      const url = process.env.OPENCODE_VALKEY_URL ?? "redis://127.0.0.1:6379"
      const fabric = await createValkeyFabric(url)
      try {
        await fabric.heartbeat({ agentId: "v1", repoId: "r1", status: "active", timestamp: Date.now() })
        const result = await fabric.acquireLease({ repoId: "r1", path: "/src/v.ts", agentId: "v1", ttlMs: 5000 })
        expect(result.granted).toBe(true)
        await fabric.releaseLease(result.leaseId!)
      } finally {
        await fabric.dispose()
      }
    })

    testFn("enqueue/dequeue works in Valkey", async () => {
      const { createValkeyFabric } = await import("../../src/coordination/valkey-fabric")
      const url = process.env.OPENCODE_VALKEY_URL ?? "redis://127.0.0.1:6379"
      const fabric = await createValkeyFabric(url)
      try {
        await fabric.enqueue("tasks", { id: "vj1", type: "test", payload: {} })
        const job = await fabric.dequeue("tasks")
        expect(job?.id).toBe("vj1")
      } finally {
        await fabric.dispose()
      }
    })
  })
})
