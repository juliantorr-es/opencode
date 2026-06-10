/**
 * Valkey Sorted Set Primitives
 * 
 * Low-level Valkey Sorted Set operations for scheduling.
 * 
 * Doctrine: Sorted sets decide WHEN work becomes eligible.
 * Streams decide WHO owns eligible work.
 * PGlite records WHAT actually happened.
 */

import type { Redis } from "ioredis"

// ── Types ──────────────────────────────────────────────────────────────

/** Sorted set entry with score and value */
export interface SortedSetEntry {
  value: string
  score: number
}

/** Sorted set range query options */
export interface SortedSetRangeOptions {
  /** Minimum score (inclusive) */
  min?: number
  /** Maximum score (inclusive) */
  max?: number
  /** Limit number of results */
  limit?: number
  /** Offset for pagination */
  offset?: number
}

/** Sorted set range query result */
export interface SortedSetRangeResult {
  entries: SortedSetEntry[]
  total: number
}

// ── Constants ──────────────────────────────────────────────────────────

/** Default due-time wheel sorted set name */
export const DEFAULT_DUE_SET_NAME = "tribunus:due"

/** Default priority queue sorted set name */
export const DEFAULT_PRIORITY_SET_NAME = "tribunus:priority"

// ── Sorted Set Primitives ─────────────────────────────────────────────

/**
 * ValkeySortedSets provides low-level sorted set operations.
 * 
 * These are thin wrappers around Redis sorted set commands.
 * The high-level scheduler uses these to manage due-time wheels and priority queues.
 */
export class ValkeySortedSets {
  private readonly redis: Redis

  constructor(redis: Redis) {
    this.redis = redis
  }

  // ── Core Operations ─────────────────────────────────────────────────

  /**
   * Add a member to a sorted set with a score.
   * Returns the number of elements added (0 or 1).
   */
  async add(setName: string, score: number, value: string): Promise<number> {
    return this.redis.zadd(setName, score, value)
  }

  /**
   * Add multiple members to a sorted set.
   * Returns the number of elements added.
   */
  async addMany(setName: string, entries: SortedSetEntry[]): Promise<number> {
    const args: (string | number)[] = [setName]
    for (const entry of entries) {
      args.push(entry.score, entry.value)
    }
    return this.redis.zadd(args) as Promise<number>
  }

  /**
   * Remove a member from a sorted set.
   * Returns the number of elements removed.
   */
  async remove(setName: string, value: string): Promise<number> {
    return this.redis.zrem(setName, value)
  }

  /**
   * Remove multiple members from a sorted set.
   * Returns the number of elements removed.
   */
  async removeMany(setName: string, values: string[]): Promise<number> {
    if (values.length === 0) return 0
    return this.redis.zrem(setName, ...values)
  }

  // ── Range Queries ──────────────────────────────────────────────────

  /**
   * Get entries from a sorted set by score range.
   * Returns entries sorted by score (ascending).
   */
  async rangeByScore(
    setName: string,
    options: SortedSetRangeOptions = {}
  ): Promise<SortedSetRangeResult> {
    const { min = -Infinity, max = Infinity, limit, offset = 0 } = options

    let args: (string | number)[] = [setName, min, max]

    if (limit !== undefined) {
      args.push("LIMIT", offset, limit)
    }

    const result = await this.redis.zrange(args, "WITHSCORES")

    // Parse result: [value1, score1, value2, score2, ...]
    const entries: SortedSetEntry[] = []
    for (let i = 0; i < result.length; i += 2) {
      entries.push({
        value: result[i] as string,
        score: Number(result[i + 1]),
      })
    }

    return {
      entries,
      total: entries.length,
    }
  }

  /**
   * Get entries from a sorted set by score range (descending order).
   */
  async rangeByScoreDesc(
    setName: string,
    options: SortedSetRangeOptions = {}
  ): Promise<SortedSetRangeResult> {
    const { min = -Infinity, max = Infinity, limit, offset = 0 } = options

    let args: (string | number)[] = [setName, max, min]

    if (limit !== undefined) {
      args.push("LIMIT", offset, limit)
    }

    const result = await this.redis.zrevrange(args, "WITHSCORES")

    // Parse result: [value1, score1, value2, score2, ...]
    const entries: SortedSetEntry[] = []
    for (let i = 0; i < result.length; i += 2) {
      entries.push({
        value: result[i] as string,
        score: Number(result[i + 1]),
      })
    }

    return {
      entries,
      total: entries.length,
    }
  }

  /**
   * Get entries with scores less than or equal to max.
   * This is useful for getting all due items.
   */
  async rangeByMax(setName: string, max: number, limit?: number): Promise<SortedSetEntry[]> {
    const result = await this.rangeByScore(setName, { max, limit })
    return result.entries
  }

  /**
   * Get entries with scores greater than or equal to min.
   */
  async rangeByMin(setName: string, min: number, limit?: number): Promise<SortedSetEntry[]> {
    const result = await this.rangeByScore(setName, { min, limit })
    return result.entries
  }

  // ── Score Operations ───────────────────────────────────────────────

  /**
   * Get the score of a member.
   * Returns null if the member doesn't exist.
   */
  async getScore(setName: string, value: string): Promise<number | null> {
    const result = await this.redis.zscore(setName, value)
    return result !== null ? Number(result) : null
  }

  /**
   * Increment the score of a member.
   * Returns the new score.
   */
  async incrementScore(setName: string, value: string, increment: number): Promise<number> {
    return this.redis.zincrby(setName, increment, value) as Promise<number>
  }

  // ── Count Operations ───────────────────────────────────────────────

  /**
   * Count the number of members in a sorted set.
   */
  async count(setName: string): Promise<number> {
    return this.redis.zcard(setName)
  }

  /**
   * Count the number of members in a score range.
   */
  async countInRange(setName: string, min: number, max: number): Promise<number> {
    return this.redis.zcount(setName, min, max)
  }

  // ── Due-Time Wheel Operations ──────────────────────────────────────

  /**
   * Add work to the due-time wheel.
   * The score is the Unix timestamp (in ms) when the work should be processed.
   */
  async scheduleDue(
    setName: string,
    workId: string,
    dueAt: number
  ): Promise<number> {
    return this.add(setName, dueAt, workId)
  }

  /**
   * Get all work that is due (score <= current time).
   */
  async getDue(setName: string, now: number = Date.now(), limit?: number): Promise<SortedSetEntry[]> {
    return this.rangeByMax(setName, now, limit)
  }

  /**
   * Remove work from the due-time wheel after it's been processed.
   */
  async removeDue(setName: string, workId: string): Promise<number> {
    return this.remove(setName, workId)
  }

  /**
   * Get the next due time (minimum score) from the set.
   */
  async getNextDueTime(setName: string): Promise<number | null> {
    const result = await this.redis.zrange(setName, 0, 0, "WITHSCORES")
    if (!result || result.length === 0) return null
    return Number(result[1])
  }

  // ── Priority Queue Operations ──────────────────────────────────────

  /**
   * Add work to the priority queue.
   * Lower scores = higher priority.
   */
  async enqueueWithPriority(
    setName: string,
    workId: string,
    priority: number
  ): Promise<number> {
    return this.add(setName, priority, workId)
  }

  /**
   * Get highest priority work (lowest score).
   */
  async getHighestPriority(setName: string): Promise<SortedSetEntry | null> {
    const result = await this.rangeByScore(setName, { limit: 1 })
    return result.entries[0] ?? null
  }

  /**
   * Get work by priority range.
   */
  async getByPriority(
    setName: string,
    minPriority: number,
    maxPriority: number,
    limit?: number
  ): Promise<SortedSetEntry[]> {
    return this.rangeByScore(setName, { min: minPriority, max: maxPriority, limit }).then(r => r.entries)
  }

  // ── Utility Operations ─────────────────────────────────────────────

  /**
   * Check if a member exists in a sorted set.
   */
  async exists(setName: string, value: string): Promise<boolean> {
    const score = await this.getScore(setName, value)
    return score !== null
  }

  /**
   * Get all members in a sorted set.
   */
  async getAll(setName: string): Promise<SortedSetEntry[]> {
    return this.rangeByScore(setName, { min: -Infinity, max: Infinity })
      .then(r => r.entries)
  }

  /**
   * Remove all members from a sorted set.
   */
  async clear(setName: string): Promise<void> {
    const members = await this.getAll(setName)
    if (members.length > 0) {
      await this.removeMany(setName, members.map(m => m.value))
    }
  }

  /**
   * Get the rank of a member (0-indexed, sorted by score ascending).
   */
  async getRank(setName: string, value: string): Promise<number | null> {
    const result = await this.redis.zrank(setName, value)
    return result !== null ? Number(result) : null
  }

  /**
   * Get the reverse rank of a member (0-indexed, sorted by score descending).
   */
  async getReverseRank(setName: string, value: string): Promise<number | null> {
    const result = await this.redis.zrevrank(setName, value)
    return result !== null ? Number(result) : null
  }
}

// ── Factory ─────────────────────────────────────────────────────────────

/**
 * Create a ValkeySortedSets instance.
 */
export function createValkeySortedSets(redis: Redis): ValkeySortedSets {
  return new ValkeySortedSets(redis)
}

