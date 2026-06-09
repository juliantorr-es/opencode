/**
 * Coordination Work Queue
 * 
 * HIGH-LEVEL API for stream-backed work coordination.
 * 
 * This is the governed work queue abstraction that enforces the critical invariant:
 * XACK must happen AFTER the authoritative PGlite write, NEVER before.
 * 
 * Doctrine:
 * - Valkey decides who is currently responsible for work
 * - PGlite records what actually happened
 * - Valkey may be wiped and rebuilt
 * - PGlite may NOT be treated as a cache
 * - No task is considered complete because Valkey says so
 * 
 * Runtime code should use this abstraction, NOT raw XREADGROUP/XACK calls.
 */

import { Effect, Schema, Context, Layer } from "effect"
import type { Redis } from "ioredis"
import { ValkeyStreams, DEFAULT_STREAM_NAME, DEFAULT_CONSUMER_GROUP, DEFAULT_PENDING_IDLE_MS } from "./stream-primitives"
import { DatabaseAdapter } from "@/storage/adapter"
import type { SessionID } from "@/session/schema"
import type { ProjectID } from "@/project/schema"
import { WorkQueueDurableStoreService } from "./durable-store"

// ── Configuration ────────────────────────────────────────────────────

/** Work queue configuration */
export interface WorkQueueConfig {
  /** Stream name for work entries */
  streamName: string
  /** Consumer group name */
  consumerGroup: string
  /** Consumer identity prefix */
  consumerPrefix: string
  /** Pending idle threshold in ms before reclaim */
  pendingIdleMs: number
  /** Read batch size */
  readBatchSize: number
  /** Read block duration in ms */
  readBlockMs: number
  /** Max attempts before dead-letter */
  maxAttempts: number
  /** Max reclaims before dead-letter */
  maxReclaims: number
}

/** Default configuration */
export const DEFAULT_CONFIG: WorkQueueConfig = {
  streamName: DEFAULT_STREAM_NAME,
  consumerGroup: DEFAULT_CONSUMER_GROUP,
  consumerPrefix: "worker",
  pendingIdleMs: DEFAULT_PENDING_IDLE_MS,
  readBatchSize: 10,
  readBlockMs: 5000,
  maxAttempts: 3,
  maxReclaims: 5,
}

// ── Types ────────────────────────────────────────────────────────────

/** Work item identity */
export interface WorkItemId {
  id: string
  sessionId: SessionID
  projectId: ProjectID
}

/** Work item envelope (content-light, references only) */
export interface WorkEnvelope {
  /** Schema version */
  schemaVersion: string
  /** Durable work item ID */
  workId: string
  /** Work kind (e.g., "tool_execution", "agent_task") */
  workKind: string
  /** Enqueue timestamp */
  enqueuedAt: number
  /** Correlation ID for tracing */
  correlationId: string
  /** Optional mission/session context */
  missionId?: string
  sessionId?: SessionID
  /** Routing metadata */
  routingTags?: string[]
  /** Attempt hint */
  attemptHint?: number
}

/** Work item with stream entry ID */
export interface QueuedWork extends WorkEnvelope {
  /** Stream entry ID */
  entryId: string
}

/** Work claim result */
export interface WorkClaim {
  /** Work envelope */
  envelope: WorkEnvelope
  /** Stream entry ID */
  entryId: string
  /** Consumer name */
  consumer: string
  /** Whether this was a reclaim */
  wasReclaimed: boolean
}

/** Terminal result kinds */
export type TerminalResultKind =
  | "completed"
  | "failed_terminal"
  | "cancelled"
  | "superseded"
  | "dead_lettered"

/** Retryable result */
export interface RetryableResult {
  kind: "failed_retryable"
  errorKind: string
  errorMessage: string
  retryAfterMs?: number
}

/** Terminal result */
export interface TerminalResult {
  kind: TerminalResultKind
  resultRef?: string
  errorKind?: string
  errorMessage?: string
}

/** Work result (either retryable or terminal) */
export type WorkResult = RetryableResult | TerminalResult

/** Completion receipt */
export interface CompletionReceipt {
  workId: string
  entryId: string
  result: WorkResult
  durableWrittenAt: number
  acknowledgedAt: number
}

// ── Service Definition ──────────────────────────────────────────────

/**
 * CoordinationWorkQueue provides the high-level API for stream-backed work.
 * 
 * CRITICAL: Every ack path requires either:
 * 1. A durable PGlite write FIRST, OR
 * 2. Verification of existing durable terminal fact FIRST
 * 
 * No naked ack(entryId) is available to ordinary runtime code.
 */
export class CoordinationWorkQueue extends Context.Service<CoordinationWorkQueue>()(
  "@tribunus/CoordinationWorkQueue"
) {
  constructor(
    private readonly streams: ValkeyStreams,
    private readonly redis: Redis,
    private readonly config: WorkQueueConfig,
    private readonly consumerId: string,
    private readonly store: WorkQueueDurableStoreService
  ) {
    super()
  }

  // ── Queue Management ────────────────────────────────────────────────

  /**
   * Ensure the stream and consumer group exist.
   * Idempotent - safe to call multiple times.
   */
  async ensureQueue(): Promise<void> {
    await this.streams.ensureGroup(this.config.consumerGroup, "$")
  }

  // ── Publishing ──────────────────────────────────────────────────────

  /**
   * Publish work to the queue.
   * 
   * Creates a stream entry with the work envelope.
   * The work envelope is content-light - it carries references, not raw data.
   * 
   * @param envelope - Work envelope with durable work ID and metadata
   * @returns The stream entry ID
   */
  async publish(envelope: WorkEnvelope): Promise<string> {
    // Convert envelope to stream values (flatten for Redis)
    const values: Record<string, string> = {
      schemaVersion: envelope.schemaVersion,
      workId: envelope.workId,
      workKind: envelope.workKind,
      enqueuedAt: envelope.enqueuedAt.toString(),
      correlationId: envelope.correlationId,
    }

    if (envelope.missionId) values.missionId = envelope.missionId
    if (envelope.sessionId) values.sessionId = envelope.sessionId
    if (envelope.routingTags) values.routingTags = JSON.stringify(envelope.routingTags)
    if (envelope.attemptHint !== undefined) values.attemptHint = envelope.attemptHint.toString()

    const entryId = await this.streams.addEntry(values)
    return entryId
  }

  // ── Consuming ──────────────────────────────────────────────────────

  /**
   * Read available work from the queue.
   * 
   * This blocks until work is available or the block timeout is reached.
   * Valkey assigns entries to this consumer and places them in the pending list.
   * 
   * @param options - Read options
   * @returns Array of claimed work items
   */
  async read(
    options: {
      count?: number
      blockMs?: number
    } = {}
  ): Promise<WorkClaim[]> {
    const { count = this.config.readBatchSize, blockMs = this.config.readBlockMs } = options

    const entries = await this.streams.readGroup(
      this.config.consumerGroup,
      this.consumerId,
      { count, blockMs, noAck: false }  // noAck: false means entries go to pending list
    )

    return entries.map(entry => ({
      envelope: this.parseEnvelope(entry.values),
      entryId: entry.id,
      consumer: this.consumerId,
      wasReclaimed: false,
    }))
  }

  /**
   * Parse stream values into a work envelope.
   */
  private parseEnvelope(values: Record<string, string>): WorkEnvelope {
    return {
      schemaVersion: values.schemaVersion,
      workId: values.workId,
      workKind: values.workKind,
      enqueuedAt: Number(values.enqueuedAt),
      correlationId: values.correlationId,
      missionId: values.missionId,
      sessionId: values.sessionId as SessionID | undefined,
      routingTags: values.routingTags ? JSON.parse(values.routingTags) : undefined,
      attemptHint: values.attemptHint ? Number(values.attemptHint) : undefined,
    }
  }

  // ── Authority-Aware Completion ──────────────────────────────────────

  /**
   * Record terminal success and acknowledge the stream entry.
   * 
   * CRITICAL: This writes to PGlite FIRST, then XACK.
   * If the PGlite write fails, XACK is NOT called.
   * If XACK fails after PGlite success, recovery will handle it.
   * 
   * @param workId - Durable work item ID
   * @param entryId - Stream entry ID to acknowledge
   * @param resultRef - Reference to durable result (not the result itself)
   * @returns Completion receipt
   */
  async completeAndAck(
    workId: string,
    entryId: string,
    resultRef: string
  ): Promise<CompletionReceipt> {
    const durableWrittenAt = Date.now()

    // Write terminal completion to PGlite BEFORE XACK
    await Effect.runPromise(
      this.store.completeTerminal(workId, resultRef)
    )

    // Only after durable write succeeds, acknowledge the stream entry
    await this.streams.ack(this.config.consumerGroup, [entryId])

    const acknowledgedAt = Date.now()

    return {
      workId,
      entryId,
      result: { kind: "completed", resultRef },
      durableWrittenAt,
      acknowledgedAt,
    }
  }

  /**
   * Record terminal failure and acknowledge the stream entry.
   * 
   * CRITICAL: This writes to PGlite FIRST, then XACK.
   * If the PGlite write fails, XACK is NOT called.
   * If XACK fails after PGlite success, recovery will handle it.
   * 
   * @param workId - Durable work item ID
   * @param entryId - Stream entry ID to acknowledge
   * @param errorKind - Classification of the error
   * @param errorMessage - Error message (should be classified, not raw)
   * @returns Completion receipt
   */
  async failTerminalAndAck(
    workId: string,
    entryId: string,
    errorKind: string,
    errorMessage: string
  ): Promise<CompletionReceipt> {
    const durableWrittenAt = Date.now()

    // Write terminal failure to PGlite BEFORE XACK
    await Effect.runPromise(
      this.store.failTerminal(workId, errorKind, errorMessage)
    )

    // Only after durable write succeeds, acknowledge the stream entry
    await this.streams.ack(this.config.consumerGroup, [entryId])

    const acknowledgedAt = Date.now()

    return {
      workId,
      entryId,
      result: { kind: "failed_terminal", errorKind, errorMessage },
      durableWrittenAt,
      acknowledgedAt,
    }
  }

  /**
   * Record retryable failure, acknowledge the current entry, and schedule retry.
   * 
   * CRITICAL: This writes to PGlite FIRST, then XACK.
   * If the PGlite write fails, XACK is NOT called.
   * If XACK fails after PGlite success, recovery will handle it.
   * The retry is scheduled separately (not in this method).
   * 
   * @param workId - Durable work item ID
   * @param entryId - Stream entry ID to acknowledge
   * @param errorKind - Classification of the error
   * @param errorMessage - Error message
   * @param retryAfterMs - When to retry (optional)
   * @returns Completion receipt
   */
  async failRetryableAndAck(
    workId: string,
    entryId: string,
    errorKind: string,
    errorMessage: string,
    retryAfterMs?: number
  ): Promise<CompletionReceipt> {
    const durableWrittenAt = Date.now()

    // Write retryable failure to PGlite BEFORE XACK
    await Effect.runPromise(
      this.store.failRetryableAndSchedule(
        workId,
        errorKind,
        errorMessage,
        retryAfterMs ?? 60000
      )
    )

    // Only after durable write succeeds, acknowledge the stream entry
    await this.streams.ack(this.config.consumerGroup, [entryId])

    const acknowledgedAt = Date.now()

    return {
      workId,
      entryId,
      result: { kind: "failed_retryable", errorKind, errorMessage, retryAfterMs },
      durableWrittenAt,
      acknowledgedAt,
    }
  }

  /**
   * Dead-letter work and acknowledge the stream entry.
   * 
   * CRITICAL: This writes to PGlite FIRST, then XACK.
   * If the PGlite write fails, XACK is NOT called.
   * If XACK fails after PGlite success, recovery will handle it.
   * Dead-lettering is a TERMINAL durable state.
   * 
   * @param workId - Durable work item ID
   * @param entryId - Stream entry ID to acknowledge
   * @param reason - Why the work was dead-lettered
   * @returns Completion receipt
   */
  async deadLetterAndAck(
    workId: string,
    entryId: string,
    reason: string
  ): Promise<CompletionReceipt> {
    const durableWrittenAt = Date.now()

    // Write durable dead-letter record to PGlite BEFORE XACK
    await Effect.runPromise(
      this.store.deadLetter({
        workId,
        workKind: "unknown",
        reason: "max_attempts_exceeded" as const,
        attemptCount: 0,
        reclaimCount: 0,
        streamName: this.config.streamName,
        streamEntryId: entryId,
        consumerGroup: this.config.consumerGroup,
        lastErrorKind: reason,
      })
    )

    // Only after durable write succeeds, acknowledge the stream entry
    await this.streams.ack(this.config.consumerGroup, [entryId])

    const acknowledgedAt = Date.now()

    return {
      workId,
      entryId,
      result: { kind: "dead_lettered" },
      durableWrittenAt,
      acknowledgedAt,
    }
  }

  // ── Lifecycle Integrity Verification ────────────────────────────────

  /**
   * Cross-check PGlite durable state against Valkey stream PEL state.
   *
   * This method walks every pending entry in the consumer group's PEL,
   * reads the stream entry data to identify the work item, then checks
   * PGlite for the authoritative state.  Anomalies are reported:
   *
   *   terminal_not_acked  — PGlite has a terminal fact but the stream
   *                         entry is still in the PEL (cleanup skipped)
   *   no_durable_record   — the stream entry references a workId that
   *                         does not exist in PGlite (orphan)
   *   unknown_workId      — the stream entry has no workId field
   *
   * INVARIANT: Every entry in the PEL MUST correspond to a PGlite work
   * item in a non-terminal state.  If PGlite says terminal, the entry
   * should have been XACK'd.
   *
   * @param limit - Max entries to inspect (default 100, 0 = no limit)
   * @returns Integrity report with count and anomalies
   */
  async verifyLifecycleIntegrity(
    limit: number = 100
  ): Promise<{
    pendingCount: number
    inspectedCount: number
    anomalies: Array<{
      type: "terminal_not_acked" | "no_durable_record" | "unknown_workId"
      entryId: string
      workId: string | null
      consumer: string
      idleMs: number
      detail: string
    }>
    verified: boolean
  }> {
    const pending = await this.streams.getPendingEntries(this.config.consumerGroup, { count: limit || undefined })
    const anomalies: Array<{
      type: "terminal_not_acked" | "no_durable_record" | "unknown_workId"
      entryId: string
      workId: string | null
      consumer: string
      idleMs: number
      detail: string
    }> = []

    for (const entry of pending) {
      // Read stream entry data to extract workId
      const streamEntries = await this.streams.readRange(entry.id, entry.id, 1)
      if (streamEntries.length === 0) continue

      const values = streamEntries[0].values
      const workId: string | undefined = values.workId

      if (!workId) {
        anomalies.push({
          type: "unknown_workId",
          entryId: entry.id,
          workId: null,
          consumer: entry.consumer,
          idleMs: entry.idleMs,
          detail: "Stream entry has no workId field; cannot cross-reference with PGlite",
        })
        continue
      }

      const isTerminal = await Effect.runPromise(
        this.store.isWorkTerminal(workId)
      )

      if (isTerminal) {
        anomalies.push({
          type: "terminal_not_acked",
          entryId: entry.id,
          workId,
          consumer: entry.consumer,
          idleMs: entry.idleMs,
          detail: `PGlite reports terminal state for ${workId}, but stream entry ${entry.id} is still in the PEL`,
        })
        continue
      }

      // Check if the work item exists at all
      const workItem = await Effect.runPromise(
        this.store.getWorkItem(workId)
      )

      if (!workItem) {
        anomalies.push({
          type: "no_durable_record",
          entryId: entry.id,
          workId,
          consumer: entry.consumer,
          idleMs: entry.idleMs,
          detail: `Stream entry ${entry.id} references workId ${workId}, but no PGlite record exists`,
        })
      }
    }

    return {
      pendingCount: pending.length,
      inspectedCount: pending.length,
      anomalies,
      verified: anomalies.length === 0,
    }
  }

  // ── Pending Inspection ─────────────────────────────────────────────

  /**
   * Get summary of pending entries for this consumer group.
   */
  async getPendingSummary(): Promise<{
    count: number
    minIdleMs: number | null
    maxIdleMs: number | null
    consumers: Record<string, number>
  }> {
    return this.streams.getPendingSummary(this.config.consumerGroup)
  }

  /**
   * Get pending entries for this consumer.
   */
  async getConsumerPending(): Promise<{ id: string; idleMs: number; deliveryCount: number }[]> {
    const pending = await this.streams.getConsumerPending(
      this.config.consumerGroup,
      this.consumerId
    )
    return pending.map(p => ({ id: p.id, idleMs: p.idleMs, deliveryCount: p.deliveryCount }))
  }

  // ── Reclaim ─────────────────────────────────────────────────────────

  /**
   * Reclaim expired pending entries.
   * 
   * This claims entries that have been idle longer than the threshold.
   * After claiming, the new worker MUST check PGlite before executing.
   * If the work item is already terminal, the worker should ack and record reconciliation.
   * 
   * @param count - Max entries to reclaim
   * @returns Array of reclaimed work claims
   */
  async reclaimExpired(count: number = 10): Promise<WorkClaim[]> {
    const claimed = await this.streams.autoClaim(
      this.config.consumerGroup,
      this.consumerId,
      this.config.pendingIdleMs,
      count
    )

    return claimed.map(c => ({
      envelope: this.parseEnvelope(c.values),
      entryId: c.id,
      consumer: this.consumerId,
      wasReclaimed: true,
    }))
  }

  // ── Recovery ────────────────────────────────────────────────────────

  /**
   * Reconcile a pending entry against PGlite.
   * 
   * This is called during recovery to handle entries that were delivered
   * but never acknowledged. It checks PGlite for the durable state and:
   * - If terminal: safely ack the entry (no re-execution)
   * - If non-terminal: leave it pending for reclaim
   * 
   * @param entryId - Stream entry ID to reconcile
   * @returns Whether the entry was acknowledged
   */
  async reconcilePending(workId: string, entryId: string): Promise<boolean> {
    // Check PGlite for durable state before deciding
    const isTerminal = await Effect.runPromise(
      this.store.isWorkTerminal(workId)
    )

    if (isTerminal) {
      // Terminal state exists in PGlite — safe to ack
      await this.streams.ack(this.config.consumerGroup, [entryId])
      // Record reconciliation receipt
      await Effect.runPromise(
        this.store.recordRecoveryReceipt({
          workId,
          streamEntryId: entryId,
          action: "acknowledged_terminal",
          recoveredByConsumer: this.consumerId,
          recoveredAt: Date.now(),
          outcome: "acknowledged",
          streamName: this.config.streamName,
          consumerGroup: this.config.consumerGroup,
          wasPending: true,
          wasTerminal: true,
        })
      )
      return true
    }

    // Check if work exists but is non-terminal (retryable or in-progress)
    const workItem = await Effect.runPromise(
      this.store.getWorkItem(workId)
    )

    if (workItem) {
      // Work exists but is not terminal — leave pending, do not ack
      return false
    }

    // No durable work record — quarantine the stream entry
    await Effect.runPromise(
      this.store.quarantineStreamEntry({
        entryId,
        streamName: this.config.streamName,
        workId,
        reason: "no_durable_work_record",
        createdAt: Date.now(),
      })
    )
    await this.streams.ack(this.config.consumerGroup, [entryId])
    return true
  }

  // ── Consumer Identity ──────────────────────────────────────────────

  /**
   * Get the current consumer identity.
   */
  getConsumerId(): string {
    return this.consumerId
  }

  /**
   * Generate a unique consumer ID.
   */
  static generateConsumerId(prefix: string): string {
    return `${prefix}:${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`
  }
}

// ── Layer ─────────────────────────────────────────────────────────────

/**
 * Create a CoordinationWorkQueue layer.
 * 
 * This layer provides the high-level work queue abstraction backed by
 * Valkey Streams with PGlite authority.
 */
export const workQueueLayer = Layer.effect(
  CoordinationWorkQueue,
  Effect.gen(function* () {
    const redis = yield* getValkeyRedis()
    const store = yield* WorkQueueDurableStoreService
    const streams = new ValkeyStreams(redis, DEFAULT_CONFIG.streamName)
    const consumerId = CoordinationWorkQueue.generateConsumerId(DEFAULT_CONFIG.consumerPrefix)
    
    // Ensure the queue exists
    yield* Effect.promise(() => streams.ensureGroup(DEFAULT_CONFIG.consumerGroup, "$"))
    
    return new CoordinationWorkQueue(streams, redis, DEFAULT_CONFIG, consumerId, store)
  })
)

// ── Helper to get Valkey Redis ────────────────────────────────────────

/**
 * Get the Valkey Redis client.
 * This is a placeholder - in production, this would come from the coordination fabric.
 */
function getValkeyRedis(): Effect.Effect<Redis> {
  // TODO: Wire this up to the actual Valkey fabric
  // For now, we return a dummy that will fail at runtime
  // This is just to make the types work
  return Effect.die(new Error("Valkey Redis not configured - implement getValkeyRedis()"))
}


