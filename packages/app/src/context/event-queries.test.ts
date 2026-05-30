import { describe, test, expect } from "bun:test"
import type { RuntimeEvent } from "@/context/inspector"
import { normalizeErrorCode, queryFailureHotspots, getActionsForCode } from "@/context/event-queries"

function makeEvent(overrides: Partial<RuntimeEvent> & { type: string }): RuntimeEvent {
  return {
    id: overrides.id ?? `evt-${Math.random().toString(36).slice(2)}`,
    type: overrides.type,
    category: overrides.category ?? "tool",
    timestamp: overrides.timestamp ?? Date.now(),
    sessionID: overrides.sessionID ?? "test-session",
    status: overrides.status ?? "failed",
    error: overrides.error,
    tool: overrides.tool,
    file: overrides.file,
    actor: overrides.actor,
    phase: overrides.phase,
    duration: overrides.duration,
    callID: overrides.callID,
    parentID: overrides.parentID,
    raw: overrides.raw ?? { id: overrides.id ?? "evt", type: overrides.type, properties: {} } as any,
  }
}

describe("normalizeErrorCode", () => {
  test("tool timeout", () => {
    expect(normalizeErrorCode("session.next.tool.failed", "timed out")).toBe("tool.timeout")
    expect(normalizeErrorCode("session.next.tool.failed", "TimeoutError: request timed out")).toBe("tool.timeout")
    expect(normalizeErrorCode("session.next.tool.failed", "ETIMEDOUT")).toBe("tool.timeout")
  })

  test("tool failed", () => {
    expect(normalizeErrorCode("session.next.tool.failed")).toBe("tool.failed")
    expect(normalizeErrorCode("session.next.tool.failed", "exit code 1")).toBe("tool.failed")
  })

  test("tool denied", () => {
    expect(normalizeErrorCode("session.next.tool.denied")).toBe("tool.denied")
    expect(normalizeErrorCode("session.next.tool.failed", "denied by policy")).toBe("tool.denied")
  })

  test("tool rejected", () => {
    expect(normalizeErrorCode("session.next.tool.rejected")).toBe("tool.rejected")
    expect(normalizeErrorCode("session.next.tool.failed", "rejected: invalid input")).toBe("tool.rejected")
  })

  test("lifecycle phase gate denied", () => {
    expect(normalizeErrorCode("session.next.step.denied")).toBe("lifecycle.phase_gate_denied")
    expect(normalizeErrorCode("session.next.step.failed", "phase gate precondition failed")).toBe("lifecycle.phase_gate_denied")
  })

  test("lifecycle step blocked", () => {
    expect(normalizeErrorCode("session.next.step.blocked")).toBe("lifecycle.step_blocked")
    expect(normalizeErrorCode("session.next.step.failed", "blocked by dependency: lane-2")).toBe("lifecycle.step_blocked")
  })

  test("lifecycle step error", () => {
    expect(normalizeErrorCode("session.next.step.error")).toBe("lifecycle.step_error")
    expect(normalizeErrorCode("session.next.step.failed", "step error: missing context")).toBe("lifecycle.step_error")
  })

  test("permission denied", () => {
    expect(normalizeErrorCode("permission.denied")).toBe("permission.denied")
    expect(normalizeErrorCode("session.next.tool.failed", "unauthorized access")).toBe("permission.denied")
    expect(normalizeErrorCode("session.next.tool.failed", "permission denied")).toBe("permission.denied")
  })

  test("coordination task blocked", () => {
    expect(normalizeErrorCode("coordination.task.blocked")).toBe("coordination.task_blocked")
    expect(normalizeErrorCode("coordination.task.failed", "blocked by path claim")).toBe("coordination.task_blocked")
  })

  test("system error", () => {
    expect(normalizeErrorCode("file.read.error")).toBe("system.error")
    expect(normalizeErrorCode("server.connection.error")).toBe("system.error")
    expect(normalizeErrorCode("pty.spawn.error")).toBe("system.error")
    expect(normalizeErrorCode("lsp.diagnostic.error")).toBe("system.error")
  })

  test("unknown fallback", () => {
    expect(normalizeErrorCode("some.random.event")).toBe("unknown")
    expect(normalizeErrorCode("custom.plugin.event")).toBe("unknown")
  })
})

describe("queryFailureHotspots", () => {
  test("empty events returns empty query", () => {
    const result = queryFailureHotspots([])
    expect(result.totalFailures).toBe(0)
    expect(result.uniqueCodes).toBe(0)
    expect(result.hotspots).toEqual([])
  })

  test("groups failed events by normalized code", () => {
    const events: RuntimeEvent[] = [
      makeEvent({ type: "session.next.tool.failed", error: "timeout reading response", tool: "bash" }),
      makeEvent({ type: "session.next.tool.failed", error: "timeout reading response", tool: "grep" }),
      makeEvent({ type: "session.next.step.denied", error: "gate precondition: tests failing", tool: "critic" }),
      makeEvent({ type: "session.next.tool.failed", error: "exit code 2", tool: "bash" }),
    ]

    const result = queryFailureHotspots(events)

    expect(result.totalFailures).toBe(4)
    expect(result.uniqueCodes).toBe(3)

    const timeout = result.hotspots.find((h) => h.code === "tool.timeout")
    expect(timeout).toBeDefined()
    expect(timeout!.count).toBe(2)
    expect(timeout!.recoverable).toBe(true)
    expect(timeout!.suggestedActions.length).toBeGreaterThan(0)

    const gate = result.hotspots.find((h) => h.code === "lifecycle.phase_gate_denied")
    expect(gate).toBeDefined()
    expect(gate!.count).toBe(1)

    const failed = result.hotspots.find((h) => h.code === "tool.failed")
    expect(failed).toBeDefined()
    expect(failed!.count).toBe(1)
  })

  test("sorts by severity then count", () => {
    const events: RuntimeEvent[] = [
      makeEvent({ type: "permission.denied", error: "unauthorized" }),
      makeEvent({ type: "session.next.tool.failed", error: "timeout", tool: "bash" }),
      makeEvent({ type: "session.next.tool.failed", error: "timeout", tool: "grep" }),
      makeEvent({ type: "session.next.tool.failed", error: "timeout", tool: "rg" }),
      makeEvent({ type: "session.next.tool.failed", error: "exit code 1", tool: "bash" }),
    ]

    const result = queryFailureHotspots(events)
    // Fatal (permission.denied) first, then error (tool.failed), then warning (tool.timeout)
    expect(result.hotspots[0]!.severity).toBe("fatal")
  })

  test("ignores non-failed events", () => {
    const events: RuntimeEvent[] = [
      makeEvent({ type: "session.next.tool.started", status: "started" }),
      makeEvent({ type: "session.next.tool.succeeded", status: "succeeded" }),
      makeEvent({ type: "session.next.tool.failed", status: "failed", error: "exit 1", tool: "bash" }),
    ]

    const result = queryFailureHotspots(events)
    expect(result.totalFailures).toBe(1)
    expect(result.uniqueCodes).toBe(1)
  })
})

describe("getActionsForCode", () => {
  test("returns sensible actions for known codes", () => {
    const actions = getActionsForCode("tool.timeout")
    expect(actions.length).toBeGreaterThan(0)
    expect(actions).toContain("Mark as pre-existing")
  })

  test("returns escalate for unknown codes", () => {
    const actions = getActionsForCode("unknown")
    expect(actions).toContain("Escalate to full investigation")
  })
})
