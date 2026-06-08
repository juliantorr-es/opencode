import type { LifecycleState } from "@/context/lifecycle"

export type RuntimeLayerState = "unknown" | "starting" | "ready" | "degraded" | "rebuilding" | "blocked" | "failed"

export type AppRuntimeLifecycle = {
  schema: "tribunus.app_runtime_lifecycle.v0"
  cellID: string
  platformMode: "desktop" | "web" | "remote"
  startedAt: number
  updatedAt: number
  truth: {
    state: RuntimeLayerState
    store: "pglite"
    reason?: string
  }
  coordination: {
    state: RuntimeLayerState
    kernel: "valkey" | "none"
    rebuildRequired: boolean
    reason?: string
  }
  execution: {
    state: RuntimeLayerState
    runtime: "native-pty" | "webcontainer" | "remote-sidecar" | "none"
    workspaceMode: "local" | "virtual_fs_sandbox" | "snapshot" | "synced" | "unknown"
    reason?: string
  }
  project?: {
    state: "unknown" | "resolving" | "ready" | "missing" | "failed"
    scopeKey?: string
    rawDirectory?: string
    normalizedDirectory?: string
    reason?: string
  }
  session?: {
    state:
      | "none"
      | "creating"
      | "created"
      | "hydrating"
      | "ready"
      | "not_yet_readable"
      | "missing"
      | "scope_mismatch"
      | "failed"
    sessionID?: string
    scopeKey?: string
    readable: boolean
    reason?: string
  }
}

export type ProjectScopeIdentity = {
  cellID: string
  serverKey: string
  rawDirectory: string
  normalizedDirectory: string
  pathKey: string
  platformMode: "desktop" | "web" | "remote"
  workspaceMode: "local" | "virtual_fs_sandbox" | "snapshot" | "synced" | "unknown"
}

export type SessionLifecycleRecord = {
  sessionID: string
  scopeKey: string
  state: Extract<AppRuntimeLifecycle["session"], { state: string }>["state"]
  createdAt: number
  readableAt?: number
  lastHydratedAt?: number
  reason?: string
}

export type SessionRouteState =
  | { state: "hydrating"; reason?: string }
  | { state: "ready"; sessionID: string; scopeKey: string }
  | { state: "not_yet_readable"; reason?: string }
  | { state: "missing"; reason?: string }
  | { state: "scope_mismatch"; reason?: string }
  | { state: "backend_unavailable"; reason?: string }
  | { state: "failed"; reason?: string }

export function isNotFoundError(error: unknown) {
  return (
    error instanceof Error &&
    typeof error.cause === "object" &&
    error.cause !== null &&
    (error.cause as { status?: unknown }).status === 404
  )
}

export function isBackendUnavailableError(error: unknown) {
  if (!(error instanceof Error)) return false
  const cause = error.cause
  if (typeof cause === "object" && cause !== null && (cause as { status?: unknown }).status === 503) return true
  const message = error.message.toLowerCase()
  return (
    message.includes("failed to fetch") ||
    message.includes("network request failed") ||
    message.includes("econnrefused") ||
    message.includes("econnreset") ||
    message.includes("etimedout")
  )
}

export function formatSessionRouteStateLabel(state: SessionRouteState) {
  if (state.state === "hydrating") return "Session hydrating"
  if (state.state === "ready") return "Session ready"
  if (state.state === "not_yet_readable") return "Session not yet readable"
  if (state.state === "missing") return "Session missing"
  if (state.state === "scope_mismatch") return "Session scope mismatch"
  if (state.state === "backend_unavailable") return "Backend unavailable"
  return "Session failed"
}

export function isHighSignalSessionRouteState(state: SessionRouteState) {
  return state.state !== "ready" && state.state !== "hydrating"
}

export function formatLifecycleStateLabel(value: LifecycleState) {
  if (value === "waiting_for_permission") return "Waiting for permission"
  if (value === "executing") return "Executing"
  if (value === "verifying") return "Verifying"
  if (value === "planning") return "Planning"
  if (value === "completed") return "Completed"
  if (value === "failed") return "Failed"
  if (value === "idle") return "Idle"
  return "Unavailable"
}

export function isHighSignalLifecycleState(value: LifecycleState) {
  return value === "failed" || value === "waiting_for_permission"
}
