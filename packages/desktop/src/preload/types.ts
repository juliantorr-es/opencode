import type { DesktopMenuAction } from "@tribunus/app/desktop-menu"
import type { CoordinationSnapshot, CoordinationDelta } from "../renderer/coordination-store"

export type InitStep =
  | { phase: "server_waiting" }
  | { phase: "safe_mode"; error: { message: string; component: string } }
  | { phase: "degraded_mode" }
  | { phase: "done" }

export type SafeModeAction =
  | "export_debug_logs"
  | "open_logs"
  | "repair_database"
  | "disable_plugins"
  | "disable_mcp"
  | "clear_stale_locks"
  | "reset_config"
  | "copy_diagnostic_summary"
  | "retry_normal_startup"

export type SidecarStartupFailure = {
  phase: string
  port: number | null
  hostname: string | null
  lastSuccessfulPhase: string
  errorMessage: string
  errorStack: string
  exitCode: number
  stderrTail: string
  timestamp: string
  platform: string
  nodeVersion: string
}

export type SafeModeDiagnostics = {
  error: { message: string; component: string }
  systemInfo: {
    platform: string
    arch: string
    version: string
    userDataPath: string
    logPath: string
  }
  sidecarFailure?: SidecarStartupFailure | null
}

export type ServerReadyData = {
  url: string
  username: string | null
  password: string | null
}

export type StorageMigrationProgress = { type: "InProgress"; value: number } | { type: "Done" }

/** @deprecated Use StorageMigrationProgress */
export type SqliteMigrationProgress = StorageMigrationProgress

export type WslConfig = { enabled: boolean }

export type LinuxDisplayBackend = "wayland" | "auto"
export type TitlebarTheme = {
  mode: "light" | "dark"
}
export type WindowConfig = {
  updaterEnabled: boolean
}

export type FatalRendererError = {
  error: string
  url: string
  version?: string
  platform: string
  os?: string
}

export type AgentDef = {
  id: string
  name: string
  prompt: string
  description?: string
  model?: string
  variant?: string
  temperature?: number
  top_p?: number
  color?: string
  steps?: number
}

export type McpLocalConfig = { type: "local"; command: string[]; environment?: Record<string, string>; timeout?: number; enabled?: boolean }
export type McpRemoteConfig = { type: "remote"; url: string; enabled?: boolean }
export type McpServerEntry = { name: string; config: McpLocalConfig | McpRemoteConfig }

export type PluginTransportHandler = (channel: string, data: unknown) => void
export type PluginTransportUnsub = () => void

export type GitCheck = {
  uncommitted: number
  unpushed: number
  mergeConflicts: number
  branch: string | null
}

export interface DesktopCapabilities {
  github: boolean
  plugins: boolean
  mcp: boolean
  shellOpen: boolean
  clipboardImage: boolean
  notifications: boolean
}

export type PluginConfigEntry = {
  name: string
  path: string
  enabled: boolean
  config?: Record<string, unknown>
}

export type ElectronAPI = {
  killSidecar: () => Promise<void>
  awaitInitialization: (onStep: (step: InitStep) => void) => Promise<ServerReadyData>
  getWindowConfig: () => Promise<WindowConfig>
  consumeInitialDeepLinks: () => Promise<string[]>
  getDefaultServerUrl: () => Promise<string | null>
  setDefaultServerUrl: (url: string | null) => Promise<void>
  getWslConfig: () => Promise<WslConfig>
  setWslConfig: (config: WslConfig) => Promise<void>
  getDisplayBackend: () => Promise<LinuxDisplayBackend | null>
  setDisplayBackend: (backend: LinuxDisplayBackend | null) => Promise<void>
  parseMarkdownCommand: (markdown: string) => Promise<string>
  checkAppExists: (appName: string) => Promise<boolean>
  wslPath: (path: string, mode: "windows" | "linux" | null) => Promise<string>
  resolveAppPath: (appName: string) => Promise<string | null>
  storeGet: (name: string, key: string) => Promise<string | null>
  storeSet: (name: string, key: string, value: string) => Promise<void>
  storeDelete: (name: string, key: string) => Promise<void>
  storeClear: (name: string) => Promise<void>
  storeKeys: (name: string) => Promise<string[]>
  storeLength: (name: string) => Promise<number>

  getWindowCount: () => Promise<number>
  onStorageMigrationProgress: (cb: (progress: StorageMigrationProgress) => void) => () => void
  onMenuCommand: (cb: (id: string) => void) => () => void
  onDeepLink: (cb: (urls: string[]) => void) => () => void

  openDirectoryPicker: (opts?: {
    multiple?: boolean
    title?: string
    defaultPath?: string
  }) => Promise<string | string[] | null>
  openFilePicker: (opts?: {
    multiple?: boolean
    title?: string
    defaultPath?: string
    accept?: string[]
    extensions?: string[]
  }) => Promise<string | string[] | null>
  saveFilePicker: (opts?: { title?: string; defaultPath?: string }) => Promise<string | null>
  openLink: (url: string) => void
  openPath: (path: string, app?: string) => Promise<string | void>
  readClipboardImage: () => Promise<{ buffer: ArrayBuffer; width: number; height: number } | null>
  showNotification: (title: string, body?: string) => void
  getWindowFocused: () => Promise<boolean>
  setWindowFocus: () => Promise<void>
  showWindow: () => Promise<void>
  relaunch: () => void
  getZoomFactor: () => Promise<number>
  setZoomFactor: (factor: number) => Promise<void>
  getPinchZoomEnabled: () => Promise<boolean>
  setPinchZoomEnabled: (enabled: boolean) => Promise<void>
  onPinchZoomEnabledChanged: (cb: (enabled: boolean) => void) => () => void
  onZoomFactorChanged: (cb: (factor: number) => void) => () => void
  setTitlebar: (theme: TitlebarTheme) => Promise<void>
  runDesktopMenuAction: (action: DesktopMenuAction) => Promise<void>
  loadingWindowComplete: () => void
  rendererReady: () => void
  runUpdater: (alertOnFail: boolean) => Promise<void>
  checkUpdate: () => Promise<{ updateAvailable: boolean; version?: string }>
  installUpdate: () => Promise<void>
  setBackgroundColor: (color: string) => Promise<void>
  exportDebugLogs: () => Promise<string>
  recordFatalRendererError: (error: FatalRendererError) => Promise<void>
  getDesktopPluginConfig: () => Promise<{ configs: PluginConfigEntry[]; dropped: number }>
  setDesktopPluginConfig: (configs: PluginConfigEntry[]) => Promise<{ configs: PluginConfigEntry[]; dropped: number }>
  getCustomAgents: () => Promise<AgentDef[]>
  setCustomAgents: (agents: AgentDef[]) => Promise<void>
  deleteCustomAgent: (id: string) => Promise<void>
  getMcpServers: () => Promise<McpServerEntry[]>
  setMcpServers: (servers: McpServerEntry[]) => Promise<{ servers: McpServerEntry[]; dropped: number }>
  githubStartOAuth: () => Promise<string>
  githubOAuthCallback: (code: string, state: string) => Promise<void>
  githubGetToken: () => Promise<string | null>
  githubSetToken: (token: string) => Promise<void>
  githubClearToken: () => Promise<void>
  githubApiProxy: (url: string, options?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{ status: number; body: string } | { error: { type: string; hostname: string | null; allowedHostnames: string[] } }>
  sessionExportData: (data: string, opts?: { title?: string; defaultPath?: string; filters?: Array<{ name: string; extensions: string[] }> }) => Promise<string | { error: string } | null>
  sessionImportFile: (opts?: { title?: string; filters?: Array<{ name: string; extensions: string[] }> }) => Promise<string | { error: string } | null>
  setLocalePreference: (locale: string) => Promise<void>
  getLocalePreference: () => Promise<string | null>

  getGitStatus: () => Promise<GitCheck | null>
  getCapabilities: () => Promise<DesktopCapabilities>
  getSafeModeDiagnostics: () => Promise<SafeModeDiagnostics>
  safeModeAction: (action: SafeModeAction) => Promise<void>
  getCoordinationSnapshot: () => Promise<CoordinationSnapshot>
  subscribeCoordinationProjection: (cb: (delta: CoordinationDelta) => void) => () => void
  requestCoordinationResync: () => void
  openProject: (directory: string) => Promise<string>

  getSystemStatus: () => Promise<{
    sidecar: { ready: boolean; url: string | null; pid: number | null; restartCount: number; lastError: string | null }
    server: { url: string | null; configured: boolean }
    safeMode: boolean
    degraded: boolean
    degradedReason: string | null
    ipc: { protocolVersion: number }
    update: { status: string; version: string | null }
    build: { version: string; channel: string; electronVersion: string }
  }>
  sidecarStatus: () => Promise<{ ready: boolean; url: string | null }>
  getUpdateStatus: () => Promise<{ updateAvailable: boolean; version?: string }>

  /** Internal map for pluginOff() to lookup the IPC listener by channel+handler key. */
  _pluginListeners: Map<string, (event: unknown, payload: { channel: string; data: unknown }) => void>
  /** Plugin transport — fire-and-forget message to main process */
  pluginSend: (channel: string, data?: unknown) => void
  /** Plugin transport — subscribe to push messages from main process */
  pluginOn: (channel: string, handler: (data: unknown) => void) => () => void
  /** Plugin transport — unsubscribe from push messages */
  pluginOff: (channel: string, handler: (data: unknown) => void) => void
  /** Plugin transport — request/response RPC to main process */
  pluginInvoke: (channel: string, data?: unknown) => Promise<unknown>
  onIpcFailure?: (cb: (error: { requestId: string; code: string; message: string; recoverability: string; timestamp: number }) => void) => () => void
}
