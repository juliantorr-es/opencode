/**
 * Valkey Streams Primitives
 * 
 * Low-level Valkey Streams operations. These are the raw Redis-compatible
 * stream commands that form the foundation for the coordination kernel.
 * 
 * Most runtime code should NOT call these directly. Instead, use the
 * higher-level CoordinationWorkQueue abstraction which enforces the
 * authority boundary (PGlite writes before XACK).
 * 
 * Doctrine: Valkey owns temporary coordination state. PGlite owns durable authority.
 */

import type { Redis } from "ioredis"

// ── Types ──────────────────────────────────────────────────────────────

export interface StreamEntry {
  id: string
  values: Record<string, string>
}

export interface StreamGroupInfo {
  name: string
  consumers: number
  pending: number
  lastDeliveredId: string | null
  entriesRead: number | null
  lag: number | null
}

export interface PendingEntry {
  id: string
  consumer: string
  idleMs: number
  deliveryCount: number
}

export interface ClaimedEntry {
  id: string
  values: Record<string, string>
}

export interface StreamInfo {
  length: number
  radixTreeKeys: number
  radixTreeNodes: number
  groups: number
  lastGeneratedId: string | null
  firstEntry: StreamEntry | null
  lastEntry: StreamEntry | null
}

// ── Stream Constants ───────────────────────────────────────────────────

/** Default stream name for runtime work coordination */
export const DEFAULT_STREAM_NAME = "tribunus:work"

/** Default consumer group name */
export const DEFAULT_CONSUMER_GROUP = "tribunus:workers"

/** Default pending idle threshold in ms before reclaim (5 minutes) */
export const DEFAULT_PENDING_IDLE_MS = 5 * 60 * 1000

/** Default read batch size */
export const DEFAULT_READ_BATCH_SIZE = 10

/** Default read block duration in ms */
export const DEFAULT_READ_BLOCK_MS = 5000

/** Default max stream length (0 = unlimited) */
export const DEFAULT_MAX_STREAM_LENGTH = 0

// ── Stream Primitive Operations ────────────────────────────────────────

/**
 * ValkeyStreams provides low-level stream operations.
 * 
 * These are thin wrappers around Redis stream commands. The high-level
 * CoordinationWorkQueue enforces the authority boundary and should be
 * used by most runtime code.
 */
export class ValkeyStreams {
  private readonly redis: Redis
  private readonly streamName: string

  constructor(redis: Redis, streamName: string = DEFAULT_STREAM_NAME) {
    this.redis = redis
    this.streamName = streamName
  }

  // ── Group Management ─────────────────────────────────────────────────

  /**
   * Create a consumer group idempotently.
   * Uses XGROUP CREATE with MKSTREAM to create the stream if it doesn't exist.
   * Returns true if the group was created, false if it already existed.
   */
  async ensureGroup(groupName: string, startId: string = "$"): Promise<boolean> {
    try {
      const result = await this.redis.xgroup(
        "CREATE",
        this.streamName,
        groupName,
        startId,
        "MKSTREAM"
      )
      return result === "OK"
    } catch (error) {
      // BUSYGROUP means the group already exists - this is idempotent success
      if (error instanceof Error && error.message.includes("BUSYGROUP")) {
        return false
      }
      throw error
    }
  }

  /**
   * Destroy a consumer group.
   * WARNING: This is a destructive operation. Only use for testing/admin.
   */
  async destroyGroup(groupName: string): Promise<number> {
    return this.redis.xgroup("DESTROY", this.streamName, groupName)
  }

  /**
   * Delete a consumer from a group.
   * Used when a worker exits and we need to clean up its pending entries.
   */
  async deleteConsumer(groupName: string, consumerName: string): Promise<number> {
    return this.redis.xgroup(
      "DELCONSUMER",
      this.streamName,
      groupName,
      consumerName
    )
  }

  /**
   * List all consumer groups for this stream.
   */
  async listGroups(): Promise<StreamGroupInfo[]> {
    const result = await this.redis.xinfo("GROUPS", this.streamName)
    return result as StreamGroupInfo[]
  }

  /**
   * Get information about a specific consumer group.
   */
  async getGroupInfo(groupName: string): Promise<StreamGroupInfo | null> {
    const groups = await this.listGroups()
    return groups.find(g => g.name === groupName) ?? null
  }

  // ── Entry Management ────────────────────────────────────────────────

  /**
   * Append an entry to the stream.
   * Returns the generated entry ID.
   */
  async addEntry(
    values: Record<string, string>,
    entryId?: string
  ): Promise<string> {
    const args: (string | Record<string, string>)[] = [
      this.streamName,
      entryId ?? "*",
      ...Object.entries(values).flatMap(([key, value]) => [key, value]),
    ]
    return this.redis.xadd(args) as Promise<string>
  }

  /**
   * Trim the stream to a maximum length.
   * Uses approximate trimming (~) for better performance.
   */
  async trim(maxLength: number, approximate: boolean = true): Promise<number> {
    const mode = approximate ? "~" : ""
    return this.redis.xtrim(
      this.streamName,
      mode,
      "MAXLEN",
      maxLength
    )
  }

  /**
   * Get stream information.
   */
  async getStreamInfo(): Promise<StreamInfo> {
    const result = await this.redis.xinfo("STREAM", this.streamName)
    return {
      length: result.length,
      radixTreeKeys: result.radix_tree_keys,
      radixTreeNodes: result.radix_tree_nodes,
      groups: result.groups,
      lastGeneratedId: result.last_generated_id,
      firstEntry: result.first_entry ? {
        id: result.first_entry[0],
        values: Object.fromEntries(
          result.first_entry.slice(1).map((v: string, i: number) => [
            result.first_entry[i + 1 + (i % 2 === 0 ? 0 : 1)],
            v,
          ])
        ),
      } : null,
      lastEntry: result.last_entry ? {
        id: result.last_entry[0],
        values: Object.fromEntries(
          result.last_entry.slice(1).map((v: string, i: number) => [
            result.last_entry[i + 1 + (i % 2 === 0 ? 0 : 1)],
            v,
          ])
        ),
      } : null,
    }
  }

  // ── Consumer Operations ────────────────────────────────────────────

  /**
   * Read entries from a stream as a consumer in a group.
   * This is the primary method for workers to get work.
   */
  async readGroup(
    groupName: string,
    consumerName: string,
    options: {
      count?: number
      blockMs?: number
      noAck?: boolean
    } = {}
  ): Promise<StreamEntry[]> {
    const {
      count = DEFAULT_READ_BATCH_SIZE,
      blockMs = DEFAULT_READ_BLOCK_MS,
      noAck = false,
    } = options

    const args: (string | number)[] = [
      "GROUP",
      groupName,
      consumerName,
    ]

    if (count !== undefined) {
      args.push("COUNT", count)
    }

    if (blockMs !== undefined) {
      args.push("BLOCK", blockMs)
    }

    if (noAck) {
      args.push("NOACK")
    }

    const result = await this.redis.xreadgroup(
      args,
      "STREAMS",
      this.streamName,
      ">"
    )

    // Parse the result: [[streamName, [[entryId, field1, value1, field2, value2, ...], ...]]]
    if (!result || !result[0]) return []

    const entries: StreamEntry[] = []
    for (const entryData of result[0][1]) {
      const entryId = entryData[0]
      const values: Record<string, string> = {}
      for (let i = 1; i < entryData.length; i += 2) {
        values[entryData[i]] = entryData[i + 1]
      }
      entries.push({ id: entryId, values })
    }

    return entries
  }

  /**
   * Acknowledge one or more entries.
   * This removes entries from the pending entries list.
   * 
   * WARNING: This should only be called AFTER durable PGlite write.
   * The high-level API enforces this invariant.
   */
  async ack(groupName: string, entryIds: string[]): Promise<number> {
    if (entryIds.length === 0) return 0
    return this.redis.xack(
      this.streamName,
      groupName,
      ...entryIds
    )
  }

  /**
   * Acknowledge a single entry.
   */
  async ackOne(groupName: string, entryId: string): Promise<number> {
    return this.ack(groupName, [entryId])
  }

  // ── Pending Entry Inspection ─────────────────────────────────────────

  /**
   * Get summary of pending entries for a consumer group.
   */
  async getPendingSummary(
    groupName: string
  ): Promise<{
    count: number
    minIdleMs: number | null
    maxIdleMs: number | null
    consumers: Record<string, number>
  }> {
    const result = await this.redis.xpending(
      this.streamName,
      groupName
    )
    
    // Result format: [count, minIdleMs, maxIdleMs, [consumer1, count1, consumer2, count2, ...]]
    if (!result || result.length < 3) {
      return { count: 0, minIdleMs: null, maxIdleMs: null, consumers: {} }
    }

    const consumers: Record<string, number> = {}
    for (let i = 3; i < result.length; i += 2) {
      consumers[result[i]] = Number(result[i + 1])
    }

    return {
      count: Number(result[0]),
      minIdleMs: result[1] !== null ? Number(result[1]) : null,
      maxIdleMs: result[2] !== null ? Number(result[2]) : null,
      consumers,
    }
  }

  /**
   * Get detailed pending entries for a consumer group.
   * Can filter by specific consumer and/or idle time range.
   */
  async getPendingEntries(
    groupName: string,
    options: {
      consumer?: string
      minIdleMs?: number
      maxIdleMs?: number
      count?: number
    } = {}
  ): Promise<PendingEntry[]> {
    const {
      consumer,
      minIdleMs = 0,
      maxIdleMs = Infinity,
      count = 100,
    } = options

    let start: string | null = null
    let end: string | null = null
    let consumerArg: string | undefined

    if (consumer) {
      consumerArg = consumer
    }

    // Use XPENDING with range to get entries
    const result = await this.redis.send_command(
      "XPENDING",
      [
        this.streamName,
        groupName,
        minIdleMs.toString(),
        maxIdleMs.toString(),
        count.toString(),
        ...(consumerArg ? [consumerArg] : []),
      ]
    )

    // Parse result: [[entryId, consumer, idleMs, deliveryCount], ...]
    if (!result || !Array.isArray(result)) return []

    return result.map((entry: unknown[]) => ({
      id: entry[0] as string,
      consumer: entry[1] as string,
      idleMs: Number(entry[2]),
      deliveryCount: Number(entry[3]),
    }))
  }

  /**
   * Get pending entries for a specific consumer.
   */
  async getConsumerPending(
    groupName: string,
    consumerName: string
  ): Promise<PendingEntry[]> {
    return this.getPendingEntries(groupName, { consumer: consumerName })
  }

  // ── Claim Operations ────────────────────────────────────────────────

  /**
   * Claim pending entries from other consumers.
   * This is used for reclaiming stale work.
   * 
   * Uses XAUTOCLAIM for simplicity - automatically claims entries idle > minIdleMs
   * and returns up to count entries.
   */
  async autoClaim(
    groupName: string,
    consumerName: string,
    minIdleMs: number,
    count: number = 10,
    justId: boolean = false
  ): Promise<ClaimedEntry[]> {
    const result = await this.redis.xautoclaim(
      this.streamName,
      groupName,
      consumerName,
      minIdleMs,
      count.toString(),
      justId ? "JUSTID" : undefined
    )

    // Parse result: [[entryId, [field1, value1, ...]], ...] or [[entryId], ...] if JUSTID
    if (!result || !Array.isArray(result)) return []

    return result.map((entry: unknown[]) => {
      const entryId = entry[0] as string
      if (justId) {
        return { id: entryId, values: {} }
      }
      const values: Record<string, string> = {}
      const data = entry[1] as unknown[]
      for (let i = 0; i < data.length; i += 2) {
        values[data[i] as string] = data[i + 1] as string
      }
      return { id: entryId, values }
    })
  }

  /**
   * Claim specific pending entries by ID.
   * Uses XCLAIM for explicit entry claiming.
   */
  async claim(
    groupName: string,
    consumerName: string,
    minIdleMs: number,
    entryIds: string[],
    justId: boolean = false
  ): Promise<ClaimedEntry[]> {
    if (entryIds.length === 0) return []

    const result = await this.redis.xclaim(
      this.streamName,
      groupName,
      consumerName,
      minIdleMs,
      ...entryIds,
      justId ? "JUSTID" : undefined
    )

    // Parse result: [[entryId, [field1, value1, ...]], ...] or [[entryId], ...] if JUSTID
    if (!result || !Array.isArray(result)) return []

    return result.map((entry: unknown[]) => {
      const entryId = entry[0] as string
      if (justId) {
        return { id: entryId, values: {} }
      }
      const values: Record<string, string> = {}
      const data = entry[1] as unknown[]
      for (let i = 0; i < data.length; i += 2) {
        values[data[i] as string] = data[i + 1] as string
      }
      return { id: entryId, values }
    })
  }

  // ── Consumer Management ──────────────────────────────────────────────

  /**
   * List all consumers in a group.
   */
  async listConsumers(groupName: string): Promise<{
    name: string
    seenTime: number
    activeTime: number
    idleMs: number
    pending: number
  }[]> {
    const result = await this.redis.xinfo(
      "CONSUMERS",
      this.streamName,
      groupName
    )
    return result as unknown as {
      name: string
      seen_time: number
      active_time: number
      idle: number
      pending: number
    }[]
  }

  // ── Utility Methods ─────────────────────────────────────────────────

  /**
   * Get the last entry ID in the stream.
   */
  async getLastEntryId(): Promise<string | null> {
    const info = await this.getStreamInfo()
    return info.lastGeneratedId
  }

  /**
   * Check if the stream exists.
   */
  async streamExists(): Promise<boolean> {
    try {
      await this.getStreamInfo()
      return true
    } catch {
      return false
    }
  }

  /**
   * Get the number of entries in the stream.
   */
  async getStreamLength(): Promise<number> {
    const info = await this.getStreamInfo()
    return info.length
  }

  /**
   * Read entries by ID range (for recovery/replay).
   */
  async readRange(
    start: string,
    end: string = "+",
    count?: number
  ): Promise<StreamEntry[]> {
    const args: (string | number)[] = [this.streamName, start]
    if (count !== undefined) {
      args.push("COUNT", count)
    }
    args.push(end)

    const result = await this.redis.xrange(args)

    if (!result || !Array.isArray(result)) return []

    return result.map((entry: unknown[]) => {
      const entryId = entry[0] as string
      const values: Record<string, string> = {}
      for (let i = 1; i < entry.length; i += 2) {
        values[entry[i] as string] = entry[i + 1] as string
      }
      return { id: entryId, values }
    })
  }
}

// ── Factory ────────────────────────────────────────────────────────────

/**
 * Create a ValkeyStreams instance for the default work stream.
 */
export function createValkeyStreams(redis: Redis): ValkeyStreams {
  return new ValkeyStreams(redis, DEFAULT_STREAM_NAME)
}

/**
 * Create a ValkeyStreams instance for a custom stream.
 */
export function createValkeyStreamsFor(redis: Redis, streamName: string): ValkeyStreams {
  return new ValkeyStreams(redis, streamName)
}
