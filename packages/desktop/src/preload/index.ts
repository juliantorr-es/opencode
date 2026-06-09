import { contextBridge, ipcRenderer } from "electron"
import type { ElectronAPI, InitStep, SafeModeAction, SafeModeDiagnostics, ServerReadyData, StorageMigrationProgress } from "./types"
import { IPC } from "../main/ipc-channels"
import { typedInvoke, typedSend, pluginSend, pluginInvoke } from "../main/ipc-contract"
import { typedInvokeV2 } from "./ipc-client"


const api: ElectronAPI = {
  // --- Simple invoke methods ---
  killSidecar: () => typedInvokeV2(IPC.handle.KILL_SIDECAR, null),
  getWindowConfig: () => typedInvokeV2(IPC.handle.GET_WINDOW_CONFIG, null),
  consumeInitialDeepLinks: () => typedInvokeV2(IPC.handle.CONSUME_INITIAL_DEEP_LINKS, null),
  getDefaultServerUrl: () => typedInvokeV2(IPC.handle.GET_DEFAULT_SERVER_URL, null),
  setDefaultServerUrl: (url) => typedInvokeV2(IPC.handle.SET_DEFAULT_SERVER_URL, null, url),
  getWslConfig: () => typedInvokeV2(IPC.handle.GET_WSL_CONFIG, null),
  setWslConfig: (config) => typedInvokeV2(IPC.handle.SET_WSL_CONFIG, null, config),
  getDisplayBackend: () => typedInvokeV2(IPC.handle.GET_DISPLAY_BACKEND, null),
  setDisplayBackend: (backend) => typedInvokeV2(IPC.handle.SET_DISPLAY_BACKEND, null, backend),
  parseMarkdownCommand: (markdown) => typedInvokeV2(IPC.handle.PARSE_MARKDOWN, null, markdown),
  checkAppExists: (appName) => typedInvokeV2(IPC.handle.CHECK_APP_EXISTS, null, appName),
  wslPath: (path, mode) => typedInvokeV2(IPC.handle.WSL_PATH, null, path, mode),
  resolveAppPath: (appName) => typedInvokeV2(IPC.handle.RESOLVE_APP_PATH, null, appName),
  storeGet: (name, key) => typedInvokeV2(IPC.handle.STORE_GET, null, name, key),
  storeSet: (name, key, value) => typedInvokeV2(IPC.handle.STORE_SET, null, name, key, value),
  storeDelete: (name, key) => typedInvokeV2(IPC.handle.STORE_DELETE, null, name, key),
  storeClear: (name) => typedInvokeV2(IPC.handle.STORE_CLEAR, null, name),
  storeKeys: (name) => typedInvokeV2(IPC.handle.STORE_KEYS, null, name),
  storeLength: (name) => typedInvokeV2(IPC.handle.STORE_LENGTH, null, name),
  getWindowCount: () => typedInvoke(IPC.handle.GET_WINDOW_COUNT),
  openDirectoryPicker: (opts) => typedInvokeV2(IPC.handle.OPEN_DIRECTORY_PICKER, null, opts),
  openFilePicker: (opts) => typedInvokeV2(IPC.handle.OPEN_FILE_PICKER, null, opts),
  saveFilePicker: (opts) => typedInvokeV2(IPC.handle.SAVE_FILE_PICKER, null, opts),
  openPath: (path, app) => typedInvokeV2(IPC.handle.OPEN_PATH, null, path, app),
  readClipboardImage: () => typedInvokeV2(IPC.handle.READ_CLIPBOARD_IMAGE, null),
  getWindowFocused: () => typedInvoke(IPC.handle.GET_WINDOW_FOCUSED),
  setWindowFocus: () => typedInvoke(IPC.handle.SET_WINDOW_FOCUS),
  showWindow: () => typedInvoke(IPC.handle.SHOW_WINDOW),
  getZoomFactor: () => typedInvoke(IPC.handle.GET_ZOOM_FACTOR),
  setZoomFactor: (factor) => typedInvoke(IPC.handle.SET_ZOOM_FACTOR, factor),
  getPinchZoomEnabled: () => typedInvoke(IPC.handle.GET_PINCH_ZOOM_ENABLED),
  setPinchZoomEnabled: (enabled) => typedInvoke(IPC.handle.SET_PINCH_ZOOM_ENABLED, enabled),
  setTitlebar: (theme) => typedInvoke(IPC.handle.SET_TITLEBAR, theme),
  runDesktopMenuAction: (action) => typedInvoke(IPC.handle.RUN_DESKTOP_MENU_ACTION, action),
  runUpdater: (alertOnFail) => typedInvokeV2(IPC.handle.RUN_UPDATER, null, alertOnFail),
  checkUpdate: () => typedInvokeV2(IPC.handle.CHECK_UPDATE, null),
  installUpdate: () => typedInvokeV2(IPC.handle.INSTALL_UPDATE, null),
  setBackgroundColor: (color) => typedInvokeV2(IPC.handle.SET_BACKGROUND_COLOR, null, color),
  exportDebugLogs: () => typedInvokeV2(IPC.handle.EXPORT_DEBUG_LOGS, null),
  recordFatalRendererError: (error) => typedInvokeV2(IPC.handle.RECORD_FATAL_RENDERER_ERROR, null, error),
  getDesktopPluginConfig: () => typedInvoke(IPC.handle.GET_DESKTOP_PLUGIN_CONFIG),
  setDesktopPluginConfig: (configs) => typedInvoke(IPC.handle.SET_DESKTOP_PLUGIN_CONFIG, configs),
  getCustomAgents: () => typedInvoke(IPC.handle.GET_DESKTOP_CUSTOM_AGENTS),
  setCustomAgents: (agents) => typedInvoke(IPC.handle.SET_DESKTOP_CUSTOM_AGENTS, agents),
  deleteCustomAgent: (id) => typedInvoke(IPC.handle.DELETE_DESKTOP_CUSTOM_AGENT, id),
  getMcpServers: () => typedInvoke(IPC.handle.GET_DESKTOP_MCP_SERVERS),
  setMcpServers: (servers) => typedInvoke(IPC.handle.SET_DESKTOP_MCP_SERVERS, servers),
  githubStartOAuth: () => typedInvokeV2(IPC.handle.GITHUB_OAUTH_START, null),
  githubOAuthCallback: (code, state) => typedInvokeV2(IPC.handle.GITHUB_OAUTH_CALLBACK, null, code, state),
  githubGetToken: () => typedInvokeV2(IPC.handle.GITHUB_GET_TOKEN, null),
  githubSetToken: (token) => typedInvokeV2(IPC.handle.GITHUB_SET_TOKEN, null, token),
  githubClearToken: () => typedInvokeV2(IPC.handle.GITHUB_CLEAR_TOKEN, null),
  githubApiProxy: (url, options) => typedInvokeV2(IPC.handle.GITHUB_API_PROXY, null, url, options),
  sessionExportData: (data, opts) => typedInvoke(IPC.handle.SESSION_EXPORT_DATA, data, opts),
  sessionImportFile: (opts) => typedInvoke(IPC.handle.SESSION_IMPORT_FILE, opts),
  setLocalePreference: (locale) => typedInvoke(IPC.handle.SET_LOCALE_PREFERENCE, locale),
  getLocalePreference: () => typedInvoke(IPC.handle.GET_LOCALE_PREFERENCE),

  getGitStatus: () => typedInvoke(IPC.handle.GET_GIT_STATUS),
  getCapabilities: () => typedInvoke(IPC.handle.GET_CAPABILITIES),
  getSystemStatus: () => typedInvokeV2(IPC.handle.GET_WINDOW_CONFIG, null),
  sidecarStatus: () => typedInvokeV2(IPC.handle.SIDECAR_STATUS, null) as unknown as Promise<{ ready: boolean; url: string | null }>,
  getUpdateStatus: () => typedInvokeV2(IPC.handle.CHECK_UPDATE, null) as unknown as Promise<{ updateAvailable: boolean; version?: string }>,
  getSafeModeDiagnostics: () => typedInvokeV2(IPC.handle.GET_SAFE_MODE_DIAGNOSTICS, null) as unknown as Promise<SafeModeDiagnostics>,
  safeModeAction: (action: SafeModeAction) => typedInvokeV2(IPC.handle.SAFE_MODE_ACTION, null, action) as unknown as Promise<void>,
  openProject: (directory) => typedInvokeV2(IPC.handle.OPEN_PROJECT, null, directory),

  // --- Send methods (fire-and-forget) ---
  openLink: (url) => typedSend(IPC.send.OPEN_LINK, url),
  showNotification: (title, body) => typedSend(IPC.send.SHOW_NOTIFICATION, title, body),
  relaunch: () => typedSend(IPC.send.RELAUNCH),
  loadingWindowComplete: () => typedSend(IPC.send.LOADING_WINDOW_COMPLETE),
  rendererReady: () => typedSend(IPC.send.RENDERER_READY),
  // --- Complex listener methods (keep ipcRenderer.on) ---
  awaitInitialization: (onStep) => {
    const handler = (_: unknown, step: InitStep) => onStep(step)
    ipcRenderer.on(IPC.push.INIT_STEP, handler)
    return (typedInvokeV2(IPC.handle.AWAIT_INITIALIZATION, null) as Promise<ServerReadyData>).finally(() => {
      ipcRenderer.removeListener(IPC.push.INIT_STEP, handler)
    })
  },
  onStorageMigrationProgress: (cb) => {
    const handler = (_: unknown, progress: StorageMigrationProgress) => cb(progress)
    ipcRenderer.on(IPC.push.STORAGE_MIGRATION_PROGRESS, handler)
    return () => ipcRenderer.removeListener(IPC.push.STORAGE_MIGRATION_PROGRESS, handler)
  },
  onMenuCommand: (cb) => {
    const handler = (_: unknown, id: string) => cb(id)
    ipcRenderer.on(IPC.push.MENU_COMMAND, handler)
    return () => ipcRenderer.removeListener(IPC.push.MENU_COMMAND, handler)
  },
  onDeepLink: (cb) => {
    const handler = (_: unknown, urls: string[]) => cb(urls)
    ipcRenderer.on(IPC.push.DEEP_LINK, handler)
    return () => ipcRenderer.removeListener(IPC.push.DEEP_LINK, handler)
  },
  onPinchZoomEnabledChanged: (cb) => {
    const handler = (_: unknown, enabled: boolean) => cb(enabled)
    ipcRenderer.on(IPC.push.PINCH_ZOOM_ENABLED_CHANGED, handler)
    return () => ipcRenderer.removeListener(IPC.push.PINCH_ZOOM_ENABLED_CHANGED, handler)
  },
  onZoomFactorChanged: (cb) => {
    const handler = (_: unknown, factor: number) => cb(factor)
    ipcRenderer.on(IPC.push.ZOOM_FACTOR_CHANGED, handler)
    return () => ipcRenderer.removeListener(IPC.push.ZOOM_FACTOR_CHANGED, handler)
  },

  // --- Plugin transport ---
  /** Map plugin channel+handler pairs to the IPC listener callback for off() cleanup. */
  _pluginListeners: new Map<string, (...args: unknown[]) => void>(),
  pluginSend: (channel: string, data?: unknown) => {
    pluginSend(channel, data)
  },
  pluginOn: (channel: string, handler: (data: unknown) => void) => {
    const listener = (_: unknown, payload: { channel: string; data: unknown }) => {
      if (payload.channel === channel) handler(payload.data)
    }
    const key = `${channel}::${String(handler)}`
    api._pluginListeners.set(key, listener)
    ipcRenderer.on(IPC.push.PLUGIN_PUSH, listener)
    return () => {
      api._pluginListeners.delete(key)
      ipcRenderer.removeListener(IPC.push.PLUGIN_PUSH, listener)
    }
  },
  pluginOff: (channel: string, handler: (data: unknown) => void) => {
    const key = `${channel}::${String(handler)}`
    const listener = api._pluginListeners.get(key)
    if (listener) {
      api._pluginListeners.delete(key)
      ipcRenderer.removeListener(IPC.push.PLUGIN_PUSH, listener)
    }
  },
  pluginInvoke: (channel: string, data?: unknown) => {
    return pluginInvoke(channel, data)
  },
  onIpcFailure: (cb) => {
    const handler = (_event: unknown, error: unknown) => cb(error as { requestId: string; code: string; message: string; recoverability: string; timestamp: number })
    ipcRenderer.on("tribunus:ipc-failure", handler)
    return () => ipcRenderer.removeListener("tribunus:ipc-failure", handler)
  },
}

contextBridge.exposeInMainWorld("api", api as unknown as ElectronAPI)
