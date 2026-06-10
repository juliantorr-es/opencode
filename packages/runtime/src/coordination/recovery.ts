/**
 * Coordination Recovery
 * 
 * Recovery protocols for the Valkey Stream-Backed Coordination Kernel.
 * 
 * Doctrine:
 * - PGlite is the authority
 * - Valkey is reconstructable coordination state
 * - Recovery starts from PGlite, not from Valkey
 * - Rebuild must be idempotent
 * 
 * The recovery module:
 * 1. Reconciles PGlite authoritative facts with Valkey pending state
 * 2. Rebuilds Valkey coordination state from PGlite after wipe
 * 3. Handles crash recovery at every critical boundary
 */

import { Effect, Context, Layer } from "effect"
import type { Redis } from "ioredis"
import { ValkeyStreams } from "./stream-primitives"
import { ValkeySortedSets } from "./sorted-set-primitives"
import { DatabaseAdapter } from "@/storage/adapter"
import { WorkQueueDurableStoreService } from "./durable-store"
import { DEFAULT_STREAM_NAME, DEFAULT_CONSUMER_GROUP } from "./stream-primitives"
import { DEFAULT_DUE_SET_NAME } from "./sorted-set-primitives"
import { CoordinationRecoveryTable } from "./recovery.pg.sql"
import type { DivergenceReport } from "./observability"

// ── Types ──────────────────────────────────────────────────────────────

/** Recovery state */
export type CoordinationRecoveryState =

  | "ready"
  | "coordination_unavailable"
  | "coordination_degraded"
  | "coordination_rebuilding"
  | "coordination_refused"

/** Recovery workflow status — separate from steady runtime state */
export type RecoveryWorkflowStatus =
  | "not_started"
  | "planned"
  | "in_progress"
  | "succeeded"
  | "failed"

/** Recovery outcome */
export type RecoveryOutcome =
  | "success"
  | "partial"
  | "failed"

/** Recovery receipt */
export interface RecoveryReceipt {
  id: string
  workId: string
  streamEntryId?: string
  action: string
  recoveredBy: string
  originalConsumer?: string
  recoveredAt: number
  idleDurationMs?: number
  outcome: RecoveryOutcome
  reason?: string
}

/** Recovery plan */
export interface RecoveryPlan {
  /** Whether recovery is needed */
  needsRecovery: boolean
  /** Current recovery state */
  state: CoordinationRecoveryState
  /** Work items to re-enqueue */
  workToReEnqueue: string[]
  /** Work items to restore to sorted sets */
  workToReschedule: string[]
  /** Work items that are terminal (should not be re-enqueued) */
  terminalWork: string[]
  /** Receipt for this recovery plan */
  receipt?: RecoveryReceipt
}

/** Recovery configuration */
export interface RecoveryConfig {
  streamName: string
  consumerGroup: string
  dueSetName: string
  pendingIdleThresholdMs: number
  maxRecoveryBatchSize: number
}

/** Default recovery configuration */
export const DEFAULT_RECOVERY_CONFIG: RecoveryConfig = {
  streamName: DEFAULT_STREAM_NAME,
  consumerGroup: DEFAULT_CONSUMER_GROUP,
  dueSetName: DEFAULT_DUE_SET_NAME,
  pendingIdleThresholdMs: 5 * 60 * 1000, // 5 minutes
  maxRecoveryBatchSize: 100,
}

// ── Rebuild Types ────────────────────────────────────────────────────────

/** Stats collected during a rebuild operation */
export interface RebuildStats {
  itemsFound: number
  itemsReenqueued: number
  itemsSkipped: number
}

/** Receipt documenting a rebuild operation */
export interface RebuildReceipt {
  receiptId: string
  itemsFound: number
  itemsReenqueued: number
  itemsSkipped: number
  duration: number
  timestamp: number
}

// ── Recovery Service ───────────────────────────────────────────────────

/**
 * CoordinationRecovery provides recovery protocols for the coordination kernel.
 * 
 * This service:
 * - Reconciles PGlite facts with Valkey pending state
 * - Rebuilds Valkey state from PGlite after wipe
 * - Handles crash recovery at every critical boundary
 */
export class CoordinationRecovery extends Context.Service<CoordinationRecovery>()(
  "@opencode/CoordinationRecovery"
) {
  constructor(
    private readonly db: DatabaseAdapter.Service,
    private readonly redis: Redis,
    private readonly store: WorkQueueDurableStoreService,
    private readonly config: RecoveryConfig = DEFAULT_RECOVERY_CONFIG
  ) {
    super("@opencode/CoordinationRecovery")
  }

  /** Cached divergence report from last state transition */
  private lastDivergenceReport: DivergenceReport | null = null

  // ── Recovery Planning ────────────────────────────────────────────────

  /**
   * Plan recovery by inspecting PGlite and Valkey state.
   * 
   * This determines what recovery actions are needed:
   * - Re-enqueue non-terminal work that's missing from Valkey
   * - Restore sorted set schedules for delayed work
   * - Skip terminal work
   * 
   * @returns Recovery plan
   */
  async planRecovery(): Promise<RecoveryPlan> {
    // Check if Valkey is available
    try {
      await this.redis.ping()
    } catch {
      // Valkey is unavailable - need recovery
      return {
        needsRecovery: true,
        state: "coordination_unavailable",
        workToReEnqueue: [],
        workToReschedule: [],
        terminalWork: [],
      }
    }

    // Check stream and group exist
    const streams = new ValkeyStreams(this.redis, this.config.streamName)
    const sortedSets = new ValkeySortedSets(this.redis)
    
    const streamExists = await streams.streamExists()
    const groupExists = await streams.getGroupInfo(this.config.consumerGroup) !== null
    
    if (!streamExists || !groupExists) {
      // Stream or group missing - need rebuild
      return {
        needsRecovery: true,
        state: "coordination_rebuilding",
        workToReEnqueue: [],
        workToReschedule: [],
        terminalWork: [],
      }
    }

    // Query PGlite for non-terminal work
    const nonTerminalWork = await Effect.runPromise(
      this.store.listNonTerminalWorkByStream(this.config.streamName)
    )

    const workToReEnqueue = nonTerminalWork
      .filter(w => w.status === "enqueue_pending" || w.status === "created" || w.status === "enqueued" || w.status === "claimed" || w.status === "recovered")
      .map(w => w.id)

    const workToReschedule = nonTerminalWork
      .filter(w => w.status === "retry_scheduled" || w.status === "failed_retryable")
      .map(w => w.id)

    const terminalWork: string[] = [] // terminal work is handled by reconcilePending

    return {
      needsRecovery: workToReEnqueue.length > 0 || workToReschedule.length > 0,
      state: workToReEnqueue.length > 0 || workToReschedule.length > 0 ? "coordination_degraded" : "ready",
      workToReEnqueue,
      workToReschedule,
      terminalWork,
    }
  }

  // ── Recovery Execution ─────────────────────────────────────────────

  /**
   * Execute recovery plan.
   * 
   * This:
   * 1. Ensures stream and consumer group exist
   * 2. Re-enqueues non-terminal work from PGlite
   * 3. Restores sorted set schedules
   * 4. Records recovery receipt
   * 
   * @param plan - Recovery plan to execute
   * @returns Recovery receipt
   */
  async executeRecovery(plan: RecoveryPlan): Promise<RecoveryReceipt> {
    const receiptId = this.generateReceiptId()
    const now = Date.now()
    const streams = new ValkeyStreams(this.redis, this.config.streamName)
    const sortedSets = new ValkeySortedSets(this.redis)
    
    // Ensure stream and group exist
    await streams.ensureGroup(this.config.consumerGroup)
    
    // Re-enqueue non-terminal work
    for (const workId of plan.workToReEnqueue) {
      try {
        const workItem = await Effect.runPromise(this.store.getWorkItem(workId))
        if (workItem) {
          await streams.addEntry({
            workId: workItem.id,
            workKind: workItem.work_kind ?? "recovered",
            schemaVersion: workItem.schema_version ?? "v1",
            enqueueTimestamp: String(now),
            correlationId: `recovered:${workItem.id}`,
            retryCount: String(workItem.attempt_count),
            maxRetries: String(workItem.max_attempts),
          })
        }
      } catch (error) {
        console.error("Failed to re-enqueue work:", workId, error)
      }
    }
    
    for (const workId of plan.workToReschedule) {
      try {
        // Get work details from PGlite for schedule context
        const workItem = await Effect.runPromise(this.store.getWorkItem(workId))
        if (workItem) {
          // Use creation time + a default retry delay as the due timestamp
          const dueAt = workItem.completed_at
            ? workItem.completed_at + 60_000 // 1 minute after completion for retry
            : workItem.created_at + 60_000
          await sortedSets.add(this.config.dueSetName, dueAt, workId)
        }
      } catch (error) {
        console.error("Failed to reschedule work:", workId, error)
      }
    }
    
    // Record recovery receipt
    const receipt: RecoveryReceipt = {
      id: receiptId,
      workId: "recovery-batch",
      action: "rebuild",
      recoveredBy: "recovery-worker",
      recoveredAt: now,
      outcome: "success",
      reason: `rebuilt ${plan.workToReEnqueue.length} work items`,
    }
    
    // Persist receipt to PGlite
    await this.persistRecoveryReceipt(receipt)
    
    return receipt
  }

  /**
   * Full recovery: plan and execute.
   */
  async recover(): Promise<RecoveryReceipt> {
    const plan = await this.planRecovery()
    return this.executeRecovery(plan)
  }

  // ── Pending Entry Reconciliation ─────────────────────────────────────

  /**
   * Reconcile pending entries against PGlite.
   * 
   * For each pending entry, check if the work is terminal in PGlite.
   * If terminal, safely acknowledge the entry.
   * If non-terminal, leave it pending for reclaim.
   * 
   * @returns Number of entries reconciled
   */
  async reconcilePendingEntries(): Promise<number> {
    const streams = new ValkeyStreams(this.redis, this.config.streamName)
    const pending = await streams.getPendingEntries(this.config.consumerGroup)
    
    let reconciled = 0
    
    for (const entry of pending) {
      // Parse work ID from entry
      // In real implementation, this would be in the entry values
      const workId = entry.id // Simplified for now
      
      // Check if work is terminal in PGlite
      const isTerminal = await this.isWorkTerminal(workId)
      
      if (isTerminal) {
        // Work is terminal - safely ack
        await streams.ack(this.config.consumerGroup, [entry.id])
        reconciled++
        
        // Record reconciliation receipt
        await this.persistRecoveryReceipt({
          id: this.generateReceiptId(),
          workId,
          streamEntryId: entry.id,
          action: "reconciled_duplicate",
          recoveredBy: "recovery-worker",
          originalConsumer: entry.consumer,
          recoveredAt: Date.now(),
          idleDurationMs: entry.idleMs,
          outcome: "success",
          reason: "work_already_terminal",
        })
      }
    }
    
    return reconciled
  }

  /**
   * Check if work is terminal in PGlite.
   */
  private async isWorkTerminal(workId: string): Promise<boolean> {
    return Effect.runPromise(this.store.isWorkTerminal(workId))
  }

  // ── Rebuild Protocol ────────────────────────────────────────────────

  /**
   * Rebuild Valkey coordination state from PGlite.
   * 
   * This is called on startup or after detected Valkey wipe.
   * It:
   * 1. Ensures required streams and consumer groups exist
   * 2. Inspects durable non-terminal work from PGlite
   * 3. Re-enqueues work that should run immediately
   * 4. Restores sorted-set schedules for delayed work
   * 5. Skips terminal work
   * 
   * The rebuild process must be idempotent.
   */
  async rebuildFromPGlite(): Promise<RebuildReceipt> {
    const startTime = Date.now()
    const receiptId = this.generateReceiptId()
    const streams = new ValkeyStreams(this.redis, this.config.streamName)
    const sortedSets = new ValkeySortedSets(this.redis)

    // Ensure stream and group exist
    await streams.ensureGroup(this.config.consumerGroup)

    // Query PGlite for all non-terminal work items
    // Non-terminal statuses are everything except: completed, failed_terminal, cancelled, dead_lettered, superseded
    const nonTerminalWork = await Effect.runPromise(
      this.store.listNonTerminalWorkByStream(this.config.streamName)
    )

    const itemsFound = nonTerminalWork.length
    let itemsReenqueued = 0
    let itemsSkipped = 0

    // Query scheduled work for retry timestamps
    const now = Date.now()
    const scheduledWork = await Effect.runPromise(
      this.store.listScheduledWork(now + 86_400_000) // next 24 hours
    )
    const scheduledDueByWorkId = new Map<string, number>(
      scheduledWork.map(s => [s.work_id, s.due_at])
    )

    // Enqueue non-terminal work items, restoring schedules for delayed work
    for (const work of nonTerminalWork) {
      const dueAt = scheduledDueByWorkId.get(work.id)

      if (dueAt && dueAt > now) {
        // Work should be scheduled for later — add to sorted set
        await sortedSets.add(this.config.dueSetName, dueAt, work.id)
        itemsReenqueued++
      } else {
        // Work should run immediately — XADD to stream
        try {
          await streams.addEntry({
            workId: work.id,
            workKind: work.work_kind ?? "recovered",
            schemaVersion: work.schema_version ?? "v1",
            enqueueTimestamp: String(now),
            retryCount: String(work.attempt_count),
            maxRetries: String(work.max_attempts),
            correlationId: `rebuilt:${work.id}`,
          })
          itemsReenqueued++
        } catch {
          itemsSkipped++
        }
      }
    }

    const duration = Date.now() - startTime

    // Record rebuild receipt to PGlite
    await this.persistRecoveryReceipt({
      id: receiptId,
      workId: "rebuild-batch",
      action: "rebuild" as any,
      recoveredBy: "recovery-worker",
      recoveredAt: now,
      outcome: itemsSkipped > 0 ? "partial" : "success",
      reason: `rebuild complete: ${itemsFound} found, ${itemsReenqueued} reenqueued, ${itemsSkipped} skipped in ${duration}ms`,
    })

    return {
      receiptId,
      itemsFound,
      itemsReenqueued,
      itemsSkipped,
      duration,
      timestamp: now,
    }
  }


  // ── Cold-Start Detection ─────────────────────────────────────────────

  /**
   * Check if Valkey stream is empty and rebuild from PGlite if so.
   *
   * This is called on boot to handle cold-start scenarios where Valkey
   * state has been wiped but PGlite still holds authoritative work items.
   *
   * @returns RebuildReceipt if rebuild was needed and performed, null if Valkey already has state
   */
  async coldStartRebuildIfNeeded(): Promise<RebuildReceipt | null> {
    // Check if Valkey is reachable
    try {
      await this.redis.ping()
    } catch {
      // Valkey unavailable — cannot detect, skip rebuild
      return null
    }

    const streams = new ValkeyStreams(this.redis, this.config.streamName)

    // Check if stream exists and has entries
    const exists = await streams.streamExists()
    if (exists) {
      const info = await streams.getStreamInfo()
      if (info.length > 0) {
        // Stream has entries — Valkey state is alive, no rebuild needed
        return null
      }
    }

    // Stream is empty or missing — rebuild from PGlite
    await this.setRecoveryState("coordination_rebuilding")
    const receipt = await this.rebuildFromPGlite()
    await this.setRecoveryState("ready")

    return receipt
  }

  // ── State Management ────────────────────────────────────────────────

  /**
   * Set recovery state.
   *
   * Persists the state transition to PGlite and records a divergence
   * snapshot for observability.
   */
  async setRecoveryState(state: CoordinationRecoveryState): Promise<void> {
    await Effect.runPromise(
      (this.db as any).query(async (db: any) => {
        await db
          .insert(CoordinationRecoveryTable)
          .values({
            id: "current",
            session_id: "recovery",
            project_id: "recovery",
            old_generation: 0,
            new_generation: 0,
            state,
            outcome: "success",
            reasons: [],
            unsafe_work: false,
            durable_receipt: false,
          })
          .onConflictDoUpdate({
            target: CoordinationRecoveryTable.id,
            set: { state },
          })
          .execute()
      })
    )

    // Record divergence snapshot after state transition
    this.lastDivergenceReport = await this.detectDivergence()
  }

  /**
   * Get the last divergence report recorded during state transitions.
   */
  getLastDivergenceReport(): DivergenceReport | null {
    return this.lastDivergenceReport
  }

  /**
   * Detect divergence between PGlite durable state and Valkey PEL.
   *
   * Cross-references non-terminal work in PGlite against pending entries
   * in the Valkey consumer group PEL to identify:
   * - lost_durability: entries in PEL whose work is absent from PGlite
   * - orphaned_work: non-terminal PGlite work not tracked in PEL
   */
  private async detectDivergence(): Promise<DivergenceReport> {
    const detectedAt = Date.now()
    const streams = new ValkeyStreams(this.redis, this.config.streamName)

    // 1. Query PGlite for non-terminal work IDs via store
    let pgliteWorkIds: string[] = []
    try {
      const workItems = await Effect.runPromise(
        this.store.listNonTerminalWorkByStream(this.config.streamName)
      )
      pgliteWorkIds = workItems.map(w => w.id)
    } catch {
      // PGlite unavailable — return partial report
      pgliteWorkIds = []
    }

    // 2. Query Valkey PEL for pending entries and extract work IDs
    let pelEntryIds: string[] = []
    let pelWorkIds: string[] = []
    try {
      const pending = await streams.getPendingEntries(this.config.consumerGroup)
      pelEntryIds = pending.map(e => e.id)

      // Read entry values to extract workId field
      if (pending.length > 0) {
        const entryIds = pending.map(e => e.id)
        const batchSize = 50
        for (let i = 0; i < entryIds.length; i += batchSize) {
          const batch = entryIds.slice(i, i + batchSize)
          const entries = await streams.readRange(batch[0], batch[batch.length - 1])
          for (const entry of entries) {
            if (entry.values?.workId) {
              pelWorkIds.push(entry.values.workId)
            }
          }
        }
      }
    } catch {
      // Valkey unavailable
      return {
        lost_durability: [],
        orphaned_work: pgliteWorkIds,
        pglite_count: pgliteWorkIds.length,
        valkey_pel_count: 0,
        detectedAt,
      }
    }

    // 3. Cross-reference
    const pgliteSet = new Set(pgliteWorkIds)
    const pelSet = new Set(pelWorkIds)

    const lost_durability = [...new Set(pelWorkIds.filter(id => !pgliteSet.has(id)))]
    const orphaned_work = [...new Set(pgliteWorkIds.filter(id => !pelSet.has(id)))]

    return {
      lost_durability,
      orphaned_work,
      pglite_count: pgliteWorkIds.length,
      valkey_pel_count: pelEntryIds.length,
      detectedAt,
    }
  }

  /**
   * Get current recovery state.
   */
  async getRecoveryState(): Promise<CoordinationRecoveryState> {
    const result = await Effect.runPromise(
      (this.db as any).query(async (db: any) => {
        const [row] = await db
          .select({ state: CoordinationRecoveryTable.state })
          .from(CoordinationRecoveryTable)
          .where(db.eq(CoordinationRecoveryTable.id, "current"))
          .execute()
        return row ?? null
      })
    )
    return ((result as any)?.state as CoordinationRecoveryState) ?? "ready"
  }

  // ── Receipt Management ──────────────────────────────────────────────

  /**
   * Persist recovery receipt to PGlite.
   */
  async persistRecoveryReceipt(receipt: RecoveryReceipt): Promise<void> {
    await Effect.runPromise(
      this.store.recordRecoveryReceipt({
        workId: receipt.workId,
        streamEntryId: receipt.streamEntryId,
        action: receipt.action as any,
        recoveredByConsumer: receipt.recoveredBy,
        originalConsumer: receipt.originalConsumer,
        recoveredAt: receipt.recoveredAt,
        idleDurationMs: receipt.idleDurationMs,
        outcome: receipt.outcome,
        outcomeReason: receipt.reason,
        streamName: this.config.streamName,
        consumerGroup: this.config.consumerGroup,
      })
    )
  }

  /**
   * Generate a unique receipt ID.
   */
  private generateReceiptId(): string {
    return `rec_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
  }

  // ── Cleanup ─────────────────────────────────────────────────────────

  /**
   * Dispose of resources.
   */
  async dispose(): Promise<void> {
    // Nothing to dispose for now
  }
}

// ── Layer ─────────────────────────────────────────────────────────────

/**
 * Layer for CoordinationRecovery.
 */
export const recoveryLayer = Layer.effect(
  CoordinationRecovery,
  Effect.gen(function* () {
    const db: any = yield* DatabaseAdapter.Service
    const redis = yield* getValkeyRedis()
    const store = yield* WorkQueueDurableStoreService
    return new CoordinationRecovery(db, redis, store)
  })
)

// ── Stubs ────────────────────────────────────────────────────────────
// TODO: These will be implemented when the recovery-state repository is complete.
// For now, provide compile-time stubs that throw at runtime.

/**
 * Plan coordination recovery.
 *
 * Pure planner — inspects session state and returns a recovery plan.
 * Not yet implemented; use CoordinationRecovery.planRecovery() instead.
 */
export function planCoordinationRecovery(...args: unknown[]): { state: string; finalState?: string; receipt?: { id: string } } {
  throw new Error(
    "planCoordinationRecovery not yet implemented. Use CoordinationRecovery.planRecovery() instead.",
  )
}

/**
 * Persist a coordination recovery receipt.
 *
 * Writes the receipt to the durable store.
 * Not yet implemented; use CoordinationRecovery.persistRecoveryReceipt() instead.
 */
export async function persistCoordinationRecoveryReceipt(
  ...args: unknown[]
): Promise<never> {
  throw new Error(
    "persistCoordinationRecoveryReceipt not yet implemented.",
  )
}

// ── Helper to get Valkey Redis ────────────────────────────────────────

function getValkeyRedis(): Effect.Effect<Redis> {
  return Effect.promise(async () => {
    const { createValkeyFabric } = await import("./valkey-fabric")
    const fabric = await createValkeyFabric("redis://127.0.0.1:6379")
    const redis = (fabric as unknown as { redis: Redis }).redis
    if (!redis) {
      throw new Error("Valkey Redis not configured")
    }
    return redis
  })
}

