/**
 * Work Queue Database Schema
 * 
 * Durable PGlite tables for the Valkey Stream-Backed Coordination Kernel.
 * 
 * Doctrine:
 * - PGlite owns ALL durable state, lifecycle facts, attempts, terminal results,
 *   recovery facts, and dead-letter records.
 * - Valkey owns stream delivery, pending ownership, group membership,
 *   scheduling sets, singleton coordination leases, heartbeats, and
 *   ephemeral progress.
 * - DuckDB remains downstream analytics/projection only.
 */

import { pgTable, text, integer, bigint, jsonb, primaryKey, index } from "drizzle-orm/pg-core"
import { TimestampsPg } from "@/storage/schema.pg.sql"
import type { SessionID } from "@/session/schema"
import type { ProjectID } from "@/project/schema"

// ── Work Item Status ──────────────────────────────────────────────────

/** Durable work item statuses */
export type WorkItemStatus =
  | "created"           // Work item created in PGlite, not yet enqueued
  | "enqueue_pending"  // Durable work item exists, XADD not yet performed
  | "enqueued"          // Work item enqueued in Valkey stream
  | "claimed"           // Work item claimed by a worker (Valkey pending)
  | "running"          // Worker is actively processing (audit fact, not authority)
  | "completed"        // Work completed successfully (terminal)
  | "failed_retryable" // Work failed but can be retried
  | "failed_terminal"  // Work failed terminally (terminal)
  | "cancelled"         // Work was cancelled (terminal)
  | "superseded"       // Work was superseded by newer work (terminal)
  | "dead_lettered"    // Work exhausted retries, dead-lettered (terminal)
  | "recovered"        // Work was recovered after crash
  | "retry_scheduled"  // Work has been scheduled for retry

// ── Work Item Table ──────────────────────────────────────────────────

/**
 * Work items are the durable units of work that the runtime wants performed.
 * Each work item has a stable identity in PGlite BEFORE it is made visible in Valkey.
 * This avoids orphan stream entries with no durable identity.
 */
export const WorkItemTable = pgTable(
  "coordination_work_item",
  {
    // Identity
    id: text().primaryKey(),
    
    // Context
    session_id: text().notNull().$type<SessionID>(),
    project_id: text().notNull().$type<ProjectID>(),
    
    // Work classification
    work_kind: text().notNull(),  // e.g., "tool_execution", "agent_task", "gate_check"
    schema_version: text().notNull().default("v1"),
    
    // Lifecycle
    status: text().notNull().$type<WorkItemStatus>(),
    
    // Routing metadata (content-light - references only)
    correlation_id: text(),
    parent_mission_id: text(),
    parent_session_id: text(),
    routing_tags: jsonb().$type<string[]>(),
    
    // Attempt tracking
    attempt_count: integer().notNull().default(0),
    max_attempts: integer().notNull().default(3),
    reclaim_count: integer().notNull().default(0),
    max_reclaims: integer().notNull().default(5),
    
    // Stream coordination (for reconciliation)
    stream_name: text(),
    stream_entry_id: text(),
    consumer_group: text(),
    consumer_id: text(),
    
    // Timestamps
    created_at: bigint({ mode: "number" }).notNull(),
    enqueued_at: bigint({ mode: "number" }),
    started_at: bigint({ mode: "number" }),
    completed_at: bigint({ mode: "number" }),
    
    // Result references (content-light - store references, not raw data)
    result_ref: text(),      // Reference to durable result in another table
    error_classification: text(),
    
    // Recovery
    recovered_from_crash: boolean().notNull().default(false),
    recovery_reason: text(),
    
    ...TimestampsPg,
  },
  (table) => [
    // Indexes for common query patterns
    index("coordination_work_item_session_idx").on(table.session_id),
    index("coordination_work_item_project_idx").on(table.project_id),
    index("coordination_work_item_status_idx").on(table.status),
    index("coordination_work_item_stream_idx").on(table.stream_name),
    index("coordination_work_item_created_idx").on(table.created_at),
    index("coordination_work_item_correlation_idx").on(table.correlation_id),
    
    // Composite indexes
    index("coordination_work_item_session_status_idx").on(
      table.session_id,
      table.status
    ),
    index("coordination_work_item_project_status_idx").on(
      table.project_id,
      table.status
    ),
  ]
)

// ── Work Attempt Table ────────────────────────────────────────────────

/**
 * Each attempt has its own durable record.
 * Attempts are append-only facts, not mutable state.
 * This enables audit trails and recovery.
 */
export const WorkAttemptTable = pgTable(
  "coordination_work_attempt",
  {
    // Identity
    id: text().primaryKey(),
    work_id: text().notNull().references(() => WorkItemTable.id),
    
    // Attempt sequencing
    attempt_number: integer().notNull(),
    
    // Stream coordination
    stream_name: text(),
    stream_entry_id: text(),
    consumer_group: text(),
    consumer_id: text().notNull(),
    worker_id: text(),
    
    // Lifecycle
    status: text().notNull().$type<"started" | "completed" | "failed" | "cancelled">(),
    
    // Timestamps
    started_at: bigint({ mode: "number" }).notNull(),
    finished_at: bigint({ mode: "number" }),
    
    // Result (content-light - references only)
    result_ref: text(),
    error_kind: text(),
    error_message: text(),
    
    // Whether this attempt produced the terminal durable fact
    produced_terminal_fact: boolean().notNull().default(false),
    
    // Reclaim information
    was_reclaimed: boolean().notNull().default(false),
    reclaimed_from_consumer: text(),
    reclaimed_at: bigint({ mode: "number" }),
    
    ...TimestampsPg,
  },
  (table) => [
    index("coordination_work_attempt_work_idx").on(table.work_id),
    index("coordination_work_attempt_work_attempt_idx").on(
      table.work_id,
      table.attempt_number
    ),
    index("coordination_work_attempt_consumer_idx").on(table.consumer_id),
    index("coordination_work_attempt_started_idx").on(table.started_at),
    index("coordination_work_attempt_status_idx").on(table.status),
  ]
)

// ── Dead Letter Table ─────────────────────────────────────────────────

/**
 * Dead-lettering is a TERMINAL durable state, not just a side queue.
 * When max attempts, max reclaims, schema incompatibility, missing durable
 * context, poison payload, or repeated worker failure makes a work item
 * unsafe to keep retrying, the system writes a PGlite dead_lettered fact.
 */
export type DeadLetterReason =
  | "max_attempts_exceeded"
  | "max_reclaims_exceeded"
  | "schema_incompatible"
  | "missing_context"
  | "poison_payload"
  | "repeated_failure"
  | "manual_intervention_required"
  | "timeout_exceeded"

export const DeadLetterTable = pgTable(
  "coordination_dead_letter",
  {
    // Identity
    id: text().primaryKey(),
    work_id: text().notNull().references(() => WorkItemTable.id),
    
    // Classification
    reason: text().notNull().$type<DeadLetterReason>(),
    
    // Context at time of dead-lettering
    work_kind: text().notNull(),
    attempt_count: integer().notNull(),
    reclaim_count: integer().notNull(),
    last_error_kind: text(),
    last_error_message: text(),
    
    // Stream coordination (for audit)
    stream_name: text(),
    stream_entry_id: text(),
    consumer_group: text(),
    last_consumer_id: text(),
    
    // Recovery
    can_be_retried: boolean().notNull().default(false),
    retry_after_ms: bigint({ mode: "number" }),
    
    // Manual intervention
    requires_manual_intervention: boolean().notNull().default(false),
    manual_intervention_notes: text(),
    
    // Timestamps
    dead_lettered_at: bigint({ mode: "number" }).notNull(),
    
    ...TimestampsPg,
  },
  (table) => [
    index("coordination_dead_letter_work_idx").on(table.work_id),
    index("coordination_dead_letter_reason_idx").on(table.reason),
    index("coordination_dead_letter_at_idx").on(table.dead_lettered_at),
    index("coordination_dead_letter_requires_manual_idx").on(
      table.requires_manual_intervention
    ),
  ]
)

// ── Recovery Receipt Table ────────────────────────────────────────────

/**
 * Recovery receipts track when work was recovered, reclaimed, or reconciled.
 * This provides the audit path for: who claimed this work, when did they claim it,
 * what durable event did they write, whether the stream entry was acknowledged,
 * and whether recovery or reclaim was involved.
 */
export type RecoveryAction =
  | "reclaimed"
  | "recovered_after_crash"
  | "reconciled_duplicate"
  | "acknowledged_terminal"
  | "dead_lettered"
  | "rebuild"

export const RecoveryReceiptTable = pgTable(
  "coordination_recovery_receipt",
  {
    // Identity
    id: text().primaryKey(),
    
    // What was recovered
    work_id: text().notNull().references(() => WorkItemTable.id),
    stream_entry_id: text(),
    
    // Recovery action
    action: text().notNull().$type<RecoveryAction>(),
    
    // Who performed the recovery
    recovered_by_consumer: text().notNull(),
    original_consumer: text(),
    
    // When
    recovered_at: bigint({ mode: "number" }).notNull(),
    idle_duration_ms: bigint({ mode: "number" }),  // How long it was pending
    
    // Result
    outcome: text().notNull(),  // e.g., "reclaimed", "acknowledged", "skipped"
    outcome_reason: text(),
    
    // Stream state
    stream_name: text(),
    consumer_group: text(),
    was_pending: boolean().notNull().default(true),
    was_terminal: boolean().notNull().default(false),
    
    ...TimestampsPg,
  },
  (table) => [
    index("coordination_recovery_receipt_work_idx").on(table.work_id),
    index("coordination_recovery_receipt_action_idx").on(table.action),
    index("coordination_recovery_receipt_at_idx").on(table.recovered_at),
    index("coordination_recovery_receipt_stream_idx").on(table.stream_name),
  ]
)

// ── Scheduling Table ──────────────────────────────────────────────────

/**
 * Scheduling uses sorted sets in Valkey, but we track the durable scheduling
 * intent in PGlite. This allows reconstruction after Valkey wipe.
 * 
 * Sorted sets decide WHEN work becomes eligible.
 * Streams decide WHO owns eligible work.
 * PGlite records WHAT actually happened.
 */
export const ScheduledWorkTable = pgTable(
  "coordination_scheduled_work",
  {
    // Identity
    id: text().primaryKey(),
    work_id: text().notNull().references(() => WorkItemTable.id),
    
    // Scheduling
    due_at: bigint({ mode: "number" }).notNull(),  // Unix timestamp in ms
    scheduled_at: bigint({ mode: "number" }).notNull(),
    
    // Retry policy
    retry_count: integer().notNull().default(0),
    max_retries: integer().notNull().default(5),
    backoff_policy: text().notNull().default("exponential"),
    next_retry_delay_ms: bigint({ mode: "number" }),
    
    // Priority (for ordering within due window)
    priority: integer().notNull().default(0),
    
    // Status
    status: text().notNull().$type<"scheduled" | "promoted" | "cancelled" | "expired">(),
    
    // Promotion tracking
    promoted_at: bigint({ mode: "number" }),
    promoted_to_stream: text(),
    promoted_stream_entry_id: text(),
    
    // Context
    reason: text(),  // Why it was scheduled (e.g., "retryable_failure", "delayed_start")
    
    ...TimestampsPg,
  },
  (table) => [
    index("coordination_scheduled_work_work_idx").on(table.work_id),
    index("coordination_scheduled_work_due_idx").on(table.due_at),
    index("coordination_scheduled_work_status_idx").on(table.status),
    index("coordination_scheduled_work_priority_idx").on(table.priority),
    
    // Composite for scheduler queries
    index("coordination_scheduled_work_due_status_idx").on(
      table.due_at,
      table.status
    ),
  ]
)

// ── Stream State Table ────────────────────────────────────────────────

/**
 * Tracks Valkey stream state for rebuild/recovery purposes.
 * This is reconstructable state, not durable authority.
 */
export const StreamStateTable = pgTable(
  "coordination_stream_state",
  {
    // Identity
    id: text().primaryKey(),
    
    // Stream configuration
    stream_name: text().notNull(),
    consumer_group: text().notNull(),
    
    // State
    last_entry_id: text(),
    last_processed_entry_id: text(),
    pending_count: integer().notNull().default(0),
    consumer_count: integer().notNull().default(0),
    
    // Recovery
    last_recovery_at: bigint({ mode: "number" }),
    recovery_generation: bigint({ mode: "number" }).notNull().default(0),
    
    // Health
    last_heartbeat_at: bigint({ mode: "number" }),
    healthy: boolean().notNull().default(true),
    
    ...TimestampsPg,
  },
  (table) => [
    primaryKey({ columns: [table.stream_name, table.consumer_group] }),
    index("coordination_stream_state_stream_idx").on(table.stream_name),
  ]
)
 
/**
 * Quarantine records track stream entries that have no known durable work item.
 * This is separate from dead-lettering, which is for known work that has terminally failed.
 * Quarantine is for unknown/orphaned entries that cannot be mapped to a work ID in PGlite.
 */
export const QuarantineTable = pgTable(
  "coordination_quarantine",
  {
    // Identity
    id: text().primaryKey(),
 
    entry_id: text().notNull(),
    stream_name: text().notNull(),
    
    // Work reference (if discoverable)
    work_id: text(),
    
    // Quarantine reason
    reason: text().notNull(),
    
    // Context at time of quarantine
    context: jsonb(),
    
    // Resolution tracking
    resolved: boolean().notNull().default(false),
    resolved_at: bigint({ mode: "number" }),
    resolved_by: text(),
    resolution_notes: text(),
    
    // Timestamps
    created_at: bigint({ mode: "number" }).notNull(),
    
    ...TimestampsPg,
  },
  (table) => [
    index("coordination_quarantine_entry_idx").on(table.entry_id),
    index("coordination_quarantine_stream_idx").on(table.stream_name),
    index("coordination_quarantine_work_idx").on(table.work_id),
    index("coordination_quarantine_resolved_idx").on(table.resolved),
    index("coordination_quarantine_created_idx").on(table.created_at),
  ]
)

