import type { CoordinationFabric, CoordinationEvent } from "./fabric"

// ── Realtime Event Types ─────────────────────────────────

export type RealtimeEventKind =
  | "agent.heartbeat"
  | "agent.started"
  | "agent.completed"
  | "agent.failed"
  | "agent.blocked"
  | "tool.job.submitted"
  | "tool.job.started"
  | "tool.job.completed"
  | "tool.job.failed"
  | "tool.job.cancelled"
  | "projection.stale"
  | "projection.current"
  | "context.invalidated"
  | "backpressure.changed"

export interface RealtimeEvent {
  kind: RealtimeEventKind
  projectId?: string
  agentId?: string
  jobId?: string
  payload: Record<string, unknown>
  timestamp: number
}

export type RealtimeEventHandler = (event: RealtimeEvent) => void

// ── Event Bridge ──────────────────────────────────────────

export interface RealtimeEventBridge {
  /** Publish a realtime event — fans out to all subscribers. */
  emit(event: RealtimeEvent): Promise<void>

  /** Subscribe to events matching a kind or prefix. Returns unsubscribe. */
  on(kind: RealtimeEventKind | "*", handler: RealtimeEventHandler): Promise<() => void>

  /** Snapshot: returns the latest events since a timestamp. */
  eventsSince(timestamp: number): Promise<RealtimeEvent[]>

  /** Clean up old events. */
  reap(ageMs: number): Promise<number>

  dispose(): Promise<void>
}

// ── Implementation ───────────────────────────────────────

export function createRealtimeEventBridge(fabric: CoordinationFabric): RealtimeEventBridge {
  const subscribers = new Map<string, Set<RealtimeEventHandler>>()
  const eventLog: RealtimeEvent[] = []
  const MAX_LOG = 500

  async function emit(event: RealtimeEvent): Promise<void> {
    eventLog.push(event)
    if (eventLog.length > MAX_LOG) eventLog.splice(0, eventLog.length - MAX_LOG)

    // Fanout to subscribers
    const handlers = new Set<RealtimeEventHandler>()
    for (const [kind, set] of subscribers) {
      if (kind === "*" || kind === event.kind) {
        for (const h of set) handlers.add(h)
      }
    }
    for (const h of handlers) {
      try { h(event) } catch {}
    }

    // Also publish to fabric for cross-process fanout
    const coordEvent: CoordinationEvent = {
      type: `opencode:realtime:${event.kind}`,
      payload: event.payload,
      timestamp: event.timestamp,
    }
    await fabric.publish(coordEvent)
  }

  async function on(kind: RealtimeEventKind | "*", handler: RealtimeEventHandler): Promise<() => void> {
    if (!subscribers.has(kind)) subscribers.set(kind, new Set())
    subscribers.get(kind)!.add(handler)
    return async () => {
      subscribers.get(kind)?.delete(handler)
    }
  }

  async function eventsSince(timestamp: number): Promise<RealtimeEvent[]> {
    return eventLog.filter(e => e.timestamp > timestamp)
  }

  async function reap(ageMs: number): Promise<number> {
    const cutoff = Date.now() - ageMs
    const before = eventLog.length
    for (let i = eventLog.length - 1; i >= 0; i--) {
      if (eventLog[i].timestamp < cutoff) {
        eventLog.splice(0, i + 1)
        break
      }
    }
    return before - eventLog.length
  }

  async function dispose() {
    subscribers.clear()
    eventLog.length = 0
  }

  return { emit, on, eventsSince, reap, dispose }
}
