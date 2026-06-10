/**
 * Projection Stream — mobile PWA WebSocket client for cursored state deltas.
 *
 * Connects to the desktop's projection WebSocket endpoint, receives
 * incremental state deltas (cursor-based), caches projections locally,
 * and falls back to cached state when offline.
 *
 * Supports exponential backoff with jitter, cursor-based replay across
 * disconnects, and heartbeat keep-alive.
 */

import { uuid } from "@/utils/uuid"

// ── Types ──────────────────────────────────────────────────────────────

export type ProjectionKind =
  | "session_update"
  | "mission_progress"
  | "agent_status"
  | "gate_event"
  | "gate_waiting"
  | "gate_resolved"
  | "lane_heartbeat"
  | "request_status"
  | "coordination_claim"

export interface ProjectionDelta {
  kind: ProjectionKind
  /** Opaque cursor – monotonically increasing on the server side. */
  cursor: string
  payload: Record<string, unknown>
  /** Unix ms when the server produced this delta. */
  timestamp: number
}

export interface ProjectionStreamState {
  connected: boolean
  lastCursor: string | null
  lastReconnect: number | null
}

export interface ProjectionCache {
  cursor: string | null
  projections: Record<string, ProjectionDelta>
  updatedAt: number
}

/** Connection status reported to consumers. */
export type ConnectionStatus = "disconnected" | "connecting" | "connected" | "reconnecting"

// ── Constants ──────────────────────────────────────────────────────────

const CACHE_KEY = "tribunus-pwa:projection-cache"
/** Persist the last cursor separately so it survives cache clears. */
const CURSOR_KEY = "tribunus-pwa:projection-cursor"
const RECONNECT_BASE_MS = 1_000
const RECONNECT_MAX_MS = 30_000
const JITTER_MAX_MS = 500
const WS_HEARTBEAT_MS = 30_000
/** Throttle cursor writes to localStorage so we don't hammer storage on flood. */
const CURSOR_WRITE_THROTTLE_MS = 1_000

// ── Implementation ─────────────────────────────────────────────────────

export interface ProjectionStreamClient {
  readonly status: ConnectionStatus
  readonly lastCursor: string | null
  connect(url: string, token: string): void
  disconnect(): void
  onDelta(cb: (delta: ProjectionDelta, cache: ProjectionCache) => void): () => void
  onStatusChange(cb: (status: ConnectionStatus) => void): () => void
  getCache(): ProjectionCache | null
  clearCache(): void
}

export function createProjectionStream(): ProjectionStreamClient {
  let ws: WebSocket | null = null
  let status: ConnectionStatus = "disconnected"
  let lastCursor: string | null = null
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let reconnectAttempt = 0
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null
  let intentionalClose = false
  /** URL+token tuple we reconnect to, set on every connect() call. */
  let connectTarget: { url: string; token: string } | null = null
  let lastCursorWrite = 0

  const deltaListeners = new Set<(delta: ProjectionDelta, cache: ProjectionCache) => void>()
  const statusListeners = new Set<(s: ConnectionStatus) => void>()

  function setStatus(s: ConnectionStatus) {
    status = s
    for (const cb of statusListeners) cb(s)
  }

  // ── Persisted cursor ──────────────────────────────────────────────────

  function loadCursor(): string | null {
    try {
      return localStorage.getItem(CURSOR_KEY)
    } catch {
      return null
    }
  }

  function saveCursor(cursor: string) {
    const now = Date.now()
    if (now - lastCursorWrite < CURSOR_WRITE_THROTTLE_MS) return
    lastCursorWrite = now
    try {
      localStorage.setItem(CURSOR_KEY, cursor)
    } catch {
      // storage unavailable
    }
  }

  function clearCursor() {
    lastCursor = null
    try {
      localStorage.removeItem(CURSOR_KEY)
    } catch {
      // noop
    }
  }

  // ── Cache ─────────────────────────────────────────────────────────────

  function loadCache(): ProjectionCache | null {
    try {
      const raw = localStorage.getItem(CACHE_KEY)
      if (!raw) return null
      return JSON.parse(raw) as ProjectionCache
    } catch {
      return null
    }
  }

  function saveCache(cursor: string, delta: ProjectionDelta) {
    try {
      const existing = loadCache() ?? { cursor: null, projections: {}, updatedAt: Date.now() }
      existing.cursor = cursor
      existing.projections[`${delta.kind}:${delta.cursor}`] = delta
      existing.updatedAt = Date.now()
      localStorage.setItem(CACHE_KEY, JSON.stringify(existing))
    } catch {
      // Storage full or unavailable – silently degrade
    }
  }

  function clearCache() {
    try {
      localStorage.removeItem(CACHE_KEY)
    } catch {
      // noop
    }
  }

  // ── Heartbeat ─────────────────────────────────────────────────────────

  function startHeartbeat() {
    stopHeartbeat()
    heartbeatTimer = setInterval(() => {
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "ping" }))
      }
    }, WS_HEARTBEAT_MS)
  }

  function stopHeartbeat() {
    if (heartbeatTimer !== null) {
      clearInterval(heartbeatTimer)
      heartbeatTimer = null
    }
  }

  // ── Reconnect with exponential backoff + jitter ───────────────────────

  function scheduleReconnect() {
    if (intentionalClose || !connectTarget) return
    const target = connectTarget; // narrow for TS
    const exponential = Math.min(RECONNECT_BASE_MS * 2 ** reconnectAttempt, RECONNECT_MAX_MS)
    const jitter = Math.floor(Math.random() * JITTER_MAX_MS)
    const delay = exponential + jitter
    reconnectAttempt++
    setStatus("reconnecting")
    reconnectTimer = setTimeout(() => connect(target.url, target.token), delay)
  }

  function clearReconnect() {
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
    reconnectAttempt = 0
  }

  // ── Connect / Disconnect ──────────────────────────────────────────────

  function connect(url: string, token: string) {
    if (ws?.readyState === WebSocket.OPEN || ws?.readyState === WebSocket.CONNECTING) return
    connectTarget = { url, token }
    intentionalClose = false
    clearReconnect()

    setStatus("connecting")

    // Append auth token as query param for the WS upgrade
    const wsUrl = new URL(url)
    wsUrl.searchParams.set("token", token)

    // Load persisted cursor for cursor-based replay
    const resumeCursor = loadCursor()
    if (resumeCursor) lastCursor = resumeCursor

    try {
      ws = new WebSocket(wsUrl.toString())
    } catch (err) {
      setStatus("disconnected")
      scheduleReconnect()
      return
    }

    ws.onopen = () => {
      setStatus("connected")
      reconnectAttempt = 0
      startHeartbeat()
      // Send cursor-based subscribe: server replays from this cursor forward
      ws!.send(JSON.stringify({
        type: "subscribe",
        cursor: lastCursor,
      }))
    }

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data as string)
        if (msg.type === "pong") return
        if (msg.type === "delta" || msg.type === "projection") {
          const delta: ProjectionDelta = {
            kind: msg.kind ?? msg.type,
            cursor: msg.cursor,
            payload: msg.payload ?? {},
            timestamp: msg.timestamp ?? Date.now(),
          }
          lastCursor = delta.cursor
          saveCursor(delta.cursor)
          saveCache(delta.cursor, delta)
          const cache = loadCache()
          for (const cb of deltaListeners) cb(delta, cache ?? { cursor: null, projections: {}, updatedAt: Date.now() })
        }
      } catch {
        // Malformed message – ignore
      }
    }

    ws.onclose = () => {
      setStatus("disconnected")
      stopHeartbeat()
      ws = null
      if (!intentionalClose) scheduleReconnect()
    }

    ws.onerror = () => {
      // onclose fires after onerror, so the close handler schedules reconnect
      ws?.close()
    }
  }

  function disconnect() {
    intentionalClose = true
    clearReconnect()
    stopHeartbeat()
    lastCursor = null
    connectTarget = null
    if (ws) {
      ws.onclose = null
      ws.onerror = null
      ws.onmessage = null
      ws.close()
      ws = null
    }
    setStatus("disconnected")
  }

  // ── Public API ────────────────────────────────────────────────────────

  const client: ProjectionStreamClient = {
    get status() { return status },
    get lastCursor() { return lastCursor },
    connect,
    disconnect,
    onDelta(cb) {
      deltaListeners.add(cb)
      return () => deltaListeners.delete(cb)
    },
    onStatusChange(cb) {
      statusListeners.add(cb)
      return () => statusListeners.delete(cb)
    },
    getCache() {
      return loadCache()
    },
    clearCache,
  }

  return client
}

export const projectionStream = createProjectionStream()
