import { createContext, createSignal, useContext, type ParentProps } from "solid-js"
import { createEventBus } from "@solid-primitives/event-bus"
import { decodeOrThrow, Diagnostics } from "./server-sync"

// Telemetry: uses app-level observability, not direct Sentry import.
// Sentry integration is provided by the desktop renderer entry point.
const telemetry = {
  setContext(_name: string, _data: unknown) {
    // Hooked by packages/desktop/src/renderer/index.tsx if available
  },
}

// ── Activation Event Bus ───────────────────────────────
// Broadcasts lifecycle facts so components can react without
// depending on the state machine directly.

export const activationEvents = createEventBus<{
  "project:selected": { directory: string }
  "project:activation-started": { directory: string }
  "project:activation-ready": { directory: string }
  "project:activation-failed": { directory?: string; error: string }
  "providers:loaded": { directory: string }
  "sessions:loaded": { directory: string }
  "session:created": { directory: string; sessionID: string }
  "diagnostics:updated": { classification: string }
}>()

export type ActivationState =
  | { name: "uninitialized" }
  | { name: "empty" }
  | { name: "opening_project"; directory: string }
  | { name: "booting_instance"; directory: string }
  | { name: "loading_project_context"; directory: string }
  | { name: "provider_setup_required"; directory: string; reason: string }
  | { name: "project_ready"; directory: string }
  | { name: "creating_session"; directory: string }
  | { name: "session_ready"; directory: string; sessionID: string }
  | { name: "failed"; directory?: string; error: string }

export type ActivationEvent =
  | { type: "SIDECAR_READY" }
  | { type: "GLOBAL_BOOTSTRAP_OK" }
  | { type: "NO_PROJECTS_FOUND" }
  | { type: "PROJECT_SELECTED"; directory: string }
  | { type: "PROJECT_OPENED_LOCALLY"; directory: string }
  | { type: "INSTANCE_BOOT_OK"; directory: string }
  | { type: "PROJECT_CONTEXT_LOADED"; directory: string }
  | { type: "PROVIDERS_MISSING"; directory: string; reason: string }
  | { type: "NEW_SESSION_REQUESTED"; directory: string }
  | { type: "SESSION_CREATED"; directory: string; sessionID: string }
  | { type: "FAIL"; directory?: string; error: string }
  | { type: "RETRY" }
  | { type: "RESET" }

// ── Diagnostics shape ───────────────────────────────────

export interface ProjectActivationDiagnostics {
  state: string
  directory: string | null
  canCreateSession: boolean
  canOpenProject: boolean
  error: string | null
  reason: string | null
  sessionID: string | null
}
// ── Typed readiness result ─────────────────────────────

export type ProjectReadiness =
  | { status: "ready"; directory: string }
  | { status: "provider_setup_required"; directory: string; reason: string }
  | { status: "empty"; directory: string }
  | { status: "failed"; directory: string; code: string; message: string; retryable: boolean }

// ── Dependency injection (avoids circular imports) ─────

interface ActivationDeps {
  openProjectLocal: (directory: string) => void
  touchProject: (directory: string) => void
  ensureReady: (directory: string) => Promise<ProjectReadiness>
  navigateToProject: (directory: string) => void
  bootstrapInstance: (directory: string) => Promise<void>
  isInstanceBooted: (directory: string) => boolean
}

// ── Public API type ─────────────────────────────────────

export interface ProjectActivationMachine {
  readonly state: () => ActivationState
  send(event: ActivationEvent): void
  canCreateSession(): boolean
  canOpenProject(): boolean
  currentDirectory(): string | undefined
  diagnostics(): ProjectActivationDiagnostics
  openProject(directory: string, opts?: { navigate?: boolean }): Promise<void>
  ensureReady(directory: string): Promise<ProjectReadiness>
  retryActivation(): void
}

// ── Helpers ─────────────────────────────────────────────

/** States whose `directory` field is declared as `string` (not optional). */
function extractDirectory(s: ActivationState): string | undefined {
  if ("directory" in s && typeof s.directory === "string") {
    return s.directory
  }
  return undefined
}

// ── Reducer ─────────────────────────────────────────────

function reducer(state: ActivationState, event: ActivationEvent): ActivationState {
  switch (state.name) {
    case "uninitialized": {
      if (event.type === "SIDECAR_READY") return { name: "empty" }
      if (event.type === "NO_PROJECTS_FOUND") return { name: "empty" }
      return state
    }
    case "empty": {
      if (event.type === "PROJECT_SELECTED") return { name: "opening_project", directory: event.directory }
      if (event.type === "GLOBAL_BOOTSTRAP_OK") return { name: "empty" }
      return state
    }
    case "opening_project": {
      if (event.type === "PROJECT_OPENED_LOCALLY") return { name: "booting_instance", directory: event.directory }
      if (event.type === "FAIL") return { name: "failed", directory: event.directory, error: event.error }
      return state
    }
    case "booting_instance": {
      if (event.type === "INSTANCE_BOOT_OK") return { name: "loading_project_context", directory: event.directory }
      if (event.type === "FAIL") return { name: "failed", directory: event.directory, error: event.error }
      return state
    }
    case "loading_project_context": {
      if (event.type === "PROJECT_CONTEXT_LOADED") return { name: "project_ready", directory: event.directory }
      if (event.type === "PROVIDERS_MISSING") return { name: "provider_setup_required", directory: event.directory, reason: event.reason }
      if (event.type === "FAIL") return { name: "failed", directory: event.directory, error: event.error }
      return state
    }
    case "provider_setup_required": {
      if (event.type === "RETRY") return { name: "loading_project_context", directory: state.directory }
      if (event.type === "PROJECT_SELECTED") return { name: "opening_project", directory: event.directory }
      return state
    }
    case "project_ready": {
      if (event.type === "NEW_SESSION_REQUESTED") return { name: "creating_session", directory: event.directory }
      if (event.type === "PROJECT_SELECTED") return { name: "opening_project", directory: event.directory }
      return state
    }
    case "creating_session": {
      if (event.type === "SESSION_CREATED") return { name: "session_ready", directory: event.directory, sessionID: event.sessionID }
      if (event.type === "FAIL") return { name: "failed", directory: event.directory, error: event.error }
      return state
    }
    case "session_ready": {
      if (event.type === "RESET") return { name: "project_ready", directory: state.directory }
      if (event.type === "PROJECT_SELECTED") return { name: "opening_project", directory: event.directory }
      return state
    }
    case "failed": {
      if (event.type === "RETRY") {
        const dir = extractDirectory(state)
        return dir ? { name: "booting_instance", directory: dir } : { name: "empty" }
      }
      if (event.type === "RESET") return { name: "empty" }
      return state
    }
    default:
      return state
  }
}

function broadcastEvent(prev: ActivationState, next: ActivationState, event: ActivationEvent) {
  switch (next.name) {
    case "opening_project":
    case "booting_instance":
      ;(activationEvents as any).emit("project:activation-started", { directory: next.directory })
      break
    case "project_ready":
      ;(activationEvents as any).emit("project:activation-ready", { directory: next.directory })
      break
    case "failed":
      ;(activationEvents as any).emit("project:activation-failed", { directory: (next as any).directory, error: (next as any).error })
      break
  }
}

 // ── Factory ─────────────────────────────────────────────

export function createProjectActivation(deps: ActivationDeps): ProjectActivationMachine {
  const [state, setState] = createSignal<ActivationState>({ name: "uninitialized" })

  function send(event: ActivationEvent): void {
    const current = state()
    const next = reducer(current, event)
    if (next !== current) {
      console.debug("[project-activation]", current.name, "→", next.name, event.type)
      setState(next)
      // Broadcast lifecycle facts
      broadcastEvent(current, next, event)
      // Update Sentry context on every lifecycle transition
      try {
        telemetry.setContext("projectActivation", {
          state: next.name,
          ...("directory" in next ? { directory: (next as any).directory } : {}),
          previousState: current.name,
          event: event.type,
        })
      } catch {}
    }
  }

  function canCreateSession(): boolean {
    return state().name === "project_ready"
  }

  function canOpenProject(): boolean {
    const n = state().name
    return n === "empty" || n === "project_ready" || n === "provider_setup_required" || n === "failed"
  }

  function currentDirectory(): string | undefined {
    return extractDirectory(state())
  }

  function diagnostics(): ProjectActivationDiagnostics {
    const s = state()
    return {
      state: s.name,
      ...("directory" in s ? { directory: (s as any).directory } : { directory: null }),
      canCreateSession: s.name === "project_ready",
      canOpenProject: s.name === "empty" || s.name === "project_ready" || s.name === "provider_setup_required" || s.name === "failed",
      ...("error" in s ? { error: (s as any).error } : { error: null }),
      ...("reason" in s ? { reason: (s as any).reason } : { reason: null }),
      ...("sessionID" in s ? { sessionID: (s as any).sessionID } : { sessionID: null }),
    }
  }

  // ── Execution methods ────────────────────────────────

  async function openProject(directory: string, opts?: { navigate?: boolean }): Promise<void> {
    send({ type: "PROJECT_SELECTED", directory })
    deps.openProjectLocal(directory)
    deps.touchProject(directory)
    try {
      const readiness = await deps.ensureReady(directory)
      switch (readiness.status) {
        case "ready":
          send({ type: "INSTANCE_BOOT_OK", directory })
          send({ type: "PROJECT_CONTEXT_LOADED", directory })
          break
        case "provider_setup_required":
          send({ type: "INSTANCE_BOOT_OK", directory })
          send({ type: "PROVIDERS_MISSING", directory, reason: readiness.reason })
          break
        case "empty":
          send({ type: "INSTANCE_BOOT_OK", directory })
          send({ type: "PROJECT_CONTEXT_LOADED", directory })
          break
        case "failed":
          send({ type: "FAIL", directory, error: readiness.message })
          return
      }
      if (opts?.navigate !== false) {
        deps.navigateToProject(directory)
      }
    } catch (err) {
      send({ type: "FAIL", directory, error: err instanceof Error ? err.message : String(err) })
    }
  }

  async function ensureReady(directory: string): Promise<ProjectReadiness> {
    if (deps.isInstanceBooted(directory)) {
      return { status: "ready", directory }
    }
    try {
      await deps.bootstrapInstance(directory)
      return { status: "ready", directory }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { status: "failed", directory, code: "BOOT_ERROR", message, retryable: true }
    }
  }

  function retryActivation(): void {
    send({ type: "RETRY" })
  }

  if (typeof window !== "undefined") {
    ;(window as any).__opencode_diag__ = { activation: () => diagnostics() }
  }

  return { state, send, canCreateSession, canOpenProject, currentDirectory, diagnostics, openProject, ensureReady, retryActivation }
}

export function setSentryDiagnostics(diag: any) {
  const decoded = decodeOrThrow("diagnostics", Diagnostics, diag)
  try {
    telemetry.setContext("sidecarDiagnostics", {
      classification: decoded.classification,
      instanceCount: decoded.instanceCount,
      instanceHealthy: decoded.instanceHealthy,
      sidecarReady: decoded.sidecarReady,
      recommendation: decoded.recommendation,
    })
  } catch {}
}

// ── Diagnostics Poller ──────────────────────────────────
// Polls the sidecar diagnostics endpoint periodically.
// Emits updates on the activation event bus.

let diagnosticsPollTimer: ReturnType<typeof setInterval> | undefined

export function startDiagnosticsPolling(fetchFn: () => Promise<any>) {
  if (diagnosticsPollTimer) return
  diagnosticsPollTimer = setInterval(async () => {
    try {
      const diag = await fetchFn()
      ;(activationEvents as any).emit("diagnostics:updated", { classification: diag.classification })
    } catch {}
  }, 30000) // every 30 seconds
}

export function stopDiagnosticsPolling() {
  if (diagnosticsPollTimer) {
    clearInterval(diagnosticsPollTimer)
    diagnosticsPollTimer = undefined
  }
}

// ── Context ─────────────────────────────────────────────

const ProjectActivationCtx = createContext<ProjectActivationMachine>()

export function ProjectActivationProvider(props: ParentProps & { value: ProjectActivationMachine }) {
  return (
    <ProjectActivationCtx.Provider value={props.value}>
      {props.children}
    </ProjectActivationCtx.Provider>
  )
}

export function useProjectActivation(): ProjectActivationMachine {
  const ctx = useContext(ProjectActivationCtx)
  if (!ctx) throw new Error("useProjectActivation must be used within ProjectActivationProvider")
  return ctx
}
