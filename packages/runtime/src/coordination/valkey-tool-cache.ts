import type { ToolCache, ToolCacheKey, ToolCacheEntry, InvalidationScope } from "./tool-cache"
import type { Redis } from "ioredis"

export async function createValkeyToolCache(redisFactory: () => Promise<Redis>): Promise<ToolCache> {
  const redis = await redisFactory()
  let hits = 0
  let misses = 0

  function cacheKey(entryKey: string): string {
    return `toolcache:${entryKey}`
  }

  function scopeKey(scope: InvalidationScope): string {
    return `toolcache:scope:${scope}`
  }

  async function set(key: ToolCacheKey, result: unknown, ttlMs: number): Promise<void> {
    const k = cacheKey(key.key)
    const entry: Omit<ToolCacheEntry, "key"> & { key: string } = {
      key: key.key,
      result,
      status: "completed",
      createdAt: Date.now(),
      expiresAt: Date.now() + ttlMs,
      ttlMs,
    }
    const ttlSeconds = Math.ceil(ttlMs / 1000)
    await redis.setex(k, ttlSeconds, JSON.stringify(entry))
    // Track by scope for invalidation
    for (const scope of key.scopes) {
      await redis.sadd(scopeKey(scope), k)
    }
  }

  async function get(key: ToolCacheKey): Promise<ToolCacheEntry | undefined> {
    const raw = await redis.get(cacheKey(key.key))
    if (!raw) { misses++; return undefined }
    const entry = JSON.parse(raw) as ToolCacheEntry
    if (Date.now() > entry.expiresAt) {
      await redis.del(cacheKey(key.key))
      misses++
      return undefined
    }
    hits++
    return entry
  }

  async function invalidate(scope: InvalidationScope, _oldDigest: string): Promise<number> {
    const sk = scopeKey(scope)
    const members = await redis.smembers(sk)
    let count = 0
    for (const key of members) {
      await redis.del(key)
      count++
    }
    await redis.del(sk)
    return count
  }

  async function stats() {
    const keys = await redis.keys("toolcache:*")
    return { entries: keys.length, hits, misses }
  }

  async function dispose() {
    await redis.quit()
  }

  return { set, get, invalidate, stats, dispose }
}
