import type { RuntimeEvent } from "@/context/inspector"

// ── Normalized Error Codes ──

export type NormalizedErrorCode =
  | "tool.timeout"
  | "tool.failed"
  | "tool.denied"
  | "tool.rejected"
  | "lifecycle.phase_gate_denied"
  | "lifecycle.step_blocked"
  | "lifecycle.step_error"
  | "permission.denied"
  | "coordination.task_blocked"
  | "system.error"
  | "unknown"

const ERROR_CODE_META: Record<NormalizedErrorCode, { label: string; recoverable: boolean; severity: "fatal" | "error" | "warning" }> = {
  "tool.timeout": { label: "Tool timed out", recoverable: true, severity: "warning" },
  "tool.failed": { label: "Tool execution failed", recoverable: true, severity: "error" },
  "tool.denied": { label: "Tool execution denied", recoverable: false, severity: "error" },
  "tool.rejected": { label: "Tool input rejected", recoverable: true, severity: "error" },
  "lifecycle.phase_gate_denied": { label: "Phase gate denied", recoverable: true, severity: "warning" },
  "lifecycle.step_blocked": { label: "Step blocked by dependency", recoverable: true, severity: "warning" },
  "lifecycle.step_error": { label: "Step execution error", recoverable: true, severity: "error" },
  "permission.denied": { label: "Permission denied", recoverable: false, severity: "fatal" },
  "coordination.task_blocked": { label: "Task blocked by another lane", recoverable: true, severity: "warning" },
  "system.error": { label: "System error", recoverable: false, severity: "fatal" },
  "unknown": { label: "Unknown error", recoverable: false, severity: "error" },
}

const CODE_ACTIONS: Partial<Record<NormalizedErrorCode, string[]>> = {
  "tool.timeout": ["Run only failing tests", "Show last related edit", "Mark as pre-existing"],
  "tool.failed": ["Open failing test", "Ask agent to repair", "Show last related edit", "Revert suspected hunk"],
  "tool.denied": ["Escalate to full investigation"],
  "tool.rejected": ["Open failing test", "Ask agent to repair", "Show last related edit"],
  "lifecycle.phase_gate_denied": ["Ask agent to repair", "Show last related edit", "Escalate to full investigation"],
  "lifecycle.step_blocked": ["Run only failing tests", "Escalate to full investigation"],
  "lifecycle.step_error": ["Open failing test", "Ask agent to repair", "Show last related edit", "Revert suspected hunk"],
  "permission.denied": ["Mark as pre-existing", "Escalate to full investigation"],
  "coordination.task_blocked": ["Show last related edit", "Mark as pre-existing", "Escalate to full investigation"],
  "system.error": ["Escalate to full investigation"],
}

// ── Failure Hotspot Types ──

export interface FailureHotspot {
  code: NormalizedErrorCode
  label: string
  count: number
  events: RuntimeEvent[]
  recoverable: boolean
  severity: "fatal" | "error" | "warning"
  suggestedActions: string[]
}

export interface FailureHotspotQuery {
  hotspots: FailureHotspot[]
  totalFailures: number
  uniqueCodes: number
}

// ── Pattern Helpers ──

const ALL_ACTIONS: string[] = [
  "Open failing test",
  "Ask agent to repair",
  "Run only failing tests",
  "Show last related edit",
  "Revert suspected hunk",
  "Mark as pre-existing",
  "Escalate to full investigation",
]

/**
 * Normalize a failed event into a canonical error code.
 * Checks are ordered from most specific to least specific.
 */
export function normalizeErrorCode(type: string, error?: string): NormalizedErrorCode {
  const lowerType = type.toLowerCase()
  const lowerError = (error ?? "").toLowerCase()

  // 1. Timeout — detected through keywords in type or error
  if (/time\s*out/i.test(lowerType) || /time\s*out/i.test(lowerError) || /timed\s*out/i.test(lowerError) || /timed_out/i.test(lowerType) || /timed_out/i.test(lowerError) || /ETIMEDOUT/i.test(lowerType) || /ETIMEDOUT/i.test(lowerError)) {
    return "tool.timeout"
  }

  // 2. Permission denied — explicit permission events
  if (lowerType.includes("permission") || /permission/i.test(lowerError) || /unauthorized/i.test(lowerError) || /unauthenticated/i.test(lowerError)) {
    return "permission.denied"
  }

  // 3. Tool rejected — explicit rejected event or error message
  if (lowerType.includes("rejected") || /rejected/i.test(lowerError)) {
    // But if it's a step event, it's lifecycle
    if (lowerType.includes("step")) return "lifecycle.phase_gate_denied"
    return "tool.rejected"
  }

  // 4. Phase gate denied — step events with denied/gate keywords
  if (lowerType.includes("step") && (/denied/i.test(lowerType) || /denied/i.test(lowerError) || /gate/i.test(lowerType) || /gate/i.test(lowerError) || /precondition/i.test(lowerType) || /precondition/i.test(lowerError))) {
    return "lifecycle.phase_gate_denied"
  }

  // 5. Step blocked
  if (lowerType.includes("step") && (/blocked/i.test(lowerType) || /blocked/i.test(lowerError) || /dependency/i.test(lowerError))) {
    return "lifecycle.step_blocked"
  }

  // 6. Step error (generic step failure not caught above)
  if (lowerType.includes("step.error") || (lowerType.includes("step") && /error/i.test(lowerError))) {
    return "lifecycle.step_error"
  }

  // 7. Tool denied — tool events with denied keywords
  if (lowerType.includes("tool") && (/denied/i.test(lowerType) || /denied/i.test(lowerError) || /not allowed/i.test(lowerError) || /forbidden/i.test(lowerError))) {
    return "tool.denied"
  }

  // 8. Tool failed — generic tool failure
  if (lowerType.includes("tool.failed") || lowerType.includes("tool.error") || (lowerType.includes("tool") && /fail/i.test(lowerError))) {
    return "tool.failed"
  }

  // 9. Coordination blocked
  if (lowerType.includes("coordination") && (/blocked/i.test(lowerType) || /blocked/i.test(lowerError))) {
    return "coordination.task_blocked"
  }

  // 10. System errors — file I/O, server, pty, lsp
  if (lowerType.startsWith("file.") || lowerType.startsWith("server.") || lowerType.startsWith("pty.") || lowerType.startsWith("lsp.")) {
    return "system.error"
  }

  return "unknown"
}

/**
 * Get the suggested safe next actions for a given error code.
 */
export function getActionsForCode(code: NormalizedErrorCode): string[] {
  return CODE_ACTIONS[code] ?? ["Escalate to full investigation"]
}

/**
 * All safe next actions in order.
 */
export function getAllActions(): string[] {
  return [...ALL_ACTIONS]
}

/**
 * Query failure hotspots from a list of runtime events.
 * Groups failed events by normalized error code, returning counts and context.
 */
export function queryFailureHotspots(events: RuntimeEvent[]): FailureHotspotQuery {
  const failed = events.filter((e) => e.status === "failed" || !!e.error)

  const groups = new Map<NormalizedErrorCode, RuntimeEvent[]>()
  for (const event of failed) {
    const code = normalizeErrorCode(event.type, event.error)
    const list = groups.get(code) ?? []
    list.push(event)
    groups.set(code, list)
  }

  const hotspots: FailureHotspot[] = []
  for (const [code, groupEvents] of groups) {
    const meta = ERROR_CODE_META[code]
    const ordered = groupEvents.sort((a, b) => b.timestamp - a.timestamp)
    hotspots.push({
      code,
      label: meta.label,
      count: groupEvents.length,
      events: ordered,
      recoverable: meta.recoverable,
      severity: meta.severity,
      suggestedActions: getActionsForCode(code),
    })
  }

  hotspots.sort((a, b) => {
    const severityOrder = { fatal: 0, error: 1, warning: 2 }
    const sa = severityOrder[a.severity]
    const sb = severityOrder[b.severity]
    if (sa !== sb) return sa - sb
    return b.count - a.count
  })

  return {
    hotspots,
    totalFailures: failed.length,
    uniqueCodes: hotspots.length,
  }
}
