import { describe, expect } from "bun:test"
import { Duration, Effect, Exit, Ref } from "effect"
import * as ToolCache from "../../src/tool/cache"
import { testEffect } from "../lib/effect"

const it = testEffect(ToolCache.defaultLayer)

describe("ToolCache pipeline", () => {
  it.live("basic getOrCompute works", () =>
    Effect.gen(function* () {
      const cache = yield* ToolCache.Service as any
      const result = yield* cache.getOrCompute("key1", () => Effect.succeed("value"))
      expect(result).toBe("value")
    }),
  )

  it.live("maxEntrySize bypass: large results are not cached", () =>
    Effect.gen(function* () {
      const cache = yield* ToolCache.Service as any
      let callCount = 0
      const compute = () => {
        callCount++
        return Effect.succeed("x".repeat(2 * 1024 * 1024)) as any
      }
      const result1: string = yield* cache.getOrCompute("test-key-large", compute, { maxEntrySize: 1024 })
      const result2: string = yield* cache.getOrCompute("test-key-large", compute, { maxEntrySize: 1024 })
      expect(result1.length).toBe(2 * 1024 * 1024)
      expect(result2.length).toBe(2 * 1024 * 1024)
      expect(callCount).toBe(2)
    }),
  )

  it.live("cache hit skips recomputation", () =>
    Effect.gen(function* () {
      const cache = yield* ToolCache.Service as any
      let executeCount = 0
      const compute = () => {
        executeCount++
        return Effect.succeed({ result: "computed" }) as any
      }
      const r1: any = yield* cache.getOrCompute("test-key-hit", compute, { ttl: Duration.minutes(5) })
      expect(r1).toEqual({ result: "computed" })
      expect(executeCount).toBe(1)
      const r2: any = yield* cache.getOrCompute("test-key-hit", compute, { ttl: Duration.minutes(5) })
      expect(r2).toEqual({ result: "computed" })
      expect(executeCount).toBe(1)
      const stats: any = yield* cache.stats()
      expect(stats.hits).toBe(1)
      expect(stats.size).toBe(1)
    }),
  )

  it.live("failure not cached, inflight map cleaned", () =>
    Effect.gen(function* () {
      const cache = yield* ToolCache.Service as any
      const computeCalls = yield* Ref.make(0) as any
      const compute = () =>
        Ref.update(computeCalls, (n: number) => n + 1).pipe(
          Effect.andThen(Effect.die("simulated failure") as any),
        ) as any
      const r1 = yield* (cache.getOrCompute("test-key-fail", compute) as any).pipe(Effect.exit)
      expect(Exit.isFailure(r1)).toBe(true)
      const count = yield* Ref.get(computeCalls) as any
      expect(count).toBe(1)
      const r2 = yield* (cache.getOrCompute("test-key-fail", compute) as any).pipe(Effect.exit)
      expect(Exit.isFailure(r2)).toBe(true)
      const count2 = yield* Ref.get(computeCalls) as any
      expect(count2).toBe(2)
      const stats: any = yield* cache.stats()
      expect(stats.size).toBe(0)
    }),
  )

  it.live("invalidate clears all entries", () =>
    Effect.gen(function* () {
      const cache = yield* ToolCache.Service as any
      const compute = () => Effect.succeed("value") as any
      yield* cache.getOrCompute("k1", compute, { ttl: Duration.minutes(5) })
      yield* cache.getOrCompute("k2", compute, { ttl: Duration.minutes(5) })
      const before: any = yield* cache.stats()
      expect(before.size).toBe(2)
      yield* cache.invalidate()
      const after: any = yield* cache.stats()
      expect(after.size).toBe(0)
      expect(after.hits).toBe(0)
    }),
  )

  it.live("dedup: concurrent calls share computation", () =>
    Effect.gen(function* () {
      const cache = yield* ToolCache.Service as any
      const computeCalls = yield* Ref.make(0) as any
      const compute = () =>
        Ref.update(computeCalls, (n: number) => n + 1).pipe(
          Effect.andThen(Effect.sleep("50 millis")),
          Effect.andThen(Effect.succeed("computed")),
        ) as any
      const [r1, r2] = yield* Effect.all([
        cache.getOrCompute("test-key-dedup", compute),
        cache.getOrCompute("test-key-dedup", compute),
      ]) as any
      expect(r1).toBe("computed")
      expect(r2).toBe("computed")
      const count: number = yield* Ref.get(computeCalls) as any
      expect(count).toBe(1)
      const stats: any = yield* cache.stats()
      // Dedup works: compute ran once, second caller joined inflight.
      // Inflight joins are not double-counted as misses.
      expect(stats.misses).toBe(1)
    }),
  )
})
