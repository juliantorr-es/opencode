/**
 * IPC Handler Contract — single source of truth for all IPC channel signatures.
 *
 * THE CONTRACT: IpcHandleContract and IpcSendContract define the renderer-facing
 * parameter and return types for every IPC channel. Both the main-process handlers
 * and the preload bridge derive from this contract.
 *
 * WHAT THIS PREVENTS:
 *   If an ipcMain.handle() changes its parameter types or return value, the
 *   contract must be updated — and that change propagates to the preload bridge
 *   type, causing a compile error if the bridge doesn't match. No more silent drift.
 *
 * HOW IT WORKS:
 *   1. Each IPC channel is listed in IpcHandleContract with { params, returns }
 *   2. The preload uses typedInvoke()/typedSend() wrappers that check args/return
 *   3. The ElectronAPI type is derived from BridgeHandleMap + IpcHandleContract
 *   4. A compile-time assertion ensures every IPC channel has a contract entry
 */

import { ipcRenderer } from "electron"
import type { DesktopMenuAction } from "@opencode-ai/app/desktop-menu"
import { IPC } from "./ipc-channels"
import type {
  InitStep,
  ServerReadyData,
  SafeModeAction,
  SafeModeDiagnostics,
  StorageMigrationProgress,
  WslConfig,
  LinuxDisplayBackend,
  TitlebarTheme,
  WindowConfig,
  FatalRendererError,
  AgentDef,
  McpServerEntry,
  PluginConfigEntry,
  PluginTransportHandler,
  PluginTransportUnsub,
} from "../preload/types"
import type { DesktopCapabilities } from "./ipc-capabilities"

// ──────────────────────────────────────────────────────────────
//  IpcResult — result envelope for all IPC operations
// ──────────────────────────────────────────────────────────────

export type IpcOk<T> = { ok: true; value: T }

export type IpcErr = {
  ok: false
  error: {
    code: "ipc.unavailable" | "ipc.invalid_request" | "ipc.permission_denied" | "ipc.timeout" | "ipc.not_found" | "ipc.conflict" | "ipc.internal"
    message: string
    recoverable: boolean
    details?: unknown
  }
}

export type IpcResult<T> = IpcOk<T> | IpcErr

export async function withIpcResult<T>(operation: string, fn: () => Promise<T>): Promise<IpcResult<T>> {
  try {
    const value = await fn()
    return { ok: true, value }
  } catch (error) {
    return { ok: false, error: normalizeIpcError(operation, error) }
  }
}

/**
 * Runtime IpcResult shape validator.
 * In development mode, typedInvoke uses this to reject malformed IPC responses
 * before they reach renderer code.
 */
export function isIpcResult(value: unknown): value is IpcResult<unknown> {
  if (value === null || typeof value !== "object") return false
  const obj = value as Record<string, unknown>
  const ok = obj.ok
  if (typeof ok !== "boolean") return false
  if (ok) {
    return "value" in obj
  }
  if (!("error" in obj)) return false
  const err = obj.error
  if (err === null || typeof err !== "object") return false
  const e = err as Record<string, unknown>
  return typeof e.code === "string" && typeof e.message === "string"
}

/** IPC contract violation error */
export class IpcContractViolationError extends Error {
  constructor(
    public readonly channel: string,
    public readonly actualShape: string,
  ) {
    super(`IPC contract violation on channel "${channel}": expected IpcResult, got ${actualShape}`)
    this.name = "IpcContractViolationError"
  }
}

export function normalizeIpcError(operation: string, error: unknown): IpcErr["error"] {
  const message = error instanceof Error ? error.message : String(error ?? "Unknown error")
  if (message.includes("Access denied") || message.includes("permission") || message.includes("Permission"))
    return { code: "ipc.permission_denied", message, recoverable: false }
  if (message.includes("not found") || message.includes("No handler registered"))
    return { code: "ipc.not_found", message, recoverable: true }
  if (message.includes("Invalid") || message.includes("validation"))
    return { code: "ipc.invalid_request", message, recoverable: false }
  return { code: "ipc.internal", message, recoverable: true, details: { operation } }
}

// ──────────────────────────────────────────────────────────────
//  CHANNELS — logical method names to raw Electron channel strings
//  Preload uses logical names (e.g. "config.get").
// ──────────────────────────────────────────────────────────────

export const CHANNELS = {
  config: {
    get: IPC.handle.GET_DESKTOP_CUSTOM_AGENTS,
    set: IPC.handle.SET_DESKTOP_CUSTOM_AGENTS,
    deleteAgent: IPC.handle.DELETE_DESKTOP_CUSTOM_AGENT,
    getMcpServers: IPC.handle.GET_DESKTOP_MCP_SERVERS,
    setMcpServers: IPC.handle.SET_DESKTOP_MCP_SERVERS,
    getPluginConfig: IPC.handle.GET_DESKTOP_PLUGIN_CONFIG,
    setPluginConfig: IPC.handle.SET_DESKTOP_PLUGIN_CONFIG,
  },
  store: {
    get: IPC.handle.STORE_GET,
    set: IPC.handle.STORE_SET,
    delete: IPC.handle.STORE_DELETE,
    clear: IPC.handle.STORE_CLEAR,
    keys: IPC.handle.STORE_KEYS,
    length: IPC.handle.STORE_LENGTH,
  },
  fs: {
    pickDirectory: IPC.handle.OPEN_DIRECTORY_PICKER,
    pickFile: IPC.handle.OPEN_FILE_PICKER,
    saveFile: IPC.handle.SAVE_FILE_PICKER,
    openLink: IPC.send.OPEN_LINK,
    openPath: IPC.handle.OPEN_PATH,
    readClipboardImage: IPC.handle.READ_CLIPBOARD_IMAGE,
    showNotification: IPC.send.SHOW_NOTIFICATION,
  },
  session: {
    export: IPC.handle.SESSION_EXPORT_DATA,
    import: IPC.handle.SESSION_IMPORT_FILE,
  },
  window: {
    getCount: IPC.handle.GET_WINDOW_COUNT,
    getFocused: IPC.handle.GET_WINDOW_FOCUSED,
    setFocus: IPC.handle.SET_WINDOW_FOCUS,
    show: IPC.handle.SHOW_WINDOW,
    getZoomFactor: IPC.handle.GET_ZOOM_FACTOR,
    setZoomFactor: IPC.handle.SET_ZOOM_FACTOR,
    getPinchZoomEnabled: IPC.handle.GET_PINCH_ZOOM_ENABLED,
    setPinchZoomEnabled: IPC.handle.SET_PINCH_ZOOM_ENABLED,
    setTitlebar: IPC.handle.SET_TITLEBAR,
    runMenuAction: IPC.handle.RUN_DESKTOP_MENU_ACTION,
  },
  locale: {
    set: IPC.handle.SET_LOCALE_PREFERENCE,
    get: IPC.handle.GET_LOCALE_PREFERENCE,
  },
  init: {
    killSidecar: IPC.handle.KILL_SIDECAR,
    awaitInitialization: IPC.handle.AWAIT_INITIALIZATION,
    getWindowConfig: IPC.handle.GET_WINDOW_CONFIG,
    consumeInitialDeepLinks: IPC.handle.CONSUME_INITIAL_DEEP_LINKS,
    getDefaultServerUrl: IPC.handle.GET_DEFAULT_SERVER_URL,
    setDefaultServerUrl: IPC.handle.SET_DEFAULT_SERVER_URL,
    getWslConfig: IPC.handle.GET_WSL_CONFIG,
    setWslConfig: IPC.handle.SET_WSL_CONFIG,
    getDisplayBackend: IPC.handle.GET_DISPLAY_BACKEND,
    setDisplayBackend: IPC.handle.SET_DISPLAY_BACKEND,
    parseMarkdown: IPC.handle.PARSE_MARKDOWN,
    checkAppExists: IPC.handle.CHECK_APP_EXISTS,
    wslPath: IPC.handle.WSL_PATH,
    resolveAppPath: IPC.handle.RESOLVE_APP_PATH,
    loadingWindowComplete: IPC.send.LOADING_WINDOW_COMPLETE,
    runUpdater: IPC.handle.RUN_UPDATER,
    checkUpdate: IPC.handle.CHECK_UPDATE,
    installUpdate: IPC.handle.INSTALL_UPDATE,
    setBackgroundColor: IPC.handle.SET_BACKGROUND_COLOR,
    exportDebugLogs: IPC.handle.EXPORT_DEBUG_LOGS,
    recordFatalRendererError: IPC.handle.RECORD_FATAL_RENDERER_ERROR,
    openProject: IPC.handle.OPEN_PROJECT,
  },
  github: {
    startOAuth: IPC.handle.GITHUB_OAUTH_START,
    oauthCallback: IPC.handle.GITHUB_OAUTH_CALLBACK,
    getToken: IPC.handle.GITHUB_GET_TOKEN,
    setToken: IPC.handle.GITHUB_SET_TOKEN,
    clearToken: IPC.handle.GITHUB_CLEAR_TOKEN,
    apiProxy: IPC.handle.GITHUB_API_PROXY,
  },
  plugin: {
    send: IPC.send.PLUGIN_SEND,
    invoke: IPC.handle.PLUGIN_INVOKE,
    push: IPC.push.PLUGIN_PUSH,
  },
  capabilities: {
    get: IPC.handle.GET_CAPABILITIES,
  },
} as const

// ──────────────────────────────────────────────────────────────
//  IpcHandleContract — ipcMain.handle / ipcRenderer.invoke channels
//  Keys are the ACTUAL channel strings (e.g. "opencode:kill-sidecar").
//  Types are renderer-facing:
//    params  — args passed by ipcRenderer.invoke (no IpcMainInvokeEvent)
//    returns — what ipcRenderer.invoke returns
// ──────────────────────────────────────────────────────────────

export interface IpcHandleContract {
  [IPC.handle.KILL_SIDECAR]: { params: []; returns: Promise<void> }
  [IPC.handle.AWAIT_INITIALIZATION]: { params: []; returns: Promise<ServerReadyData> }
  [IPC.handle.SIDECAR_STATUS]: { params: []; returns: Promise<{ pid: number | null; url: string | null; startedAt: number | null; readyAt: number | null; lastExitCode: number | null; restartCount: number; startupPhases: ReadonlyArray<{ phase: string; status: string; timestamp: number }> }> },
  [IPC.handle.RESTART_SIDECAR]: { params: []; returns: Promise<void> },
  [IPC.handle.GET_WINDOW_CONFIG]: { params: []; returns: Promise<WindowConfig> }
  [IPC.handle.CONSUME_INITIAL_DEEP_LINKS]: { params: []; returns: Promise<string[]> }
  [IPC.handle.GET_DEFAULT_SERVER_URL]: { params: []; returns: Promise<string | null> }
  [IPC.handle.SET_DEFAULT_SERVER_URL]: { params: [url: string | null]; returns: Promise<void> }
  [IPC.handle.GET_WSL_CONFIG]: { params: []; returns: Promise<WslConfig> }
  [IPC.handle.SET_WSL_CONFIG]: { params: [config: WslConfig]; returns: Promise<void> }
  [IPC.handle.GET_DISPLAY_BACKEND]: { params: []; returns: Promise<LinuxDisplayBackend | null> }
  [IPC.handle.SET_DISPLAY_BACKEND]: { params: [backend: LinuxDisplayBackend | null]; returns: Promise<void> }
  [IPC.handle.PARSE_MARKDOWN]: { params: [markdown: string]; returns: Promise<string> }
  [IPC.handle.CHECK_APP_EXISTS]: { params: [appName: string]; returns: Promise<boolean> }
  [IPC.handle.WSL_PATH]: { params: [path: string, mode: "windows" | "linux" | null]; returns: Promise<string> }
  [IPC.handle.RESOLVE_APP_PATH]: { params: [appName: string]; returns: Promise<string | null> }
  [IPC.handle.STORE_GET]: { params: [name: string, key: string]; returns: Promise<string | null> }
  [IPC.handle.STORE_SET]: { params: [name: string, key: string, value: unknown]; returns: Promise<void> }
  [IPC.handle.STORE_DELETE]: { params: [name: string, key: string]; returns: Promise<void> }
  [IPC.handle.STORE_CLEAR]: { params: [name: string]; returns: Promise<void> }
  [IPC.handle.STORE_KEYS]: { params: [name: string]; returns: Promise<string[]> }
  [IPC.handle.STORE_LENGTH]: { params: [name: string]; returns: Promise<number> }
  [IPC.handle.GET_WINDOW_COUNT]: { params: []; returns: Promise<number> }
  [IPC.handle.OPEN_DIRECTORY_PICKER]: { params: [opts?: { multiple?: boolean; title?: string; defaultPath?: string }]; returns: Promise<string | string[] | null> }
  [IPC.handle.OPEN_FILE_PICKER]: { params: [opts?: { multiple?: boolean; title?: string; defaultPath?: string; accept?: string[]; extensions?: string[] }]; returns: Promise<string | string[] | null> }
  [IPC.handle.SAVE_FILE_PICKER]: { params: [opts?: { title?: string; defaultPath?: string }]; returns: Promise<string | null> }
  [IPC.handle.OPEN_PATH]: { params: [path: string, app?: string]; returns: Promise<string | void> }
  [IPC.handle.READ_CLIPBOARD_IMAGE]: { params: []; returns: Promise<{ buffer: ArrayBuffer; width: number; height: number } | null> }
  [IPC.handle.GET_WINDOW_FOCUSED]: { params: []; returns: Promise<boolean> }
  [IPC.handle.SET_WINDOW_FOCUS]: { params: []; returns: Promise<void> }
  [IPC.handle.SHOW_WINDOW]: { params: []; returns: Promise<void> }
  [IPC.handle.GET_ZOOM_FACTOR]: { params: []; returns: Promise<number> }
  [IPC.handle.SET_ZOOM_FACTOR]: { params: [factor: number]; returns: Promise<void> }
  [IPC.handle.GET_PINCH_ZOOM_ENABLED]: { params: []; returns: Promise<boolean> }
  [IPC.handle.SET_PINCH_ZOOM_ENABLED]: { params: [enabled: boolean]; returns: Promise<void> }
  [IPC.handle.SET_TITLEBAR]: { params: [theme: TitlebarTheme]; returns: Promise<void> }
  [IPC.handle.RUN_DESKTOP_MENU_ACTION]: { params: [action: DesktopMenuAction]; returns: Promise<void> }
  [IPC.handle.RUN_UPDATER]: { params: [alertOnFail: boolean]; returns: Promise<void> }
  [IPC.handle.CHECK_UPDATE]: { params: []; returns: Promise<{ updateAvailable: boolean; version?: string }> }
  [IPC.handle.INSTALL_UPDATE]: { params: []; returns: Promise<void> }
  [IPC.handle.SET_BACKGROUND_COLOR]: { params: [color: string]; returns: Promise<void> }
  [IPC.handle.EXPORT_DEBUG_LOGS]: { params: []; returns: Promise<string> }
  [IPC.handle.RECORD_FATAL_RENDERER_ERROR]: { params: [error: FatalRendererError]; returns: Promise<void> }
  [IPC.handle.GET_DESKTOP_PLUGIN_CONFIG]: { params: []; returns: Promise<{ configs: PluginConfigEntry[]; dropped: number }> }
  [IPC.handle.SET_DESKTOP_PLUGIN_CONFIG]: { params: [configs: PluginConfigEntry[]]; returns: Promise<{ configs: PluginConfigEntry[]; dropped: number }> }
  [IPC.handle.GET_DESKTOP_CUSTOM_AGENTS]: { params: []; returns: Promise<AgentDef[]> }
  [IPC.handle.SET_DESKTOP_CUSTOM_AGENTS]: { params: [agents: AgentDef[]]; returns: Promise<void> }
  [IPC.handle.DELETE_DESKTOP_CUSTOM_AGENT]: { params: [id: string]; returns: Promise<void> }
  [IPC.handle.GET_DESKTOP_MCP_SERVERS]: { params: []; returns: Promise<McpServerEntry[]> }
  [IPC.handle.SET_DESKTOP_MCP_SERVERS]: { params: [servers: McpServerEntry[]]; returns: Promise<{ servers: McpServerEntry[]; dropped: number }> }
  [IPC.handle.GITHUB_OAUTH_START]: { params: []; returns: Promise<string> }
  [IPC.handle.GITHUB_OAUTH_CALLBACK]: { params: [code: string, state: string]; returns: Promise<void> }
  [IPC.handle.GITHUB_GET_TOKEN]: { params: []; returns: Promise<string | null> }
  [IPC.handle.GITHUB_SET_TOKEN]: { params: [token: string]; returns: Promise<void> }
  [IPC.handle.GITHUB_CLEAR_TOKEN]: { params: []; returns: Promise<void> }
  [IPC.handle.GITHUB_API_PROXY]: { params: [url: string, options?: { method?: string; headers?: Record<string, string>; body?: string }]; returns: Promise<{ status: number; body: string } | { error: { type: string; hostname: string | null; allowedHostnames: string[] } }> }
  [IPC.handle.SESSION_EXPORT_DATA]: { params: [data: string, opts?: { title?: string; defaultPath?: string; filters?: Array<{ name: string; extensions: string[] }> }]; returns: Promise<string | { error: string } | null> }
  [IPC.handle.SESSION_IMPORT_FILE]: { params: [opts?: { title?: string; filters?: Array<{ name: string; extensions: string[] }> }]; returns: Promise<string | { error: string } | null> }
  [IPC.handle.SET_LOCALE_PREFERENCE]: { params: [locale: string]; returns: Promise<void> }
  [IPC.handle.GET_LOCALE_PREFERENCE]: { params: []; returns: Promise<string | null> }
  [IPC.handle.PLUGIN_INVOKE]: { params: [channel: string, data?: unknown]; returns: Promise<unknown> }
  [IPC.handle.GET_CAPABILITIES]: { params: []; returns: Promise<DesktopCapabilities> }
  [IPC.handle.GET_GIT_STATUS]: { params: []; returns: Promise<{ uncommitted: number; unpushed: number; mergeConflicts: number; branch: string | null } | null> }
  [IPC.handle.GET_SAFE_MODE_DIAGNOSTICS]: { params: []; returns: Promise<SafeModeDiagnostics> }
  [IPC.handle.SAFE_MODE_ACTION]: { params: [action: SafeModeAction]; returns: Promise<void> }
  [IPC.handle.OPEN_PROJECT]: { params: [directory: string]; returns: Promise<string> }
  // ── Secrets ──────────────────────────────────────────────
  [IPC.handle.SECRETS_SET]: { params: [ref: { namespace: string; accountID?: string; key: string }, value: string]; returns: Promise<void> }
  [IPC.handle.SECRETS_GET]: { params: [ref: { namespace: string; accountID?: string; key: string }]; returns: Promise<string | null> }
  [IPC.handle.SECRETS_DELETE]: { params: [ref: { namespace: string; accountID?: string; key: string }]; returns: Promise<void> }
  [IPC.handle.SECRETS_LIST]: { params: [namespace?: string]; returns: Promise<{ namespace: string; accountID?: string; key: string; createdAt: number; updatedAt: number }[]> }
  [IPC.handle.SECRETS_STATUS]: { params: []; returns: Promise<{ available: boolean; encrypted: boolean; secretCount: number }> }
  // ── Notifications ───────────────────────────────────────
  [IPC.handle.NOTIFICATIONS_NOTIFY]: { params: [opts: { kind: string; title: string; body: string; actionRef?: string; project?: string }]; returns: Promise<boolean> }
  [IPC.handle.NOTIFICATIONS_STATUS]: { params: []; returns: Promise<{ supported: boolean; enabled: boolean; permission: string }> }
  [IPC.handle.NOTIFICATIONS_SET_PREFERENCES]: { params: [prefs: { enabled?: boolean; agentBlocked?: boolean; reviewRequired?: boolean; releaseBinderComplete?: boolean; projectActivationFailed?: boolean; sidecarFailed?: boolean }]; returns: Promise<void> }
}

// ──────────────────────────────────────────────────────────────
//  IpcSendContract — ipcRenderer.send / ipcMain.on channels
//  Keys are the ACTUAL channel strings.
//  params only — void return (fire-and-forget).
// ──────────────────────────────────────────────────────────────

export interface IpcSendContract {
  [IPC.send.OPEN_LINK]: { params: [url: string] }
  [IPC.send.SHOW_NOTIFICATION]: { params: [title: string, body?: string] }
  [IPC.send.RELAUNCH]: { params: [] }
  [IPC.send.LOADING_WINDOW_COMPLETE]: { params: [] }
  [IPC.send.PLUGIN_SEND]: { params: [channel: string, data?: unknown] }
  [IPC.send.RENDERER_READY]: { params: [] }
}

// ──────────────────────────────────────────────────────────────
//  Compile-time assertion: every IPC channel must have a contract entry
// ──────────────────────────────────────────────────────────────

type _AllHandleValues = (typeof IPC.handle)[keyof typeof IPC.handle] & string
type _AllSendValues = (typeof IPC.send)[keyof typeof IPC.send] & string
type _ContractHandleKeys = keyof IpcHandleContract & string
type _ContractSendKeys = keyof IpcSendContract & string

// Compile-time assertion: if any channel is missing from a contract, this
// produces an error like: Type 'true' is not assignable to type '"ERROR: ..."'
type _CoverageOk =
  _AllHandleValues extends _ContractHandleKeys
    ? (_AllSendValues extends _ContractSendKeys
        ? true
        : "ERROR: Send channel(s) missing from IpcSendContract")
    : "ERROR: Handle channel(s) missing from IpcHandleContract"

/** @internal — Compile-time channel coverage assertion. Ignore the value. */
export const _channelCoverage: _CoverageOk = true

// ──────────────────────────────────────────────────────────────
//  Typed IPC helpers — for use in preload/index.ts
//  These replace raw ipcRenderer.invoke() / ipcRenderer.send()
//  and type-check arguments against the contract.
// ──────────────────────────────────────────────────────────────

/**
 * Type-safe ipcRenderer.invoke wrapper.
 * The channel must be in IpcHandleContract, and args/return are auto-typed.
 */
export function typedInvoke<C extends keyof IpcHandleContract & string>(
  channel: C,
  ...args: IpcHandleContract[C]["params"]
): IpcHandleContract[C]["returns"] {
  return ipcRenderer.invoke(channel, ...(args as unknown[]))
    .then((rawResult: unknown): IpcHandleContract[C]["returns"] => {
      if (process.env.NODE_ENV === "development") {
        if (!isIpcResult(rawResult)) {
          throw new IpcContractViolationError(
            channel,
            rawResult === null ? "null" : typeof rawResult,
          )
        }
      }
      const result = rawResult as IpcResult<unknown>
      if (result.ok) return result.value as IpcHandleContract[C]["returns"]
      throw result.error
    })
}

/**
 * Type-safe ipcRenderer.send wrapper.
 * The channel must be in IpcSendContract, and args are auto-typed.
 */
export function typedSend<C extends keyof IpcSendContract & string>(
  channel: C,
  ...args: IpcSendContract[C]["params"]
): void {
  ipcRenderer.send(channel, ...(args as unknown[]))
}



// ──────────────────────────────────────────────────────────────
//  Bridge Method Mapping — maps friendly bridge method names
//  to their IPC channel constants for type derivation.
// ──────────────────────────────────────────────────────────────

/** @internal — Bridge bridge-method → IPC handle channel constant mapping */
interface BridgeHandleMap {
  killSidecar: typeof IPC.handle.KILL_SIDECAR
  getWindowConfig: typeof IPC.handle.GET_WINDOW_CONFIG
  consumeInitialDeepLinks: typeof IPC.handle.CONSUME_INITIAL_DEEP_LINKS
  getDefaultServerUrl: typeof IPC.handle.GET_DEFAULT_SERVER_URL
  setDefaultServerUrl: typeof IPC.handle.SET_DEFAULT_SERVER_URL
  getWslConfig: typeof IPC.handle.GET_WSL_CONFIG
  setWslConfig: typeof IPC.handle.SET_WSL_CONFIG
  getDisplayBackend: typeof IPC.handle.GET_DISPLAY_BACKEND
  setDisplayBackend: typeof IPC.handle.SET_DISPLAY_BACKEND
  parseMarkdownCommand: typeof IPC.handle.PARSE_MARKDOWN
  checkAppExists: typeof IPC.handle.CHECK_APP_EXISTS
  wslPath: typeof IPC.handle.WSL_PATH
  resolveAppPath: typeof IPC.handle.RESOLVE_APP_PATH
  storeGet: typeof IPC.handle.STORE_GET
  storeSet: typeof IPC.handle.STORE_SET
  storeDelete: typeof IPC.handle.STORE_DELETE
  storeClear: typeof IPC.handle.STORE_CLEAR
  storeKeys: typeof IPC.handle.STORE_KEYS
  storeLength: typeof IPC.handle.STORE_LENGTH
  getWindowCount: typeof IPC.handle.GET_WINDOW_COUNT
  openDirectoryPicker: typeof IPC.handle.OPEN_DIRECTORY_PICKER
  openFilePicker: typeof IPC.handle.OPEN_FILE_PICKER
  saveFilePicker: typeof IPC.handle.SAVE_FILE_PICKER
  openPath: typeof IPC.handle.OPEN_PATH
  readClipboardImage: typeof IPC.handle.READ_CLIPBOARD_IMAGE
  getWindowFocused: typeof IPC.handle.GET_WINDOW_FOCUSED
  setWindowFocus: typeof IPC.handle.SET_WINDOW_FOCUS
  showWindow: typeof IPC.handle.SHOW_WINDOW
  getZoomFactor: typeof IPC.handle.GET_ZOOM_FACTOR
  setZoomFactor: typeof IPC.handle.SET_ZOOM_FACTOR
  getPinchZoomEnabled: typeof IPC.handle.GET_PINCH_ZOOM_ENABLED
  setPinchZoomEnabled: typeof IPC.handle.SET_PINCH_ZOOM_ENABLED
  setTitlebar: typeof IPC.handle.SET_TITLEBAR
  runDesktopMenuAction: typeof IPC.handle.RUN_DESKTOP_MENU_ACTION
  runUpdater: typeof IPC.handle.RUN_UPDATER
  checkUpdate: typeof IPC.handle.CHECK_UPDATE
  installUpdate: typeof IPC.handle.INSTALL_UPDATE
  setBackgroundColor: typeof IPC.handle.SET_BACKGROUND_COLOR
  exportDebugLogs: typeof IPC.handle.EXPORT_DEBUG_LOGS
  recordFatalRendererError: typeof IPC.handle.RECORD_FATAL_RENDERER_ERROR
  getDesktopPluginConfig: typeof IPC.handle.GET_DESKTOP_PLUGIN_CONFIG
  setDesktopPluginConfig: typeof IPC.handle.SET_DESKTOP_PLUGIN_CONFIG
  getCustomAgents: typeof IPC.handle.GET_DESKTOP_CUSTOM_AGENTS
  setCustomAgents: typeof IPC.handle.SET_DESKTOP_CUSTOM_AGENTS
  deleteCustomAgent: typeof IPC.handle.DELETE_DESKTOP_CUSTOM_AGENT
  getMcpServers: typeof IPC.handle.GET_DESKTOP_MCP_SERVERS
  setMcpServers: typeof IPC.handle.SET_DESKTOP_MCP_SERVERS
  githubStartOAuth: typeof IPC.handle.GITHUB_OAUTH_START
  githubOAuthCallback: typeof IPC.handle.GITHUB_OAUTH_CALLBACK
  githubGetToken: typeof IPC.handle.GITHUB_GET_TOKEN
  githubSetToken: typeof IPC.handle.GITHUB_SET_TOKEN
  githubClearToken: typeof IPC.handle.GITHUB_CLEAR_TOKEN
  githubApiProxy: typeof IPC.handle.GITHUB_API_PROXY
  sessionExportData: typeof IPC.handle.SESSION_EXPORT_DATA
  sessionImportFile: typeof IPC.handle.SESSION_IMPORT_FILE
  setLocalePreference: typeof IPC.handle.SET_LOCALE_PREFERENCE
  getLocalePreference: typeof IPC.handle.GET_LOCALE_PREFERENCE
  getGitStatus: typeof IPC.handle.GET_GIT_STATUS
  getCapabilities: typeof IPC.handle.GET_CAPABILITIES
  openProject: typeof IPC.handle.OPEN_PROJECT
  // ── Secrets ──────────────────────────────────────────────
  secretsSet: typeof IPC.handle.SECRETS_SET
  secretsGet: typeof IPC.handle.SECRETS_GET
  secretsDelete: typeof IPC.handle.SECRETS_DELETE
  secretsList: typeof IPC.handle.SECRETS_LIST
  secretsStatus: typeof IPC.handle.SECRETS_STATUS
  // ── Notifications ───────────────────────────────────────
  notificationsNotify: typeof IPC.handle.NOTIFICATIONS_NOTIFY
  notificationsStatus: typeof IPC.handle.NOTIFICATIONS_STATUS
  notificationsSetPreferences: typeof IPC.handle.NOTIFICATIONS_SET_PREFERENCES
}

/** @internal — Bridge send-method → IPC send channel constant mapping */
interface BridgeSendMap {
  openLink: typeof IPC.send.OPEN_LINK
  showNotification: typeof IPC.send.SHOW_NOTIFICATION
  relaunch: typeof IPC.send.RELAUNCH
  loadingWindowComplete: typeof IPC.send.LOADING_WINDOW_COMPLETE
}

// ──────────────────────────────────────────────────────────────
//  ElectronAPI Type Derivation
// ──────────────────────────────────────────────────────────────

/** All simple invoke-mapped methods (typedInvoke-based) */
type DerivedInvokeAPI = {
  [K in keyof BridgeHandleMap]: (...args: IpcHandleContract[BridgeHandleMap[K]]["params"]) => IpcHandleContract[BridgeHandleMap[K]]["returns"]
}

/** All simple send-mapped methods (typedSend-based) */
type DerivedSendAPI = {
  [K in keyof BridgeSendMap]: (...args: IpcSendContract[BridgeSendMap[K]]["params"]) => void
}

/**
 * Complex wrapper methods — these can't be derived from a simple
 * channel → method mapping because they have custom listener wiring
 * (event subscriptions, setup/teardown logic, etc.).
 *
 * Their internal IPC calls still use typedInvoke/typedSend for type safety.
 */
export interface ComplexAPIMethods {
  awaitInitialization: (onStep: (step: InitStep) => void) => Promise<ServerReadyData>
  onStorageMigrationProgress: (cb: (progress: StorageMigrationProgress) => void) => () => void
  onMenuCommand: (cb: (id: string) => void) => () => void
  onDeepLink: (cb: (urls: string[]) => void) => () => void
  onPinchZoomEnabledChanged: (cb: (enabled: boolean) => void) => () => void
  onZoomFactorChanged: (cb: (factor: number) => void) => () => void
  /** Plugin transport — dynamic channel names, cannot be statically typed by contract */
  pluginSend: (channel: string, data?: unknown) => void
  pluginOn: (channel: string, handler: PluginTransportHandler) => PluginTransportUnsub
  pluginOff: (channel: string, handler: PluginTransportHandler) => void
  pluginInvoke: (channel: string, data?: unknown) => Promise<unknown>
}

/**
 * Derived ElectronAPI — the full preload bridge type, generated from the IPC contract.
 * This replaces the manually written ElectronAPI type in preload/types.ts.
 *
 * Composed of:
 *   DerivedInvokeAPI  — methods backed by ipcRenderer.invoke (typedInvoke)
 *   DerivedSendAPI    — methods backed by ipcRenderer.send (typedSend)
 *   ComplexAPIMethods — methods with custom listener/plugin wiring
 */
export type DerivedElectronAPI = DerivedInvokeAPI & DerivedSendAPI & ComplexAPIMethods

/**
 * Plugin transport send — typed wrapper for the dynamic PLUGIN_SEND channel.
 * Uses typedSend under the hood so the channel type is checked against IpcSendContract.
 * Plugin sub-channels are dynamic (runtime-defined by the plugin), but the outer IPC
 * channel (PLUGIN_SEND) is statically typed. Includes error handling for the
 * fire-and-forget send pattern.
 */
export function pluginSend(channel: string, data?: unknown): void {
  try {
    typedSend(IPC.send.PLUGIN_SEND, channel, data)
  } catch (error) {
    console.error(`[plugin] Failed to send on channel "${channel}":`, error)
  }
}

/**
 * Plugin transport invoke — typed wrapper for the dynamic PLUGIN_INVOKE channel.
 * Uses typedInvoke under the hood so the channel type is checked against IpcHandleContract.
 * Plugin sub-channels are dynamic (runtime-defined by the plugin), but the outer IPC
 * channel (PLUGIN_INVOKE) is statically typed.
 */
export function pluginInvoke(channel: string, data?: unknown): Promise<unknown> {
  return typedInvoke(IPC.handle.PLUGIN_INVOKE, channel, data)
}


// ── IPC Method Registry ──────────────────────────────────
// Documents every ipcMain.handle method: its channel string,
// handler return shape (after withIpcResult wrapping),
// whether it uses withIpcResult, and what the renderer
// receives after typedInvoke unwrapping.

export const IPC_METHOD_REGISTRY: {
  channel: string
  usesIpcResult: boolean
  returns: string // what ipcMain.handle returns over the wire
  rendererSees: string // what typedInvoke returns to the renderer
}[] = [
  // ── Init ───────────────────────────────────────────────
  { channel: IPC.handle.KILL_SIDECAR, usesIpcResult: true, returns: "IpcResult<void>", rendererSees: "void" },
  { channel: IPC.handle.AWAIT_INITIALIZATION, usesIpcResult: true, returns: "IpcResult<ServerReadyData>", rendererSees: "ServerReadyData" },
  { channel: IPC.handle.GET_WINDOW_CONFIG, usesIpcResult: true, returns: "IpcResult<WindowConfig>", rendererSees: "WindowConfig" },
  { channel: IPC.handle.CONSUME_INITIAL_DEEP_LINKS, usesIpcResult: true, returns: "IpcResult<string[]>", rendererSees: "string[]" },
  { channel: IPC.handle.GET_DEFAULT_SERVER_URL, usesIpcResult: true, returns: "IpcResult<string | null>", rendererSees: "string | null" },
  { channel: IPC.handle.SET_DEFAULT_SERVER_URL, usesIpcResult: true, returns: "IpcResult<void>", rendererSees: "void" },
  { channel: IPC.handle.GET_WSL_CONFIG, usesIpcResult: true, returns: "IpcResult<WslConfig>", rendererSees: "WslConfig" },
  { channel: IPC.handle.SET_WSL_CONFIG, usesIpcResult: true, returns: "IpcResult<void>", rendererSees: "void" },
  { channel: IPC.handle.GET_DISPLAY_BACKEND, usesIpcResult: true, returns: "IpcResult<LinuxDisplayBackend | null>", rendererSees: "LinuxDisplayBackend | null" },
  { channel: IPC.handle.SET_DISPLAY_BACKEND, usesIpcResult: true, returns: "IpcResult<void>", rendererSees: "void" },
  { channel: IPC.handle.PARSE_MARKDOWN, usesIpcResult: true, returns: "IpcResult<string>", rendererSees: "string" },
  { channel: IPC.handle.CHECK_APP_EXISTS, usesIpcResult: true, returns: "IpcResult<boolean>", rendererSees: "boolean" },
  { channel: IPC.handle.WSL_PATH, usesIpcResult: true, returns: "IpcResult<string>", rendererSees: "string" },
  { channel: IPC.handle.RESOLVE_APP_PATH, usesIpcResult: true, returns: "IpcResult<string | null>", rendererSees: "string | null" },
  { channel: IPC.handle.RUN_UPDATER, usesIpcResult: true, returns: "IpcResult<void>", rendererSees: "void" },
  { channel: IPC.handle.CHECK_UPDATE, usesIpcResult: true, returns: "IpcResult<{ updateAvailable: boolean; version?: string }>", rendererSees: "{ updateAvailable: boolean; version?: string }" },
  { channel: IPC.handle.INSTALL_UPDATE, usesIpcResult: true, returns: "IpcResult<void>", rendererSees: "void" },
  { channel: IPC.handle.SET_BACKGROUND_COLOR, usesIpcResult: true, returns: "IpcResult<void>", rendererSees: "void" },
  { channel: IPC.handle.EXPORT_DEBUG_LOGS, usesIpcResult: true, returns: "IpcResult<string>", rendererSees: "string" },
  { channel: IPC.handle.RECORD_FATAL_RENDERER_ERROR, usesIpcResult: true, returns: "IpcResult<void>", rendererSees: "void" },
  { channel: IPC.handle.GET_SAFE_MODE_DIAGNOSTICS, usesIpcResult: true, returns: "IpcResult<SafeModeDiagnostics>", rendererSees: "SafeModeDiagnostics" },
  { channel: IPC.handle.SAFE_MODE_ACTION, usesIpcResult: true, returns: "IpcResult<void>", rendererSees: "void" },

  // ── Store ──────────────────────────────────────────────
  { channel: IPC.handle.STORE_GET, usesIpcResult: true, returns: "IpcResult<string | null>", rendererSees: "string | null" },
  { channel: IPC.handle.STORE_SET, usesIpcResult: true, returns: "IpcResult<void>", rendererSees: "void" },
  { channel: IPC.handle.STORE_DELETE, usesIpcResult: true, returns: "IpcResult<void>", rendererSees: "void" },
  { channel: IPC.handle.STORE_CLEAR, usesIpcResult: true, returns: "IpcResult<void>", rendererSees: "void" },
  { channel: IPC.handle.STORE_KEYS, usesIpcResult: true, returns: "IpcResult<string[]>", rendererSees: "string[]" },
  { channel: IPC.handle.STORE_LENGTH, usesIpcResult: true, returns: "IpcResult<number>", rendererSees: "number" },

  // ── Window ─────────────────────────────────────────────
  { channel: IPC.handle.GET_WINDOW_COUNT, usesIpcResult: true, returns: "IpcResult<number>", rendererSees: "number" },
  { channel: IPC.handle.GET_WINDOW_FOCUSED, usesIpcResult: true, returns: "IpcResult<boolean>", rendererSees: "boolean" },
  { channel: IPC.handle.SET_WINDOW_FOCUS, usesIpcResult: true, returns: "IpcResult<void>", rendererSees: "void" },
  { channel: IPC.handle.SHOW_WINDOW, usesIpcResult: true, returns: "IpcResult<void>", rendererSees: "void" },
  { channel: IPC.handle.GET_ZOOM_FACTOR, usesIpcResult: true, returns: "IpcResult<number>", rendererSees: "number" },
  { channel: IPC.handle.SET_ZOOM_FACTOR, usesIpcResult: true, returns: "IpcResult<void>", rendererSees: "void" },
  { channel: IPC.handle.GET_PINCH_ZOOM_ENABLED, usesIpcResult: true, returns: "IpcResult<boolean>", rendererSees: "boolean" },
  { channel: IPC.handle.SET_PINCH_ZOOM_ENABLED, usesIpcResult: true, returns: "IpcResult<void>", rendererSees: "void" },
  { channel: IPC.handle.SET_TITLEBAR, usesIpcResult: true, returns: "IpcResult<void>", rendererSees: "void" },
  { channel: IPC.handle.RUN_DESKTOP_MENU_ACTION, usesIpcResult: true, returns: "IpcResult<void>", rendererSees: "void" },

  // ── FS ─────────────────────────────────────────────────
  { channel: IPC.handle.OPEN_DIRECTORY_PICKER, usesIpcResult: true, returns: "IpcResult<string | string[] | null>", rendererSees: "string | string[] | null" },
  { channel: IPC.handle.OPEN_FILE_PICKER, usesIpcResult: true, returns: "IpcResult<string | string[] | null>", rendererSees: "string | string[] | null" },
  { channel: IPC.handle.SAVE_FILE_PICKER, usesIpcResult: true, returns: "IpcResult<string | null>", rendererSees: "string | null" },
  { channel: IPC.handle.OPEN_PATH, usesIpcResult: true, returns: "IpcResult<string | void>", rendererSees: "string | void" },
  { channel: IPC.handle.READ_CLIPBOARD_IMAGE, usesIpcResult: true, returns: "IpcResult<{ buffer: ArrayBuffer; width: number; height: number } | null>", rendererSees: "{ buffer: ArrayBuffer; width: number; height: number } | null" },

  // ── Config ─────────────────────────────────────────────
  { channel: IPC.handle.GET_DESKTOP_CUSTOM_AGENTS, usesIpcResult: true, returns: "IpcResult<AgentDef[]>", rendererSees: "AgentDef[]" },
  { channel: IPC.handle.SET_DESKTOP_CUSTOM_AGENTS, usesIpcResult: true, returns: "IpcResult<void>", rendererSees: "void" },
  { channel: IPC.handle.DELETE_DESKTOP_CUSTOM_AGENT, usesIpcResult: true, returns: "IpcResult<void>", rendererSees: "void" },
  { channel: IPC.handle.GET_DESKTOP_MCP_SERVERS, usesIpcResult: true, returns: "IpcResult<McpServerEntry[]>", rendererSees: "McpServerEntry[]" },
  { channel: IPC.handle.SET_DESKTOP_MCP_SERVERS, usesIpcResult: true, returns: "IpcResult<{ servers: McpServerEntry[]; dropped: number }>", rendererSees: "{ servers: McpServerEntry[]; dropped: number }" },
  { channel: IPC.handle.GET_DESKTOP_PLUGIN_CONFIG, usesIpcResult: true, returns: "IpcResult<{ configs: PluginConfigEntry[]; dropped: number }>", rendererSees: "{ configs: PluginConfigEntry[]; dropped: number }" },
  { channel: IPC.handle.SET_DESKTOP_PLUGIN_CONFIG, usesIpcResult: true, returns: "IpcResult<{ configs: PluginConfigEntry[]; dropped: number }>", rendererSees: "{ configs: PluginConfigEntry[]; dropped: number }" },

  // ── Session ────────────────────────────────────────────
  { channel: IPC.handle.SESSION_EXPORT_DATA, usesIpcResult: true, returns: "IpcResult<string | { error: string } | null>", rendererSees: "string | { error: string } | null" },
  { channel: IPC.handle.SESSION_IMPORT_FILE, usesIpcResult: true, returns: "IpcResult<string | { error: string } | null>", rendererSees: "string | { error: string } | null" },

  // ── Locale ─────────────────────────────────────────────
  { channel: IPC.handle.SET_LOCALE_PREFERENCE, usesIpcResult: true, returns: "IpcResult<void>", rendererSees: "void" },
  { channel: IPC.handle.GET_LOCALE_PREFERENCE, usesIpcResult: true, returns: "IpcResult<string | null>", rendererSees: "string | null" },

  // ── GitHub ─────────────────────────────────────────────
  { channel: IPC.handle.GITHUB_OAUTH_START, usesIpcResult: true, returns: "IpcResult<string>", rendererSees: "string" },
  { channel: IPC.handle.GITHUB_OAUTH_CALLBACK, usesIpcResult: true, returns: "IpcResult<void>", rendererSees: "void" },
  { channel: IPC.handle.GITHUB_GET_TOKEN, usesIpcResult: true, returns: "IpcResult<string | null>", rendererSees: "string | null" },
  { channel: IPC.handle.GITHUB_SET_TOKEN, usesIpcResult: true, returns: "IpcResult<void>", rendererSees: "void" },
  { channel: IPC.handle.GITHUB_CLEAR_TOKEN, usesIpcResult: true, returns: "IpcResult<void>", rendererSees: "void" },
  { channel: IPC.handle.GITHUB_API_PROXY, usesIpcResult: true, returns: "IpcResult<{ status: number; body: string } | { error: { type: string; hostname: string | null; allowedHostnames: string[] } }>", rendererSees: "{ status: number; body: string } | { error: { type: string; hostname: string | null; allowedHostnames: string[] } }" },

  // ── Plugin Transport ───────────────────────────────────
  { channel: IPC.handle.PLUGIN_INVOKE, usesIpcResult: true, returns: "IpcResult<unknown>", rendererSees: "unknown" },

  // ── Capabilities ───────────────────────────────────────
  { channel: IPC.handle.GET_CAPABILITIES, usesIpcResult: true, returns: "IpcResult<DesktopCapabilities>", rendererSees: "DesktopCapabilities" },

  // ── Git ────────────────────────────────────────────────
  { channel: IPC.handle.GET_GIT_STATUS, usesIpcResult: true, returns: "IpcResult<GitCheck | null>", rendererSees: "GitCheck | null" },
  // ── Secrets ──────────────────────────────────────────────
  { channel: IPC.handle.SECRETS_SET, usesIpcResult: true, returns: "IpcResult<void>", rendererSees: "void" },
  { channel: IPC.handle.SECRETS_GET, usesIpcResult: true, returns: "IpcResult<string | null>", rendererSees: "string | null" },
  { channel: IPC.handle.SECRETS_DELETE, usesIpcResult: true, returns: "IpcResult<void>", rendererSees: "void" },
  { channel: IPC.handle.SECRETS_LIST, usesIpcResult: true, returns: "IpcResult<{ namespace: string; accountID?: string; key: string; createdAt: number; updatedAt: number }[]>", rendererSees: "{ namespace: string; accountID?: string; key: string; createdAt: number; updatedAt: number }[]" },
  { channel: IPC.handle.SECRETS_STATUS, usesIpcResult: true, returns: "IpcResult<{ available: boolean; encrypted: boolean; secretCount: number }>", rendererSees: "{ available: boolean; encrypted: boolean; secretCount: number }" },
  // ── Notifications ───────────────────────────────────────
  { channel: IPC.handle.NOTIFICATIONS_NOTIFY, usesIpcResult: true, returns: "IpcResult<boolean>", rendererSees: "boolean" },
  { channel: IPC.handle.NOTIFICATIONS_STATUS, usesIpcResult: true, returns: "IpcResult<{ supported: boolean; enabled: boolean; permission: string }>", rendererSees: "{ supported: boolean; enabled: boolean; permission: string }" },
  { channel: IPC.handle.NOTIFICATIONS_SET_PREFERENCES, usesIpcResult: true, returns: "IpcResult<void>", rendererSees: "void" },
]

// ── Runtime Validation ───────────────────────────────────

/**
 * Validates IPC_METHOD_REGISTRY against actual ipcMain.handle registrations.
 * Only meaningful in the Electron main process.
 *
 * Checks:
 *   1. Every registry entry has a corresponding ipcMain handler registered.
 *   2. Every ipcMain.handle handler has a registry entry.
 *
 * @returns Array of issue descriptions; empty array means all clear.
 */
export function validateIpcMethodRegistry(): string[] {
  const issues: string[] = []

  // Access ipcMain — only available in Electron main process.
  // Using a type-only import + dynamic require to keep this module
  // safe in preload/renderer contexts.
  let ipcMain: import("electron").IpcMain | undefined
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    ipcMain = require("electron").ipcMain
  } catch {
    return issues
  }
  if (!ipcMain) return issues

  const registered = new Set<string>()
  const evts = ipcMain.eventNames()
  for (const evt of evts) {
    registered.add(String(evt))
  }

  // All handle channels that SHOULD be registered
  const allHandleChannels = new Set(Object.values(IPC.handle) as string[])

  // 1. Registry → ipcMain: every registry entry must have a handler
  for (const entry of IPC_METHOD_REGISTRY) {
    if (!registered.has(entry.channel)) {
      issues.push(`IPC_METHOD_REGISTRY entry "${entry.channel}" has no ipcMain.handle registration`)
    }
  }

  // 2. ipcMain → Registry: every handle handler must have a registry entry
  for (const ch of registered) {
    if (!allHandleChannels.has(ch)) continue // skip send/push/internal channels
    if (!IPC_METHOD_REGISTRY.some(e => e.channel === ch)) {
      issues.push(`ipcMain.handle "${ch}" is not in IPC_METHOD_REGISTRY`)
    }
  }

  return issues
}

// In development mode, validate the registry against actual handler
// registrations at startup. Uses setImmediate so handlers have time to register.
if (
  typeof process !== "undefined" &&
  (process as { type?: string }).type === "browser" &&
  process.env.NODE_ENV === "development"
) {
  setImmediate(() => {
    const issues = validateIpcMethodRegistry()
    if (issues.length > 0) {
      console.error("[IPC Registry] Mismatch between IPC_METHOD_REGISTRY and ipcMain handlers:")
      for (const issue of issues) console.error(`  • ${issue}`)
    }
  })
}
