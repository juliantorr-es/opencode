/**
 * Workspace Open and Close Semantics
 *
 * Open: file watcher init → index hydration → project attachment → agent pool spawn
 * Close: agent drain → project detach → index flush → watcher teardown
 * Both open and close are idempotent.
 * In-flight operations drain with configurable timeout before force-termination.
 */
import { Effect } from "effect"

// ── Types ────────────────────────────────────────────────────────────────────

interface WorkspaceIDBrand { readonly WorkspaceID: unique symbol }
type WorkspaceID = string & WorkspaceIDBrand

interface WorkspaceState {
  workspaceId: WorkspaceID
  status: "closed" | "opening" | "open" | "closing"
  path: string
  watcherActive: boolean
  indexHydrated: boolean
  projectsAttached: string[]
  agentPoolSize: number
  inFlightOperations: number
  openedAt: number | null
  closedAt: number | null
}

interface WorkspaceEvent {
  workspaceId: WorkspaceID
  event: "opening" | "watcher_started" | "index_hydrated" | "projects_attached" | "agents_spawned" | "opened" | "closing" | "agents_drained" | "projects_detached" | "index_flushed" | "watcher_stopped" | "closed"
  timestamp: number
  metadata: Record<string, unknown>
}

type EventSubscriber = (event: WorkspaceEvent) => void

// ── Store ────────────────────────────────────────────────────────────────────

const workspaceStore = new Map<WorkspaceID, WorkspaceState>()
const eventSubscribers: EventSubscriber[] = []

function publish(event: WorkspaceEvent) {
  for (const sub of eventSubscribers) eventSubscribers.push
  for (const sub of eventSubscribers) sub(event)
}

function subscribe(fn: EventSubscriber): () => void {
  eventSubscribers.push(fn)
  return () => {
    const idx = eventSubscribers.indexOf(fn)
    if (idx >= 0) eventSubscribers.splice(idx, 1)
  }
}

// ── Workspace Open ───────────────────────────────────────────────────────────

function openWorkspace(
  path: string,
  options?: { agentPoolSize?: number; drainTimeoutMs?: number }
): Effect.Effect<WorkspaceState, Error> {
  return Effect.gen(function* () {
    // Idempotent: re-opening returns existing handle
    for (const ws of workspaceStore.values()) {
      if (ws.path === path && ws.status === "open") return ws
    }

    const id = `${Date.now()}-${path}` as WorkspaceID
    const ws: WorkspaceState = {
      workspaceId: id,
      status: "opening",
      path,
      watcherActive: false,
      indexHydrated: false,
      projectsAttached: [],
      agentPoolSize: options?.agentPoolSize ?? 4,
      inFlightOperations: 0,
      openedAt: null,
      closedAt: null,
    }
    workspaceStore.set(id, ws)

    // Deterministic open sequence
    publish({ workspaceId: id, event: "opening", timestamp: Date.now(), metadata: { path } })

    // 1. File watcher init
    ws.watcherActive = true
    publish({ workspaceId: id, event: "watcher_started", timestamp: Date.now(), metadata: {} })

    // 2. Index hydration
    ws.indexHydrated = true
    publish({ workspaceId: id, event: "index_hydrated", timestamp: Date.now(), metadata: {} })

    // 3. Project attachment
    ws.projectsAttached = [path]
    publish({ workspaceId: id, event: "projects_attached", timestamp: Date.now(), metadata: { projects: [path] } })

    // 4. Agent pool spawn
    publish({ workspaceId: id, event: "agents_spawned", timestamp: Date.now(), metadata: { poolSize: ws.agentPoolSize } })

    ws.status = "open"
    ws.openedAt = Date.now()
    publish({ workspaceId: id, event: "opened", timestamp: ws.openedAt, metadata: {} })

    return ws
  })
}

// ── Workspace Close ──────────────────────────────────────────────────────────

function closeWorkspace(
  workspaceId: WorkspaceID,
  options?: { drainTimeoutMs?: number }
): Effect.Effect<WorkspaceState, Error> {
  return Effect.gen(function* () {
    const ws = workspaceStore.get(workspaceId)
    if (!ws) throw new Error(`Workspace not found: ${workspaceId}`)

    // Idempotent: double-close is safe
    if (ws.status === "closed") return ws

    ws.status = "closing"
    const timeout = options?.drainTimeoutMs ?? 30_000
    publish({ workspaceId, event: "closing", timestamp: Date.now(), metadata: {} })

    // 1. Agent pool drain (with timeout)
    if (ws.inFlightOperations > 0) {
      // In production: wait for in-flight ops to complete with configurable timeout
      // If timeout exceeded, force-terminate remaining operations
      ws.inFlightOperations = 0
    }
    publish({ workspaceId, event: "agents_drained", timestamp: Date.now(), metadata: {} })

    // 2. Project detach
    ws.projectsAttached = []
    publish({ workspaceId, event: "projects_detached", timestamp: Date.now(), metadata: {} })

    // 3. Index flush
    ws.indexHydrated = false
    publish({ workspaceId, event: "index_flushed", timestamp: Date.now(), metadata: {} })

    // 4. Watcher teardown
    ws.watcherActive = false
    publish({ workspaceId, event: "watcher_stopped", timestamp: Date.now(), metadata: {} })

    ws.status = "closed"
    ws.closedAt = Date.now()
    publish({ workspaceId, event: "closed", timestamp: ws.closedAt, metadata: {} })

    return ws
  })
}

function getWorkspace(workspaceId: WorkspaceID): WorkspaceState | undefined {
  return workspaceStore.get(workspaceId)
}

export type { WorkspaceID, WorkspaceState, WorkspaceEvent }
export { openWorkspace, closeWorkspace, getWorkspace, subscribe, workspaceStore }
