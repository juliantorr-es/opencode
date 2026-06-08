import { Clock, Context, Deferred, Duration, Effect, Exit, Layer, Ref } from "effect"

type CacheKey = string

interface CacheEntry {
  value: any
  expiresAt: number
  size: number
}

/**
 * Cache configuration passed per getOrCompute call.
 * All fields are optional — defaults apply when omitted.
 */
export interface CacheConfig {
  readonly maxEntries?: number
  readonly ttl?: Duration.Duration
  readonly maxEntrySize?: number
}

export interface CacheStats {
  readonly size: number
  readonly hits: number
  readonly misses: number
  readonly evictions: number
  readonly estimatedBytes: number
}

export interface Interface {
  readonly getOrCompute: <R = never>(
    key: CacheKey,
    compute: () => Effect.Effect<any, never, R>,
    config?: CacheConfig,
  ) => Effect.Effect<any, never, R>
  readonly invalidate: () => Effect.Effect<void>
  readonly invalidateKey: (key: CacheKey) => Effect.Effect<void>
  readonly stats: () => Effect.Effect<CacheStats>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ToolCache") {}

const approximateSize = (value: unknown): number => {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).length
  } catch {
    return 0
  }
}

const recalcBytes = (m: Map<CacheKey, CacheEntry>): number => {
  let total = 0
  for (const [, entry] of m) {
    total += entry.size
  }
  return total
}

interface CacheState {
  entries: Map<CacheKey, CacheEntry>
  estimatedBytes: number
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const cache = yield* Ref.make<CacheState>({ entries: new Map(), estimatedBytes: 0 })
    const inflight = yield* Ref.make(new Map<CacheKey, Deferred.Deferred<any>>())
    const hits = yield* Ref.make(0)
    const misses = yield* Ref.make(0)
    const evictions = yield* Ref.make(0)

    const getOrCompute: Interface["getOrCompute"] = (key, compute, config) =>
      Effect.gen(function* () {
        const t = yield* Clock.currentTimeMillis
        const ttlDuration: Duration.Duration = config?.ttl ?? Duration.minutes(5)
        const ttlMs = Duration.toMillis(ttlDuration)
        const maxEntries = config?.maxEntries ?? 1000
        const maxEntrySize = config?.maxEntrySize ?? 1024 * 1024

        // 1. Check cache atomically — Ref.modify ensures no race between read and mutation
        type HitCheck = { kind: "hit"; entry: CacheEntry }
        type ExpiredCheck = { kind: "expired"; entry: CacheEntry }
        type MissCheck = { kind: "miss"; entry?: undefined }
        const hitResult: HitCheck | ExpiredCheck | MissCheck = yield* Ref.modify(cache, (state): readonly [HitCheck | ExpiredCheck | MissCheck, CacheState] => {
          const entry = state.entries.get(key)
          if (entry) {
            if (entry.expiresAt > t) {
              // Hit — promote to MRU atomically
              state.entries.delete(key)
              state.entries.set(key, entry)
              return [{ kind: "hit" as const, entry }, state]
            }
            // Expired — remove atomically, adjusting bytes inline
            state.entries.delete(key)
            state.estimatedBytes -= entry.size
            return [{ kind: "expired" as const, entry }, state]
          }
          return [{ kind: "miss" as const }, state]
        })

        if (hitResult.kind === "hit") {
          yield* Ref.update(hits, (n) => n + 1)
          yield* Effect.annotateCurrentSpan({
            "cache.hit": true,
            "cache.key_kind": "sha256",
            "cache.result_source": "cache",
          })
          return hitResult.entry!.value
        }

        if (hitResult.kind === "expired") {
          yield* Ref.update(evictions, (n) => n + 1)
          yield* Effect.annotateCurrentSpan({
            "cache.evicted": true,
            "cache.reason": "expired",
            "cache.miss_reason": "ttl_expired",
            "cache.key_kind": "sha256",
            "cache.result_source": "miss",
          })
        }

        // 2. Check inflight dedup atomically
        const d = yield* Deferred.make<any>()
        const existing = yield* Ref.modify(inflight, (pending) => {
          const existing = pending.get(key)
          if (existing) {
            return [existing, pending] as const
          }
          pending.set(key, d)
          return [undefined, pending] as const
        })
        if (existing) {
          yield* Ref.update(misses, (n) => n + 1)
          yield* Effect.annotateCurrentSpan({
            "cache.hit": false,
            "cache.dedup": true,
            "cache.key_kind": "sha256",
            "cache.result_source": "dedup",
          })
          return yield* Deferred.await(existing)
        }

        // 3. New computation
        yield* Ref.update(misses, (n) => n + 1)
        yield* Effect.annotateCurrentSpan({
          "cache.hit": false,
          "cache.dedup": false,
          "cache.key_kind": "sha256",
          "cache.result_source": "compute",
        })

        // Capture the exit so the Deferred always resolves — even on defect
        const exit = yield* compute().pipe(
          Effect.exit,
          Effect.ensuring(
            Ref.update(inflight, (m) => {
              m.delete(key)
              return m
            }),
          ),
        )

        // Resolve Deferred for concurrent awaiters (handles both success and defect)
        yield* Deferred.done(d, exit as any)

        // 4. Handle result or propagate defect
        if (Exit.isSuccess(exit)) {
          const result = exit.value
          const size = approximateSize(result)

          // 4a. Check max entry size — skip caching if too large
          if (size <= maxEntrySize) {
            const expiresAt = t + ttlMs

            // Evict expired + LRU entries, then insert — bytes recalculated atomically inside Ref.update
            let evictedCount = 0
            yield* Ref.update(cache, (state) => {
              const m = state.entries
              for (const [k, e] of m) {
                if (e.expiresAt <= t) {
                  m.delete(k)
                  evictedCount++
                }
              }
              while (m.size >= maxEntries) {
                const oldestKey = m.keys().next().value
                if (oldestKey === undefined) break
                m.delete(oldestKey)
                evictedCount++
              }
              m.set(key, { value: result, expiresAt, size })
              state.estimatedBytes = recalcBytes(m)
              return state
            })
            if (evictedCount > 0) {
              yield* Ref.update(evictions, (n) => n + evictedCount)
              yield* Effect.annotateCurrentSpan({
                "cache.evicted": true,
                "cache.reason": "lru",
                "cache.evicted_count": evictedCount,
              })
            }
          } else {
            yield* Effect.annotateCurrentSpan({
              "cache.skipped": true,
              "cache.reason": "maxEntrySize",
              "cache.miss_reason": "maxEntrySize",
              "cache.entry_size_bytes": size,
              "cache.key_kind": "sha256",
            })
          }

          return result
        }

        // 4b. Failure/defect — propagate to this caller
        return yield* Effect.failCause(exit.cause)
      })

    const invalidate: Interface["invalidate"] = () =>
      Ref.set(cache, { entries: new Map(), estimatedBytes: 0 }).pipe(
        Effect.andThen(Ref.set(hits, 0)),
        Effect.andThen(Ref.set(misses, 0)),
        Effect.andThen(Ref.set(evictions, 0)),
      )

    const invalidateKey: Interface["invalidateKey"] = (key) =>
      Ref.update(cache, (state) => {
        state.entries.delete(key)
        state.estimatedBytes = recalcBytes(state.entries)
        return state
      })

    const stats: Interface["stats"] = () =>
      Effect.gen(function* () {
        const [h, m, e, state] = yield* Effect.all([
          Ref.get(hits),
          Ref.get(misses),
          Ref.get(evictions),
          Ref.get(cache),
        ])
        return {
          size: state.entries.size,
          hits: h,
          misses: m,
          evictions: e,
          estimatedBytes: state.estimatedBytes,
        }
      })

    return Service.of({ getOrCompute, invalidate, invalidateKey, stats })
  }),
)

export const defaultLayer = layer
