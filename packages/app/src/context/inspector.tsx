import { createMemo, createSignal, onCleanup } from "solid-js"
import { createStore, produce } from "solid-js/store"
import type { Event } from "@tribunus/sdk/v2/client"
import { createSimpleContext } from "@tribunus/ui/context"
import { useServerSDK } from "./server-sdk"

// ── Public Types ──

export interface RuntimeEvent {
  id: string
  type: string
  category: EventCategory
  timestamp: number
  sessionID: string
  actor?: string
  phase?: string
  tool?: string
  file?: string
  status: EventStatus
  duration?: number
  error?: string
  callID?: string
  parentID?: string
  raw: Event
}

export type EventStatus = "started" | "succeeded" | "failed" | "denied" | "progress" | "info"

export type EventCategory =
  | "tool"
  | "file"
  | "permission"
  | "lifecycle"
  | "agent"
  | "mcp"
  | "error"
  | "coordination"
  | "session"
  | "system"
  | "other"

export const EVENT_CATEGORIES: EventCategory[] = [
  "tool",
  "file",
  "permission",
  "lifecycle",
  "agent",
  "mcp",
  "error",
  "coordination",
  "session",
  "system",
  "other",
]

export const EVENT_CATEGORY_LABELS: Record<EventCategory, { icon: string; label: string }> = {
  tool: { icon: "🛠", label: "Tool Calls" },
  file: { icon: "📁", label: "Files" },
  permission: { icon: "🔒", label: "Permissions" },
  lifecycle: { icon: "🔄", label: "Lifecycle" },
  agent: { icon: "🤖", label: "Agent" },
  mcp: { icon: "🔌", label: "MCP" },
  error: { icon: "⚠️", label: "Errors" },
  coordination: { icon: "🔗", label: "Coordination" },
  session: { icon: "📋", label: "Session" },
  system: { icon: "🖥", label: "System" },
  other: { icon: "●", label: "Other" },
}

export const EVENT_STATUS_COLORS: Record<EventStatus, string> = {
  started: "#4A90D9",
  succeeded: "#2ECC71",
  failed: "#E74C3C",
  denied: "#E67E22",
  progress: "#F1C40F",
  info: "#888",
}

export interface InspectorFilters {
  categories: EventCategory[]
  statuses: EventStatus[]
  toolQuery: string
  fileQuery: string
  sessionID: string
  actor: string
  timeRange: "all" | "5m" | "15m" | "1h" | "6h" | "24h"
  showErrorsOnly: boolean
  showToolCallsOnly: boolean
  showFileEditsOnly: boolean
}

export interface InspectorStats {
  total: number
  byType: Record<string, number>
  byCategory: Record<string, number>
  errors: number
}

export interface InspectorContextType {
  events: () => RuntimeEvent[]
  filteredEvents: () => RuntimeEvent[]
  filters: () => InspectorFilters
  setFilter: (key: keyof InspectorFilters, value: unknown) => void
  clearFilters: () => void
  selectedEvent: () => RuntimeEvent | null
  selectEvent: (id: string) => void
  getChildren: (eventId: string) => RuntimeEvent[]
  getParent: (eventId: string) => RuntimeEvent | null
  stats: () => InspectorStats
  connected: () => boolean
  sessions: () => string[]
}

// ── Internal Helpers ──

const MAX_EVENTS = 10_000
let eventCounter = 0

function eventID(): string {
  return `inspector-${++eventCounter}`
}

function classifyEvent(type: string): { category: EventCategory; phase?: string } {
  if (type.startsWith("session.next.tool")) return { category: "tool", phase: type.split(".").pop() }
  if (type === "session.next.shell.started" || type === "session.next.shell.ended")
    return { category: "tool", phase: "shell" }
  if (type.startsWith("file.")) return { category: "file" }
  if (type.startsWith("permission.")) return { category: "permission" }
  if (type.startsWith("session.next.step.")) return { category: "lifecycle", phase: type.split(".").pop() }
  if (type === "session.next.prompted" || type === "session.next.synthetic") return { category: "lifecycle" }
  if (type.startsWith("session.next.")) return { category: "agent" }
  if (type.startsWith("mcp.")) return { category: "mcp" }
  if (type.startsWith("coordination.")) return { category: "coordination" }
  if (type.startsWith("session.")) return { category: "session" }
  if (type.startsWith("server.") || type.startsWith("pty.")) return { category: "system" }
  if (type.startsWith("workspace.") || type.startsWith("worktree.")) return { category: "system" }
  if (type.startsWith("lsp.")) return { category: "system" }
  return { category: "other" }
}

function inferStatus(type: string): EventStatus {
  if (type.endsWith(".called") || type.endsWith(".started") || type.endsWith(".asked"))
    return "started"
  if (type.endsWith(".success") || type.endsWith(".ended") || type.endsWith(".replied"))
    return "succeeded"
  if (type.endsWith(".failed")) return "failed"
  if (type.endsWith(".rejected") || type === "permission.replied") return "denied"
  if (type.endsWith(".progress") || type.endsWith(".delta")) return "progress"
  return "info"
}

function extractTool(event: Event): string | undefined {
  const p = event.properties as Record<string, unknown>
  if (typeof p.tool === "string") return p.tool
  if (typeof p.command === "string") {
    const cmd = String(p.command)
    const first = cmd.split(/\s+/)[0]
    return first || "shell"
  }
  if (typeof p.permission === "string") return p.permission
  return undefined
}

function extractFile(event: Event): string | undefined {
  const p = event.properties as Record<string, unknown>
  if (typeof p.file === "string") return p.file
  if (typeof p.patterns !== "undefined" && Array.isArray(p.patterns)) {
    return String(p.patterns[0] ?? "")
  }
  return undefined
}

function extractActor(event: Event): string | undefined {
  const p = event.properties as Record<string, unknown>
  if (typeof p.agent === "string") return p.agent
  return undefined
}

function extractCallID(event: Event): string | undefined {
  const p = event.properties as Record<string, unknown>
  if (typeof p.callID === "string") return p.callID
  if (typeof p.requestID === "string") return p.requestID
  return undefined
}

function extractSessionID(event: Event): string {
  const p = event.properties as Record<string, unknown>
  return String(p.sessionID ?? p.session_id ?? "global")
}

function extractError(event: Event): string | undefined {
  const p = event.properties as Record<string, unknown>
  if (p.error && typeof p.error === "object") {
    const err = p.error as Record<string, unknown>
    return String(err.message ?? err.type ?? JSON.stringify(err))
  }
  if (typeof p.error === "string") return p.error
  if (p.type === "failed" || p.type === "rejected") return String(p.type)
  return undefined
}

function extractTimestamp(event: Event): number {
  const p = event.properties as Record<string, unknown>
  return typeof p.timestamp === "number" ? p.timestamp : Date.now()
}

export const { use: useInspector, provider: InspectorProvider } = createSimpleContext({
  name: "Inspector",
  init: (): InspectorContextType => {
    const sdk = useServerSDK()

    const [events, setEvents] = createStore<RuntimeEvent[]>([])
    const [filters, setFilters] = createStore<InspectorFilters>({
      categories: [],
      statuses: [],
      toolQuery: "",
      fileQuery: "",
      sessionID: "",
      actor: "",
      timeRange: "all",
      showErrorsOnly: false,
      showToolCallsOnly: false,
      showFileEditsOnly: false,
    })
    const [selectedID, setSelectedID] = createSignal<string | undefined>(undefined)

    // Subscribe to ALL events from the SDK event stream
    const unsub = sdk.event.on("*", (event: Event) => {
      setEvents(
        produce((list) => {
          const category = classifyEvent(event.type)
          const re: RuntimeEvent = {
            id: eventID(),
            type: event.type,
            category: category.category,
            timestamp: extractTimestamp(event),
            sessionID: extractSessionID(event),
            actor: extractActor(event),
            phase: category.phase,
            tool: extractTool(event),
            file: extractFile(event),
            status: event.type === "permission.replied"
              ? (event.properties as Record<string, unknown>).reply === "reject" ? "denied" : "succeeded"
              : inferStatus(event.type),
            callID: extractCallID(event),
            raw: event,
          }
          // Error extraction
          if (event.type.endsWith(".failed") || event.type.endsWith(".rejected")) {
            re.error = extractError(event)
            re.status = "failed"
          }
          list.push(re)
          if (list.length > MAX_EVENTS) {
            list.splice(0, list.length - MAX_EVENTS)
          }
        }),
      )
    })

    onCleanup(unsub)

    // ── Filtered events (computed) ──
    const filteredEvents = createMemo(() => {
      let items = [...events]
      const f = filters

      if (f.showErrorsOnly) items = items.filter((e) => e.status === "failed" || e.error)
      if (f.showToolCallsOnly) items = items.filter((e) => e.category === "tool")
      if (f.showFileEditsOnly) items = items.filter((e) => e.category === "file")

      if (f.categories.length > 0) items = items.filter((e) => f.categories.includes(e.category))
      if (f.statuses.length > 0) items = items.filter((e) => f.statuses.includes(e.status))
      if (f.sessionID) items = items.filter((e) => e.sessionID === f.sessionID)
      if (f.actor) items = items.filter((e) => e.actor?.toLowerCase().includes(f.actor.toLowerCase()))
      if (f.toolQuery) items = items.filter((e) => e.tool?.toLowerCase().includes(f.toolQuery.toLowerCase()))
      if (f.fileQuery) items = items.filter((e) => e.file?.toLowerCase().includes(f.fileQuery.toLowerCase()))

      if (f.timeRange !== "all") {
        const cutoff = Date.now() - parseTimeRange(f.timeRange)
        items = items.filter((e) => e.timestamp >= cutoff)
      }

      return items.sort((a, b) => b.timestamp - a.timestamp)
    })

    // ── Stats ──
    const stats = createMemo((): InspectorStats => {
      const byType: Record<string, number> = {}
      const byCategory: Record<string, number> = {}
      let errors = 0
      for (const e of events) {
        byType[e.type] = (byType[e.type] ?? 0) + 1
        byCategory[e.category] = (byCategory[e.category] ?? 0) + 1
        if (e.status === "failed" || e.error) errors++
      }
      return {
        total: events.length,
        byType,
        byCategory,
        errors,
      }
    })

    // ── Sessions list (derived) ──
    const sessions = createMemo(() => {
      const seen = new Set<string>()
      const result: string[] = []
      for (let i = events.length - 1; i >= 0; i--) {
        const e = events[i]!
        if (!seen.has(e.sessionID)) {
          seen.add(e.sessionID)
          result.push(e.sessionID)
        }
      }
      return result
    })

    // ── Correlation helpers ──
    function getChildren(eventId: string): RuntimeEvent[] {
      const parent = events.find((e) => e.id === eventId)
      if (!parent?.callID) return []
      return events.filter((e) => e.callID === parent.callID && e.id !== eventId)
    }

    function getParent(eventId: string): RuntimeEvent | null {
      const child = events.find((e) => e.id === eventId)
      if (!child?.callID) return null
      return events.find((e) => e.callID === child.callID && e.id !== eventId && e.timestamp <= child.timestamp) ?? null
    }

    return {
      events: () => events,
      filteredEvents,
      filters: () => ({ ...filters }),
      setFilter: (key, value) => {
        setFilters(key as never, value as never)
      },
      clearFilters: () => {
        setFilters({
          categories: [],
          statuses: [],
          toolQuery: "",
          fileQuery: "",
          sessionID: "",
          actor: "",
          timeRange: "all",
          showErrorsOnly: false,
          showToolCallsOnly: false,
          showFileEditsOnly: false,
        })
      },
      selectedEvent: () => (selectedID() ? events.find((e) => e.id === selectedID()) ?? null : null),
      selectEvent: (id) => setSelectedID(id),
      getChildren,
      getParent,
      stats,
      connected: () => true,
      sessions,
    }
  },
})

function parseTimeRange(range: string): number {
  switch (range) {
    case "5m": return 5 * 60 * 1000
    case "15m": return 15 * 60 * 1000
    case "1h": return 60 * 60 * 1000
    case "6h": return 6 * 60 * 60 * 1000
    case "24h": return 24 * 60 * 60 * 1000
    default: return Infinity
  }
}
