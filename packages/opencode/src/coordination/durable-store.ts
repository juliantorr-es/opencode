/**
 * Work Queue Durable Store
 *
 * This module provides the explicit durable-store contract for the coordination kernel.
 * It enforces semantic lifecycle transitions rather than generic status updates,
 * ensuring that authority-critical operations cannot bypass the domain invariants.
 *
 * Doctrine:
 * - PGlite is the authority of record
 * - Every terminal transition is idempotent (at most one terminal outcome per work ID)
 * - Retry scheduling creates durable ScheduledWork with active link
 * - Unknown stream entries are quarantined, not auto-dead-lettered
 * - Every recovery action persists a receipt
 */

import { Effect, Context, Layer } from "effect"
import { DatabaseAdapter } from "@/storage/adapter"
import type { SessionID } from "@/session/schema"
import type { ProjectID } from "@/project/schema"
import {
  WorkItemTable,
  WorkAttemptTable,
  DeadLetterTable,
  RecoveryReceiptTable,
  ScheduledWorkTable,
  StreamStateTable,
  QuarantineTable,
} from "./work-queue.pg.sql"
import type {
  WorkItemStatus,
  DeadLetterReason,
  RecoveryAction,
} from "./work-queue.pg.sql"
import { DatabaseError } from "@/storage/adapter"

// ── Input Types ──────────────────────────────────────────────────────────

/** Input for creating a new work item */
export interface WorkItemInput {
  id: string
  sessionId: SessionID
  projectId: ProjectID
  workKind: string
  schemaVersion: string
  correlationId: string
  missionId?: string
  parentMissionId?: string
  parentSessionId?: string
  routingTags?: string[]
  maxAttempts?: number
  maxReclaims?: number
}

/** Input for recording an attempt */
export interface AttemptInput {
  workId: string
  attemptNumber: number
  streamName: string
  streamEntryId: string
  consumerGroup: string
  consumerId: string
  workerId?: string
  startedAt: number
}

/** Input for dead-lettering */
export interface DeadLetterInput {
  workId: string
  reason: DeadLetterReason
  workKind: string
  attemptCount: number
  reclaimCount: number
  lastErrorKind?: string
  lastErrorMessage?: string
  streamName?: string
  streamEntryId?: string
  consumerGroup?: string
  lastConsumerId?: string
  canBeRetried?: boolean
  retryAfterMs?: number
  requiresManualIntervention?: boolean
  manualInterventionNotes?: string
}

/** Input for recovery receipt */
export interface RecoveryReceiptInput {
  workId: string
  streamEntryId?: string
  action: RecoveryAction
  recoveredByConsumer: string
  originalConsumer?: string
  recoveredAt: number
  idleDurationMs?: number
  outcome: string
  outcomeReason?: string
  streamName?: string
  consumerGroup?: string
  wasPending?: boolean
  wasTerminal?: boolean
}

/** Input for quarantine record */
export interface QuarantineInput {
  entryId: string
  streamName: string
  workId?: string
  reason: string
  context?: unknown
  createdAt: number
}

/** Update for stream state */
export interface StreamStateUpdate {
  streamName: string
  consumerGroup: string
  lastEntryId?: string
  lastProcessedEntryId?: string
  pendingCount?: number
  consumerCount?: number
  lastRecoveryAt?: number
  recoveryGeneration?: number
  lastHeartbeatAt?: number
  healthy?: boolean
}

// ── Output Types ─────────────────────────────────────────────────────────

/** Work item with all fields */
export interface WorkItem {
  id: string
  session_id: SessionID
  project_id: ProjectID
  work_kind: string
  schema_version: string
  status: WorkItemStatus
  correlation_id: string
  parent_mission_id?: string
  parent_session_id?: string
  routing_tags?: string[]
  attempt_count: number
  max_attempts: number
  reclaim_count: number
  max_reclaims: number
  stream_name?: string
  stream_entry_id?: string
  consumer_group?: string
  consumer_id?: string
  created_at: number
  enqueued_at?: number
  started_at?: number
  completed_at?: number
  result_ref?: string
  error_classification?: string
  recovered_from_crash: boolean
  recovery_reason?: string
  time_created: number
  time_updated: number
}

/** Work attempt record */
export interface WorkAttempt {
  id: string
  work_id: string
  attempt_number: number
  stream_name?: string
  stream_entry_id?: string
  consumer_group?: string
  consumer_id: string
  worker_id?: string
  status: "started" | "completed" | "failed" | "cancelled"
  started_at: number
  finished_at?: number
  result_ref?: string
  error_kind?: string
  error_message?: string
  produced_terminal_fact: boolean
  was_reclaimed: boolean
  reclaimed_from_consumer?: string
  reclaimed_at?: number
  time_created: number
  time_updated: number
}

/** Dead letter record */
export interface DeadLetter {
  id: string
  work_id: string
  reason: DeadLetterReason
  work_kind: string
  attempt_count: number
  reclaim_count: number
  last_error_kind?: string
  last_error_message?: string
  stream_name?: string
  stream_entry_id?: string
  consumer_group?: string
  last_consumer_id?: string
  can_be_retried: boolean
  retry_after_ms?: number
  requires_manual_intervention: boolean
  manual_intervention_notes?: string
  dead_lettered_at: number
  time_created: number
  time_updated: number
}

/** Recovery receipt */
export interface RecoveryReceipt {
  id: string
  work_id: string
  stream_entry_id?: string
  action: RecoveryAction
  recovered_by_consumer: string
  original_consumer?: string
  recovered_at: number
  idle_duration_ms?: number
  outcome: string
  outcome_reason?: string
  stream_name?: string
  consumer_group?: string
  was_pending: boolean
  was_terminal: boolean
  time_created: number
  time_updated: number
}

/** Scheduled work */
export interface ScheduledWork {
  id: string
  work_id: string
  due_at: number
  scheduled_at: number
  retry_count: number
  max_retries: number
  backoff_policy: string
  next_retry_delay_ms?: number
  priority: number
  status: "scheduled" | "promoted" | "cancelled" | "expired"
  promoted_at?: number
  promoted_to_stream?: string
  promoted_stream_entry_id?: string
  reason?: string
  time_created: number
  time_updated: number
}

/** Stream state */
export interface StreamState {
  id: string
  stream_name: string
  consumer_group: string
  last_entry_id?: string
  last_processed_entry_id?: string
  pending_count: number
  consumer_count: number
  last_recovery_at?: number
  recovery_generation: number
  last_heartbeat_at?: number
  healthy: boolean
  time_created: number
  time_updated: number
}

/** Quarantine record */
export interface QuarantineRecord {
  id: string
  entry_id: string
  stream_name: string
  work_id?: string
  reason: string
  context?: unknown
  resolved: boolean
  resolved_at?: number
  resolved_by?: string
  resolution_notes?: string
  created_at: number
  time_created: number
  time_updated: number
}

// ── Filter Types ─────────────────────────────────────────────────────────

/** Filter for dead letters */
export interface DeadLetterFilter {
  workId?: string
  reason?: DeadLetterReason
  requiresManualIntervention?: boolean
  createdAfter?: number
  createdBefore?: number
  limit?: number
}

/** Filter for scheduled work */
export interface ScheduledWorkFilter {
  workId?: string
  status?: ScheduledWork["status"]
  dueBefore?: number
  dueAfter?: number
  limit?: number
}

/** Options for rebuilding */
export interface RebuildOptions {
  streamName?: string
  consumerGroup?: string
  dryRun?: boolean
}

/** Result of rebuild */
export interface RebuildResult {
  workItemsRestored: number
  scheduledWorkRestored: number
  streamEntriesCreated: number
  sortedSetEntriesCreated: number
  duplicatesSkipped: number
  errors: string[]
}

// ── Durable Store Interface ──────────────────────────────────────────────

/**
 * WorkQueueDurableStore provides the explicit durable-store contract for the
 * coordination kernel.
 *
 * This interface uses SEMANTIC lifecycle transitions, NOT generic updateWorkStatus.
 * This forces domain encoding and prevents "just set status" paths that could bypass
 * authority invariants.
 *
 * Key invariants enforced:
 * - At most one terminal outcome per work ID
 * - Retry scheduling creates ScheduledWork with active link (status = retry_scheduled)
 * - Unknown stream entries are quarantined, not auto-dead-lettered
 * - Every recovery action persists a receipt
 */
export interface WorkQueueDurableStore {
  // ── Lifecycle Transitions ────────────────────────────────────────────

  /**
   * Create a new work item in "created" status.
   * This is the first step in the publish flow.
   */
  createWorkItem(input: WorkItemInput): Effect.Effect<WorkItem, DatabaseError>

  /**
   * Transition work item from "created" to "enqueue_pending".
   * Called after work item is created but before XADD to Valkey stream.
   */
  markEnqueuePending(
    workId: string,
    streamName: string,
    consumerGroup: string
  ): Effect.Effect<WorkItem, DatabaseError>

  /**
   * Transition work item from "enqueue_pending" to "enqueued".
   * Called after successful XADD to Valkey stream.
   * Records stream state in the work item.
   */
  markEnqueued(
    workId: string,
    entryId: string,
    streamName: string,
    consumerGroup: string
  ): Effect.Effect<WorkItem, DatabaseError>

  /**
   * Record that an attempt has started.
   * Creates a WorkAttempt record with status = "started".
   */
  startAttempt(input: AttemptInput): Effect.Effect<WorkAttempt, DatabaseError>

  // ── Terminal Transitions ──────────────────────────────────────────────

  /**
   * Complete work terminally.
   * Transitions work item status to "completed".
   * Creates WorkAttempt with status = "completed", produced_terminal_fact = true.
   * 
   * INVARIANT: At most one terminal outcome per work ID.
   * If terminal state already exists, returns existing state.
   */
  completeTerminal(
    workId: string,
    resultRef: string
  ): Effect.Effect<{ workItem: WorkItem; attempt: WorkAttempt }, DatabaseError>

  /**
   * Fail work terminally.
   * Transitions work item status to "failed_terminal".
   * Creates WorkAttempt with status = "failed", produced_terminal_fact = true.
   * 
   * INVARIANT: At most one terminal outcome per work ID.
   */
  failTerminal(
    workId: string,
    errorKind: string,
    errorMessage: string
  ): Effect.Effect<{ workItem: WorkItem; attempt: WorkAttempt }, DatabaseError>

  /**
   * Fail work as retryable and schedule retry.
   * Transitions work item status to "retry_scheduled".
   * Creates WorkAttempt with status = "failed", produced_terminal_fact = false.
   * Creates ScheduledWork record with active link to work item.
   * 
   * INVARIANT: retry_scheduled status requires active ScheduledWork row.
   */
  failRetryableAndSchedule(
    workId: string,
    errorKind: string,
    errorMessage: string,
    retryAfterMs: number,
    reason?: string
  ): Effect.Effect<
    { workItem: WorkItem; attempt: WorkAttempt; scheduledWork: ScheduledWork },
    DatabaseError
  >

  /**
   * Dead-letter work.
   * Transitions work item status to "dead_lettered" (terminal).
   * Creates DeadLetterTable record.
   * Creates WorkAttempt with status = "failed", produced_terminal_fact = true.
   * 
   * INVARIANT: At most one terminal outcome per work ID.
   */
  deadLetter(
    input: DeadLetterInput
  ): Effect.Effect<
    { workItem: WorkItem; deadLetter: DeadLetter; attempt: WorkAttempt },
    DatabaseError
  >

  // ── Quarantine ────────────────────────────────────────────────────────

  /**
   * Quarantine a stream entry with no known durable work item.
   * This is for unknown/orphaned entries, NOT for dead-lettering known work.
   */
  quarantineStreamEntry(
    input: QuarantineInput
  ): Effect.Effect<QuarantineRecord, DatabaseError>

  /**
   * Get quarantine record by entry ID.
   */
  getQuarantineRecord(
    entryId: string
  ): Effect.Effect<QuarantineRecord | null, DatabaseError>

  /**
   * List quarantined entries.
   */
  listQuarantinedEntries(): Effect.Effect<QuarantineRecord[], DatabaseError>

  // ── Recovery Audit ─────────────────────────────────────────────────────

  /**
   * Persist a recovery receipt for audit.
   * Every recovery action MUST record a receipt.
   */
  recordRecoveryReceipt(
    input: RecoveryReceiptInput
  ): Effect.Effect<RecoveryReceipt, DatabaseError>

  // ── Promotion ──────────────────────────────────────────────────────────

  /**
   * Mark scheduled work as promoted.
   * Updates ScheduledWork.status to "promoted".
   * Records the stream entry ID and generation for deduplication.
   */
  markPromotion(
    workId: string,
    scheduledWorkId: string,
    entryId: string,
    generation: number
  ): Effect.Effect<ScheduledWork, DatabaseError>

  // ── Query Methods ─────────────────────────────────────────────────────

  /** Get work item by ID */
  getWorkItem(workId: string): Effect.Effect<WorkItem | null, DatabaseError>

  /** Get work item status by ID */
  getWorkStatus(workId: string): Effect.Effect<WorkItemStatus | null, DatabaseError>

  /** Check if work item is in a terminal state */
  isWorkTerminal(workId: string): Effect.Effect<boolean, DatabaseError>

  /** Get latest attempt for a work item */
  getLatestAttempt(
    workId: string
  ): Effect.Effect<WorkAttempt | null, DatabaseError>

  /** List non-terminal work items for a specific stream */
  listNonTerminalWorkByStream(
    streamName: string
  ): Effect.Effect<WorkItem[], DatabaseError>

  /** List scheduled work due before a timestamp */
  listScheduledWork(
    dueBefore: number,
    limit?: number
  ): Effect.Effect<ScheduledWork[], DatabaseError>

  /** Get stream state by stream name and consumer group */
  getStreamState(
    streamName: string,
    consumerGroup: string
  ): Effect.Effect<StreamState | null, DatabaseError>

  /** Get stream state by entry ID */
  getStreamStateByEntryId(
    entryId: string
  ): Effect.Effect<StreamState | null, DatabaseError>

  /** Get active stream state for a work item */
  getActiveStreamStateForWork(
    workId: string
  ): Effect.Effect<StreamState | null, DatabaseError>

  /** Update stream state */
  updateStreamState(
    update: StreamStateUpdate
  ): Effect.Effect<StreamState, DatabaseError>

  /** List dead letters with optional filter */
  listDeadLetters(
    filter?: DeadLetterFilter
  ): Effect.Effect<DeadLetter[], DatabaseError>

  /** Get dead letter by work ID */
  getDeadLetter(workId: string): Effect.Effect<DeadLetter | null, DatabaseError>

  /** Get recovery receipts for a work item */
  getRecoveryReceipts(
    workId: string
  ): Effect.Effect<RecoveryReceipt[], DatabaseError>

  // ── Batch Operations ─────────────────────────────────────────────────

  /** Get work items by IDs (batch) */
  getWorkItems(workIds: string[]): Effect.Effect<Map<string, WorkItem>, DatabaseError>

  /** Check terminal status for multiple work IDs (batch) */
  checkWorkTerminal(
    workIds: string[]
  ): Effect.Effect<Map<string, boolean>, DatabaseError>
}

// ── Service Definition ──────────────────────────────────────────────────

/**
 * WorkQueueDurableStore as an Effect service.
 * This allows dependency injection through the Effect layer system.
 */
export class WorkQueueDurableStoreService extends Context.Service<WorkQueueDurableStoreService>()(
  "@opencode/WorkQueueDurableStore"
) {
  constructor(store: WorkQueueDurableStore) {
    super()
    this.store = store
  }
  private readonly store: WorkQueueDurableStore

  // Delegate all methods to the underlying store
  createWorkItem(input: WorkItemInput): Effect.Effect<WorkItem, DatabaseError> {
    return this.store.createWorkItem(input)
  }

  markEnqueuePending(
    workId: string,
    streamName: string,
    consumerGroup: string
  ): Effect.Effect<WorkItem, DatabaseError> {
    return this.store.markEnqueuePending(workId, streamName, consumerGroup)
  }

  markEnqueued(
    workId: string,
    entryId: string,
    streamName: string,
    consumerGroup: string
  ): Effect.Effect<WorkItem, DatabaseError> {
    return this.store.markEnqueued(workId, entryId, streamName, consumerGroup)
  }

  startAttempt(input: AttemptInput): Effect.Effect<WorkAttempt, DatabaseError> {
    return this.store.startAttempt(input)
  }

  completeTerminal(
    workId: string,
    resultRef: string
  ): Effect.Effect<{ workItem: WorkItem; attempt: WorkAttempt }, DatabaseError> {
    return this.store.completeTerminal(workId, resultRef)
  }

  failTerminal(
    workId: string,
    errorKind: string,
    errorMessage: string
  ): Effect.Effect<{ workItem: WorkItem; attempt: WorkAttempt }, DatabaseError> {
    return this.store.failTerminal(workId, errorKind, errorMessage)
  }

  failRetryableAndSchedule(
    workId: string,
    errorKind: string,
    errorMessage: string,
    retryAfterMs: number,
    reason?: string
  ): Effect.Effect<
    { workItem: WorkItem; attempt: WorkAttempt; scheduledWork: ScheduledWork },
    DatabaseError
  > {
    return this.store.failRetryableAndSchedule(
      workId,
      errorKind,
      errorMessage,
      retryAfterMs,
      reason
    )
  }

  deadLetter(
    input: DeadLetterInput
  ): Effect.Effect<
    { workItem: WorkItem; deadLetter: DeadLetter; attempt: WorkAttempt },
    DatabaseError
  > {
    return this.store.deadLetter(input)
  }

  quarantineStreamEntry(
    input: QuarantineInput
  ): Effect.Effect<QuarantineRecord, DatabaseError> {
    return this.store.quarantineStreamEntry(input)
  }

  getQuarantineRecord(
    entryId: string
  ): Effect.Effect<QuarantineRecord | null, DatabaseError> {
    return this.store.getQuarantineRecord(entryId)
  }

  listQuarantinedEntries(): Effect.Effect<QuarantineRecord[], DatabaseError> {
    return this.store.listQuarantinedEntries()
  }

  recordRecoveryReceipt(
    input: RecoveryReceiptInput
  ): Effect.Effect<RecoveryReceipt, DatabaseError> {
    return this.store.recordRecoveryReceipt(input)
  }

  markPromotion(
    workId: string,
    scheduledWorkId: string,
    entryId: string,
    generation: number
  ): Effect.Effect<ScheduledWork, DatabaseError> {
    return this.store.markPromotion(workId, scheduledWorkId, entryId, generation)
  }

  getWorkItem(workId: string): Effect.Effect<WorkItem | null, DatabaseError> {
    return this.store.getWorkItem(workId)
  }

  getWorkStatus(
    workId: string
  ): Effect.Effect<WorkItemStatus | null, DatabaseError> {
    return this.store.getWorkStatus(workId)
  }

  isWorkTerminal(workId: string): Effect.Effect<boolean, DatabaseError> {
    return this.store.isWorkTerminal(workId)
  }

  getLatestAttempt(
    workId: string
  ): Effect.Effect<WorkAttempt | null, DatabaseError> {
    return this.store.getLatestAttempt(workId)
  }

  listNonTerminalWorkByStream(
    streamName: string
  ): Effect.Effect<WorkItem[], DatabaseError> {
    return this.store.listNonTerminalWorkByStream(streamName)
  }

  listScheduledWork(
    dueBefore: number,
    limit?: number
  ): Effect.Effect<ScheduledWork[], DatabaseError> {
    return this.store.listScheduledWork(dueBefore, limit)
  }

  getStreamState(
    streamName: string,
    consumerGroup: string
  ): Effect.Effect<StreamState | null, DatabaseError> {
    return this.store.getStreamState(streamName, consumerGroup)
  }

  getStreamStateByEntryId(
    entryId: string
  ): Effect.Effect<StreamState | null, DatabaseError> {
    return this.store.getStreamStateByEntryId(entryId)
  }

  getActiveStreamStateForWork(
    workId: string
  ): Effect.Effect<StreamState | null, DatabaseError> {
    return this.store.getActiveStreamStateForWork(workId)
  }

  updateStreamState(
    update: StreamStateUpdate
  ): Effect.Effect<StreamState, DatabaseError> {
    return this.store.updateStreamState(update)
  }

  listDeadLetters(
    filter?: DeadLetterFilter
  ): Effect.Effect<DeadLetter[], DatabaseError> {
    return this.store.listDeadLetters(filter)
  }

  getDeadLetter(
    workId: string
  ): Effect.Effect<DeadLetter | null, DatabaseError> {
    return this.store.getDeadLetter(workId)
  }

  getRecoveryReceipts(
    workId: string
  ): Effect.Effect<RecoveryReceipt[], DatabaseError> {
    return this.store.getRecoveryReceipts(workId)
  }

  getWorkItems(workIds: string[]): Effect.Effect<Map<string, WorkItem>, DatabaseError> {
    return this.store.getWorkItems(workIds)
  }

  checkWorkTerminal(
    workIds: string[]
  ): Effect.Effect<Map<string, boolean>, DatabaseError> {
    return this.store.checkWorkTerminal(workIds)
  }
}

// ── PGlite Implementation ────────────────────────────────────────────────

/**
 * PGliteWorkQueueStore is the production implementation of WorkQueueDurableStore
 * backed by PGlite via Drizzle ORM and DatabaseAdapter.
 *
 * This implementation enforces all authority invariants at the database level:
 * - Terminal transitions are protected by work ID uniqueness
 * - All operations are atomic within transactions where needed
 * - Idempotency is guaranteed for all terminal writes
 */
export class PGliteWorkQueueStore implements WorkQueueDurableStore {
  constructor(private readonly db: DatabaseAdapter.Interface) {}

  // ── Helper methods for Drizzle operations ────────────────────────────

  private query<T>(fn: (db: any) => T | Promise<T>): Effect.Effect<T, DatabaseError> {
    return this.db.query(fn)
  }

  private transaction<T>(
    fn: (db: any) => T | Promise<T>
  ): Effect.Effect<T, DatabaseError> {
    return this.db.transaction(fn)
  }

  // ── Lifecycle Transitions ────────────────────────────────────────────

  createWorkItem(input: WorkItemInput): Effect.Effect<WorkItem, DatabaseError> {
    const now = Date.now()
    return this.query(async db => {
      const [workItem] = await db
        .insert(WorkItemTable)
        .values({
          id: input.id,
          session_id: input.sessionId,
          project_id: input.projectId,
          work_kind: input.workKind,
          schema_version: input.schemaVersion,
          status: "created",
          correlation_id: input.correlationId,
          parent_mission_id: input.missionId,
          parent_session_id: input.parentSessionId,
          routing_tags: input.routingTags,
          attempt_count: 0,
          max_attempts: input.maxAttempts ?? 3,
          reclaim_count: 0,
          max_reclaims: input.maxReclaims ?? 5,
          created_at: now,
          time_created: now,
          time_updated: now,
        })
        .returning()
        .execute()
      return workItem
    })
  }

  markEnqueuePending(
    workId: string,
    streamName: string,
    consumerGroup: string
  ): Effect.Effect<WorkItem, DatabaseError> {
    const now = Date.now()
    return this.query(async db => {
      const [workItem] = await db
        .update(WorkItemTable)
        .set({
          status: "enqueue_pending",
          stream_name: streamName,
          consumer_group: consumerGroup,
          time_updated: now,
        })
        .where(
          db.and(
            db.eq(WorkItemTable.id, workId),
            db.eq(WorkItemTable.status, "created")
          )
        )
        .returning()
        .execute()

      if (!workItem) {
        throw new Error(
          `Work item ${workId} not found or not in 'created' status`
        )
      }
      return workItem
    })
  }

  markEnqueued(
    workId: string,
    entryId: string,
    streamName: string,
    consumerGroup: string
  ): Effect.Effect<WorkItem, DatabaseError> {
    const now = Date.now()
    return this.query(async db => {
      const [workItem] = await db
        .update(WorkItemTable)
        .set({
          status: "enqueued",
          stream_name: streamName,
          stream_entry_id: entryId,
          consumer_group: consumerGroup,
          enqueued_at: now,
          time_updated: now,
        })
        .where(
          db.and(
            db.eq(WorkItemTable.id, workId),
            db.inArray(WorkItemTable.status, ["created", "enqueue_pending"])
          )
        )
        .returning()
        .execute()

      if (!workItem) {
        throw new Error(
          `Work item ${workId} not found or not in enqueueable status`
        )
      }
      return workItem
    })
  }

  startAttempt(input: AttemptInput): Effect.Effect<WorkAttempt, DatabaseError> {
    const now = Date.now()
    return this.query(async db => {
      const [attempt] = await db
        .insert(WorkAttemptTable)
        .values({
          id: `${input.workId}:attempt:${input.attemptNumber}:${now}`,
          work_id: input.workId,
          attempt_number: input.attemptNumber,
          stream_name: input.streamName,
          stream_entry_id: input.streamEntryId,
          consumer_group: input.consumerGroup,
          consumer_id: input.consumerId,
          worker_id: input.workerId,
          status: "started",
          started_at: input.startedAt,
          produced_terminal_fact: false,
          was_reclaimed: false,
          time_created: now,
          time_updated: now,
        })
        .returning()
        .execute()
      return attempt
    })
  }

  // ── Terminal Transitions ──────────────────────────────────────────────

  completeTerminal(
    workId: string,
    resultRef: string
  ): Effect.Effect<{ workItem: WorkItem; attempt: WorkAttempt }, DatabaseError> {
    const now = Date.now()

    // Check if already terminal - return existing state for idempotency
    const existingTerminalEffect = this.query(async db => {
      const [existing] = await db
        .select({ id: WorkItemTable.id, status: WorkItemTable.status })
        .from(WorkItemTable)
        .where(
          db.and(
            db.eq(WorkItemTable.id, workId),
            db.inArray(WorkItemTable.status, [
              "completed",
              "failed_terminal",
              "cancelled",
              "superseded",
              "dead_lettered",
            ])
          )
        )
        .execute()
      return existing
    })

    return this.transaction(async db => {
      // Check if already terminal
      const existing = await existingTerminalEffect.pipe(Effect.runPromise)

      if (existing) {
        // Already terminal - return existing state
        const [fullWorkItem] = await db
          .select()
          .from(WorkItemTable)
          .where(db.eq(WorkItemTable.id, workId))
          .execute()

        const [latestAttempt] = await db
          .select()
          .from(WorkAttemptTable)
          .where(
            db.and(
              db.eq(WorkAttemptTable.work_id, workId),
              db.eq(WorkAttemptTable.produced_terminal_fact, true)
            )
          )
          .orderBy(db.desc(WorkAttemptTable.attempt_number))
          .limit(1)
          .execute()

        if (!fullWorkItem || !latestAttempt) {
          throw new Error(
            `Terminal work item ${workId} exists but missing records`
          )
        }
        return { workItem: fullWorkItem, attempt: latestAttempt }
      }

      // Get current attempt count
      const [workItem] = await db
        .select({ attempt_count: WorkItemTable.attempt_count })
        .from(WorkItemTable)
        .where(db.eq(WorkItemTable.id, workId))
        .execute()

      if (!workItem) {
        throw new Error(`Work item ${workId} not found`)
      }

      const attemptNumber = workItem.attempt_count + 1

      // Update work item to completed
      const [updatedWorkItem] = await db
        .update(WorkItemTable)
        .set({
          status: "completed",
          completed_at: now,
          result_ref: resultRef,
          attempt_count: attemptNumber,
          time_updated: now,
        })
        .where(
          db.and(
            db.eq(WorkItemTable.id, workId),
            db.notInArray(WorkItemTable.status, [
              "completed",
              "failed_terminal",
              "cancelled",
              "superseded",
              "dead_lettered",
            ])
          )
        )
        .returning()
        .execute()

      if (!updatedWorkItem) {
        throw new Error(
          `Failed to transition work item ${workId} to completed`
        )
      }

      // Record the terminal attempt
      const [attempt] = await db
        .insert(WorkAttemptTable)
        .values({
          id: `${workId}:attempt:${attemptNumber}:${now}`,
          work_id: workId,
          attempt_number: attemptNumber,
          status: "completed",
          started_at: now,
          finished_at: now,
          result_ref: resultRef,
          produced_terminal_fact: true,
          time_created: now,
          time_updated: now,
        })
        .returning()
        .execute()

      return { workItem: updatedWorkItem, attempt }
    })
  }

  failTerminal(
    workId: string,
    errorKind: string,
    errorMessage: string
  ): Effect.Effect<{ workItem: WorkItem; attempt: WorkAttempt }, DatabaseError> {
    const now = Date.now()

    return this.transaction(async db => {
      // Check if already terminal
      const [existing] = await db
        .select({ id: WorkItemTable.id })
        .from(WorkItemTable)
        .where(
          db.and(
            db.eq(WorkItemTable.id, workId),
            db.inArray(WorkItemTable.status, [
              "completed",
              "failed_terminal",
              "cancelled",
              "superseded",
              "dead_lettered",
            ])
          )
        )
        .execute()

      if (existing) {
        const [fullWorkItem] = await db
          .select()
          .from(WorkItemTable)
          .where(db.eq(WorkItemTable.id, workId))
          .execute()

        const [latestAttempt] = await db
          .select()
          .from(WorkAttemptTable)
          .where(
            db.and(
              db.eq(WorkAttemptTable.work_id, workId),
              db.eq(WorkAttemptTable.produced_terminal_fact, true)
            )
          )
          .orderBy(db.desc(WorkAttemptTable.attempt_number))
          .limit(1)
          .execute()

        if (!fullWorkItem || !latestAttempt) {
          throw new Error(
            `Terminal work item ${workId} exists but missing records`
          )
        }
        return { workItem: fullWorkItem, attempt: latestAttempt }
      }

      // Get current attempt count
      const [workItem] = await db
        .select({ attempt_count: WorkItemTable.attempt_count })
        .from(WorkItemTable)
        .where(db.eq(WorkItemTable.id, workId))
        .execute()

      if (!workItem) {
        throw new Error(`Work item ${workId} not found`)
      }

      const attemptNumber = workItem.attempt_count + 1

      // Update work item to failed_terminal
      const [updatedWorkItem] = await db
        .update(WorkItemTable)
        .set({
          status: "failed_terminal",
          error_classification: errorKind,
          completed_at: now,
          attempt_count: attemptNumber,
          time_updated: now,
        })
        .where(
          db.and(
            db.eq(WorkItemTable.id, workId),
            db.notInArray(WorkItemTable.status, [
              "completed",
              "failed_terminal",
              "cancelled",
              "superseded",
              "dead_lettered",
            ])
          )
        )
        .returning()
        .execute()

      if (!updatedWorkItem) {
        throw new Error(
          `Failed to transition work item ${workId} to failed_terminal`
        )
      }

      // Record the terminal attempt
      const [attempt] = await db
        .insert(WorkAttemptTable)
        .values({
          id: `${workId}:attempt:${attemptNumber}:${now}`,
          work_id: workId,
          attempt_number: attemptNumber,
          status: "failed",
          started_at: now,
          finished_at: now,
          error_kind: errorKind,
          error_message: errorMessage,
          produced_terminal_fact: true,
          time_created: now,
          time_updated: now,
        })
        .returning()
        .execute()

      return { workItem: updatedWorkItem, attempt }
    })
  }

  failRetryableAndSchedule(
    workId: string,
    errorKind: string,
    errorMessage: string,
    retryAfterMs: number,
    reason?: string
  ): Effect.Effect<
    { workItem: WorkItem; attempt: WorkAttempt; scheduledWork: ScheduledWork },
    DatabaseError
  > {
    const now = Date.now()
    const dueAt = now + retryAfterMs

    return this.transaction(async db => {
      // Get current attempt/reclaim counts
      const [workItem] = await db
        .select({
          attempt_count: WorkItemTable.attempt_count,
          max_attempts: WorkItemTable.max_attempts,
        })
        .from(WorkItemTable)
        .where(db.eq(WorkItemTable.id, workId))
        .execute()

      if (!workItem) {
        throw new Error(`Work item ${workId} not found`)
      }

      const attemptNumber = workItem.attempt_count + 1

      // Update work item to failed_retryable first
      const [updatedWorkItem] = await db
        .update(WorkItemTable)
        .set({
          status: "failed_retryable",
          error_classification: errorKind,
          attempt_count: attemptNumber,
          time_updated: now,
        })
        .where(
          db.and(
            db.eq(WorkItemTable.id, workId),
            db.notInArray(WorkItemTable.status, [
              "completed",
              "failed_terminal",
              "cancelled",
              "superseded",
              "dead_lettered",
            ])
          )
        )
        .returning()
        .execute()

      if (!updatedWorkItem) {
        throw new Error(
          `Failed to transition work item ${workId} to failed_retryable`
        )
      }

      // Record the non-terminal attempt
      const [attempt] = await db
        .insert(WorkAttemptTable)
        .values({
          id: `${workId}:attempt:${attemptNumber}:${now}`,
          work_id: workId,
          attempt_number: attemptNumber,
          status: "failed",
          started_at: now,
          finished_at: now,
          error_kind: errorKind,
          error_message: errorMessage,
          produced_terminal_fact: false,
          time_created: now,
          time_updated: now,
        })
        .returning()
        .execute()

      // Create scheduled work
      const scheduledWorkId = `${workId}:scheduled:${attemptNumber}:${now}`
      const [scheduledWork] = await db
        .insert(ScheduledWorkTable)
        .values({
          id: scheduledWorkId,
          work_id: workId,
          due_at: dueAt,
          scheduled_at: now,
          retry_count: attemptNumber,
          max_retries: workItem.max_attempts,
          backoff_policy: "exponential",
          next_retry_delay_ms: BigInt(retryAfterMs),
          priority: 0,
          status: "scheduled",
          reason: reason ?? errorKind,
          time_created: now,
          time_updated: now,
        })
        .returning()
        .execute()

      // Update work item to retry_scheduled (linked to scheduled work)
      const [finalWorkItem] = await db
        .update(WorkItemTable)
        .set({
          status: "retry_scheduled",
          time_updated: now,
        })
        .where(db.eq(WorkItemTable.id, workId))
        .returning()
        .execute()

      return {
        workItem: finalWorkItem ?? updatedWorkItem,
        attempt,
        scheduledWork,
      }
    })
  }

  deadLetter(
    input: DeadLetterInput
  ): Effect.Effect<
    { workItem: WorkItem; deadLetter: DeadLetter; attempt: WorkAttempt },
    DatabaseError
  > {
    const now = Date.now()

    return this.transaction(async db => {
      const workId = input.workId

      // Get current attempt count
      const [workItem] = await db
        .select({ attempt_count: WorkItemTable.attempt_count })
        .from(WorkItemTable)
        .where(db.eq(WorkItemTable.id, workId))
        .execute()

      if (!workItem) {
        throw new Error(`Work item ${workId} not found`)
      }

      const attemptNumber = workItem.attempt_count + 1

      // Check if already terminal
      const [existing] = await db
        .select({ id: WorkItemTable.id })
        .from(WorkItemTable)
        .where(
          db.and(
            db.eq(WorkItemTable.id, workId),
            db.inArray(WorkItemTable.status, [
              "completed",
              "failed_terminal",
              "cancelled",
              "superseded",
              "dead_lettered",
            ])
          )
        )
        .execute()

      if (existing) {
        const [fullWorkItem] = await db
          .select()
          .from(WorkItemTable)
          .where(db.eq(WorkItemTable.id, workId))
          .execute()

        const [latestAttempt] = await db
          .select()
          .from(WorkAttemptTable)
          .where(
            db.and(
              db.eq(WorkAttemptTable.work_id, workId),
              db.eq(WorkAttemptTable.produced_terminal_fact, true)
            )
          )
          .orderBy(db.desc(WorkAttemptTable.attempt_number))
          .limit(1)
          .execute()

        const [deadLetter] = await db
          .select()
          .from(DeadLetterTable)
          .where(db.eq(DeadLetterTable.work_id, workId))
          .execute()

        if (!fullWorkItem || !latestAttempt || !deadLetter) {
          throw new Error(
            `Terminal work item ${workId} exists but missing records`
          )
        }
        return { workItem: fullWorkItem, deadLetter, attempt: latestAttempt }
      }

      // Update work item to dead_lettered
      const [updatedWorkItem] = await db
        .update(WorkItemTable)
        .set({
          status: "dead_lettered",
          error_classification: input.lastErrorKind,
          completed_at: now,
          attempt_count: attemptNumber,
          reclaim_count: input.reclaimCount,
          time_updated: now,
        })
        .where(
          db.and(
            db.eq(WorkItemTable.id, workId),
            db.notInArray(WorkItemTable.status, [
              "completed",
              "failed_terminal",
              "cancelled",
              "superseded",
              "dead_lettered",
            ])
          )
        )
        .returning()
        .execute()

      if (!updatedWorkItem) {
        throw new Error(
          `Failed to transition work item ${workId} to dead_lettered`
        )
      }

      // Record the terminal attempt
      const [attempt] = await db
        .insert(WorkAttemptTable)
        .values({
          id: `${workId}:attempt:${attemptNumber}:${now}`,
          work_id: workId,
          attempt_number: attemptNumber,
          status: "failed",
          started_at: now,
          finished_at: now,
          error_kind: input.lastErrorKind,
          error_message: input.lastErrorMessage,
          produced_terminal_fact: true,
          time_created: now,
          time_updated: now,
        })
        .returning()
        .execute()

      // Create dead letter record
      const [deadLetter] = await db
        .insert(DeadLetterTable)
        .values({
          id: `${workId}:dl:${now}`,
          work_id: workId,
          reason: input.reason,
          work_kind: input.workKind,
          attempt_count: input.attemptCount,
          reclaim_count: input.reclaimCount,
          last_error_kind: input.lastErrorKind,
          last_error_message: input.lastErrorMessage,
          stream_name: input.streamName,
          stream_entry_id: input.streamEntryId,
          consumer_group: input.consumerGroup,
          last_consumer_id: input.lastConsumerId,
          can_be_retried: input.canBeRetried ?? false,
          retry_after_ms: input.retryAfterMs
            ? BigInt(input.retryAfterMs)
            : undefined,
          requires_manual_intervention: input.requiresManualIntervention ?? false,
          manual_intervention_notes: input.manualInterventionNotes,
          dead_lettered_at: now,
          time_created: now,
          time_updated: now,
        })
        .returning()
        .execute()

      return { workItem: updatedWorkItem, deadLetter, attempt }
    })
  }

  // ── Quarantine ────────────────────────────────────────────────────────

  quarantineStreamEntry(
    input: QuarantineInput
  ): Effect.Effect<QuarantineRecord, DatabaseError> {
    const now = Date.now()
    const quarantineId = `${input.entryId}:quarantine:${now}`

    return this.query(async db => {
      const [record] = await db
        .insert(QuarantineTable)
        .values({
          id: quarantineId,
          entry_id: input.entryId,
          stream_name: input.streamName,
          work_id: input.workId,
          reason: input.reason,
          context: input.context,
          resolved: false,
          created_at: input.createdAt,
          time_created: now,
          time_updated: now,
        })
        .returning()
        .execute()
      return record
    })
  }

  getQuarantineRecord(
    entryId: string
  ): Effect.Effect<QuarantineRecord | null, DatabaseError> {
    return this.query(async db => {
      const [record] = await db
        .select()
        .from(QuarantineTable)
        .where(db.eq(QuarantineTable.entry_id, entryId))
        .execute()
      return record ?? null
    })
  }

  listQuarantinedEntries(): Effect.Effect<QuarantineRecord[], DatabaseError> {
    return this.query(async db => {
      const records = await db.select().from(QuarantineTable).execute()
      return records
    })
  }

  // ── Recovery Audit ─────────────────────────────────────────────────────

  recordRecoveryReceipt(
    input: RecoveryReceiptInput
  ): Effect.Effect<RecoveryReceipt, DatabaseError> {
    const now = Date.now()
    const receiptId = `${input.workId}:recovery:${input.action}:${now}`

    return this.query(async db => {
      const [receipt] = await db
        .insert(RecoveryReceiptTable)
        .values({
          id: receiptId,
          work_id: input.workId,
          stream_entry_id: input.streamEntryId,
          action: input.action,
          recovered_by_consumer: input.recoveredByConsumer,
          original_consumer: input.originalConsumer,
          recovered_at: input.recoveredAt,
          idle_duration_ms: input.idleDurationMs
            ? BigInt(input.idleDurationMs)
            : undefined,
          outcome: input.outcome,
          outcome_reason: input.outcomeReason,
          stream_name: input.streamName,
          consumer_group: input.consumerGroup,
          was_pending: input.wasPending ?? true,
          was_terminal: input.wasTerminal ?? false,
          time_created: now,
          time_updated: now,
        })
        .returning()
        .execute()
      return receipt
    })
  }

  // ── Promotion ──────────────────────────────────────────────────────────

  markPromotion(
    workId: string,
    scheduledWorkId: string,
    entryId: string,
    generation: number
  ): Effect.Effect<ScheduledWork, DatabaseError> {
    const now = Date.now()

    return this.query(async db => {
      const [scheduledWork] = await db
        .update(ScheduledWorkTable)
        .set({
          status: "promoted",
          promoted_at: now,
          promoted_to_stream: "tribunus:work",
          promoted_stream_entry_id: entryId,
          time_updated: now,
        })
        .where(
          db.and(
            db.eq(ScheduledWorkTable.id, scheduledWorkId),
            db.eq(ScheduledWorkTable.status, "scheduled")
          )
        )
        .returning()
        .execute()

      if (!scheduledWork) {
        throw new Error(
          `Scheduled work ${scheduledWorkId} not found or not in 'scheduled' status`
        )
      }

      return scheduledWork
    })
  }

  // ── Query Methods ─────────────────────────────────────────────────────

  getWorkItem(workId: string): Effect.Effect<WorkItem | null, DatabaseError> {
    return this.query(async db => {
      const [workItem] = await db
        .select()
        .from(WorkItemTable)
        .where(db.eq(WorkItemTable.id, workId))
        .execute()
      return workItem ?? null
    })
  }

  getWorkStatus(
    workId: string
  ): Effect.Effect<WorkItemStatus | null, DatabaseError> {
    return this.query(async db => {
      const [result] = await db
        .select({ status: WorkItemTable.status })
        .from(WorkItemTable)
        .where(db.eq(WorkItemTable.id, workId))
        .execute()
      return result?.status ?? null
    })
  }

  isWorkTerminal(workId: string): Effect.Effect<boolean, DatabaseError> {
    return this.getWorkStatus(workId).pipe(
      Effect.map(status => {
        if (!status) return false
        return [
          "completed",
          "failed_terminal",
          "cancelled",
          "superseded",
          "dead_lettered",
        ].includes(status)
      })
    )
  }

  getLatestAttempt(
    workId: string
  ): Effect.Effect<WorkAttempt | null, DatabaseError> {
    return this.query(async db => {
      const [attempt] = await db
        .select()
        .from(WorkAttemptTable)
        .where(db.eq(WorkAttemptTable.work_id, workId))
        .orderBy(db.desc(WorkAttemptTable.attempt_number))
        .limit(1)
        .execute()
      return attempt ?? null
    })
  }

  listNonTerminalWorkByStream(
    streamName: string
  ): Effect.Effect<WorkItem[], DatabaseError> {
    return this.query(async db => {
      const workItems = await db
        .select()
        .from(WorkItemTable)
        .where(
          db.and(
            db.eq(WorkItemTable.stream_name, streamName),
            db.notInArray(WorkItemTable.status, [
              "completed",
              "failed_terminal",
              "cancelled",
              "superseded",
              "dead_lettered",
            ])
          )
        )
        .execute()
      return workItems
    })
  }

  listScheduledWork(
    dueBefore: number,
    limit: number = 100
  ): Effect.Effect<ScheduledWork[], DatabaseError> {
    return this.query(async db => {
      const scheduledWork = await db
        .select()
        .from(ScheduledWorkTable)
        .where(
          db.and(
            db.eq(ScheduledWorkTable.status, "scheduled"),
            db.lte(ScheduledWorkTable.due_at, dueBefore)
          )
        )
        .orderBy(db.asc(ScheduledWorkTable.due_at))
        .limit(limit)
        .execute()
      return scheduledWork
    })
  }

  getStreamState(
    streamName: string,
    consumerGroup: string
  ): Effect.Effect<StreamState | null, DatabaseError> {
    return this.query(async db => {
      const [state] = await db
        .select()
        .from(StreamStateTable)
        .where(
          db.and(
            db.eq(StreamStateTable.stream_name, streamName),
            db.eq(StreamStateTable.consumer_group, consumerGroup)
          )
        )
        .execute()
      return state ?? null
    })
  }

  getStreamStateByEntryId(
    entryId: string
  ): Effect.Effect<StreamState | null, DatabaseError> {
    return this.query(async db => {
      // This is a more complex query - we need to find stream state by entry ID
      // For now, we'll query all stream states and filter
      // TODO: Optimize with proper indexing if needed
      const states = await db.select().from(StreamStateTable).execute()
      // In a real implementation, we'd join with the stream entries
      // For now, return null as this is a best-effort lookup
      return null
    })
  }

  getActiveStreamStateForWork(
    workId: string
  ): Effect.Effect<StreamState | null, DatabaseError> {
    return this.query(async db => {
      const [workItem] = await db
        .select({ stream_name: WorkItemTable.stream_name })
        .from(WorkItemTable)
        .where(db.eq(WorkItemTable.id, workId))
        .execute()

      if (!workItem?.stream_name) return null

      // Get default consumer group
      const defaultConsumerGroup = "tribunus:workers"

      return this.getStreamState(workItem.stream_name, defaultConsumerGroup).pipe(
        Effect.runPromise
      )
    }).pipe(Effect.flatten)
  }

  updateStreamState(
    update: StreamStateUpdate
  ): Effect.Effect<StreamState, DatabaseError> {
    const now = Date.now()

    return this.query(async db => {
      const key = `${update.streamName}:${update.consumerGroup}`
      const [state] = await db
        .insert(StreamStateTable)
        .values({
          id: key,
          stream_name: update.streamName,
          consumer_group: update.consumerGroup,
          last_entry_id: update.lastEntryId,
          last_processed_entry_id: update.lastProcessedEntryId,
          pending_count: update.pendingCount ?? 0,
          consumer_count: update.consumerCount ?? 0,
          last_recovery_at: update.lastRecoveryAt,
          recovery_generation: update.recoveryGeneration ?? 0,
          last_heartbeat_at: update.lastHeartbeatAt,
          healthy: update.healthy ?? true,
          time_created: now,
          time_updated: now,
        })
        .onConflictDoUpdate({
          target: [
            StreamStateTable.stream_name,
            StreamStateTable.consumer_group,
          ],
          set: {
            last_entry_id: update.lastEntryId,
            last_processed_entry_id: update.lastProcessedEntryId,
            pending_count: update.pendingCount,
            consumer_count: update.consumerCount,
            last_recovery_at: update.lastRecoveryAt,
            recovery_generation: update.recoveryGeneration,
            last_heartbeat_at: update.lastHeartbeatAt,
            healthy: update.healthy,
            time_updated: now,
          },
        })
        .returning()
        .execute()
      return state
    })
  }

  listDeadLetters(
    filter?: DeadLetterFilter
  ): Effect.Effect<DeadLetter[], DatabaseError> {
    return this.query(async db => {
      let query = db.select().from(DeadLetterTable)

      if (filter?.workId) {
        query = query.where(db.eq(DeadLetterTable.work_id, filter.workId))
      }
      if (filter?.reason) {
        query = query.where(db.eq(DeadLetterTable.reason, filter.reason))
      }
      if (filter?.requiresManualIntervention !== undefined) {
        query = query.where(
          db.eq(
            DeadLetterTable.requires_manual_intervention,
            filter.requiresManualIntervention
          )
        )
      }
      if (filter?.limit) {
        query = query.limit(filter.limit)
      }

      const deadLetters = await query.execute()
      return deadLetters
    })
  }

  getDeadLetter(
    workId: string
  ): Effect.Effect<DeadLetter | null, DatabaseError> {
    return this.query(async db => {
      const [deadLetter] = await db
        .select()
        .from(DeadLetterTable)
        .where(db.eq(DeadLetterTable.work_id, workId))
        .execute()
      return deadLetter ?? null
    })
  }

  getRecoveryReceipts(
    workId: string
  ): Effect.Effect<RecoveryReceipt[], DatabaseError> {
    return this.query(async db => {
      const receipts = await db
        .select()
        .from(RecoveryReceiptTable)
        .where(db.eq(RecoveryReceiptTable.work_id, workId))
        .orderBy(db.desc(RecoveryReceiptTable.recovered_at))
        .execute()
      return receipts
    })
  }

  // ── Batch Operations ─────────────────────────────────────────────────

  getWorkItems(workIds: string[]): Effect.Effect<Map<string, WorkItem>, DatabaseError> {
    if (workIds.length === 0) return Effect.succeed(new Map())

    return this.query(async db => {
      const workItems = await db
        .select()
        .from(WorkItemTable)
        .where(db.inArray(WorkItemTable.id, workIds))
        .execute()

      const map = new Map<string, WorkItem>()
      for (const item of workItems) {
        map.set(item.id, item)
      }
      return map
    })
  }

  checkWorkTerminal(
    workIds: string[]
  ): Effect.Effect<Map<string, boolean>, DatabaseError> {
    if (workIds.length === 0) return Effect.succeed(new Map())

    return this.query(async db => {
      const workItems = await db
        .select({ id: WorkItemTable.id, status: WorkItemTable.status })
        .from(WorkItemTable)
        .where(db.inArray(WorkItemTable.id, workIds))
        .execute()

      const terminalStates: WorkItemStatus[] = [
        "completed",
        "failed_terminal",
        "cancelled",
        "superseded",
        "dead_lettered",
      ]

      const map = new Map<string, boolean>()
      for (const item of workItems) {
        map.set(item.id, terminalStates.includes(item.status))
      }

      // Ensure all requested IDs are in the map
      for (const id of workIds) {
        if (!map.has(id)) {
          map.set(id, false)
        }
      }

      return map
    })
  }
}

// ── Fake Implementation for Unit Tests ───────────────────────────────────

/**
 * FakeWorkQueueStore is a deterministic, in-memory implementation for unit tests.
 * It simulates PGlite behavior without requiring a real database.
 */
export class FakeWorkQueueStore implements WorkQueueDurableStore {
  private workItems = new Map<string, WorkItem>()
  private workAttempts = new Map<string, WorkAttempt[]>()
  private deadLetters = new Map<string, DeadLetter>()
  private recoveryReceipts: RecoveryReceipt[] = []
  private scheduledWork = new Map<string, ScheduledWork>()
  private streamStates = new Map<string, StreamState>()
  private quarantineRecords = new Map<string, QuarantineRecord>()

  private nextAttemptNumber(workId: string): number {
    const attempts = this.workAttempts.get(workId) ?? []
    return attempts.length + 1
  }

  // ── Lifecycle Transitions ────────────────────────────────────────────

  createWorkItem(input: WorkItemInput): Effect.Effect<WorkItem, DatabaseError> {
    return Effect.succeed(this._createWorkItemSync(input))
  }

  private _createWorkItemSync(input: WorkItemInput): WorkItem {
    const now = Date.now()
    const workItem: WorkItem = {
      id: input.id,
      session_id: input.sessionId,
      project_id: input.projectId,
      work_kind: input.workKind,
      schema_version: input.schemaVersion,
      status: "created",
      correlation_id: input.correlationId,
      parent_mission_id: input.missionId,
      parent_session_id: input.parentSessionId,
      routing_tags: input.routingTags,
      attempt_count: 0,
      max_attempts: input.maxAttempts ?? 3,
      reclaim_count: 0,
      max_reclaims: input.maxReclaims ?? 5,
      stream_name: undefined,
      stream_entry_id: undefined,
      consumer_group: undefined,
      consumer_id: undefined,
      created_at: now,
      enqueued_at: undefined,
      started_at: undefined,
      completed_at: undefined,
      result_ref: undefined,
      error_classification: undefined,
      recovered_from_crash: false,
      recovery_reason: undefined,
      time_created: now,
      time_updated: now,
    }
    this.workItems.set(workItem.id, workItem)
    return workItem
  }

  markEnqueuePending(
    workId: string,
    streamName: string,
    consumerGroup: string
  ): Effect.Effect<WorkItem, DatabaseError> {
    return Effect.succeed(this._markEnqueuePendingSync(workId, streamName, consumerGroup))
  }

  private _markEnqueuePendingSync(workId: string, streamName: string, consumerGroup: string): WorkItem {
    const workItem = this.workItems.get(workId)
    if (!workItem) {
      throw new Error(`Work item ${workId} not found`)
    }
    if (workItem.status !== "created") {
      throw new Error(
        `Work item ${workId} not in 'created' status (current: ${workItem.status})`
      )
    }
    workItem.status = "enqueue_pending"
    workItem.stream_name = streamName
    workItem.consumer_group = consumerGroup
    workItem.time_updated = Date.now()
    return workItem
  }

  markEnqueued(
    workId: string,
    entryId: string,
    streamName: string,
    consumerGroup: string
  ): Effect.Effect<WorkItem, DatabaseError> {
    return Effect.succeed(this._markEnqueuedSync(workId, entryId, streamName, consumerGroup))
  }

  private _markEnqueuedSync(workId: string, entryId: string, streamName: string, consumerGroup: string): WorkItem {
    const workItem = this.workItems.get(workId)
    if (!workItem) {
      throw new Error(`Work item ${workId} not found`)
    }
    if (!["created", "enqueue_pending"].includes(workItem.status)) {
      throw new Error(
        `Work item ${workId} not in enqueueable status (current: ${workItem.status})`
      )
    }
    workItem.status = "enqueued"
    workItem.stream_name = streamName
    workItem.stream_entry_id = entryId
    workItem.consumer_group = consumerGroup
    workItem.enqueued_at = Date.now()
    workItem.time_updated = Date.now()
    return workItem
  }

  startAttempt(input: AttemptInput): Effect.Effect<WorkAttempt, DatabaseError> {
    return Effect.succeed(this._startAttemptSync(input))
  }

  private _startAttemptSync(input: AttemptInput): WorkAttempt {
    const now = Date.now()
    const attempt: WorkAttempt = {
      id: `${input.workId}:attempt:${input.attemptNumber}:${now}`,
      work_id: input.workId,
      attempt_number: input.attemptNumber,
      stream_name: input.streamName,
      stream_entry_id: input.streamEntryId,
      consumer_group: input.consumerGroup,
      consumer_id: input.consumerId,
      worker_id: input.workerId,
      status: "started",
      started_at: input.startedAt,
      finished_at: undefined,
      result_ref: undefined,
      error_kind: undefined,
      error_message: undefined,
      produced_terminal_fact: false,
      was_reclaimed: false,
      reclaimed_from_consumer: undefined,
      reclaimed_at: undefined,
      time_created: now,
      time_updated: now,
    }
    const attempts = this.workAttempts.get(input.workId) ?? []
    attempts.push(attempt)
    this.workAttempts.set(input.workId, attempts)
    return attempt
  }

  // ── Terminal Transitions ──────────────────────────────────────────────

  completeTerminal(
    workId: string,
    resultRef: string
  ): Effect.Effect<{ workItem: WorkItem; attempt: WorkAttempt }, DatabaseError> {
    return Effect.succeed(this._completeTerminalSync(workId, resultRef))
  }

  private _completeTerminalSync(workId: string, resultRef: string): { workItem: WorkItem; attempt: WorkAttempt } {
    const workItem = this.workItems.get(workId)
    if (!workItem) {
      throw new Error(`Work item ${workId} not found`)
    }

    const terminalStates: WorkItemStatus[] = [
      "completed",
      "failed_terminal",
      "cancelled",
      "superseded",
      "dead_lettered",
    ]
    if (terminalStates.includes(workItem.status)) {
      const existingAttempts = this.workAttempts.get(workId) ?? []
      const terminalAttempt = existingAttempts.find(a => a.produced_terminal_fact)
      if (!terminalAttempt) {
        throw new Error(`Terminal work item ${workId} exists but no terminal attempt`)
      }
      return { workItem, attempt: terminalAttempt }
    }

    workItem.status = "completed"
    workItem.completed_at = Date.now()
    workItem.result_ref = resultRef
    workItem.attempt_count++
    workItem.time_updated = Date.now()

    const attemptNumber = this.nextAttemptNumber(workId)
    const attempt: WorkAttempt = {
      id: `${workId}:attempt:${attemptNumber}:${Date.now()}`,
      work_id: workId,
      attempt_number: attemptNumber,
      status: "completed",
      started_at: Date.now(),
      finished_at: Date.now(),
      result_ref: resultRef,
      produced_terminal_fact: true,
      consumer_id: "fake-consumer",
      was_reclaimed: false,
      time_created: Date.now(),
      time_updated: Date.now(),
    }
    const attempts = this.workAttempts.get(workId) ?? []
    attempts.push(attempt)
    this.workAttempts.set(workId, attempts)

    return { workItem, attempt }
  }

  failTerminal(
    workId: string,
    errorKind: string,
    errorMessage: string
  ): Effect.Effect<{ workItem: WorkItem; attempt: WorkAttempt }, DatabaseError> {
    return Effect.succeed(this._failTerminalSync(workId, errorKind, errorMessage))
  }

  private _failTerminalSync(workId: string, errorKind: string, errorMessage: string): { workItem: WorkItem; attempt: WorkAttempt } {
    const workItem = this.workItems.get(workId)
    if (!workItem) {
      throw new Error(`Work item ${workId} not found`)
    }

    const terminalStates: WorkItemStatus[] = [
      "completed",
      "failed_terminal",
      "cancelled",
      "superseded",
      "dead_lettered",
    ]
    if (terminalStates.includes(workItem.status)) {
      const existingAttempts = this.workAttempts.get(workId) ?? []
      const terminalAttempt = existingAttempts.find(a => a.produced_terminal_fact)
      if (!terminalAttempt) {
        throw new Error(`Terminal work item ${workId} exists but no terminal attempt`)
      }
      return { workItem, attempt: terminalAttempt }
    }

    workItem.status = "failed_terminal"
    workItem.error_classification = errorKind
    workItem.completed_at = Date.now()
    workItem.attempt_count++
    workItem.time_updated = Date.now()

    const attemptNumber = this.nextAttemptNumber(workId)
    const attempt: WorkAttempt = {
      id: `${workId}:attempt:${attemptNumber}:${Date.now()}`,
      work_id: workId,
      attempt_number: attemptNumber,
      status: "failed",
      started_at: Date.now(),
      finished_at: Date.now(),
      error_kind: errorKind,
      error_message: errorMessage,
      produced_terminal_fact: true,
      consumer_id: "fake-consumer",
      was_reclaimed: false,
      time_created: Date.now(),
      time_updated: Date.now(),
    }
    const attempts = this.workAttempts.get(workId) ?? []
    attempts.push(attempt)
    this.workAttempts.set(workId, attempts)

    return { workItem, attempt }
  }

  failRetryableAndSchedule(
    workId: string,
    errorKind: string,
    errorMessage: string,
    retryAfterMs: number,
    reason?: string
  ): Effect.Effect<
    { workItem: WorkItem; attempt: WorkAttempt; scheduledWork: ScheduledWork },
    DatabaseError
  > {
    return Effect.succeed(this._failRetryableAndScheduleSync(workId, errorKind, errorMessage, retryAfterMs, reason))
  }

  private _failRetryableAndScheduleSync(
    workId: string,
    errorKind: string,
    errorMessage: string,
    retryAfterMs: number,
    reason?: string
  ): { workItem: WorkItem; attempt: WorkAttempt; scheduledWork: ScheduledWork } {
    const workItem = this.workItems.get(workId)
    if (!workItem) {
      throw new Error(`Work item ${workId} not found`)
    }

    const terminalStates: WorkItemStatus[] = [
      "completed",
      "failed_terminal",
      "cancelled",
      "superseded",
      "dead_lettered",
    ]
    if (terminalStates.includes(workItem.status)) {
      throw new Error(`Work item ${workId} already terminal`)
    }

    const attemptNumber = this.nextAttemptNumber(workId)
    const now = Date.now()
    const dueAt = now + retryAfterMs

    workItem.status = "retry_scheduled"
    workItem.error_classification = errorKind
    workItem.attempt_count = attemptNumber
    workItem.time_updated = now

    const attempt: WorkAttempt = {
      id: `${workId}:attempt:${attemptNumber}:${now}`,
      work_id: workId,
      attempt_number: attemptNumber,
      status: "failed",
      started_at: now,
      finished_at: now,
      error_kind: errorKind,
      error_message: errorMessage,
      produced_terminal_fact: false,
      consumer_id: "fake-consumer",
      was_reclaimed: false,
      time_created: now,
      time_updated: now,
    }
    const attempts = this.workAttempts.get(workId) ?? []
    attempts.push(attempt)
    this.workAttempts.set(workId, attempts)

    const scheduledWorkId = `${workId}:scheduled:${attemptNumber}:${now}`
    const scheduledWork: ScheduledWork = {
      id: scheduledWorkId,
      work_id: workId,
      due_at: dueAt,
      scheduled_at: now,
      retry_count: attemptNumber,
      max_retries: workItem.max_attempts,
      backoff_policy: "exponential",
      next_retry_delay_ms: retryAfterMs,
      status: "scheduled",
      reason: reason ?? errorKind,
      time_created: now,
      time_updated: now,
    }
    this.scheduledWork.set(scheduledWorkId, scheduledWork)

    return { workItem, attempt, scheduledWork }
  }

  deadLetter(
    input: DeadLetterInput
  ): Effect.Effect<
    { workItem: WorkItem; deadLetter: DeadLetter; attempt: WorkAttempt },
    DatabaseError
  > {
    return Effect.succeed(this._deadLetterSync(input))
  }

  private _deadLetterSync(input: DeadLetterInput): { workItem: WorkItem; deadLetter: DeadLetter; attempt: WorkAttempt } {
    const workItem = this.workItems.get(input.workId)
    if (!workItem) {
      throw new Error(`Work item ${input.workId} not found`)
    }

    const terminalStates: WorkItemStatus[] = [
      "completed",
      "failed_terminal",
      "cancelled",
      "superseded",
      "dead_lettered",
    ]
    if (terminalStates.includes(workItem.status)) {
      const existingDeadLetter = this.deadLetters.get(input.workId)
      const existingAttempts = this.workAttempts.get(input.workId) ?? []
      const terminalAttempt = existingAttempts.find(a => a.produced_terminal_fact)
      if (!existingDeadLetter || !terminalAttempt) {
        throw new Error(`Terminal work item ${input.workId} exists but missing records`)
      }
      return { workItem, deadLetter: existingDeadLetter, attempt: terminalAttempt }
    }

    const attemptNumber = this.nextAttemptNumber(input.workId)
    const now = Date.now()

    workItem.status = "dead_lettered"
    workItem.error_classification = input.lastErrorKind
    workItem.completed_at = now
    workItem.attempt_count = attemptNumber
    workItem.reclaim_count = input.reclaimCount
    workItem.time_updated = now

    const attempt: WorkAttempt = {
      id: `${input.workId}:attempt:${attemptNumber}:${now}`,
      work_id: input.workId,
      attempt_number: attemptNumber,
      status: "failed",
      started_at: now,
      finished_at: now,
      error_kind: input.lastErrorKind,
      error_message: input.lastErrorMessage,
      produced_terminal_fact: true,
      consumer_id: "fake-consumer",
      was_reclaimed: false,
      time_created: now,
      time_updated: now,
    }
    const attempts = this.workAttempts.get(input.workId) ?? []
    attempts.push(attempt)
    this.workAttempts.set(input.workId, attempts)

    const deadLetter: DeadLetter = {
      id: `${input.workId}:dl:${now}`,
      work_id: input.workId,
      reason: input.reason,
      work_kind: input.workKind,
      attempt_count: input.attemptCount,
      reclaim_count: input.reclaimCount,
      last_error_kind: input.lastErrorKind,
      last_error_message: input.lastErrorMessage,
      stream_name: input.streamName,
      stream_entry_id: input.streamEntryId,
      consumer_group: input.consumerGroup,
      last_consumer_id: input.lastConsumerId,
      can_be_retried: input.canBeRetried ?? false,
      retry_after_ms: input.retryAfterMs ? BigInt(input.retryAfterMs) : undefined,
      requires_manual_intervention: input.requiresManualIntervention ?? false,
      manual_intervention_notes: input.manualInterventionNotes,
      dead_lettered_at: now,
      time_created: now,
      time_updated: now,
    }
    this.deadLetters.set(deadLetter.id, deadLetter)

    return { workItem, deadLetter, attempt }
  }

  // ── Quarantine ────────────────────────────────────────────────────────

  quarantineStreamEntry(
    input: QuarantineInput
  ): Effect.Effect<QuarantineRecord, DatabaseError> {
    return Effect.succeed(this._quarantineStreamEntrySync(input))
  }

  private _quarantineStreamEntrySync(input: QuarantineInput): QuarantineRecord {
    const now = Date.now()
    const quarantineId = `${input.entryId}:quarantine:${now}`
    const record: QuarantineRecord = {
      id: quarantineId,
      entry_id: input.entryId,
      stream_name: input.streamName,
      work_id: input.workId,
      reason: input.reason,
      context: input.context,
      resolved: false,
      created_at: input.createdAt,
      time_created: now,
      time_updated: now,
    }
    this.quarantineRecords.set(quarantineId, record)
    return record
  }

  getQuarantineRecord(
    entryId: string
  ): Effect.Effect<QuarantineRecord | null, DatabaseError> {
    return Effect.succeed(this._getQuarantineRecordSync(entryId))
  }

  private _getQuarantineRecordSync(entryId: string): QuarantineRecord | null {
    for (const record of this.quarantineRecords.values()) {
      if (record.entry_id === entryId) {
        return record
      }
    }
    return null
  }

  listQuarantinedEntries(): Effect.Effect<QuarantineRecord[], DatabaseError> {
    return Effect.succeed(Array.from(this.quarantineRecords.values()))
  }

  // ── Recovery Audit ─────────────────────────────────────────────────────

  recordRecoveryReceipt(
    input: RecoveryReceiptInput
  ): Effect.Effect<RecoveryReceipt, DatabaseError> {
    return Effect.succeed(this._recordRecoveryReceiptSync(input))
  }

  private _recordRecoveryReceiptSync(input: RecoveryReceiptInput): RecoveryReceipt {
    const now = Date.now()
    const receipt: RecoveryReceipt = {
      id: `${input.workId}:recovery:${input.action}:${now}`,
      work_id: input.workId,
      stream_entry_id: input.streamEntryId,
      action: input.action,
      recovered_by_consumer: input.recoveredByConsumer,
      original_consumer: input.originalConsumer,
      recovered_at: input.recoveredAt,
      idle_duration_ms: input.idleDurationMs,
      outcome_reason: input.outcomeReason,
      stream_name: input.streamName,
      consumer_group: input.consumerGroup,
      was_pending: input.wasPending ?? true,
      was_terminal: input.wasTerminal ?? false,
      time_created: now,
      time_updated: now,
    }
    this.recoveryReceipts.push(receipt)
    return receipt
  }

  // ── Promotion ──────────────────────────────────────────────────────────

  markPromotion(
    workId: string,
    scheduledWorkId: string,
    entryId: string,
    generation: number
  ): Effect.Effect<ScheduledWork, DatabaseError> {
    return Effect.succeed(this._markPromotionSync(workId, scheduledWorkId, entryId, generation))
  }

  private _markPromotionSync(workId: string, scheduledWorkId: string, entryId: string, generation: number): ScheduledWork {
    const scheduledWork = this.scheduledWork.get(scheduledWorkId)
    if (!scheduledWork) {
      throw new Error(`Scheduled work ${scheduledWorkId} not found`)
    }
    if (scheduledWork.status !== "scheduled") {
      throw new Error(
        `Scheduled work ${scheduledWorkId} not in 'scheduled' status`
      )
    }

    scheduledWork.status = "promoted"
    scheduledWork.promoted_at = Date.now()
    scheduledWork.promoted_to_stream = "tribunus:work"
    scheduledWork.promoted_stream_entry_id = entryId
    scheduledWork.time_updated = Date.now()

    return scheduledWork
  }

  // ── Query Methods ─────────────────────────────────────────────────────

  getWorkItem(workId: string): Effect.Effect<WorkItem | null, DatabaseError> {
    return Effect.succeed(this.workItems.get(workId) ?? null)
  }

  getWorkStatus(
    workId: string
  ): Effect.Effect<WorkItemStatus | null, DatabaseError> {
    return Effect.succeed(this.workItems.get(workId)?.status ?? null)
  }

  isWorkTerminal(workId: string): Effect.Effect<boolean, DatabaseError> {
    return this.getWorkStatus(workId).pipe(
      Effect.map(status => {
        if (!status) return false
        return [
          "completed",
          "failed_terminal",
          "cancelled",
          "superseded",
          "dead_lettered",
        ].includes(status)
      })
    )
  }
  getLatestAttempt(
    workId: string
  ): Effect.Effect<WorkAttempt | null, DatabaseError> {
    const attempts = this.workAttempts.get(workId) ?? []
    if (attempts.length === 0) return Effect.succeed(null)
    return Effect.succeed(attempts[attempts.length - 1])
  }

  listNonTerminalWorkByStream(
    streamName: string
  ): Effect.Effect<WorkItem[], DatabaseError> {
    const terminalStates: WorkItemStatus[] = [
      "completed",
      "failed_terminal",
      "cancelled",
      "superseded",
      "dead_lettered",
    ]
    const result: WorkItem[] = []
    for (const workItem of this.workItems.values()) {
      if (workItem.stream_name === streamName && !terminalStates.includes(workItem.status)) {
        result.push(workItem)
      }
    }
    return Effect.succeed(result)
  }

  listScheduledWork(
    dueBefore: number,
    limit: number = 100
  ): Effect.Effect<ScheduledWork[], DatabaseError> {
    const result: ScheduledWork[] = []
    for (const sw of this.scheduledWork.values()) {
      if (sw.status === "scheduled" && sw.due_at <= dueBefore) {
        result.push(sw)
      }
    }
    result.sort((a, b) => a.due_at - b.due_at)
    return Effect.succeed(result.slice(0, limit))
  }

  getStreamState(
    streamName: string,
    consumerGroup: string
  ): Effect.Effect<StreamState | null, DatabaseError> {
    return Effect.succeed(this.streamStates.get(`${streamName}:${consumerGroup}`) ?? null)
  }

  getStreamStateByEntryId(
    entryId: string
  ): Effect.Effect<StreamState | null, DatabaseError> {
    for (const state of this.streamStates.values()) {
      if (state.last_entry_id === entryId) {
        return Effect.succeed(state)
      }
    }
    return Effect.succeed(null)
  }



  getActiveStreamStateForWork(
    workId: string
  ): Effect.Effect<StreamState | null, DatabaseError> {
    return this.getWorkItem(workId).pipe(
      Effect.map(workItem => {
        if (!workItem?.stream_name) return null
        return this.streamStates.get(`${workItem.stream_name}:tribunus:workers`) ?? null
      })
    )
  }

  updateStreamState(
    update: StreamStateUpdate
  ): Effect.Effect<StreamState, DatabaseError> {
    const now = Date.now()
    const key = `${update.streamName}:${update.consumerGroup}`
    const state: StreamState = {
      id: key,
      stream_name: update.streamName,
      consumer_group: update.consumerGroup,
      last_entry_id: update.lastEntryId,
      last_processed_entry_id: update.lastProcessedEntryId,
      pending_count: update.pendingCount ?? 0,
      consumer_count: update.consumerCount ?? 0,
      last_recovery_at: update.lastRecoveryAt,
      recovery_generation: update.recoveryGeneration ?? 0,
      last_heartbeat_at: update.lastHeartbeatAt,
      healthy: update.healthy ?? true,
      time_created: now,
      time_updated: now,
    }
    this.streamStates.set(key, state)
    return Effect.succeed(state)
  }

  listDeadLetters(
    filter?: DeadLetterFilter
  ): Effect.Effect<DeadLetter[], DatabaseError> {
    let result = Array.from(this.deadLetters.values())
    if (filter?.workId) {
      result = result.filter(dl => dl.work_id === filter.workId)
    }
    if (filter?.reason) {
      result = result.filter(dl => dl.reason === filter.reason)
    }
    if (filter?.requiresManualIntervention !== undefined) {
      result = result.filter(
        dl => dl.requires_manual_intervention === filter.requiresManualIntervention
      )
    }
    if (filter?.limit) {
      result = result.slice(0, filter.limit)
    }
    return Effect.succeed(result)
  }
  getDeadLetter(
    workId: string
  ): Effect.Effect<DeadLetter | null, DatabaseError> {
    for (const dl of this.deadLetters.values()) {
      if (dl.work_id === workId) {
        return Effect.succeed(dl)
      }
    }
    return Effect.succeed(null)
  }

  getRecoveryReceipts(
    workId: string
  ): Effect.Effect<RecoveryReceipt[], DatabaseError> {
    return Effect.succeed(this.recoveryReceipts.filter(r => r.work_id === workId))
  }
  // ── Batch Operations ─────────────────────────────────────────────────

  getWorkItems(workIds: string[]): Effect.Effect<Map<string, WorkItem>, DatabaseError> {
    if (workIds.length === 0) return Effect.succeed(new Map())
    const map = new Map<string, WorkItem>()
    for (const id of workIds) {
      const workItem = this.workItems.get(id)
      if (workItem) {
        map.set(id, workItem)
      }
    }
    return Effect.succeed(map)
  }

  checkWorkTerminal(
    workIds: string[]
  ): Effect.Effect<Map<string, boolean>, DatabaseError> {
    if (workIds.length === 0) return Effect.succeed(new Map())
    const map = new Map<string, boolean>()
    for (const id of workIds) {
      map.set(id, this.workItems.has(id) && this._isTerminalSync(id))
    }
    return Effect.succeed(map)
  }

  private _isTerminalSync(workId: string): boolean {
    const workItem = this.workItems.get(workId)
    if (!workItem) return false
    return [
      "completed",
      "failed_terminal",
      "cancelled",
      "superseded",
      "dead_lettered",
    ].includes(workItem.status)
  }
}

// ── Layer Definitions ────────────────────────────────────────────────────

/**
 * Layer for the real PGlite-backed durable store.
 * Requires a DatabaseAdapter to be available in the context.
 */
export const PGliteWorkQueueStoreLayer = Layer.effect(
  WorkQueueDurableStoreService,
  Effect.map(
    DatabaseAdapter.Service,
    db => new WorkQueueDurableStoreService(new PGliteWorkQueueStore(db))
  )
)

/**
 * Layer for the fake durable store for unit tests.
 * Uses an in-memory implementation that doesn't require a real database.
 */
export const FakeWorkQueueStoreLayer = Layer.effect(
  WorkQueueDurableStoreService,
  Effect.sync(() => {
    const fakeStore = new FakeWorkQueueStore()
    return new WorkQueueDurableStoreService(fakeStore)
  })
)

/**
 * Type-safe access to the WorkQueueDurableStore from Effect context.
 */
export const WorkQueueDurableStore = WorkQueueDurableStoreService
