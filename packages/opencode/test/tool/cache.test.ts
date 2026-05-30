import { describe, expect } from "bun:test"
import { Deferred, Effect, Exit, Fiber, Ref } from "effect"
import * as ToolCache from "@/tool/cache"
import { testEffect } from "../lib/effect"

const it = testEffect(ToolCache.layer)

describe("ToolCache concurrency", () => {
  it.live("concurrent identical misses", () =>
    Effect.gen(function* () {
      const cache = yield* ToolCache.Service
      const computeCount = yield* Ref.make(0)

      const compute = () =>
        Ref.updateAndGet(computeCount, (n) => n + 1).pipe(
          Effect.as("result" as const),
        )

      const N = 10
      const tasks = Array.from({ length: N }, () => cache.getOrCompute("key1", compute))
      const results = yield* Effect.all(tasks, { concurrency: "unbounded" })

      const count = yield* Ref.get(computeCount)
      expect(count).toBe(1)
      expect(results).toEqual(Array.from({ length: N }, () => "result"))
    }),
  )

  it.live("compute failure propagation", () =>
    Effect.gen(function* () {
      const cache = yield* ToolCache.Service
      const computeCount = yield* Ref.make(0)

      // The sleep gives all 10 concurrent fibers time to reach
      // getOrCompute before the first fiber's compute completes.
      // The first fiber creates the inflight entry and sleeps;
      // the other 9 hit the inflight dedup while the first sleeps.
      const compute = () =>
        Ref.updateAndGet(computeCount, (n) => n + 1).pipe(
          Effect.andThen(Effect.sleep("500 millis")),
          Effect.andThen(Effect.die("boom")),
        )

      const N = 10
      const tasks = Array.from({ length: N }, () =>
        cache.getOrCompute("key2", compute).pipe(Effect.exit),
      )
      const exits = yield* Effect.all(tasks, { concurrency: "unbounded" })

      const count = yield* Ref.get(computeCount)
      expect(count).toBe(1)
      expect(exits.length).toBe(N)
      for (const exit of exits) {
        expect(Exit.isFailure(exit)).toBe(true)
      }
    }),
  )

  it.live("cancellation safety", () =>
    Effect.gen(function* () {
      const cache = yield* ToolCache.Service
      const computeCount = yield* Ref.make(0)
      const gate = yield* Deferred.make<void>()
      const computeStarted = yield* Deferred.make<void>()

      const doCompute = () =>
        Ref.updateAndGet(computeCount, (n) => n + 1).pipe(
          Effect.andThen(Deferred.succeed(computeStarted, undefined)),
          Effect.andThen(Deferred.await(gate)),
          Effect.as("result" as const),
        )

      const neverCompute = () => Effect.die("should not run")

      // Fork the compute fiber that blocks on gate
      const computeFiber = yield* cache
        .getOrCompute("key3", doCompute)
        .pipe(Effect.forkScoped)

      // Wait for compute to claim the inflight entry
      yield* Deferred.await(computeStarted)

      // Fork 2 waiters — their compute should never run (inflight dedup)
      const waiter1 = yield* cache
        .getOrCompute("key3", neverCompute)
        .pipe(Effect.forkScoped)

      const waiter2 = yield* cache
        .getOrCompute("key3", neverCompute)
        .pipe(Effect.forkScoped)

      // Cancel one waiter
      yield* Fiber.interrupt(waiter1)

      // Release the gate — compute fiber completes
      yield* Deferred.succeed(gate, undefined)

      // Verify compute fiber succeeded
      const computeExit = yield* Fiber.await(computeFiber)
      expect(Exit.isSuccess(computeExit)).toBe(true)
      if (Exit.isSuccess(computeExit)) {
        expect(computeExit.value).toBe("result")
      }

      // Cancelled waiter is interrupted (captured as failure exit)
      const waiter1Exit = yield* Fiber.await(waiter1)
      expect(Exit.isFailure(waiter1Exit)).toBe(true)

      // Remaining waiter got the result via inflight dedup
      const waiter2Exit = yield* Fiber.await(waiter2)
      expect(Exit.isSuccess(waiter2Exit)).toBe(true)
      if (Exit.isSuccess(waiter2Exit)) {
        expect(waiter2Exit.value).toBe("result")
      }

      // Compute ran exactly once
      const count = yield* Ref.get(computeCount)
      expect(count).toBe(1)
    }),
  )

  it.live("timeout cleanup", () =>
    Effect.gen(function* () {
      const cache = yield* ToolCache.Service
      const computeCount = yield* Ref.make(0)

      const neverCompute = () => Effect.never

      // First call with Effect.never — should time out. The timeout interrupts
      // the compute fiber, triggering the ensuring callback that cleans up the
      // inflight entry so subsequent callers can retry.
      const firstExit = yield* cache
        .getOrCompute("key4", neverCompute)
        .pipe(Effect.timeout("250 millis"), Effect.exit)

      // Second call to same key — inflight was cleaned up, so compute runs
      const compute = () =>
        Ref.updateAndGet(computeCount, (n) => n + 1).pipe(
          Effect.as("recovered" as const),
        )
      const result = yield* cache.getOrCompute("key4", compute)

      expect(result).toBe("recovered")
      const count = yield* Ref.get(computeCount)
      expect(count).toBe(1)
    }),
  )

  it.live("high-cardinality pressure", () =>
    Effect.gen(function* () {
      const cache = yield* ToolCache.Service

      // 100 keys × 10 fibers each = 1000 concurrent requests
      const keys = 100
      const perKey = 10
      const tasks = Array.from({ length: keys }, (_, i) => {
        const compute = () => Effect.succeed(`value-${i}` as const)
        return Effect.all(
          Array.from({ length: perKey }, () => cache.getOrCompute(`key-${i}`, compute)),
          { concurrency: "unbounded" },
        )
      })
      const results = yield* Effect.all(tasks, { concurrency: "unbounded" })

      // Verify all results are correct
      for (let i = 0; i < keys; i++) {
        for (let j = 0; j < perKey; j++) {
          expect(results[i][j]).toBe(`value-${i}`)
        }
      }

      // Stats: 100 first-call misses + 900 subsequent hits
      const s = yield* cache.stats()
      expect(s.size).toBe(keys)
      expect(s.hits).toBe(keys * (perKey - 1))
      expect(s.misses).toBe(keys)
    }),
  )

  it.live("cache eviction correctness", () =>
    Effect.gen(function* () {
      const cache = yield* ToolCache.Service
      const computeCount = yield* Ref.make(0)

      const compute = () =>
        Ref.updateAndGet(computeCount, (n) => n + 1).pipe(
          Effect.as("computed" as const),
        )

      // First call — miss, compute
      const r1 = yield* cache.getOrCompute("evict-key", compute)
      expect(r1).toBe("computed")

      // Second call — hit
      const r2 = yield* cache.getOrCompute("evict-key", compute)
      expect(r2).toBe("computed")

      // Invalidate the key
      yield* cache.invalidateKey("evict-key")

      // Third call — miss, recompute
      const r3 = yield* cache.getOrCompute("evict-key", compute)
      expect(r3).toBe("computed")

      // Compute ran twice (first + after eviction)
      const count = yield* Ref.get(computeCount)
      expect(count).toBe(2)

      // Stats show 2 misses, 1 hit
      const s = yield* cache.stats()
      expect(s.size).toBe(1)
      expect(s.misses).toBe(2)
      expect(s.hits).toBe(1)
    }),
  )
})
