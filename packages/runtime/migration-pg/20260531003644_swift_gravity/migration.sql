CREATE TABLE "coordination_claim" (
	"task_id" text PRIMARY KEY,
	"session_id" text NOT NULL,
	"wave" integer DEFAULT 0 NOT NULL,
	"wave_type" text DEFAULT '' NOT NULL,
	"subagent_type" text NOT NULL,
	"description" text NOT NULL,
	"status" text NOT NULL,
	"result" text,
	"error" text,
	"created_at" integer NOT NULL,
	"expires_at" integer,
	"released_at" integer
);
--> statement-breakpoint
CREATE TABLE "coordination_fan_out" (
	"session_id" text,
	"wave" integer,
	"wave_type" text,
	"task_ids" text NOT NULL,
	"complete_count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "coordination_fan_out_pkey" PRIMARY KEY("session_id","wave","wave_type")
);
--> statement-breakpoint
CREATE TABLE "coordination_reservation" (
	"path" text PRIMARY KEY,
	"task_id" text NOT NULL,
	"session_id" text NOT NULL,
	"status" text NOT NULL,
	"created_at" integer NOT NULL
);
