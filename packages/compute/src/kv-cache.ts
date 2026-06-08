import type { TensorView } from "./tensor-view.js"

// ── Types ─────────────────────────────────────────────────────────────────────

export type EvictionPolicy = "lru" | "fifo" | "sliding_window"

export interface KVCacheEntry {
  readonly key: string
  readonly k: TensorView
  readonly v: TensorView
  readonly lastAccess: string
  readonly tokenCount: number
}

export interface KVCache {
  readonly maxEntries: number
  readonly policy: EvictionPolicy
  get(key: string): KVCacheEntry | undefined
  set(key: string, k: TensorView, v: TensorView): void
  evict(): number // returns count evicted
  stats(): { size: number; hits: number; misses: number }
}

// ── Internal entry representation ─────────────────────────────────────────────

interface InternalEntry {
  key: string
  k: TensorView
  v: TensorView
  lastAccess: number // unix ms for ordering
  insertOrder: number // monotonic counter for fifo
  tokenCount: number
}

// ── Concrete implementation ───────────────────────────────────────────────────

export class SimpleKVCache implements KVCache {
  readonly maxEntries: number
  readonly policy: EvictionPolicy
  readonly windowSize: number // used only when policy === "sliding_window"

  private readonly entries = new Map<string, InternalEntry>()
  private hits = 0
  private misses = 0
  private insertCounter = 0

  constructor(opts: {
    maxEntries: number
    policy: EvictionPolicy
    /** Window size in tokens when policy is "sliding_window" (default 4096). */
    windowSize?: number
  }) {
    this.maxEntries = opts.maxEntries
    this.policy = opts.policy
    this.windowSize = opts.windowSize ?? 4096
  }

  // ── KVCache ─────────────────────────────────────────────────────────────

  get(key: string): KVCacheEntry | undefined {
    const entry = this.entries.get(key)
    if (!entry) {
      this.misses++
      return undefined
    }

    // Sliding-window: discard entries whose token position falls outside the
    // current window relative to the most recent cached position.
    if (this.policy === "sliding_window") {
      const maxPos = latestTokenPosition(this.entries)
      if (entry.tokenCount < maxPos - this.windowSize) {
        this.entries.delete(key)
        this.misses++
        return undefined
      }
    }

    this.hits++
    entry.lastAccess = nowMs()

    // Return a frozen view of the entry.
    return {
      key: entry.key,
      k: entry.k,
      v: entry.v,
      lastAccess: new Date(entry.lastAccess).toISOString(),
      tokenCount: entry.tokenCount,
    }
  }

  set(key: string, k: TensorView, v: TensorView): void {
    // Ensure capacity before inserting.
    this.makeRoom()

    const now = nowMs()
    this.entries.set(key, {
      key,
      k,
      v,
      lastAccess: now,
      insertOrder: ++this.insertCounter,
      tokenCount: k.shape.length > 0 ? k.shape[1] ?? 1 : 1,
    })
  }

  evict(): number {
    if (this.entries.size === 0) return 0

    // Determine how many to evict: bring the cache to 75% capacity.
    const target = Math.max(1, Math.floor(this.maxEntries * 0.75))
    const count = Math.max(0, this.entries.size - target)
    if (count === 0) return 0

    // Pick victims according to policy.
    const victims = this.selectVictims(count)

    for (const key of victims) {
      this.entries.delete(key)
    }
    return victims.length
  }

  stats(): { size: number; hits: number; misses: number } {
    return {
      size: this.entries.size,
      hits: this.hits,
      misses: this.misses,
    }
  }

  // ── Internals ───────────────────────────────────────────────────────────

  /** Remove the oldest entries until there is room for one more. */
  private makeRoom(): void {
    if (this.entries.size < this.maxEntries) return

    const overflow = this.entries.size - this.maxEntries + 1
    const victims = this.selectVictims(overflow)
    for (const key of victims) {
      this.entries.delete(key)
    }
  }

  /** Select `count` victims according to the configured policy. */
  private selectVictims(count: number): string[] {
    if (count <= 0 || this.entries.size === 0) return []

    const pool = Array.from(this.entries.values())

    switch (this.policy) {
      case "lru":
        // Least-recently accessed first.
        pool.sort((a, b) => a.lastAccess - b.lastAccess)
        break
      case "fifo":
        // Earliest-inserted first.
        pool.sort((a, b) => a.insertOrder - b.insertOrder)
        break
      case "sliding_window":
        // Evict entries farthest from the most recent token position.
        {
          const maxPos = latestTokenPosition(this.entries)
          pool.sort((a, b) => Math.abs(a.tokenCount - maxPos) - Math.abs(b.tokenCount - maxPos))
        }
        break
    }

    return pool.slice(0, count).map((e) => e.key)
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function nowMs(): number {
  return Date.now()
}

/** Largest token position recorded in the cache. */
function latestTokenPosition(entries: Map<string, InternalEntry>): number {
  let max = 0
  for (const entry of entries.values()) {
    if (entry.tokenCount > max) max = entry.tokenCount
  }
  return max
}
