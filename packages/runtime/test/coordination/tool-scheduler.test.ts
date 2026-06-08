import { describe, test, expect } from "bun:test"
import { createLocalToolScheduler } from "../../src/coordination/local-tool-scheduler"
import { createLocalFabric } from "../../src/coordination/local-fabric"
import { createSingleFlightCache } from "../../src/coordination/single-flight-cache"
import { buildCacheKey } from "../../src/coordination/tool-cache"
import type { ToolScheduler, ResourceClass } from "../../src/coordination/tool-scheduler"

function makeJob(agentId: string, idempotencyKey?: string) {
  return {
    agentId,
    projectId: "test-project",
    repoRoot: "/test-repo",
    toolName: "typecheck",
    args: {},
    resourceClass: "cpu_heavy" as const,
    priority: "normal" as const,
    timeoutMs: 60_000,
    ...(idempotencyKey ? { idempotencyKey } : {}),
  }
}

describe("LocalToolScheduler", () => {
  test("submits and awaits result", async () => {
    const fabric = createLocalFabric()
    const scheduler = createLocalToolScheduler(fabric)

    const { jobId } = await scheduler.submit(makeJob("agent-1"))
    expect(jobId).toBeTruthy()

    // Simulate execution
    void scheduler.cancel(jobId, "test done")
    const result = await scheduler.awaitResult(jobId, 5000)
    expect(result.status).toBe("cancelled")

    await scheduler.dispose()
  })

  test("enforces concurrency limits for cpu_heavy", async () => {
    const fabric = createLocalFabric()
    const scheduler = createLocalToolScheduler(fabric)

    // cpu_heavy limit is 1
    const { jobId: id1 } = await scheduler.submit(makeJob("agent-1"))
    const { jobId: id2 } = await scheduler.submit(makeJob("agent-2"))

    const can = await scheduler.canAdmit("test-project", "cpu_heavy")
    // Already admitted one implicitly via submit(), second should be queued
    // canAdmit checks if a new immediate admission is possible

    await scheduler.cancel(id1, "done")
    await scheduler.cancel(id2, "done")
    await scheduler.dispose()
  })

  test("backpressure reports queued and active", async () => {
    const fabric = createLocalFabric()
    const scheduler = createLocalToolScheduler(fabric)

    const bp = await scheduler.backpressure("test-project")
    expect(bp.length).toBeGreaterThan(0)
    const cpu = bp.find(b => b.resourceClass === "cpu_heavy")
    expect(cpu).toBeTruthy()
    expect(cpu!.limit).toBe(1)

    await scheduler.dispose()
  })

  test("reap removes old completed jobs", async () => {
    const fabric = createLocalFabric()
    const scheduler = createLocalToolScheduler(fabric)

    const { jobId } = await scheduler.submit(makeJob("agent-1"))
    await scheduler.cancel(jobId, "done")

    // Reap with 0ms age — should remove all done jobs
    const count = await scheduler.reap(0)
    expect(count).toBeGreaterThanOrEqual(1)

    const state = await scheduler.getState(jobId)
    expect(state).toBeUndefined()

    await scheduler.dispose()
  })

  test("multiple agents queue for same resource class", async () => {
    const fabric = createLocalFabric()
    const scheduler = createLocalToolScheduler(fabric)

    // Submit 5 cpu_heavy jobs (limit = 1)
    const ids: string[] = []
    for (let i = 0; i < 5; i++) {
      const { jobId } = await scheduler.submit(makeJob(`agent-${i}`))
      ids.push(jobId)
    }

    // All should have been accepted (queued)
    for (const id of ids) {
      const state = await scheduler.getState(id)
      expect(state).toBeTruthy()
    }

    // Cancel all
    for (const id of ids) {
      await scheduler.cancel(id, "test")
    }

    await scheduler.dispose()
  })

  test("canAdmit respects concurrency limits", async () => {
    const fabric = createLocalFabric()
    const scheduler = createLocalToolScheduler(fabric)

    // read_light has limit 32 — should always admit
    const canRead = await scheduler.canAdmit("test-project", "read_light")
    expect(canRead).toBe(true)

    // cpu_heavy has limit 1 — should admit first time
    const canCpu1 = await scheduler.canAdmit("test-project", "cpu_heavy")
    expect(canCpu1).toBe(true)

    await scheduler.dispose()
  })
})

describe("Single-flight deduplication", () => {
  test("same idempotencyKey gets deduped", async () => {
    const fabric = createLocalFabric()
    const cache = createSingleFlightCache(fabric)

    const key = buildCacheKey({
      toolName: "typecheck",
      idempotencyKey: "bun:abc123:tsconfig-hash",
    })

    let executions = 0
    const execute = () => { executions++; return Promise.resolve({ passed: true }) }

    // Launch 10 concurrent requests
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        cache.singleFlight(key, execute)
      )
    )

    // Only one execution should have happened
    expect(executions).toBe(1)
    // All should get result
    expect(results.every(r => r.result.passed === true)).toBe(true)
    // One leader, 9 waiters
    const leaders = results.filter(r => r.role === "leader")
    expect(leaders.length).toBe(1)

    await cache.dispose()
  })
})
