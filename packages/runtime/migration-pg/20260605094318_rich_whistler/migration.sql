CREATE TABLE "capability_authority_receipt" (
	"id" text PRIMARY KEY,
	"timestamp" bigint NOT NULL,
	"capability_id" text NOT NULL,
	"action_name" text NOT NULL,
	"session_id" text,
	"project_id" text,
	"authority_outcome" text NOT NULL,
	"refusal_reasons" jsonb,
	"authority_chain" jsonb,
	"missing_authority" jsonb,
	"recovery_state" text NOT NULL,
	"approval_level" text NOT NULL,
	"privilege_boundaries" jsonb,
	"consent_class" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "coordination_recovery" (
	"id" text PRIMARY KEY,
	"session_id" text NOT NULL,
	"project_id" text NOT NULL,
	"old_generation" bigint NOT NULL,
	"new_generation" bigint NOT NULL,
	"state" text NOT NULL,
	"outcome" text NOT NULL,
	"reasons" jsonb NOT NULL,
	"unsafe_work" boolean NOT NULL,
	"durable_receipt" boolean NOT NULL,
	"time_created" bigint NOT NULL,
	"time_updated" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "coordination_reservation" ADD COLUMN "expires_at" bigint;--> statement-breakpoint
ALTER TABLE "coordination_reservation" ADD COLUMN "base_digest" text;--> statement-breakpoint
ALTER TABLE "account" ALTER COLUMN "token_expiry" SET DATA TYPE bigint USING "token_expiry"::bigint;--> statement-breakpoint
ALTER TABLE "account" ALTER COLUMN "time_created" SET DATA TYPE bigint USING "time_created"::bigint;--> statement-breakpoint
ALTER TABLE "account" ALTER COLUMN "time_updated" SET DATA TYPE bigint USING "time_updated"::bigint;--> statement-breakpoint
ALTER TABLE "control_account" ALTER COLUMN "token_expiry" SET DATA TYPE bigint USING "token_expiry"::bigint;--> statement-breakpoint
ALTER TABLE "control_account" ALTER COLUMN "time_created" SET DATA TYPE bigint USING "time_created"::bigint;--> statement-breakpoint
ALTER TABLE "control_account" ALTER COLUMN "time_updated" SET DATA TYPE bigint USING "time_updated"::bigint;--> statement-breakpoint
ALTER TABLE "workspace" ALTER COLUMN "time_used" SET DATA TYPE bigint USING "time_used"::bigint;--> statement-breakpoint
ALTER TABLE "data_migration" ALTER COLUMN "time_completed" SET DATA TYPE bigint USING "time_completed"::bigint;--> statement-breakpoint
ALTER TABLE "runtime_events" ALTER COLUMN "time_created" SET DATA TYPE bigint USING "time_created"::bigint;--> statement-breakpoint
ALTER TABLE "runtime_events" ALTER COLUMN "time_updated" SET DATA TYPE bigint USING "time_updated"::bigint;--> statement-breakpoint
ALTER TABLE "project" ALTER COLUMN "time_created" SET DATA TYPE bigint USING "time_created"::bigint;--> statement-breakpoint
ALTER TABLE "project" ALTER COLUMN "time_updated" SET DATA TYPE bigint USING "time_updated"::bigint;--> statement-breakpoint
ALTER TABLE "project" ALTER COLUMN "time_initialized" SET DATA TYPE bigint USING "time_initialized"::bigint;--> statement-breakpoint
ALTER TABLE "message" ALTER COLUMN "time_created" SET DATA TYPE bigint USING "time_created"::bigint;--> statement-breakpoint
ALTER TABLE "message" ALTER COLUMN "time_updated" SET DATA TYPE bigint USING "time_updated"::bigint;--> statement-breakpoint
ALTER TABLE "part" ALTER COLUMN "time_created" SET DATA TYPE bigint USING "time_created"::bigint;--> statement-breakpoint
ALTER TABLE "part" ALTER COLUMN "time_updated" SET DATA TYPE bigint USING "time_updated"::bigint;--> statement-breakpoint
ALTER TABLE "permission" ALTER COLUMN "time_created" SET DATA TYPE bigint USING "time_created"::bigint;--> statement-breakpoint
ALTER TABLE "permission" ALTER COLUMN "time_updated" SET DATA TYPE bigint USING "time_updated"::bigint;--> statement-breakpoint
ALTER TABLE "session_message" ALTER COLUMN "time_created" SET DATA TYPE bigint USING "time_created"::bigint;--> statement-breakpoint
ALTER TABLE "session_message" ALTER COLUMN "time_updated" SET DATA TYPE bigint USING "time_updated"::bigint;--> statement-breakpoint
ALTER TABLE "session" ALTER COLUMN "time_created" SET DATA TYPE bigint USING "time_created"::bigint;--> statement-breakpoint
ALTER TABLE "session" ALTER COLUMN "time_updated" SET DATA TYPE bigint USING "time_updated"::bigint;--> statement-breakpoint
ALTER TABLE "session" ALTER COLUMN "time_compacting" SET DATA TYPE bigint USING "time_compacting"::bigint;--> statement-breakpoint
ALTER TABLE "session" ALTER COLUMN "time_archived" SET DATA TYPE bigint USING "time_archived"::bigint;--> statement-breakpoint
ALTER TABLE "todo" ALTER COLUMN "time_created" SET DATA TYPE bigint USING "time_created"::bigint;--> statement-breakpoint
ALTER TABLE "todo" ALTER COLUMN "time_updated" SET DATA TYPE bigint USING "time_updated"::bigint;--> statement-breakpoint
ALTER TABLE "session_share" ALTER COLUMN "time_created" SET DATA TYPE bigint USING "time_created"::bigint;--> statement-breakpoint
ALTER TABLE "session_share" ALTER COLUMN "time_updated" SET DATA TYPE bigint USING "time_updated"::bigint;--> statement-breakpoint
ALTER TABLE "coordination_claim" ALTER COLUMN "created_at" SET DATA TYPE bigint USING "created_at"::bigint;--> statement-breakpoint
ALTER TABLE "coordination_claim" ALTER COLUMN "expires_at" SET DATA TYPE bigint USING "expires_at"::bigint;--> statement-breakpoint
ALTER TABLE "coordination_claim" ALTER COLUMN "released_at" SET DATA TYPE bigint USING "released_at"::bigint;--> statement-breakpoint
ALTER TABLE "coordination_reservation" ALTER COLUMN "created_at" SET DATA TYPE bigint USING "created_at"::bigint;--> statement-breakpoint
CREATE INDEX "account_state_active_account_idx" ON "account_state" ("active_account_id");--> statement-breakpoint
CREATE INDEX "workspace_project_idx" ON "workspace" ("project_id");--> statement-breakpoint
CREATE INDEX "coordination_recovery_session_idx" ON "coordination_recovery" ("session_id");--> statement-breakpoint
CREATE INDEX "coordination_recovery_project_idx" ON "coordination_recovery" ("project_id");--> statement-breakpoint
CREATE INDEX "event_aggregate_idx" ON "event" ("aggregate_id");--> statement-breakpoint
ALTER TABLE "capability_authority_receipt" ADD CONSTRAINT "capability_authority_receipt_session_id_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "session"("id") ON DELETE CASCADE;