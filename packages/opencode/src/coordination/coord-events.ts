import { Schema } from "effect"
import { BusEvent } from "@/bus/bus-event"

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
