import { Schema } from "effect"
import { BusEvent } from "@/bus/bus-event"

export const TaskStatusChanged = BusEvent.define(
  "coordination.task_status",
  Schema.Struct({
    session_id: Schema.String,
    task_id: Schema.String,
    task_type: Schema.String,
    status: Schema.Literals(["running", "completed", "failed", "blocked"]),
    description: Schema.String,
    agent_name: Schema.optional(Schema.String),
    changed_at: Schema.Number,
  }),
)

export const PathClaimed = BusEvent.define(
  "coordination.path_claimed",
  Schema.Struct({
    session_id: Schema.String,
    path: Schema.String,
    intent: Schema.Literals(["edit", "create", "read", "delete"]),
    claimed_at: Schema.Number,
  }),
)

export const SessionHeartbeat = BusEvent.define(
  "coordination.session_heartbeat",
  Schema.Struct({
    session_id: Schema.String,
    agent: Schema.String,
    status: Schema.Literals(["active", "idle", "blocked"]),
    current_file: Schema.optional(Schema.String),
    mission_summary: Schema.optional(Schema.String),
    heartbeat_at: Schema.Number,
  }),
)

export const ActivityLogged = BusEvent.define(
  "coordination.activity_logged",
  Schema.Struct({
    session_id: Schema.String,
    action: Schema.String,
    target: Schema.optional(Schema.String),
    details: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
    logged_at: Schema.Number,
  }),
)

export const FragmentContention = BusEvent.define(
  "coordination.fragment_contention",
  Schema.Struct({
    session_id: Schema.String,
    target_file: Schema.String,
    conflicting_fragment_id: Schema.String,
    conflicting_lane_id: Schema.String,
    anchor_overlap: Schema.String,
    severity: Schema.Literals(["info", "warning", "collision"]),
    detected_at: Schema.Number,
  }),
)

export const SubagentPhaseChanged = BusEvent.define(
  "coord.subagent.phase",
  Schema.Struct({
    session_id: Schema.String,
    tool_call_id: Schema.String,
    tool_name: Schema.String,
    phase: Schema.Literals(["started", "completed", "failed"]),
    description: Schema.String,
    changed_at: Schema.Number,
  }),
)

export * as CoordEvents from "./coord-events"
