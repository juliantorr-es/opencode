import { createSignal, createContext, useContext, type JSX } from "solid-js"

/** Sidecar lifecycle state */
export interface SidecarState {
  status: "starting" | "ready" | "degraded" | "unavailable" | "error"
  url: string | null
  pid: number | null
  lastError: string | null
  restartCount: number
}

/** IPC protocol state */
export interface IpcState {
  protocolVersion: number
  connected: boolean
  lastError: string | null
}

/** Update state */
export interface UpdateState {
  status: "idle" | "checking" | "available" | "installing" | "error"
  version: string | null
  error: string | null
}

/** Desktop runtime state owned by the provider */
export interface DesktopRuntimeState {
  sidecar: SidecarState
  ready: boolean
  safeMode: boolean
  degraded: boolean
  degradedReason: string | null
  shutdown: boolean
  ipc: IpcState
  update: UpdateState
}

const DesktopRuntimeContext = createContext<{
  state: DesktopRuntimeState
  setSidecar: (s: Partial<SidecarState>) => void
  setReady: (r: boolean) => void
  setSafeMode: (s: boolean) => void
  setDegraded: (d: boolean, reason?: string) => void
  setShutdown: (s: boolean) => void
  setIpc: (i: Partial<IpcState>) => void
  setUpdate: (u: Partial<UpdateState>) => void
}>()

export function useDesktopRuntime() {
  const ctx = useContext(DesktopRuntimeContext)
  if (!ctx) throw new Error("useDesktopRuntime must be used within DesktopRuntimeProvider")
  return ctx
}

export function DesktopRuntimeProvider(props: { children: JSX.Element }) {
  const [sidecar, setSidecarSignal] = createSignal<SidecarState>({
    status: "starting",
    url: null,
    pid: null,
    lastError: null,
    restartCount: 0,
  })
  const [ready, setReady] = createSignal(false)
  const [safeMode, setSafeMode] = createSignal(false)
  const [degraded, setDegradedState] = createSignal(false)
  const [degradedReason, setDegradedReason] = createSignal<string | null>(null)
  const [shutdown, setShutdown] = createSignal(false)
  const [ipc, setIpcSignal] = createSignal<IpcState>({
    protocolVersion: 1,
    connected: true,
    lastError: null,
  })
  const [update, setUpdateSignal] = createSignal<UpdateState>({
    status: "idle",
    version: null,
    error: null,
  })

  const state: DesktopRuntimeState = {
    get sidecar() { return sidecar() },
    get ready() { return ready() },
    get safeMode() { return safeMode() },
    get degraded() { return degraded() },
    get degradedReason() { return degradedReason() },
    get shutdown() { return shutdown() },
    get ipc() { return ipc() },
    get update() { return update() },
  }

  return (
    <DesktopRuntimeContext.Provider
      value={{
        state,
        setSidecar: (s) => setSidecarSignal((prev) => ({ ...prev, ...s })),
        setReady,
        setSafeMode,
        setDegraded: (d, r) => { setDegradedState(d); if (r) setDegradedReason(r) },
        setShutdown,
        setIpc: (i) => setIpcSignal((prev) => ({ ...prev, ...i })),
        setUpdate: (u) => setUpdateSignal((prev) => ({ ...prev, ...u })),
      }}
    >
      {props.children}
    </DesktopRuntimeContext.Provider>
  )
}
