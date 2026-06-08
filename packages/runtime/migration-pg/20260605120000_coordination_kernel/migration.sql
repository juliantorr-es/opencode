-- Coordination Kernel Tables Migration
-- This migration creates all tables needed for the Valkey Stream-Backed Coordination Kernel
-- Generated from work-queue.pg.sql.ts schema definitions

-- ============================================================================
-- Work Item Table
-- ============================================================================
CREATE TABLE "coordination_work_item" (
	"id" text PRIMARY KEY,
	"session_id" text NOT NULL,
	"project_id" text NOT NULL,
	"work_kind" text NOT NULL,
	"schema_version" text NOT NULL DEFAULT 'v1',
	"status" text NOT NULL,
	"correlation_id" text,
	"parent_mission_id" text,
	"parent_session_id" text,
	"routing_tags" jsonb,
	"attempt_count" integer NOT NULL DEFAULT 0,
	"max_attempts" integer NOT NULL DEFAULT 3,
	"reclaim_count" integer NOT NULL DEFAULT 0,
	"max_reclaims" integer NOT NULL DEFAULT 5,
	"stream_name" text,
	"stream_entry_id" text,
	"consumer_group" text,
	"consumer_id" text,
	"created_at" bigint NOT NULL,
	"enqueued_at" bigint,
	"started_at" bigint,
	"completed_at" bigint,
	"result_ref" text,
	"error_classification" text,
	"recovered_from_crash" boolean NOT NULL DEFAULT false,
	"recovery_reason" text,
	"time_created" bigint NOT NULL,
	"time_updated" bigint NOT NULL
);

-- Indexes for coordination_work_item
CREATE INDEX "coordination_work_item_session_idx" ON "coordination_work_item" ("session_id");
CREATE INDEX "coordination_work_item_project_idx" ON "coordination_work_item" ("project_id");
CREATE INDEX "coordination_work_item_status_idx" ON "coordination_work_item" ("status");
CREATE INDEX "coordination_work_item_stream_idx" ON "coordination_work_item" ("stream_name");
CREATE INDEX "coordination_work_item_created_idx" ON "coordination_work_item" ("created_at");
CREATE INDEX "coordination_work_item_correlation_idx" ON "coordination_work_item" ("correlation_id");
CREATE INDEX "coordination_work_item_session_status_idx" ON "coordination_work_item" ("session_id", "status");
CREATE INDEX "coordination_work_item_project_status_idx" ON "coordination_work_item" ("project_id", "status");

-- ============================================================================
-- Work Attempt Table
-- ============================================================================
CREATE TABLE "coordination_work_attempt" (
	"id" text PRIMARY KEY,
	"work_id" text NOT NULL REFERENCES "coordination_work_item"("id"),
	"attempt_number" integer NOT NULL,
	"stream_name" text,
	"stream_entry_id" text,
	"consumer_group" text,
	"consumer_id" text NOT NULL,
	"worker_id" text,
	"status" text NOT NULL,
	"started_at" bigint NOT NULL,
	"finished_at" bigint,
	"result_ref" text,
	"error_kind" text,
	"error_message" text,
	"produced_terminal_fact" boolean NOT NULL DEFAULT false,
	"was_reclaimed" boolean NOT NULL DEFAULT false,
	"reclaimed_from_consumer" text,
	"reclaimed_at" bigint,
	"time_created" bigint NOT NULL,
	"time_updated" bigint NOT NULL
);

-- Indexes for coordination_work_attempt
CREATE INDEX "coordination_work_attempt_work_idx" ON "coordination_work_attempt" ("work_id");
CREATE INDEX "coordination_work_attempt_work_attempt_idx" ON "coordination_work_attempt" ("work_id", "attempt_number");
CREATE INDEX "coordination_work_attempt_consumer_idx" ON "coordination_work_attempt" ("consumer_id");
CREATE INDEX "coordination_work_attempt_started_idx" ON "coordination_work_attempt" ("started_at");
CREATE INDEX "coordination_work_attempt_status_idx" ON "coordination_work_attempt" ("status");

-- ============================================================================
-- Dead Letter Table
-- ============================================================================
CREATE TABLE "coordination_dead_letter" (
	"id" text PRIMARY KEY,
	"work_id" text NOT NULL REFERENCES "coordination_work_item"("id"),
	"reason" text NOT NULL,
	"work_kind" text NOT NULL,
	"attempt_count" integer NOT NULL,
	"reclaim_count" integer NOT NULL,
	"last_error_kind" text,
	"last_error_message" text,
	"stream_name" text,
	"stream_entry_id" text,
	"consumer_group" text,
	"last_consumer_id" text,
	"can_be_retried" boolean NOT NULL DEFAULT false,
	"retry_after_ms" bigint,
	"requires_manual_intervention" boolean NOT NULL DEFAULT false,
	"manual_intervention_notes" text,
	"dead_lettered_at" bigint NOT NULL,
	"time_created" bigint NOT NULL,
	"time_updated" bigint NOT NULL
);

-- Indexes for coordination_dead_letter
CREATE INDEX "coordination_dead_letter_work_idx" ON "coordination_dead_letter" ("work_id");
CREATE INDEX "coordination_dead_letter_reason_idx" ON "coordination_dead_letter" ("reason");
CREATE INDEX "coordination_dead_letter_at_idx" ON "coordination_dead_letter" ("dead_lettered_at");
CREATE INDEX "coordination_dead_letter_requires_manual_idx" ON "coordination_dead_letter" ("requires_manual_intervention");

-- ============================================================================
-- Recovery Receipt Table
-- ============================================================================
CREATE TABLE "coordination_recovery_receipt" (
	"id" text PRIMARY KEY,
	"work_id" text NOT NULL REFERENCES "coordination_work_item"("id"),
	"stream_entry_id" text,
	"action" text NOT NULL,
	"recovered_by_consumer" text NOT NULL,
	"original_consumer" text,
	"recovered_at" bigint NOT NULL,
	"idle_duration_ms" bigint,
	"outcome" text NOT NULL,
	"outcome_reason" text,
	"stream_name" text,
	"consumer_group" text,
	"was_pending" boolean NOT NULL DEFAULT true,
	"was_terminal" boolean NOT NULL DEFAULT false,
	"time_created" bigint NOT NULL,
	"time_updated" bigint NOT NULL
);

-- Indexes for coordination_recovery_receipt
CREATE INDEX "coordination_recovery_receipt_work_idx" ON "coordination_recovery_receipt" ("work_id");
CREATE INDEX "coordination_recovery_receipt_action_idx" ON "coordination_recovery_receipt" ("action");
CREATE INDEX "coordination_recovery_receipt_at_idx" ON "coordination_recovery_receipt" ("recovered_at");
CREATE INDEX "coordination_recovery_receipt_stream_idx" ON "coordination_recovery_receipt" ("stream_name");

-- ============================================================================
-- Scheduled Work Table
-- ============================================================================
CREATE TABLE "coordination_scheduled_work" (
	"id" text PRIMARY KEY,
	"work_id" text NOT NULL REFERENCES "coordination_work_item"("id"),
	"due_at" bigint NOT NULL,
	"scheduled_at" bigint NOT NULL,
	"retry_count" integer NOT NULL DEFAULT 0,
	"max_retries" integer NOT NULL DEFAULT 5,
	"backoff_policy" text NOT NULL DEFAULT 'exponential',
	"next_retry_delay_ms" bigint,
	"priority" integer NOT NULL DEFAULT 0,
	"status" text NOT NULL,
	"promoted_at" bigint,
	"promoted_to_stream" text,
	"promoted_stream_entry_id" text,
	"reason" text,
	"time_created" bigint NOT NULL,
	"time_updated" bigint NOT NULL
);

-- Indexes for coordination_scheduled_work
CREATE INDEX "coordination_scheduled_work_work_idx" ON "coordination_scheduled_work" ("work_id");
CREATE INDEX "coordination_scheduled_work_due_idx" ON "coordination_scheduled_work" ("due_at");
CREATE INDEX "coordination_scheduled_work_status_idx" ON "coordination_scheduled_work" ("status");
CREATE INDEX "coordination_scheduled_work_priority_idx" ON "coordination_scheduled_work" ("priority");
CREATE INDEX "coordination_scheduled_work_due_status_idx" ON "coordination_scheduled_work" ("due_at", "status");

-- ============================================================================
-- Stream State Table
-- ============================================================================
CREATE TABLE "coordination_stream_state" (
	"id" text PRIMARY KEY,
	"stream_name" text NOT NULL,
	"consumer_group" text NOT NULL,
	"last_entry_id" text,
	"last_processed_entry_id" text,
	"pending_count" integer NOT NULL DEFAULT 0,
	"consumer_count" integer NOT NULL DEFAULT 0,
	"last_recovery_at" bigint,
	"recovery_generation" bigint NOT NULL DEFAULT 0,
	"last_heartbeat_at" bigint,
	"healthy" boolean NOT NULL DEFAULT true,
	"time_created" bigint NOT NULL,
	"time_updated" bigint NOT NULL,
	CONSTRAINT "coordination_stream_state_stream_group_pk" UNIQUE ("stream_name", "consumer_group")
);

-- Indexes for coordination_stream_state
CREATE INDEX "coordination_stream_state_stream_idx" ON "coordination_stream_state" ("stream_name");

-- ============================================================================
-- Quarantine Table
-- ============================================================================
CREATE TABLE "coordination_quarantine" (
	"id" text PRIMARY KEY,
	"entry_id" text NOT NULL,
	"stream_name" text NOT NULL,
	"work_id" text,
	"reason" text NOT NULL,
	"context" jsonb,
	"resolved" boolean NOT NULL DEFAULT false,
	"resolved_at" bigint,
	"resolved_by" text,
	"resolution_notes" text,
	"created_at" bigint NOT NULL,
	"time_created" bigint NOT NULL,
	"time_updated" bigint NOT NULL
);

-- Indexes for coordination_quarantine
CREATE INDEX "coordination_quarantine_entry_idx" ON "coordination_quarantine" ("entry_id");
CREATE INDEX "coordination_quarantine_stream_idx" ON "coordination_quarantine" ("stream_name");
CREATE INDEX "coordination_quarantine_work_idx" ON "coordination_quarantine" ("work_id");
CREATE INDEX "coordination_quarantine_resolved_idx" ON "coordination_quarantine" ("resolved");
CREATE INDEX "coordination_quarantine_created_idx" ON "coordination_quarantine" ("created_at");
