import { createSignal, onCleanup, onMount } from "solid-js"
import { createStore, produce } from "solid-js/store"
import type { Event } from "@tribunus/sdk/v2/client"
import { useServerSDK } from "./server-sdk"
import { useSettings } from "./settings"
import { createSimpleContext } from "@tribunus/ui/context"

// ── Types ──

export interface SessionVizSession {
  id: string
  agent: string
  status: "active" | "idle" | "blocked"
  current_file?: string
  mission_summary?: string
  color: string
  last_heartbeat: number
  tasks: VizTask[]
  recent_activity: ActivityEntry[]
  agentHeartbeat?: AgentHeartbeatInfo
}

export interface VizTask {
  id: string
  type: string
  status: "running" | "completed" | "failed" | "blocked"
  description: string
}

export interface ActivityEntry {
  id: string
  session_id: string
  agent: string
  type: ActivityType
  summary: string
  detail?: string
  timestamp: number
}

export interface AgentHeartbeatInfo {
  agent: string
  toolName?: string
  toolStatus?: "running" | "completed" | "failed"
  startedAt: number
  lastActiveAt: number
}

export type ActivityType = "tool_call" | "file_edit" | "message" | "permission" | "llm_turn" | "session_status" | "task_status"

export interface ClaimedPath {
  path: string
  session_id: string
  intent: "edit" | "create" | "read" | "delete"
}

// ── Internal event shapes (coordination events not in the SDK Event union) ──

interface CoordinationHeartbeat {
  id: string
  type: "coordination.session_heartbeat"
  properties: {
    session_id: string
    agent: string
    status: "active" | "idle" | "blocked"
    current_file?: string
    mission_summary?: string
    heartbeat_at: number
  }
}

interface CoordinationTaskStatus {
  id: string
  type: "coordination.task_status"
  properties: {
    session_id: string
    task_id: string
    task_type: string
    status: "running" | "completed" | "failed" | "blocked"
    description: string
    agent_name?: string
    changed_at: number
  }
}

interface CoordinationPathClaimed {
  id: string
  type: "coordination.path_claimed"
  properties: {
    session_id: string
    path: string
    intent: "edit" | "create" | "read" | "delete"
    claimed_at: number
  }
}

interface CoordinationActivityLogged {
  id: string
  type: "coordination.activity_logged"
  properties: {
    session_id: string
    action: string
    target?: string
    details?: Record<string, unknown>
    logged_at: number
  }
}

export interface AgentHeartbeatInfo {
  agent: string
  toolName?: string
  toolStatus?: "running" | "completed" | "failed"
  startedAt: number
  lastActiveAt: number
}

// ── Context ──

export interface SessionVizContextType {
  sessions: () => SessionVizSession[]
  activity: () => ActivityEntry[]
  claimedPaths: () => ClaimedPath[]
  isConnected: () => boolean
  vizEnabled: () => boolean
  setVizEnabled: (enabled: boolean) => void
  agentHeartbeat: (sessionID: string) => AgentHeartbeatInfo | undefined
  getAgentColor: (name: string) => string
}

// Curated 12-color palette (distinguishable, accessible)
const SESSION_COLORS = [
  "#4A90D9", "#E67E22", "#2ECC71", "#E74C3C", "#9B59B6",
  "#1ABC9C", "#F39C12", "#3498DB", "#E91E63", "#00BCD4",
  "#FF5722", "#8BC34A",
]

const ACTIVITY_CAP = 50
const SESSION_CAP = 100

let colorIndex = 0

function nextColor(): string {
  return SESSION_COLORS[colorIndex++ % SESSION_COLORS.length]
}

function now(): number {
  return Date.now()
}

function activityID(): string {
  return `act_${now()}_${Math.random().toString(36).slice(2, 8)}`
}

function mapSessionStatus(input: string): "active" | "idle" | "blocked" {
  if (input === "idle") return "idle"
  if (input === "blocked") return "blocked"
  return "active"
}

export const { use: useSessionViz, provider: SessionVizProvider } = createSimpleContext({
  name: "SessionViz",
  init: () => {
    const sdk = useServerSDK()
    const settings = useSettings()

    const [sessions, setSessions] = createStore<Record<string, SessionVizSession>>({})
    const [activityLog, setActivityLog] = createStore<ActivityEntry[]>([])
    const [paths, setPaths] = createStore<Record<string, ClaimedPath>>({})
    const [isConnected, setIsConnected] = createSignal(false)
    const [vizEnabled, setVizEnabled] = createSignal(true)
    const agentColorMap: Record<string, string> = {}

    onMount(() => {
      const handler = (e: KeyboardEvent) => {
        if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "v") {
          // Don't intercept when user is typing in an input/textarea
          const tag = (e.target as HTMLElement)?.tagName
          if (tag === "INPUT" || tag === "TEXTAREA" || (e.target as HTMLElement)?.isContentEditable) return
          e.preventDefault()
          settings.general.setShowSessionViz(!settings.general.showSessionViz())
        }
      }
      document.addEventListener("keydown", handler)
      onCleanup(() => document.removeEventListener("keydown", handler))
    })

    // ── Helpers ──

    function ensureSession(sessionID: string): SessionVizSession {
      const existing = sessions[sessionID]
      if (existing) return existing
      // Evict oldest sessions when over cap
      if (Object.keys(sessions).length >= SESSION_CAP) {
        const entries = Object.entries(sessions).sort(
          ([, a], [, b]) => a.last_heartbeat - b.last_heartbeat,
        )
        const evict = entries.slice(0, entries.length - SESSION_CAP + 1)
        setSessions(
          produce((draft) => {
            for (const [key] of evict) {
              delete draft[key]
            }
          }),
        )
      }
      const session: SessionVizSession = {
        id: sessionID,
        agent: "unknown",
        status: "active",
        color: nextColor(),
        last_heartbeat: now(),
        tasks: [],
        recent_activity: [],
      }
      setSessions(sessionID, session)
      return session
    }

    function pushActivity(entry: ActivityEntry) {
      setActivityLog(
        produce((draft) => {
          draft.unshift(entry)
          if (draft.length > ACTIVITY_CAP) {
            draft.length = ACTIVITY_CAP
          }
        }),
      )
    }

    function pushSessionActivity(sessionID: string, entry: ActivityEntry) {
      const session = ensureSession(sessionID)
      setSessions(sessionID, "recent_activity", (prev) => {
        const next = [entry, ...prev]
        if (next.length > 10) next.length = 10
        return next
      })
    }

    // ── Event handlers ──

    function handleSessionStatus(payload: Event["properties"]) {
      const { sessionID, status } = payload as { sessionID: string; status: { type: string } }
      const session = ensureSession(sessionID)
      const mapped = mapSessionStatus(status.type)
      setSessions(sessionID, "status", mapped)
      setSessions(sessionID, "last_heartbeat", now())
      pushActivity({
        id: activityID(),
        session_id: sessionID,
        agent: session.agent,
        type: "session_status",
        summary: `Session ${sessionID.slice(0, 8)} status: ${status.type}`,
        timestamp: now(),
      })
    }

    function handleSessionCreated(payload: Event["properties"]) {
      const { sessionID } = payload as { sessionID: string }
      ensureSession(sessionID)
      pushActivity({
        id: activityID(),
        session_id: sessionID,
        agent: "unknown",
        type: "session_status",
        summary: `Session created: ${sessionID.slice(0, 8)}`,
        timestamp: now(),
      })
    }

    function handleSessionDeleted(payload: Event["properties"]) {
      const { sessionID } = payload as { sessionID: string }
      setSessions(
        produce((draft) => {
          delete draft[sessionID]
        }),
      )
      pushActivity({
        id: activityID(),
        session_id: sessionID,
        agent: "unknown",
        type: "session_status",
        summary: `Session deleted: ${sessionID.slice(0, 8)}`,
        timestamp: now(),
      })
    }

    function handleAgentSwitched(payload: Event["properties"]) {
      const { sessionID, agent } = payload as { sessionID: string; agent: string; timestamp: number }
      ensureSession(sessionID)
      setSessions(sessionID, "agent", agent)
      setSessions(sessionID, "agentHeartbeat", {
        agent,
        startedAt: now(),
        lastActiveAt: now(),
      })
      pushActivity({
        id: activityID(),
        session_id: sessionID,
        agent,
        type: "session_status",
        summary: `Agent switched to ${agent}`,
        timestamp: now(),
      })
    }

    function handleToolCalled(payload: Event["properties"]) {
      const { sessionID, callID, tool } = payload as {
        sessionID: string
        callID: string
        tool: string
        timestamp: number
        input: Record<string, unknown>
      }
      const session = ensureSession(sessionID)
      const description = `${tool}(${JSON.stringify(payload).slice(0, 80)})`
      // Update agent heartbeat with tool info
      const hb = sessions[sessionID]?.agentHeartbeat
      if (hb) {
        setSessions(sessionID, "agentHeartbeat", {
          ...hb,
          toolName: tool,
          toolStatus: "running",
          lastActiveAt: now(),
        })
      }
      const task: VizTask = {
        id: callID,
        type: tool,
        status: "running",
        description,
      }
      setSessions(sessionID, "tasks", (prev) => [...prev, task])
      pushActivity({
        id: activityID(),
        session_id: sessionID,
        agent: session.agent,
        type: "tool_call",
        summary: `${tool} started`,
        detail: description,
        timestamp: now(),
      })
    }

    function handleToolSuccess(payload: Event["properties"]) {
      const { sessionID, callID } = payload as { sessionID: string; callID: string; timestamp: number }
      setSessions(sessionID, "tasks", (prev) =>
        prev.map((t) => (t.id === callID ? { ...t, status: "completed" as const } : t)),
      )
      const session = ensureSession(sessionID)
      const hb = sessions[sessionID]?.agentHeartbeat
      if (hb) {
        setSessions(sessionID, "agentHeartbeat", {
          ...hb,
          toolStatus: "completed",
          lastActiveAt: now(),
        })
      }
      pushActivity({
        id: activityID(),
        session_id: sessionID,
        agent: session.agent,
        type: "tool_call",
        summary: `Tool completed`,
        timestamp: now(),
      })
    }

    function handleToolFailed(payload: Event["properties"]) {
      const { sessionID, callID } = payload as {
        sessionID: string
        callID: string
        timestamp: number
        error: { message: string }
      }
      setSessions(sessionID, "tasks", (prev) =>
        prev.map((t) => (t.id === callID ? { ...t, status: "failed" as const } : t)),
      )
      const session = ensureSession(sessionID)
      const hb = sessions[sessionID]?.agentHeartbeat
      if (hb) {
        setSessions(sessionID, "agentHeartbeat", {
          ...hb,
          toolStatus: "failed",
          lastActiveAt: now(),
        })
      }
      pushActivity({
        id: activityID(),
        session_id: sessionID,
        agent: session.agent,
        type: "tool_call",
        summary: "Tool failed",
        timestamp: now(),
      })
    }

    function handleFileEdited(payload: Event["properties"]) {
      const { file, sessionID } = payload as { file: string; sessionID?: string }
      const sid = sessionID ?? "unknown"
      const session = ensureSession(sid)
      pushActivity({
        id: activityID(),
        session_id: sid,
        agent: session.agent,
        type: "file_edit",
        summary: `Edited ${file}`,
        timestamp: now(),
      })
    }

    function handleStepStarted(payload: Event["properties"]) {
      const { sessionID, agent } = payload as {
        sessionID: string
        agent: string
        timestamp: number
        model: { id: string }
      }
      ensureSession(sessionID)
      setSessions(sessionID, "agent", agent)
      setSessions(sessionID, "status", "active")
      setSessions(sessionID, "agentHeartbeat", {
        agent,
        startedAt: now(),
        lastActiveAt: now(),
      })
      pushActivity({
        id: activityID(),
        session_id: sessionID,
        agent,
        type: "llm_turn",
        summary: `Step started (${agent})`,
        timestamp: now(),
      })
    }

    function handleShellStarted(payload: Event["properties"]) {
      const { sessionID, command } = payload as {
        sessionID: string
        callID: string
        command: string
        timestamp: number
      }
      const session = ensureSession(sessionID)
      pushActivity({
        id: activityID(),
        session_id: sessionID,
        agent: session.agent,
        type: "tool_call",
        summary: `Shell: ${command.slice(0, 60)}`,
        timestamp: now(),
      })
    }

    function handlePermissionAsked(payload: Event["properties"]) {
      const { sessionID } = payload as { sessionID: string }
      const session = ensureSession(sessionID)
      pushActivity({
        id: activityID(),
        session_id: sessionID,
        agent: session.agent,
        type: "permission",
        summary: "Permission requested",
        timestamp: now(),
      })
    }

    function handlePermissionReplied(payload: Event["properties"]) {
      const { sessionID, reply } = payload as {
        sessionID: string
        requestID: string
        reply: "once" | "always" | "reject"
      }
      const session = ensureSession(sessionID)
      pushActivity({
        id: activityID(),
        session_id: sessionID,
        agent: session.agent,
        type: "permission",
        summary: `Permission ${reply}`,
        timestamp: now(),
      })
    }

    // ── Coordination event handlers ──

    function handleCoordinationHeartbeat(payload: CoordinationHeartbeat["properties"]) {
      const { session_id, agent, status, current_file, mission_summary, heartbeat_at } = payload
      const session = ensureSession(session_id)
      const color = session.color
      setSessions(session_id, {
        agent,
        status: mapSessionStatus(status),
        current_file,
        mission_summary,
        last_heartbeat: heartbeat_at,
        color,
      })
      pushSessionActivity(session_id, {
        id: activityID(),
        session_id,
        agent,
        type: "session_status",
        summary: `Heartbeat: ${status}${current_file ? ` (${current_file})` : ""}`,
        timestamp: heartbeat_at,
      })
    }

    function handleCoordinationTaskStatus(payload: CoordinationTaskStatus["properties"]) {
      const { session_id, task_id, task_type, status, description, changed_at } = payload
      const session = ensureSession(session_id)
      const task: VizTask = {
        id: task_id,
        type: task_type,
        status,
        description: description.slice(0, 120),
      }
      setSessions(session_id, "tasks", (prev) => {
        const idx = prev.findIndex((t) => t.id === task_id)
        if (idx >= 0) {
          const next = [...prev]
          next[idx] = task
          return next
        }
        return [...prev, task]
      })
      pushSessionActivity(session_id, {
        id: activityID(),
        session_id,
        agent: session.agent,
        type: "task_status",
        summary: `Task ${task_id.slice(0, 8)}: ${status}`,
        detail: description,
        timestamp: changed_at,
      })
    }

    function handleCoordinationPathClaimed(payload: CoordinationPathClaimed["properties"]) {
      const { session_id, path, intent, claimed_at } = payload
      const key = `${session_id}:${path}`
      setPaths(key, { path, session_id, intent })
      pushSessionActivity(session_id, {
        id: activityID(),
        session_id,
        agent: sessions[session_id]?.agent ?? "unknown",
        type: "file_edit",
        summary: `${intent} ${path}`,
        timestamp: claimed_at,
      })
    }

    function handleCoordinationActivityLogged(payload: CoordinationActivityLogged["properties"]) {
      const { session_id, action, target, details, logged_at } = payload
      const session = ensureSession(session_id)
      pushActivity({
        id: activityID(),
        session_id,
        agent: session.agent,
        type: details?.type === "file_edit" ? "file_edit" : "session_status",
        summary: `${action}${target ? ` ${target}` : ""}`,
        detail: details ? JSON.stringify(details).slice(0, 200) : undefined,
        timestamp: logged_at,
      })
    }

    // ── Subscribe to SSE event stream ──

    const unsub = sdk.event.listen((e) => {
      const event = e.details as Event
      const { type, properties } = event as any

      // Handle known SDK event types
      switch (type) {
        case "session.status":
          handleSessionStatus(properties)
          break
        case "session.created":
          handleSessionCreated(properties)
          break
        case "session.deleted":
          handleSessionDeleted(properties)
          break
        case "session.next.agent.switched":
          handleAgentSwitched(properties)
          break
        case "session.next.step.started":
          handleStepStarted(properties)
          break
        case "session.next.tool.called":
          handleToolCalled(properties)
          break
        case "session.next.tool.success":
          handleToolSuccess(properties)
          break
        case "session.next.tool.failed":
          handleToolFailed(properties)
          break
        case "session.next.shell.started":
          handleShellStarted(properties)
          break
        case "file.edited":
          handleFileEdited(properties)
          break
        case "permission.asked":
          handlePermissionAsked(properties)
          break
        case "permission.replied":
          handlePermissionReplied(properties)
          break
        case "server.connected":
          setIsConnected(true)
          break
        case "global.disposed":
          setIsConnected(false)
          break
        // Coordination events (custom types not in SDK Event union)
        case "coordination.session_heartbeat":
          handleCoordinationHeartbeat(properties as CoordinationHeartbeat["properties"])
          break
        case "coordination.task_status":
          handleCoordinationTaskStatus(properties as CoordinationTaskStatus["properties"])
          break
        case "coordination.path_claimed":
          handleCoordinationPathClaimed(properties as CoordinationPathClaimed["properties"])
          break
        case "coordination.activity_logged":
          handleCoordinationActivityLogged(properties as CoordinationActivityLogged["properties"])
          break
      }
    })

    onCleanup(unsub)

    return {
      sessions: () => Object.values(sessions),
      activity: () => {
        const log = activityLog
        return [...log].sort((a, b) => b.timestamp - a.timestamp).slice(0, ACTIVITY_CAP)
      },
      claimedPaths: () => Object.values(paths),
      isConnected,
      vizEnabled,
      setVizEnabled,
      agentHeartbeat: (sessionID: string) => sessions[sessionID]?.agentHeartbeat,
      getAgentColor: (name: string) => {
        if (agentColorMap[name]) return agentColorMap[name]
        const color = SESSION_COLORS[colorIndex++ % SESSION_COLORS.length]!
        agentColorMap[name] = color!
        return color
      },
    }
  },
})
