import { Bus } from "@/bus"
import { CoordEvents } from "@/coordination/coord-events"

export function publishStarted(
  bus: Bus.Interface,
  sessionID: string,
  toolCallID: string,
  toolName: string,
  description: string,
) {
  return bus.publish(CoordEvents.SubagentPhaseChanged, {
    session_id: sessionID,
    tool_call_id: toolCallID,
    tool_name: toolName,
    phase: "started",
    description,
    changed_at: Date.now(),
  })
}

export function publishCompleted(
  bus: Bus.Interface,
  sessionID: string,
  toolCallID: string,
  toolName: string,
  description: string,
) {
  return bus.publish(CoordEvents.SubagentPhaseChanged, {
    session_id: sessionID,
    tool_call_id: toolCallID,
    tool_name: toolName,
    phase: "completed",
    description,
    changed_at: Date.now(),
  })
}

export function publishFailed(
  bus: Bus.Interface,
  sessionID: string,
  toolCallID: string,
  toolName: string,
  description: string,
) {
  return bus.publish(CoordEvents.SubagentPhaseChanged, {
    session_id: sessionID,
    tool_call_id: toolCallID,
    tool_name: toolName,
    phase: "failed",
    description,
    changed_at: Date.now(),
  })
}
