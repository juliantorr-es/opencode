CREATE TABLE "runtime_events" (
	"id" text PRIMARY KEY,
	"session_id" text NOT NULL,
	"run_id" text NOT NULL,
	"parent_event_id" text,
	"correlation_id" text,
	"ts" text NOT NULL,
	"actor" text NOT NULL,
	"event_type" text NOT NULL,
	"phase" text,
	"status" text,
	"tool_name" text,
	"file_path" text,
	"model" text,
	"duration_ms" integer,
	"token_input" integer,
	"token_output" integer,
	"error_code" text,
	"error_message" text,
	"recoverable" boolean,
	"payload_json" jsonb,
	"campaign_id" text,
	"lane_id" text,
	"role" text,
	"time_created" bigint NOT NULL,
	"time_updated" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX "runtime_events_session_idx" ON "runtime_events" ("session_id");--> statement-breakpoint
CREATE INDEX "runtime_events_event_type_idx" ON "runtime_events" ("event_type");--> statement-breakpoint
CREATE INDEX "runtime_events_ts_idx" ON "runtime_events" ("ts");--> statement-breakpoint
CREATE INDEX "runtime_events_actor_idx" ON "runtime_events" ("actor");--> statement-breakpoint
CREATE INDEX "runtime_events_run_id_idx" ON "runtime_events" ("run_id");--> statement-breakpoint
CREATE INDEX "runtime_events_session_ts_idx" ON "runtime_events" ("session_id","ts");--> statement-breakpoint
CREATE INDEX "runtime_events_campaign_id_idx" ON "runtime_events" ("campaign_id");--> statement-breakpoint
CREATE INDEX "runtime_events_lane_id_idx" ON "runtime_events" ("lane_id");