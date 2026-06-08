/**
 * Control-Plane Entity PGlite Schema
 *
 * Canonical PGlite table definitions for all Tribunus control-plane entities.
 * This is the destination schema for the SQLite-to-PGlite migration (campaign 0015).
 *
 * Doctrine:
 * - PGlite is the single durable authority for all control-plane state
 * - Filesystem JSON files are transitional; PGlite is canonical
 * - Every entity has a stable ID, versioned schema, and full audit timestamps
 * - Foreign keys enforce referential integrity across the entity hierarchy
 * - Indices are specified for every query pattern
 */
import {
  pgTable,
  text,
  integer,
  bigint,
  jsonb,
  boolean,
  index,
  uniqueIndex,
  foreignKey,
} from "drizzle-orm/pg-core"
import { TimestampsPg } from "../storage/schema.pg.sql"

// ── Campaign ────────────────────────────────────────────────────────────────

export const CampaignTable = pgTable(
  "control_plane_campaign",
  {
    id: text().primaryKey(),
    name: text().notNull(),
    slug: text().notNull(),
    description: text().notNull().default(""),
    objective: text().notNull().default(""),
    status: text().notNull().default("not_started"),
    maturity: text().notNull().default("modeled"),
    horizon: text().notNull().default("strategic"),
    priority: integer().notNull().default(50),
    start_date: text(),
    end_date: text(),
    memory_bank: text().notNull().default("tribunus-core"),
    follow_on_campaigns: jsonb().$type<string[]>().notNull().default([]),
    tags: jsonb().$type<string[]>().notNull().default([]),
    authors: jsonb().$type<string[]>().notNull().default([]),
    ...TimestampsPg,
  },
  (table) => [
    uniqueIndex("cp_campaign_slug_idx").on(table.slug),
    index("cp_campaign_status_idx").on(table.status),
    index("cp_campaign_horizon_idx").on(table.horizon),
    index("cp_campaign_maturity_idx").on(table.maturity),
  ]
)

// ── Mission ─────────────────────────────────────────────────────────────────

export const MissionTable = pgTable(
  "control_plane_mission",
  {
    id: text().primaryKey(),
    campaign_id: text()
      .notNull()
      .references(() => CampaignTable.id, { onDelete: "cascade" }),
    name: text().notNull(),
    slug: text().notNull(),
    description: text().notNull().default(""),
    purpose: text().notNull().default(""),
    status: text().notNull().default("not_started"),
    maturity: text().notNull().default("modeled"),
    horizon: text().notNull().default("planned"),
    priority: integer().notNull().default(50),
    depends_on: jsonb().$type<string[]>().notNull().default([]),
    unlocks: jsonb().$type<string[]>().notNull().default([]),
    authority_scope: text().notNull().default(""),
    allowed_paths: jsonb().$type<string[]>().notNull().default([]),
    required_evidence: jsonb().$type<string[]>().notNull().default([]),
    acceptance_gates: jsonb().$type<string[]>().notNull().default([]),
    acceptance_criteria: jsonb().$type<string[]>().notNull().default([]),
    rollback_strategy: text().notNull().default(""),
    recovery_strategy: text().notNull().default(""),
    automation_mode: text().notNull().default("manual"),
    maximum_attempts: integer().notNull().default(3),
    escalation_policy: text().notNull().default(""),
    maturity_target: text().notNull().default("bootstrap_complete"),
    tags: jsonb().$type<string[]>().notNull().default([]),
    authors: jsonb().$type<string[]>().notNull().default([]),
    ...TimestampsPg,
  },
  (table) => [
    uniqueIndex("cp_mission_slug_idx").on(table.slug),
    index("cp_mission_campaign_idx").on(table.campaign_id),
    index("cp_mission_status_idx").on(table.status),
    index("cp_mission_horizon_idx").on(table.horizon),
  ]
)

// ── Lane ─────────────────────────────────────────────────────────────────────

export const LaneTable = pgTable(
  "control_plane_lane",
  {
    id: text().primaryKey(),
    mission_id: text()
      .notNull()
      .references(() => MissionTable.id, { onDelete: "cascade" }),
    name: text().notNull(),
    slug: text().notNull(),
    description: text().notNull().default(""),
    scope: text().notNull(),
    status: text().notNull().default("idle"),
    maturity: text().notNull().default("modeled"),
    is_read_only: boolean().notNull().default(false),
    write_paths: jsonb().$type<string[]>().notNull().default([]),
    stream_key: text(),
    consumer_group: text(),
    concurrency_group: text(),
    lease_holder: text(),
    lease_acquired_at: bigint("lease_acquired_at", { mode: "number" }),
    lease_expires_at: bigint("lease_expires_at", { mode: "number" }),
    tags: jsonb().$type<string[]>().notNull().default([]),
    authors: jsonb().$type<string[]>().notNull().default([]),
    ...TimestampsPg,
  },
  (table) => [
    uniqueIndex("cp_lane_slug_idx").on(table.slug),
    index("cp_lane_mission_idx").on(table.mission_id),
    index("cp_lane_status_idx").on(table.status),
    index("cp_lane_lease_idx").on(table.lease_holder),
  ]
)

// ── Task ─────────────────────────────────────────────────────────────────────

export const TaskTable = pgTable(
  "control_plane_task",
  {
    id: text().primaryKey(),
    lane_id: text()
      .notNull()
      .references(() => LaneTable.id, { onDelete: "cascade" }),
    mission_id: text()
      .notNull()
      .references(() => MissionTable.id, { onDelete: "cascade" }),
    name: text().notNull(),
    slug: text().notNull(),
    description: text().notNull().default(""),
    status: text().notNull().default("pending"),
    maturity: text().notNull().default("modeled"),
    horizon: text().notNull().default("planned"),
    priority: integer().notNull().default(50),
    risk_class: text().notNull().default("medium"),
    estimated_effort: text(),
    actual_effort: text(),
    assigned_to: text(),
    started_at: bigint("started_at", { mode: "number" }),
    completed_at: bigint("completed_at", { mode: "number" }),
    depends_on: jsonb().$type<string[]>().notNull().default([]),
    blocks: jsonb().$type<string[]>().notNull().default([]),
    acceptance_criteria: jsonb().$type<string[]>().notNull().default([]),
    expected_outputs: jsonb().$type<string[]>().notNull().default([]),
    verification_commands: jsonb().$type<string[]>().notNull().default([]),
    evidence_requirements: jsonb().$type<string[]>().notNull().default([]),
    mutation_scope: jsonb().$type<string[]>().notNull().default([]),
    retry_policy: jsonb().$type<{ max_retries: number; backoff_strategy: string; initial_delay_ms?: number; max_delay_ms?: number }>().notNull().default({ max_retries: 3, backoff_strategy: "exponential" }),
    failure_classification: text(),
    next_safe_action: text(),
    completion_receipt: jsonb().$type<{ evidence_type: string; artifact_path?: string; observed_at?: string; verifier?: string }>(),
    tags: jsonb().$type<string[]>().notNull().default([]),
    authors: jsonb().$type<string[]>().notNull().default([]),
    ...TimestampsPg,
  },
  (table) => [
    uniqueIndex("cp_task_slug_idx").on(table.slug),
    index("cp_task_lane_idx").on(table.lane_id),
    index("cp_task_mission_idx").on(table.mission_id),
    index("cp_task_status_idx").on(table.status),
    index("cp_task_priority_idx").on(table.priority),
    index("cp_task_risk_idx").on(table.risk_class),
    index("cp_task_assigned_idx").on(table.assigned_to),
  ]
)

// ── Receipt ──────────────────────────────────────────────────────────────────

export const ReceiptTable = pgTable(
  "control_plane_receipt",
  {
    id: text().primaryKey(),
    entity_type: text().notNull(),  // campaign, mission, lane, task
    entity_id: text().notNull(),
    action: text().notNull(),       // created, started, completed, blocked, failed, abandoned
    actor: text().notNull(),
    timestamp: bigint("timestamp", { mode: "number" }).notNull(),
    previous_receipt_id: text(),    // Hash chain: references previous receipt
    receipt_hash: text().notNull(), // SHA-256 of this receipt's content
    evidence_ref: text(),           // Reference to evidence artifact
    metadata: jsonb(),
    ...TimestampsPg,
  },
  (table) => [
    index("cp_receipt_entity_idx").on(table.entity_type, table.entity_id),
    index("cp_receipt_actor_idx").on(table.actor),
    index("cp_receipt_chain_idx").on(table.previous_receipt_id),
    index("cp_receipt_timestamp_idx").on(table.timestamp),
  ]
)

// ── Checkpoint ───────────────────────────────────────────────────────────────

export const CheckpointTable = pgTable(
  "control_plane_checkpoint",
  {
    id: text().primaryKey(),
    entity_type: text().notNull(),  // campaign, mission, lane, task
    entity_id: text().notNull(),
    name: text().notNull(),
    description: text(),
    snapshot_json: jsonb().notNull(), // Full entity snapshot at checkpoint time
    git_commit: text(),
    git_branch: text(),
    git_dirty: boolean(),
    receipt_id: text()
      .references(() => ReceiptTable.id),
    ...TimestampsPg,
  },
  (table) => [
    index("cp_checkpoint_entity_idx").on(table.entity_type, table.entity_id),
    index("cp_checkpoint_receipt_idx").on(table.receipt_id),
    index("cp_checkpoint_time_idx").on(table.time_created),
  ]
)

// ── Memory Link ──────────────────────────────────────────────────────────────

export const MemoryLinkTable = pgTable(
  "control_plane_memory_link",
  {
    id: text().primaryKey(),
    source_entity_type: text().notNull(),
    source_entity_id: text().notNull(),
    target_entity_type: text().notNull(),
    target_entity_id: text().notNull(),
    relationship: text().notNull(), // context, decision, lesson, constraint, requirement
    context: text(),
    ...TimestampsPg,
  },
  (table) => [
    uniqueIndex("cp_memory_link_pair_idx").on(
      table.source_entity_type,
      table.source_entity_id,
      table.target_entity_type,
      table.target_entity_id
    ),
    index("cp_memory_link_source_idx").on(table.source_entity_type, table.source_entity_id),
    index("cp_memory_link_target_idx").on(table.target_entity_type, table.target_entity_id),
    index("cp_memory_link_rel_idx").on(table.relationship),
  ]
)

// ── Research Packet ──────────────────────────────────────────────────────────

export const ResearchPacketTable = pgTable(
  "control_plane_research_packet",
  {
    id: text().primaryKey(),
    name: text().notNull(),
    slug: text().notNull(),
    description: text(),
    research_topic: text().notNull(),
    transcript_summary: text(),
    findings_json: jsonb().notNull().default([]),
    implementation_specs_json: jsonb().notNull().default([]),
    linked_entities_json: jsonb().notNull().default([]),
    tags: jsonb().$type<string[]>().notNull().default([]),
    authors: jsonb().$type<string[]>().notNull().default([]),
    ...TimestampsPg,
  },
  (table) => [
    uniqueIndex("cp_research_slug_idx").on(table.slug),
    index("cp_research_topic_idx").on(table.research_topic),
  ]
)
