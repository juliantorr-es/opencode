/**
 * Work Scheduler
 * 
 * Scheduler adapter that uses Valkey Sorted Sets for delayed retry and scheduling.
 * 
 * Doctrine:
 * - Sorted sets decide WHEN work becomes eligible
 * - Streams decide WHO owns eligible work
 * - PGlite records WHAT actually happened
 * 
 * The scheduler loop:
 * 1. Read due items from sorted set (ZRANGEBYSCORE)
 * 2. Promote them into the stream (XADD)
 * 3. Remove them from sorted set ONLY after successful stream append
 * 
 * This ensures:
 * - If remove happens before stream append, due work can be lost
 * - If append happens before remove and scheduler crashes, duplicate promotion
 *   is idempotently handled by durable work item identity
 */

import type { Redis } from "ioredis"
import { ValkeySortedSets, DEFAULT_DUE_SET_NAME } from "./sorted-set-primitives"
import { ValkeyStreams, DEFAULT_STREAM_NAME, DEFAULT_CONSUMER_GROUP } from "./stream-primitives"
import { Effect } from "effect"
import { WorkQueueDurableStoreService } from "./durable-store"

// ── Types ──────────────────────────────────────────────────────────────

/** Scheduling configuration */
export interface SchedulerConfig {
  /** Sorted set name for due-time wheel */
  dueSetName: string
  /** Stream name for work queue */
  streamName: string
  /** Consumer group name */
  consumerGroup: string
  /** Poll interval in ms */
  pollIntervalMs: number
  /** Batch size for promotion */
  batchSize: number
  /** Max retries before dead-letter */
  maxRetries: number
}

/** Default scheduler configuration */
export const DEFAULT_SCHEDULER_CONFIG: SchedulerConfig = {
  dueSetName: DEFAULT_DUE_SET_NAME,
  streamName: DEFAULT_STREAM_NAME,
  consumerGroup: DEFAULT_CONSUMER_GROUP,
  pollIntervalMs: 1000,
  batchSize: 10,
  maxRetries: 5,
}

/** Scheduled work item */
export interface ScheduledWork {
  /** Work ID (durable identity) */
  workId: string
  /** When this work should be processed (Unix timestamp in ms) */
  dueAt: number
  /** Retry count */
  retryCount: number
  /** Maximum retries */
  maxRetries: number
  /** Reason for scheduling */
  reason: string
  /** Priority (lower = higher priority) */
  priority: number
}

/** Scheduler metrics */
export interface SchedulerMetrics {
  /** Total promotions */
  promotions: number
  /** Duplicate promotions (idempotent handling) */
  duplicatePromotions: number
  /** Failed promotions */
  failedPromotions: number
  /** Due items found */
  dueItemsFound: number
  /** Last promotion timestamp */
  lastPromotionAt: number | null
}

// ── Scheduler ──────────────────────────────────────────────────────────

/**
 * Work Scheduler
 * 
 * Promotes due work from sorted sets into streams.
 * This is the bridge between "when work is eligible" and "who owns the work".
 */
export class WorkScheduler {
  private readonly redis: Redis
  private readonly sortedSets: ValkeySortedSets
  private readonly streams: ValkeyStreams
  private readonly config: SchedulerConfig
  private readonly store: WorkQueueDurableStoreService
  
  // Metrics
  private promotions: number = 0
  private duplicatePromotions: number = 0
  private failedPromotions: number = 0
  private dueItemsFound: number = 0
  private lastPromotionAt: number | null = null
  
  // Running state
  private running: boolean = false
  private timer: ReturnType<typeof setInterval> | null = null
  constructor(
    redis: Redis,
    store: WorkQueueDurableStoreService,
    config: Partial<SchedulerConfig> = {}
  ) {
    this.redis = redis
    this.store = store
    this.sortedSets = new ValkeySortedSets(redis)
    this.streams = new ValkeyStreams(redis, config.streamName ?? DEFAULT_SCHEDULER_CONFIG.streamName)
    this.config = { ...DEFAULT_SCHEDULER_CONFIG, ...config }
  }

  // ── Lifecycle ────────────────────────────────────────────────────────

  /**
   * Start the scheduler loop.
   */
  async start(): Promise<void> {
    if (this.running) return
    
    this.running = true
    
    // Ensure stream and group exist
    await this.streams.ensureGroup(this.config.consumerGroup)
    
    // Start polling
    this.timer = setInterval(
      () => this.promoteDueWork().catch(console.error),
      this.config.pollIntervalMs
    )
    
    // Initial promotion
    await this.promoteDueWork()
  }

  /**
   * Stop the scheduler loop.
   */
  async stop(): Promise<void> {
    if (!this.running) return
    
    this.running = false
    
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  // ── Scheduling ──────────────────────────────────────────────────────

  /**
   * Schedule work for delayed execution.
   * 
   * This writes the work to a sorted set with the due timestamp as score.
   * The scheduler will later promote it to the stream when due.
   * 
   * @param work - Work to schedule
   * @returns true if scheduled successfully
   */
  async schedule(work: ScheduledWork): Promise<boolean> {
    const result = await this.sortedSets.add(
      this.config.dueSetName,
      work.dueAt,
      JSON.stringify(work)
    )
    return result === 1
  }

  /**
   * Schedule work with a delay from now.
   * 
   * @param workId - Work ID
   * @param delayMs - Delay in milliseconds
   * @param options - Additional scheduling options
   * @returns true if scheduled successfully
   */
  async scheduleWithDelay(
    workId: string,
    delayMs: number,
    options: {
      retryCount?: number
      maxRetries?: number
      reason?: string
      priority?: number
    } = {}
  ): Promise<boolean> {
    const dueAt = Date.now() + delayMs
    const work: ScheduledWork = {
      workId,
      dueAt,
      retryCount: options.retryCount ?? 0,
      maxRetries: options.maxRetries ?? this.config.maxRetries,
      reason: options.reason ?? "retryable_failure",
      priority: options.priority ?? 0,
    }
    return this.schedule(work)
  }

  /**
   * Cancel scheduled work.
   * 
   * @param workId - Work ID to cancel
   * @returns true if work was found and removed
   */
  async cancel(workId: string): Promise<boolean> {
    // Find the work in the sorted set
    const entries = await this.sortedSets.getAll(this.config.dueSetName)
    
    for (const entry of entries) {
      try {
        const work = JSON.parse(entry.value) as ScheduledWork
        if (work.workId === workId) {
          const result = await this.sortedSets.remove(this.config.dueSetName, entry.value)
          return result === 1
        }
      } catch {
        // Skip malformed entries
      }
    }
    
    return false
  }

  // ── Promotion ───────────────────────────────────────────────────────

  /**
   * Promote due work from sorted set to stream.
   * 
   * This is the core scheduler operation. It:
   * 1. Reads due items from the sorted set
   * 2. Promotes them to the stream
   * 3. Removes them from the sorted set ONLY after successful promotion
   * 
   * This ensures idempotency: if promotion fails mid-way, the work
   * remains in the sorted set and will be retried on the next poll.
   */
  private async promoteDueWork(): Promise<void> {
    const now = Date.now()
    
    // Get due items (score <= now)
    const dueEntries = await this.sortedSets.getDue(this.config.dueSetName, now, this.config.batchSize)
    
    this.dueItemsFound += dueEntries.length
    
    if (dueEntries.length === 0) return
    
    // Track successfully promoted work IDs to avoid duplicates
    const promotedWorkIds = new Set<string>()
    const toRemove: string[] = []
    
    for (const entry of dueEntries) {
      try {
        const work = JSON.parse(entry.value) as ScheduledWork
        
        // Check if we've already promoted this work ID in this batch
        if (promotedWorkIds.has(work.workId)) {
          this.duplicatePromotions++
          continue
        }
        
        // Durable-first: write to PGlite before Valkey XADD
        await Effect.runPromise(
          this.store.markEnqueuePending(work.workId, this.config.streamName, this.config.consumerGroup)
        )
        // Promote to stream
        const streamEntryId = await this.streams.addEntry({
          workId: work.workId,
          workKind: "scheduled",
          schemaVersion: "v1",
          enqueueTimestamp: String(now),
          correlationId: `scheduled:${work.workId}`,
          retryCount: String(work.retryCount),
          maxRetries: String(work.maxRetries),
          reason: work.reason,
        })
        
        // Only mark for removal if promotion succeeded
        promotedWorkIds.add(work.workId)
        toRemove.push(entry.value)
        this.promotions++
        this.lastPromotionAt = now
        // Record stream entry ID in PGlite after successful XADD
        await Effect.runPromise(
          this.store.markEnqueued(work.workId, streamEntryId, this.config.streamName, this.config.consumerGroup)
        )
        
      } catch (error) {
        this.failedPromotions++
        console.error("Failed to promote work:", error)
      }
    }
    
    // Remove successfully promoted items from sorted set
    if (toRemove.length > 0) {
      await this.sortedSets.removeMany(this.config.dueSetName, toRemove)
    }
  }

  // ── Metrics ─────────────────────────────────────────────────────────

  /**
   * Get scheduler metrics.
   */
  getMetrics(): SchedulerMetrics {
    return {
      promotions: this.promotions,
      duplicatePromotions: this.duplicatePromotions,
      failedPromotions: this.failedPromotions,
      dueItemsFound: this.dueItemsFound,
      lastPromotionAt: this.lastPromotionAt,
    }
  }

  /**
   * Reset metrics.
   */
  resetMetrics(): void {
    this.promotions = 0
    this.duplicatePromotions = 0
    this.failedPromotions = 0
    this.dueItemsFound = 0
    this.lastPromotionAt = null
  }

  // ── Inspection ──────────────────────────────────────────────────────

  /**
   * Get all scheduled work.
   */
  async getScheduledWork(): Promise<ScheduledWork[]> {
    const entries = await this.sortedSets.getAll(this.config.dueSetName)
    
    const work: ScheduledWork[] = []
    for (const entry of entries) {
      try {
        work.push(JSON.parse(entry.value) as ScheduledWork)
      } catch {
        // Skip malformed entries
      }
    }
    
    return work.sort((a, b) => a.dueAt - b.dueAt)
  }

  /**
   * Get work scheduled for a specific work ID.
   */
  async getScheduledWorkById(workId: string): Promise<ScheduledWork | null> {
    const allWork = await this.getScheduledWork()
    return allWork.find(w => w.workId === workId) ?? null
  }

  /**
   * Get the next due time.
   */
  async getNextDueTime(): Promise<number | null> {
    return this.sortedSets.getNextDueTime(this.config.dueSetName)
  }

  /**
   * Get count of scheduled work.
   */
  async getScheduledCount(): Promise<number> {
    return this.sortedSets.count(this.config.dueSetName)
  }

  // ── Cleanup ─────────────────────────────────────────────────────────

  /**
   * Clear all scheduled work.
   */
  async clearAll(): Promise<void> {
    await this.sortedSets.clear(this.config.dueSetName)
  }
}

// ── Factory ─────────────────────────────────────────────────────────────

export function createWorkScheduler(
  redis: Redis,
  store: WorkQueueDurableStoreService
): WorkScheduler {
  return new WorkScheduler(redis, store)
}

/**
 * Create a WorkScheduler with custom configuration.
 */
export function createWorkSchedulerWith(
  redis: Redis,
  store: WorkQueueDurableStoreService,
  config: Partial<SchedulerConfig>
): WorkScheduler {
  return new WorkScheduler(redis, store, config)
}


