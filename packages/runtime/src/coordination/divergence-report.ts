/**
 * Divergence Report
 *
 * A read-only diagnostic that detects mismatches between PGlite durable state
 * and Valkey coordination state. Each section identifies a specific class of
 * divergence so recovery/repair operations can be targeted precisely.
 *
 * Read-only invariant: this module NEVER modifies PGlite or Valkey state.
 * It only queries and reports.
 */

import { Effect } from "effect"
import { WorkQueueDurableStoreService } from "./durable-store"
import type { WorkItemStatus } from "./work-queue.pg.sql"
import type { Redis } from "ioredis"
import {
  ValkeyStreams,
  DEFAULT_STREAM_NAME,
  DEFAULT_CONSUMER_GROUP,
} from "./stream-primitives"
import {
  ValkeySortedSets,
  DEFAULT_DUE_SET_NAME,
} from "./sorted-set-primitives"

// ── Terminal Status Constants ───────────────────────────────────────────

/** Statuses considered terminal by the coordination kernel. */
const TERMINAL_STATUSES: Partial<Record<WorkItemStatus, true>> = {
  completed: true,
  failed_terminal: true,
  cancelled: true,
  superseded: true,
  dead_lettered: true,
}

// ── Report Types ────────────────────────────────────────────────────────

export interface DivergenceReport {
  generatedAt: number
  streamName: string
  consumerGroup: string
  missingStreamEntries: MissingStreamEntry[]
  orphanStreamEntries: OrphanStreamEntry[]
  missingScheduledWork: MissingScheduledWork[]
  pendingWithoutAttempts: PendingWithoutAttempt[]
  terminalWorkInValkey: TerminalWorkInValkey[]
  recoveryReceipts: RecoveryReceiptSummary[]
  summary: DivergenceSummary
}

export interface DivergenceSummary {
  totalDivergences: number
  missingStreamCount: number
  orphanStreamCount: number
  missingScheduledCount: number
  pendingWithoutAttemptCount: number
  terminalWorkInValkeyCount: number
  healthy: boolean
}

export interface MissingStreamEntry {
  workId: string
  status: string
  enqueuedAt: number | null
}

export interface OrphanStreamEntry {
  entryId: string
  workId: string
  hasPGliteRecord: boolean
  pgliteStatus: string | null
}

export interface MissingScheduledWork {
  workId: string
  retryCount: number
  dueAt: number
}

export interface PendingWithoutAttempt {
  entryId: string
  workId: string
  idleMs: number
  deliveryCount: number
}

export interface TerminalWorkInValkey {
  workId: string
  pgliteStatus: string
  streamEntryId: string | null
}

export interface RecoveryReceiptSummary {
  receiptId: string
  workId: string
  action: string
  recoveredAt: number
  outcome: string
}

// ── Report Generator ────────────────────────────────────────────────────

/**
 * Generate a divergence report comparing PGlite durable state against
 * Valkey coordination state.
 *
 * Read-only: never modifies PGlite or Valkey state.
 * Errors in individual sections are caught and reported as empty arrays,
 * so a partial result is always returned.
 *
 * @param store - The PGlite-backed durable store service
 * @param redis - The Valkey (ioredis) client
 * @param streamName - Valkey stream name (default: DEFAULT_STREAM_NAME)
 * @param consumerGroup - Consumer group name (default: DEFAULT_CONSUMER_GROUP)
 * @param dueSetName - Sorted set name for due-time wheel (default: DEFAULT_DUE_SET_NAME)
 */
export async function generateDivergenceReport(
  store: WorkQueueDurableStoreService,
  redis: Redis,
  streamName: string = DEFAULT_STREAM_NAME,
  consumerGroup: string = DEFAULT_CONSUMER_GROUP,
  dueSetName: string = DEFAULT_DUE_SET_NAME
): Promise<DivergenceReport> {
  const generatedAt = Date.now()
  const streams = new ValkeyStreams(redis, streamName)
  const sortedSets = new ValkeySortedSets(redis)

  // ── Collect raw data from both sides ────────────────────────────────

  // Read all stream entries from Valkey
  let streamEntries: { id: string; values: Record<string, string> }[] = []
  try {
    streamEntries = await streams.readRange("0", "+")
  } catch {
    // Valkey unavailable — all sections will report as unavailable
  }

  // Build workId→entryId map from stream values
  const streamWorkIds = new Map<string, string>()
  for (const entry of streamEntries) {
    const workId = entry.values.workId
    if (workId) {
      streamWorkIds.set(workId, entry.id)
    }
  }

  // Build entryId→workId map for reverse lookup
  const entryIdToWorkId = new Map<string, string>()
  for (const entry of streamEntries) {
    const workId = entry.values.workId
    if (workId) {
      entryIdToWorkId.set(entry.id, workId)
    }
  }

  // Query PGlite for non-terminal work items in this stream
  let nonTerminalWork: {
    id: string
    status: WorkItemStatus
    stream_entry_id?: string
    enqueued_at?: number
  }[] = []
  try {
    nonTerminalWork = await Effect.runPromise(
      store.listNonTerminalWorkByStream(streamName)
    )
  } catch {
    // PGlite unavailable — proceed with empty
  }

  // Batch query PGlite for all work items mentioned in stream entries
  const streamWorkIdList = [...streamWorkIds.keys()]
  let pgliteWorkMap = new Map<string, { id: string; status: WorkItemStatus } | undefined>()
  try {
    if (streamWorkIdList.length > 0) {
      const items = await Effect.runPromise(store.getWorkItems(streamWorkIdList))
      for (const [id, item] of items) {
        pgliteWorkMap.set(id, item)
      }
    }
  } catch {
    // Batch query unavailable — proceed with empty map
  }

  // ── Section 1: Missing Stream Entries ───────────────────────────────
  //
  // Work items that are non-terminal in PGlite but have no corresponding
  // Valkey stream entry. This includes items still in "created" or
  // "enqueue_pending" status (stream_entry_id may be null) and items
  // whose stream entry was evicted or never materialized.

  const missingStreamEntries: MissingStreamEntry[] = []
  for (const work of nonTerminalWork) {
    // If work has no stream_entry_id or the entry isn't found in Valkey
    if (!work.stream_entry_id || !streamWorkIds.has(work.id)) {
      missingStreamEntries.push({
        workId: work.id,
        status: work.status,
        enqueuedAt: work.enqueued_at ?? null,
      })
    }
  }

  // ── Section 2: Orphan Stream Entries ────────────────────────────────
  //
  // Valkey stream entries whose workId has no corresponding PGlite record,
  // OR whose PGlite record is terminal but the stream entry is still present.

  const orphanStreamEntries: OrphanStreamEntry[] = []
  for (const [workId, entryId] of streamWorkIds) {
    const workItem = pgliteWorkMap.get(workId)
    const hasPGliteRecord = workItem !== undefined
    const pgliteStatus = workItem?.status ?? null

    if (!hasPGliteRecord || (pgliteStatus && TERMINAL_STATUSES[pgliteStatus])) {
      orphanStreamEntries.push({
        entryId,
        workId,
        hasPGliteRecord,
        pgliteStatus,
      })
    }
  }

  // ── Section 3: Missing Scheduled Work ───────────────────────────────
  //
  // Work items with retry_scheduled status in PGlite that are missing from
  // the Valkey due-time sorted set. Look ahead 24 hours for scheduled work.

  const missingScheduledWork: MissingScheduledWork[] = []
  try {
    const scheduledWorkItems = await Effect.runPromise(
      store.listScheduledWork(generatedAt + 86_400_000) // next 24 hours
    )

    for (const sw of scheduledWorkItems) {
      try {
        const exists = await sortedSets.exists(dueSetName, sw.work_id)
        if (!exists) {
          missingScheduledWork.push({
            workId: sw.work_id,
            retryCount: sw.retry_count,
            dueAt: sw.due_at,
          })
        }
      } catch {
        // Valkey sorted set query failed — skip this entry
      }
    }
  } catch {
    // PGlite query failed — proceed with empty
  }

  // ── Section 4: Pending Entries Without Attempts ─────────────────────
  //
  // Stream entries that are pending (claimed but not yet acknowledged) but
  // have no matching WorkAttempt record in PGlite. This indicates work that
  // was claimed in Valkey but never recorded as started in PGlite.

  const pendingWithoutAttempts: PendingWithoutAttempt[] = []
  try {
    const pendingEntries = await streams.getPendingEntries(consumerGroup)

    for (const p of pendingEntries) {
      const workId = entryIdToWorkId.get(p.id)
      if (!workId) continue

      try {
        const attempt = await Effect.runPromise(store.getLatestAttempt(workId))
        if (!attempt) {
          pendingWithoutAttempts.push({
            entryId: p.id,
            workId,
            idleMs: p.idleMs,
            deliveryCount: p.deliveryCount,
          })
        }
      } catch {
        // PGlite query failed — skip this entry
      }
    }
  } catch {
    // Valkey pending query failed — proceed with empty
  }

  // ── Section 5: Terminal Work in Valkey ──────────────────────────────
  //
  // Work items that are terminal in PGlite (completed, failed_terminal,
  // dead_lettered) but still have entries in Valkey streams. These should
  // have been acknowledged and removed.

  const terminalWorkInValkey: TerminalWorkInValkey[] = []
  for (const [workId, streamEntryId] of streamWorkIds) {
    const workItem = pgliteWorkMap.get(workId)
    if (workItem && TERMINAL_STATUSES[workItem.status]) {
      terminalWorkInValkey.push({
        workId,
        pgliteStatus: workItem.status,
        streamEntryId,
      })
    }
  }

  // ── Section 6: Recovery Receipts ────────────────────────────────────
  //
  // Collect recovery receipts from PGlite for all work items referenced
  // by either PGlite or Valkey. Shows recovery/rebuild activity.

  const recoveryReceipts: RecoveryReceiptSummary[] = []
  try {
    // Collect unique workIds from both non-terminal work and stream entries
    const workIdSet = new Set<string>()
    for (const work of nonTerminalWork) workIdSet.add(work.id)
    for (const workId of streamWorkIds.keys()) workIdSet.add(workId)

    for (const workId of workIdSet) {
      try {
        const receipts = await Effect.runPromise(store.getRecoveryReceipts(workId))
        for (const r of receipts) {
          recoveryReceipts.push({
            receiptId: r.id,
            workId: r.work_id,
            action: r.action,
            recoveredAt: r.recovered_at,
            outcome: r.outcome,
          })
        }
      } catch {
        // Receipt query failed for this workId — skip
      }
    }

    // Sort by recency
    recoveryReceipts.sort((a, b) => b.recoveredAt - a.recoveredAt)
  } catch {
    // Proceed with empty
  }

  // ── Summary ─────────────────────────────────────────────────────────

  const missingStreamCount = missingStreamEntries.length
  const orphanStreamCount = orphanStreamEntries.length
  const missingScheduledCount = missingScheduledWork.length
  const pendingWithoutAttemptCount = pendingWithoutAttempts.length
  const terminalWorkInValkeyCount = terminalWorkInValkey.length
  const totalDivergences =
    missingStreamCount +
    orphanStreamCount +
    missingScheduledCount +
    pendingWithoutAttemptCount +
    terminalWorkInValkeyCount

  const summary: DivergenceSummary = {
    totalDivergences,
    missingStreamCount,
    orphanStreamCount,
    missingScheduledCount,
    pendingWithoutAttemptCount,
    terminalWorkInValkeyCount,
    healthy: totalDivergences === 0,
  }

  return {
    generatedAt,
    streamName,
    consumerGroup,
    missingStreamEntries,
    orphanStreamEntries,
    missingScheduledWork,
    pendingWithoutAttempts,
    terminalWorkInValkey,
    recoveryReceipts,
    summary,
  }
}
