import type {
  ToolCache,
  ToolCacheKey,
  ToolCacheEntry,
  SingleFlightResult,
  InvalidationScope,
} from "./tool-cache"
import type { CoordinationFabric } from "./fabric"

// ── Per-flight state ────────────────────────────────────

interface Flight<T> {
  promise: Promise<T>
  waiters: number
}

// ── Extended cache ──────────────────────────────────────

export interface SingleFlightCache extends ToolCache {
  singleFlight<T>(key: ToolCacheKey, execute: () => Promise<T>): Promise<SingleFlightResult<T>>
}

// ── Factory ─────────────────────────────────────────────

// fabric reserved for future coordination-plane cache sharing
export function createSingleFlightCache(_fabric: CoordinationFabric): SingleFlightCache {
  const cache = new Map<string, ToolCacheEntry>()
  const flights = new Map<string, Flight<unknown>>()
  let hits = 0
  let misses = 0

  // ── Core cache operations ─────────────────────────────

  async function set(key: ToolCacheKey, result: unknown, ttlMs: number): Promise<void> {
    const now = Date.now()
    const entry: ToolCacheEntry = {
      key: key.key,
      result,
      status: "completed",
      createdAt: now,
      expiresAt: now + ttlMs,
      ttlMs,
    }
    cache.set(key.key, entry)
  }

  async function get(key: ToolCacheKey): Promise<ToolCacheEntry | undefined> {
    const entry = cache.get(key.key)
    if (!entry) {
      misses++
      return undefined
    }
    if (Date.now() > entry.expiresAt) {
      cache.delete(key.key)
      misses++
      return undefined
    }
    hits++
    return entry
  }

  /**
   * Invalidate cache entries. In this initial implementation the cache is
   * scope-naive: any invalidation clears everything. A production version would
   * match entries by scope + digest.
   */
  async function invalidate(_scope: InvalidationScope, _oldDigest: string): Promise<number> {
    const count = cache.size
    cache.clear()
    return count
  }

  async function stats(): Promise<{ entries: number; hits: number; misses: number }> {
    return { entries: cache.size, hits, misses }
  }

  async function dispose(): Promise<void> {
    cache.clear()
    flights.clear()
  }

  // ── Single-flight ─────────────────────────────────────

  async function singleFlight<T>(
    key: ToolCacheKey,
    execute: () => Promise<T>,
  ): Promise<SingleFlightResult<T>> {
    // 1. Cache hit → return immediately as waiter
    const cached = await get(key)
    if (cached) {
      return { role: "waiter", jobId: key.key, result: cached.result as T, waiterCount: 0 }
    }

    // 2. Already in-flight → attach as waiter
    const existing = flights.get(key.key)
    if (existing) {
      existing.waiters++
      const result = (await existing.promise) as T
      return { role: "waiter", jobId: key.key, result, waiterCount: existing.waiters }
    }

    // 3. Leader — execute, cache, return
    const promise = execute()
    const flight: Flight<unknown> = { promise, waiters: 0 }
    flights.set(key.key, flight)
    try {
      const result = await promise
      await set(key, result, 300_000) // 5 min default TTL
      return { role: "leader", jobId: key.key, result, waiterCount: flight.waiters }
    } finally {
      flights.delete(key.key)
    }
  }

  return { set, get, invalidate, stats, dispose, singleFlight }
}
