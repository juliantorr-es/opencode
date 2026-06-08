/**
 * Stream Primitives Tests
 * 
 * These tests verify the low-level Valkey Streams operations.
 * They use a real Valkey-compatible instance (or mock for local testing).
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test"
import Redis from "ioredis"
import { ValkeyStreams, DEFAULT_STREAM_NAME, DEFAULT_CONSUMER_GROUP } from "@/coordination/stream-primitives"

// ── Test Setup ────────────────────────────────────────────────────────

let redis: Redis
let streams: ValkeyStreams

beforeAll(async () => {
  // Use a test Redis instance
  // In production, this would connect to a real Valkey instance
  redis = new Redis("redis://127.0.0.1:6379", { lazyConnect: true })
  streams = new ValkeyStreams(redis, `test:stream:${Date.now()}`)
  
  // Try to connect, but don't fail if Redis isn't available
  // These tests will be skipped if Redis isn't running
  try {
    await redis.ping()
  } catch {
    // Redis not available - tests will be skipped
  }
})

afterAll(async () => {
  await redis.quit()
})

beforeEach(async () => {
  // Clean up test stream
  try {
    await redis.del(streams["streamName"])
  } catch {}
})

// ── Helper to check if Redis is available ───────────────────────────────

function isRedisAvailable(): boolean {
  return redis.status === "ready"
}

// ── Group Management Tests ────────────────────────────────────────────

describe("Stream Group Management", () => {
  test("ensureGroup creates group idempotently", async () => {
    if (!isRedisAvailable()) return test.skip()

    // First call should create the group
    const first = await streams.ensureGroup("test-group")
    expect(first).toBe(true)

    // Second call should return false (already exists)
    const second = await streams.ensureGroup("test-group")
    expect(second).toBe(false)

    // Verify group exists
    const groups = await streams.listGroups()
    expect(groups.some(g => g.name === "test-group")).toBe(true)
  })

  test("listGroups returns all groups", async () => {
    if (!isRedisAvailable()) return test.skip()

    await streams.ensureGroup("group1")
    await streams.ensureGroup("group2")

    const groups = await streams.listGroups()
    expect(groups.length).toBeGreaterThanOrEqual(2)
    expect(groups.some(g => g.name === "group1")).toBe(true)
    expect(groups.some(g => g.name === "group2")).toBe(true)
  })

  test("destroyGroup removes group", async () => {
    if (!isRedisAvailable()) return test.skip()

    await streams.ensureGroup("to-destroy")
    await streams.destroyGroup("to-destroy")

    const groups = await streams.listGroups()
    expect(groups.some(g => g.name === "to-destroy")).toBe(false)
  })
})

// ── Entry Management Tests ────────────────────────────────────────────

describe("Stream Entry Management", () => {
  test("addEntry appends to stream", async () => {
    if (!isRedisAvailable()) return test.skip()

    const entryId = await streams.addEntry({ workId: "work1", kind: "test" })
    expect(entryId).toBeDefined()
    expect(entryId.length).toBeGreaterThan(0)

    const info = await streams.getStreamInfo()
    expect(info.length).toBe(1)
  })

  test("addEntry with custom ID", async () => {
    if (!isRedisAvailable()) return test.skip()

    const customId = "custom-entry-id"
    const entryId = await streams.addEntry({ workId: "work1" }, customId)
    expect(entryId).toBe(customId)
  })

  test("trim reduces stream length", async () => {
    if (!isRedisAvailable()) return test.skip()

    // Add multiple entries
    for (let i = 0; i < 10; i++) {
      await streams.addEntry({ workId: `work${i}` })
    }

    // Trim to 5
    await streams.trim(5)

    const info = await streams.getStreamInfo()
    expect(info.length).toBeLessThanOrEqual(5)
  })

  test("getStreamInfo returns correct info", async () => {
    if (!isRedisAvailable()) return test.skip()

    await streams.addEntry({ workId: "work1" })
    await streams.addEntry({ workId: "work2" })

    const info = await streams.getStreamInfo()
    expect(info.length).toBe(2)
    expect(info.lastGeneratedId).toBeDefined()
  })
})

// ── Consumer Operations Tests ─────────────────────────────────────────

describe("Consumer Operations", () => {
  test("readGroup reads entries as consumer", async () => {
    if (!isRedisAvailable()) return test.skip()

    await streams.ensureGroup("test-group")
    await streams.addEntry({ workId: "work1", kind: "test" })

    const entries = await streams.readGroup("test-group", "consumer1", { count: 1, blockMs: 100 })
    expect(entries.length).toBe(1)
    expect(entries[0].values.workId).toBe("work1")
  })

  test("readGroup with no entries returns empty", async () => {
    if (!isRedisAvailable()) return test.skip()

    await streams.ensureGroup("test-group")
    
    const entries = await streams.readGroup("test-group", "consumer1", { count: 1, blockMs: 100 })
    expect(entries.length).toBe(0)
  })

  test("ack removes entry from pending", async () => {
    if (!isRedisAvailable()) return test.skip()

    await streams.ensureGroup("test-group")
    const entryId = await streams.addEntry({ workId: "work1" })
    
    // Read as consumer (puts in pending)
    await streams.readGroup("test-group", "consumer1", { count: 1, blockMs: 100 })
    
    // Check pending
    const pending = await streams.getPendingSummary("test-group")
    expect(pending.count).toBeGreaterThanOrEqual(1)
    
    // Acknowledge
    await streams.ack("test-group", [entryId])
    
    // Check pending again
    const pendingAfter = await streams.getPendingSummary("test-group")
    expect(pendingAfter.count).toBeLessThan(pending.count)
  })

  test("ackOne acknowledges single entry", async () => {
    if (!isRedisAvailable()) return test.skip()

    await streams.ensureGroup("test-group")
    const entryId = await streams.addEntry({ workId: "work1" })
    
    await streams.readGroup("test-group", "consumer1", { count: 1, blockMs: 100 })
    await streams.ackOne("test-group", entryId)
    
    const pending = await streams.getPendingSummary("test-group")
    expect(pending.count).toBe(0)
  })
})

// ── Pending Entry Tests ───────────────────────────────────────────────

describe("Pending Entry Inspection", () => {
  test("getPendingSummary returns correct counts", async () => {
    if (!isRedisAvailable()) return test.skip()

    await streams.ensureGroup("test-group")
    
    // Add and read multiple entries
    for (let i = 0; i < 5; i++) {
      await streams.addEntry({ workId: `work${i}` })
    }
    await streams.readGroup("test-group", "consumer1", { count: 5, blockMs: 100 })

    const summary = await streams.getPendingSummary("test-group")
    expect(summary.count).toBe(5)
    expect(summary.consumers.consumer1).toBe(5)
  })

  test("getPendingEntries returns detailed pending info", async () => {
    if (!isRedisAvailable()) return test.skip()

    await streams.ensureGroup("test-group")
    
    await streams.addEntry({ workId: "work1" })
    await streams.readGroup("test-group", "consumer1", { count: 1, blockMs: 100 })

    const pending = await streams.getPendingEntries("test-group")
    expect(pending.length).toBeGreaterThanOrEqual(1)
    expect(pending[0].consumer).toBe("consumer1")
    expect(pending[0].idleMs).toBeGreaterThanOrEqual(0)
  })

  test("getConsumerPending returns entries for specific consumer", async () => {
    if (!isRedisAvailable()) return test.skip()

    await streams.ensureGroup("test-group")
    
    await streams.addEntry({ workId: "work1" })
    await streams.addEntry({ workId: "work2" })
    
    await streams.readGroup("test-group", "consumer1", { count: 1, blockMs: 100 })
    await streams.readGroup("test-group", "consumer2", { count: 1, blockMs: 100 })

    const consumer1Pending = await streams.getConsumerPending("test-group", "consumer1")
    expect(consumer1Pending.length).toBe(1)
    expect(consumer1Pending[0].consumer).toBe("consumer1")
  })
})

// ── Claim Operations Tests ───────────────────────────────────────────

describe("Claim Operations", () => {
  test("autoClaim reclaims idle entries", async () => {
    if (!isRedisAvailable()) return test.skip()

    await streams.ensureGroup("test-group")
    
    // Add entry and read as consumer1
    await streams.addEntry({ workId: "work1" })
    await streams.readGroup("test-group", "consumer1", { count: 1, blockMs: 100 })
    
    // Wait a bit to make it idle
    await new Promise(resolve => setTimeout(resolve, 100))
    
    // Claim as consumer2
    const claimed = await streams.autoClaim("test-group", "consumer2", 0, 10)
    expect(claimed.length).toBeGreaterThanOrEqual(1)
    expect(claimed[0].values.workId).toBe("work1")
  })

  test("claim reclaims specific entries", async () => {
    if (!isRedisAvailable()) return test.skip()

    await streams.ensureGroup("test-group")
    
    const entryId = await streams.addEntry({ workId: "work1" })
    await streams.readGroup("test-group", "consumer1", { count: 1, blockMs: 100 })
    
    // Wait a bit
    await new Promise(resolve => setTimeout(resolve, 100))
    
    // Claim specific entry
    const claimed = await streams.claim("test-group", "consumer2", 0, [entryId])
    expect(claimed.length).toBe(1)
    expect(claimed[0].id).toBe(entryId)
  })
})

// ── Consumer Management Tests ─────────────────────────────────────────

describe("Consumer Management", () => {
  test("listConsumers returns all consumers in group", async () => {
    if (!isRedisAvailable()) return test.skip()

    await streams.ensureGroup("test-group")
    
    // Read as multiple consumers
    await streams.addEntry({ workId: "work1" })
    await streams.readGroup("test-group", "consumer1", { count: 1, blockMs: 100 })
    
    await streams.addEntry({ workId: "work2" })
    await streams.readGroup("test-group", "consumer2", { count: 1, blockMs: 100 })

    const consumers = await streams.listConsumers("test-group")
    expect(consumers.length).toBeGreaterThanOrEqual(2)
    expect(consumers.some(c => c.name === "consumer1")).toBe(true)
    expect(consumers.some(c => c.name === "consumer2")).toBe(true)
  })

  test("deleteConsumer removes consumer from group", async () => {
    if (!isRedisAvailable()) return test.skip()

    await streams.ensureGroup("test-group")
    
    await streams.addEntry({ workId: "work1" })
    await streams.readGroup("test-group", "consumer1", { count: 1, blockMs: 100 })

    await streams.deleteConsumer("test-group", "consumer1")

    const consumers = await streams.listConsumers("test-group")
    expect(consumers.some(c => c.name === "consumer1")).toBe(false)
  })
})

// ── Utility Tests ─────────────────────────────────────────────────────

describe("Utility Operations", () => {
  test("getLastEntryId returns last entry ID", async () => {
    if (!isRedisAvailable()) return test.skip()

    await streams.addEntry({ workId: "work1" })
    await streams.addEntry({ workId: "work2" })

    const lastId = await streams.getLastEntryId()
    expect(lastId).toBeDefined()
    expect(lastId?.length).toBeGreaterThan(0)
  })

  test("streamExists returns true for existing stream", async () => {
    if (!isRedisAvailable()) return test.skip()

    await streams.addEntry({ workId: "work1" })
    
    const exists = await streams.streamExists()
    expect(exists).toBe(true)
  })

  test("getStreamLength returns correct length", async () => {
    if (!isRedisAvailable()) return test.skip()

    await streams.addEntry({ workId: "work1" })
    await streams.addEntry({ workId: "work2" })
    await streams.addEntry({ workId: "work3" })

    const length = await streams.getStreamLength()
    expect(length).toBe(3)
  })

  test("readRange reads entries by ID range", async () => {
    if (!isRedisAvailable()) return test.skip()

    const entryId1 = await streams.addEntry({ workId: "work1" })
    const entryId2 = await streams.addEntry({ workId: "work2" })

    const entries = await streams.readRange(entryId1, entryId2)
    expect(entries.length).toBe(2)
    expect(entries[0].id).toBe(entryId1)
    expect(entries[1].id).toBe(entryId2)
  })
})
