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
  [IPC.handle.GET_SAFE_MODE_DIAGNOSTICS]: { params: []; returns: Promise<SafeModeDiagnostics> }
  [IPC.handle.SAFE_MODE_ACTION]: { params: [action: SafeModeAction]; returns: Promise<void> }
  [IPC.handle.EVENT_EXPLAIN]: { params: [event: string]; returns: Promise<string> }
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
  return ipcRenderer.invoke(channel, ...(args as unknown[])) as unknown as IpcHandleContract[C]["returns"]
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

/**
 * Safe invoke — wraps typedInvoke with IpcResult degradation.
 * If the IPC call throws (e.g. channel not registered, main process not ready),
 * returns an IpcErr instead of a rejected promise.
 *
 * Use this in preload/index.ts for every external-facing API method.
 */
export async function safeInvoke<C extends keyof IpcHandleContract & string>(
  channel: C,
  ...args: IpcHandleContract[C]["params"]
): Promise<IpcResult<IpcHandleContract[C]["returns"]>> {
  try {
    const value = await typedInvoke(channel, ...args)
    return { ok: true, value }
  } catch (error) {
    return {
      ok: false,
      error: normalizeIpcError(channel, error),
    }
  }
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

// --- lane-8 ---
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

// --- lane-8 ---
// --- Change import line 4: remove safeInvoke dead code, add pluginSend/pluginInvoke ---
// OLD: import { typedInvoke, typedSend, safeInvoke } from "../main/ipc-contract"
// NEW: import { typedInvoke, typedSend, pluginSend, pluginInvoke } from "../main/ipc-contract"

// --- Replace pluginSend method body (line ~124) ---
// OLD:
//   pluginSend: (channel: string, data?: unknown) => {
//     ipcRenderer.send(IPC.send.PLUGIN_SEND, channel, data)
//   },
// NEW:
//   pluginSend: (channel: string, data?: unknown) => {
//     pluginSend(channel, data)
//   },

// --- Replace pluginInvoke method body (line ~137) ---
// OLD:
//   pluginInvoke: (channel: string, data?: unknown) => {
//     return ipcRenderer.invoke(IPC.handle.PLUGIN_INVOKE, channel, data)
//   },
// NEW:
//   pluginInvoke: (channel: string, data?: unknown) => {
//     return pluginInvoke(channel, data)
//   },
