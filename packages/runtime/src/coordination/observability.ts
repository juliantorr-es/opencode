/**
 * Coordination Observability
 * 
 * Observability utilities for the Valkey Stream-Backed Coordination Kernel.
 * 
 * This module provides metrics, inspection, and debugging capabilities for
 * the coordination kernel without exposing raw Valkey commands to runtime code.
 */

import type { Redis } from "ioredis"
import { Effect } from "effect"
import { DatabaseAdapter } from "@/storage/adapter"
import { ValkeyStreams } from "./stream-primitives"
import { ValkeySortedSets } from "./sorted-set-primitives"
import { DEFAULT_STREAM_NAME, DEFAULT_CONSUMER_GROUP } from "./stream-primitives"
import { DEFAULT_DUE_SET_NAME } from "./sorted-set-primitives"
import {
  WorkItemTable,
  WorkAttemptTable,
  RecoveryReceiptTable,
} from "./work-queue.pg.sql"

// ── Types ──────────────────────────────────────────────────────────────

/** Stream metrics */
export interface StreamMetrics {
  /** Stream name */
  streamName: string
  /** Consumer group name */
  consumerGroup: string
  /** Total entries in stream */
  totalEntries: number
  /** Number of consumers in group */
  consumerCount: number
  /** Number of pending entries */
  pendingCount: number
  /** Oldest pending entry age in ms (null if no pending) */
  oldestPendingAgeMs: number | null
  /** Newest entry ID */
  newestEntryId: string | null
  /** Oldest entry ID */
  oldestEntryId: string | null
}

/** Sorted set metrics */
export interface SortedSetMetrics {
  /** Sorted set name */
  setName: string
  /** Number of items in set */
  count: number
  /** Next due time in ms (null if empty) */
  nextDueTimeMs: number | null
  /** Oldest due time in ms (null if empty) */
  oldestDueTimeMs: number | null
}

/** Work queue metrics */
export interface WorkQueueMetrics {
  /** Stream metrics */
  stream: StreamMetrics
  /** Sorted set metrics for due work */
  dueSet: SortedSetMetrics
  /** Total work enqueued */
  enqueuedCount: number
  /** Total work completed */
  completedCount: number
  /** Total work failed retryable */
  failedRetryableCount: number
  /** Total work failed terminal */
  failedTerminalCount: number
  /** Total work dead-lettered */
  deadLetteredCount: number
  /** Total acks */
  ackCount: number
  /** Total reclaims */
  reclaimCount: number
  /** Total scheduler promotions */
  schedulerPromotions: number
  /** Last recovery timestamp */
  lastRecoveryAt: number | null
  /** Last rebuild timestamp */
  lastRebuildAt: number | null
}

/** Pending entry info */
export interface PendingEntryInfo {
  /** Stream entry ID */
  entryId: string
  /** Work ID */
  workId: string
  /** Consumer name */
  consumer: string
  /** Idle time in ms */
  idleMs: number
  /** Delivery count */
  deliveryCount: number
}

/** Work item inspection */
export interface WorkItemInspection {
  /** Work ID */
  workId: string
  /** Current durable status */
  durableStatus: string
  /** Current stream entry ID (if any) */
  streamEntryId: string | null
  /** Current pending owner (if any) */
  pendingOwner: string | null
  /** Attempt count */
  attemptCount: number
  /** Reclaim count */
  reclaimCount: number
  /** Retry schedule (if scheduled) */
  retryScheduleAt: number | null
  /** Terminal receipt (if complete) */
  terminalReceipt: string | null
  /** Created at */
  createdAt: number
  /** Last updated at */
  updatedAt: number
  /** Last error message (from most recent attempt or error_classification) */
  lastError?: string
  /** Most recent durable recovery receipt ID */
  durableReceipt?: string
}

/** Divergence report — cross-reference between PGlite and Valkey state */
export interface DivergenceReport {
  /** Work IDs in Valkey PEL but not in PGlite (durability gap) */
  lost_durability: string[]
  /** Work IDs in PGlite non-terminal but absent from Valkey PEL */
  orphaned_work: string[]
  /** Count of non-terminal work items in PGlite */
  pglite_count: number
  /** Count of pending entries in Valkey PEL */
  valkey_pel_count: number
  /** Timestamp of detection */
  detectedAt: number
}

/** Structured observability report */
export interface ObservabilityReport {
  /** Work queue metrics */
  metrics: WorkQueueMetrics
  /** Health check results */
  health: {
    healthy: boolean
    streamHealthy: boolean
    groupHealthy: boolean
    redisHealthy: boolean
    errors: string[]
  }
  /** Divergence between PGlite and Valkey (null if detection failed or unavailable) */
  divergence: DivergenceReport | null
  /** Current pending entries snapshot */
  pendingEntries: PendingEntryInfo[]
  /** Timestamp of report generation */
  generatedAt: number
}

/** Observability configuration */
export interface ObservabilityConfig {
  streamName: string
  consumerGroup: string
  dueSetName: string
}

/** Default observability configuration */
export const DEFAULT_OBSERVABILITY_CONFIG: ObservabilityConfig = {
  streamName: DEFAULT_STREAM_NAME,
  consumerGroup: DEFAULT_CONSUMER_GROUP,
  dueSetName: DEFAULT_DUE_SET_NAME,
}

// ── Observability Service ─────────────────────────────────────────────

/**
 * CoordinationObservability provides metrics and inspection for the coordination kernel.
 */
export class CoordinationObservability {
  private readonly redis: Redis
  private readonly config: ObservabilityConfig
  private readonly adapter?: DatabaseAdapter.Interface
  
  // Counters (reset on restart, but useful for debugging)
  private enqueuedCount: number = 0
  private completedCount: number = 0
  private failedRetryableCount: number = 0
  private failedTerminalCount: number = 0
  private deadLetteredCount: number = 0
  private ackCount: number = 0
  private reclaimCount: number = 0
  private schedulerPromotions: number = 0
  private lastRecoveryAt: number | null = null
  private lastRebuildAt: number | null = null

  constructor(
    redis: Redis,
    config: Partial<ObservabilityConfig> = {},
    adapter?: DatabaseAdapter.Interface
  ) {
    this.redis = redis
    this.config = { ...DEFAULT_OBSERVABILITY_CONFIG, ...config }
    this.adapter = adapter
  }

  // ── Stream Metrics ───────────────────────────────────────────────────

  /**
   * Get stream metrics.
   */
  async getStreamMetrics(): Promise<StreamMetrics> {
    const streams = new ValkeyStreams(this.redis, this.config.streamName)
    
    const [streamInfo, groupInfo, pending] = await Promise.all([
      streams.getStreamInfo(),
      streams.getGroupInfo(this.config.consumerGroup),
      streams.getPendingEntries(this.config.consumerGroup),
    ])
    
    const now = Date.now()
    
    // Calculate oldest pending age
    let oldestPendingAgeMs: number | null = null
    if (pending.length > 0) {
      const oldestPending = pending.reduce((oldest, entry) => 
        entry.idleMs > oldest.idleMs ? entry : oldest
      )
      oldestPendingAgeMs = oldestPending.idleMs
    }
    
    return {
      streamName: this.config.streamName,
      consumerGroup: this.config.consumerGroup,
      totalEntries: streamInfo?.length ?? 0,
      consumerCount: groupInfo?.consumerCount ?? 0,
      pendingCount: pending.length,
      oldestPendingAgeMs,
      newestEntryId: streamInfo?.newestEntryId ?? null,
      oldestEntryId: streamInfo?.oldestEntryId ?? null,
    }
  }

  // ── Sorted Set Metrics ──────────────────────────────────────────────

  /**
   * Get sorted set metrics.
   */
  async getSortedSetMetrics(): Promise<SortedSetMetrics> {
    const sortedSets = new ValkeySortedSets(this.redis)
    
    const [count, entries] = await Promise.all([
      sortedSets.count(this.config.dueSetName),
      sortedSets.getAll(this.config.dueSetName),
    ])
    
    let nextDueTimeMs: number | null = null
    let oldestDueTimeMs: number | null = null
    
    if (entries.length > 0) {
      // Sorted by score (timestamp), so first is next due
      nextDueTimeMs = entries[0].score
      oldestDueTimeMs = entries[entries.length - 1].score
    }
    
    return {
      setName: this.config.dueSetName,
      count,
      nextDueTimeMs,
      oldestDueTimeMs,
    }
  }

  // ── Work Queue Metrics ─────────────────────────────────────────────

  /**
   * Get comprehensive work queue metrics.
   */
  async getMetrics(): Promise<WorkQueueMetrics> {
    const [stream, dueSet] = await Promise.all([
      this.getStreamMetrics(),
      this.getSortedSetMetrics(),
    ])
    
    return {
      stream,
      dueSet,
      enqueuedCount: this.enqueuedCount,
      completedCount: this.completedCount,
      failedRetryableCount: this.failedRetryableCount,
      failedTerminalCount: this.failedTerminalCount,
      deadLetteredCount: this.deadLetteredCount,
      ackCount: this.ackCount,
      reclaimCount: this.reclaimCount,
      schedulerPromotions: this.schedulerPromotions,
      lastRecoveryAt: this.lastRecoveryAt,
      lastRebuildAt: this.lastRebuildAt,
    }
  }

  // ── Pending Inspection ─────────────────────────────────────────────

  /**
   * Get all pending entries.
   */
  async getPendingEntries(): Promise<PendingEntryInfo[]> {
    const streams = new ValkeyStreams(this.redis, this.config.streamName)
    const pending = await streams.getPendingEntries(this.config.consumerGroup)
    
    return pending.map(entry => ({
      entryId: entry.id,
      workId: this.parseWorkIdFromEntry(entry),
      consumer: entry.consumer,
      idleMs: entry.idleMs,
      deliveryCount: entry.deliveryCount,
    }))
  }

  /**
   * Get pending entries for a specific consumer.
   */
  async getPendingEntriesForConsumer(consumer: string): Promise<PendingEntryInfo[]> {
    const allPending = await this.getPendingEntries()
    return allPending.filter(entry => entry.consumer === consumer)
  }

  /**
   * Get stale pending entries (idle longer than threshold).
   */
  async getStalePendingEntries(idleThresholdMs: number): Promise<PendingEntryInfo[]> {
    const allPending = await this.getPendingEntries()
    return allPending.filter(entry => entry.idleMs >= idleThresholdMs)
  }

  // ── Work Item Inspection ────────────────────────────────────────────

  /**
   * Inspect a specific work item.
   */
  async inspectWorkItem(workId: string): Promise<WorkItemInspection | null> {
    if (this.adapter) {
      try {
        return await Effect.runPromise(
          this.adapter.query(async (db: any) => {
            const [workItem] = await db
              .select()
              .from(WorkItemTable)
              .where(db.eq(WorkItemTable.id, workId))
              .execute()

            if (!workItem) return null

            // Get latest attempt for error information
            const [latestAttempt] = await db
              .select({ error_message: WorkAttemptTable.error_message })
              .from(WorkAttemptTable)
              .where(db.eq(WorkAttemptTable.work_id, workId))
              .orderBy(db.desc(WorkAttemptTable.attempt_number))
              .limit(1)
              .execute()

            // Get latest recovery receipt for durable receipt
            const [latestReceipt] = await db
              .select({ id: RecoveryReceiptTable.id })
              .from(RecoveryReceiptTable)
              .where(db.eq(RecoveryReceiptTable.work_id, workId))
              .orderBy(db.desc(RecoveryReceiptTable.recovered_at))
              .limit(1)
              .execute()

            return {
              workId: workItem.id,
              durableStatus: workItem.status,
              streamEntryId: workItem.stream_entry_id ?? null,
              pendingOwner: workItem.consumer_id ?? null,
              attemptCount: workItem.attempt_count,
              reclaimCount: workItem.reclaim_count,
              retryScheduleAt: null,
              terminalReceipt: workItem.result_ref ?? null,
              createdAt: workItem.created_at,
              updatedAt: workItem.time_updated,
              lastError: latestAttempt?.error_message ?? workItem.error_classification ?? undefined,
              durableReceipt: latestReceipt?.id ?? undefined,
            }
          })
        )
      } catch {
        // Fall through to placeholder on error
      }
    }

    // Fallback when no adapter or query fails
    return {
      workId,
      durableStatus: "unknown",
      streamEntryId: null,
      pendingOwner: null,
      attemptCount: 0,
      reclaimCount: 0,
      retryScheduleAt: null,
      terminalReceipt: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
  }

  /**
   * Inspect work item by stream entry ID.
   */
  async inspectByEntryId(entryId: string): Promise<WorkItemInspection | null> {
    const streams = new ValkeyStreams(this.redis, this.config.streamName)
    
    // Get the entry details
    const entries = await streams.readEntries(entryId, 1)
    if (entries.length === 0) return null
    
    const entry = entries[0]
    const workId = this.parseWorkIdFromEntryData(entry)
    
    return this.inspectWorkItem(workId)
  }

  // ── Counter Management ─────────────────────────────────────────────

  /**
   * Increment enqueued counter.
   */
  incrementEnqueued(): void {
    this.enqueuedCount++
  }

  /**
   * Increment completed counter.
   */
  incrementCompleted(): void {
    this.completedCount++
  }

  /**
   * Increment failed retryable counter.
   */
  incrementFailedRetryable(): void {
    this.failedRetryableCount++
  }

  /**
   * Increment failed terminal counter.
   */
  incrementFailedTerminal(): void {
    this.failedTerminalCount++
  }

  /**
   * Increment dead-lettered counter.
   */
  incrementDeadLettered(): void {
    this.deadLetteredCount++
  }

  /**
   * Increment ack counter.
   */
  incrementAck(): void {
    this.ackCount++
  }

  /**
   * Increment reclaim counter.
   */
  incrementReclaim(): void {
    this.reclaimCount++
  }

  /**
   * Increment scheduler promotions counter.
   */
  incrementSchedulerPromotions(): void {
    this.schedulerPromotions++
  }

  /**
   * Record recovery timestamp.
   */
  recordRecovery(): void {
    this.lastRecoveryAt = Date.now()
  }

  /**
   * Record rebuild timestamp.
   */
  recordRebuild(): void {
    this.lastRebuildAt = Date.now()
  }

  /**
   * Reset all counters.
   */
  resetCounters(): void {
    this.enqueuedCount = 0
    this.completedCount = 0
    this.failedRetryableCount = 0
    this.failedTerminalCount = 0
    this.deadLetteredCount = 0
    this.ackCount = 0
    this.reclaimCount = 0
    this.schedulerPromotions = 0
    this.lastRecoveryAt = null
    this.lastRebuildAt = null
  }

  // ── Helper Methods ──────────────────────────────────────────────────

  /**
   * Parse work ID from pending entry.
   */
  private parseWorkIdFromEntry(entry: any): string {
    // In real implementation, this would parse the work ID from the entry values
    // For now, use the entry ID as a fallback
    return entry.id
  }

  /**
   * Parse work ID from entry data.
   */
  private parseWorkIdFromEntryData(entry: any): string {
    // In real implementation, this would parse the work ID from entry values
    return entry.id
  }

  // ── Health Checks ───────────────────────────────────────────────────

  /**
   * Check if coordination kernel is healthy.
   */
  async healthCheck(): Promise<{
    healthy: boolean
    streamHealthy: boolean
    groupHealthy: boolean
    redisHealthy: boolean
    errors: string[]
  }> {
    const errors: string[] = []
    let streamHealthy = true
    let groupHealthy = true
    let redisHealthy = true
    
    try {
      // Check Redis connection
      await this.redis.ping()
    } catch (error) {
      redisHealthy = false
      errors.push(`Redis connection failed: ${error}`)
    }
    
    if (redisHealthy) {
      const streams = new ValkeyStreams(this.redis, this.config.streamName)
      
      try {
        const streamExists = await streams.streamExists()
        if (!streamExists) {
          streamHealthy = false
          errors.push(`Stream ${this.config.streamName} does not exist`)
        }
      } catch (error) {
        streamHealthy = false
        errors.push(`Stream check failed: ${error}`)
      }
      
      try {
        const groupInfo = await streams.getGroupInfo(this.config.consumerGroup)
        if (!groupInfo) {
          groupHealthy = false
          errors.push(`Consumer group ${this.config.consumerGroup} does not exist`)
        }
      } catch (error) {
        groupHealthy = false
        errors.push(`Consumer group check failed: ${error}`)
      }
    }
    
    const healthy = redisHealthy && streamHealthy && groupHealthy
    
    return {
      healthy,
      streamHealthy,
      groupHealthy,
      redisHealthy,
      errors,
    }
  }


  // ── Divergence Detection ──────────────────────────────────────────

  /**
   * Detect divergence between PGlite durable state and Valkey PEL.
   *
   * Cross-references non-terminal work items in PGlite against pending
   * entries in the Valkey consumer group PEL to find:
   * - lost_durability: entries in the PEL whose work no longer exists in PGlite
   * - orphaned_work: non-terminal work in PGlite that has no corresponding PEL entry
   *
   * Requires the DatabaseAdapter to be configured.
   */
  async detectDivergence(): Promise<DivergenceReport> {
    const detectedAt = Date.now()
    const streams = new ValkeyStreams(this.redis, this.config.streamName)

    // 1. Query PGlite for non-terminal work IDs
    const pgliteWorkIds = await this.queryPGliteNonTerminalWorkIds()

    // 2. Query Valkey PEL for pending entries
    let pelEntryIds: string[] = []
    let pelEntries: { entryId: string; workId: string }[] = []
    try {
      const pending = await streams.getPendingEntries(this.config.consumerGroup)
      pelEntryIds = pending.map(e => e.id)

      // Read entry values from Valkey to extract work IDs
      if (pending.length > 0) {
        const entryIds = pending.map(e => e.id)
        // Read entries in batches to avoid oversized commands
        const batchSize = 50
        for (let i = 0; i < entryIds.length; i += batchSize) {
          const batch = entryIds.slice(i, i + batchSize)
          const entries = await streams.readRange(batch[0], batch[batch.length - 1])
          for (const entry of entries) {
            if (entry.values?.workId) {
              pelEntries.push({ entryId: entry.id, workId: entry.values.workId })
            }
          }
        }
      }
    } catch {
      // Valkey unavailable — return empty report with counts
      return {
        lost_durability: [],
        orphaned_work: [],
        pglite_count: pgliteWorkIds.length,
        valkey_pel_count: 0,
        detectedAt,
      }
    }

    // 3. Build lookup sets
    const pgliteSet = new Set(pgliteWorkIds)
    const pelWorkIdSet = new Set(pelEntries.map(e => e.workId))

    // 4. Cross-reference
    const lost_durability = pelEntries
      .filter(e => !pgliteSet.has(e.workId))
      .map(e => e.workId)

    const orphaned_work = pgliteWorkIds.filter(id => !pelWorkIdSet.has(id))

    // Deduplicate
    return {
      lost_durability: [...new Set(lost_durability)],
      orphaned_work: [...new Set(orphaned_work)],
      pglite_count: pgliteWorkIds.length,
      valkey_pel_count: pelEntryIds.length,
      detectedAt,
    }
  }

  /**
   * Query PGlite for non-terminal work item IDs via the adapter.
   */
  private async queryPGliteNonTerminalWorkIds(): Promise<string[]> {
    if (!this.adapter) return []

    try {
      return await Effect.runPromise(
        this.adapter.query(async (db: any) => {
          const rows = await db
            .select({ id: WorkItemTable.id })
            .from(WorkItemTable)
            .where(
              db.in(WorkItemTable.status, [
                "created",
                "enqueue_pending",
                "enqueued",
                "claimed",
                "running",
                "recovered",
                "retry_scheduled",
                "failed_retryable",
              ])
            )
            .execute()
          return rows.map((r: any) => r.id)
        })
      )
    } catch {
      return []
    }
  }

  // ── Observability Report ───────────────────────────────────────────

  /**
   * Generate a structured observability report.
   *
   * Combines metrics, health, divergence detection, and pending entries
   * into a single JSON-serializable report.
   */
  async generateObservabilityReport(): Promise<ObservabilityReport> {
    const [metrics, health, divergence, pendingEntries] = await Promise.all([
      this.getMetrics(),
      this.healthCheck(),
      this.detectDivergence().catch(() => null),
      this.getPendingEntries().catch(() => [] as PendingEntryInfo[]),
    ])

    return {
      metrics,
      health,
      divergence,
      pendingEntries,
      generatedAt: Date.now(),
    }
  }

  // ── Summary ─────────────────────────────────────────────────────────

  /**
   * Get a human-readable summary of coordination state.
   */
  async getSummary(): Promise<string> {
    const metrics = await this.getMetrics()
    const health = await this.healthCheck()
    
    const lines = [
      `=== Coordination Kernel Summary ===`,
      ``,
      `Health: ${health.healthy ? "✓ Healthy" : "✗ Unhealthy"}`,
      ...health.errors.map(e => `  Error: ${e}`),
      ``,
      `Stream: ${metrics.stream.streamName}`,
      `  Total Entries: ${metrics.stream.totalEntries}`,
      `  Consumers: ${metrics.stream.consumerCount}`,
      `  Pending: ${metrics.stream.pendingCount}`,
      `  Oldest Pending Age: ${metrics.stream.oldestPendingAgeMs ?? "N/A"}ms`,
      ``,
      `Due Set: ${metrics.dueSet.setName}`,
      `  Scheduled Items: ${metrics.dueSet.count}`,
      `  Next Due: ${metrics.dueSet.nextDueTimeMs ? new Date(metrics.dueSet.nextDueTimeMs).toISOString() : "N/A"}`,
      ``,
      `Counters:`,
      `  Enqueued: ${metrics.enqueuedCount}`,
      `  Completed: ${metrics.completedCount}`,
      `  Failed (Retryable): ${metrics.failedRetryableCount}`,
      `  Failed (Terminal): ${metrics.failedTerminalCount}`,
      `  Dead-Lettered: ${metrics.deadLetteredCount}`,
      `  ACKs: ${metrics.ackCount}`,
      `  Reclaims: ${metrics.reclaimCount}`,
      `  Scheduler Promotions: ${metrics.schedulerPromotions}`,
      ``,
      `Recovery:`,
      `  Last Recovery: ${metrics.lastRecoveryAt ? new Date(metrics.lastRecoveryAt).toISOString() : "Never"}`,
      `  Last Rebuild: ${metrics.lastRebuildAt ? new Date(metrics.lastRebuildAt).toISOString() : "Never"}`,
    ]
    
    return lines.join("\n")
  }
}

// ── Factory ─────────────────────────────────────────────────────────────

/**
 * Create a CoordinationObservability instance.
 */
export function createObservability(
  redis: Redis,
  adapter?: DatabaseAdapter.Interface
): CoordinationObservability {
  return new CoordinationObservability(redis, {}, adapter)
}

/**
 * Create a CoordinationObservability instance with custom configuration.
 */
export function createObservabilityWith(
  redis: Redis,
  config: Partial<ObservabilityConfig>,
  adapter?: DatabaseAdapter.Interface
): CoordinationObservability {
  return new CoordinationObservability(redis, config, adapter)
}

