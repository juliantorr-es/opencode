import { contextBridge, ipcRenderer } from "electron"
import type { ElectronAPI, InitStep, SafeModeAction, SqliteMigrationProgress } from "./types"
import { IPC } from "../main/ipc-channels"
import { typedInvoke, typedSend, safeInvoke } from "../main/ipc-contract"

const api: ElectronAPI = {
  // --- Simple invoke methods ---
  killSidecar: () => typedInvoke(IPC.handle.KILL_SIDECAR),
  getWindowConfig: () => typedInvoke(IPC.handle.GET_WINDOW_CONFIG),
  consumeInitialDeepLinks: () => typedInvoke(IPC.handle.CONSUME_INITIAL_DEEP_LINKS),
  getDefaultServerUrl: () => typedInvoke(IPC.handle.GET_DEFAULT_SERVER_URL),
  setDefaultServerUrl: (url) => typedInvoke(IPC.handle.SET_DEFAULT_SERVER_URL, url),
  getWslConfig: () => typedInvoke(IPC.handle.GET_WSL_CONFIG),
  setWslConfig: (config) => typedInvoke(IPC.handle.SET_WSL_CONFIG, config),
  getDisplayBackend: () => typedInvoke(IPC.handle.GET_DISPLAY_BACKEND),
  setDisplayBackend: (backend) => typedInvoke(IPC.handle.SET_DISPLAY_BACKEND, backend),
  parseMarkdownCommand: (markdown) => typedInvoke(IPC.handle.PARSE_MARKDOWN, markdown),
  checkAppExists: (appName) => typedInvoke(IPC.handle.CHECK_APP_EXISTS, appName),
  wslPath: (path, mode) => typedInvoke(IPC.handle.WSL_PATH, path, mode),
  resolveAppPath: (appName) => typedInvoke(IPC.handle.RESOLVE_APP_PATH, appName),
  storeGet: (name, key) => typedInvoke(IPC.handle.STORE_GET, name, key),
  storeSet: (name, key, value) => typedInvoke(IPC.handle.STORE_SET, name, key, value),
  storeDelete: (name, key) => typedInvoke(IPC.handle.STORE_DELETE, name, key),
  storeClear: (name) => typedInvoke(IPC.handle.STORE_CLEAR, name),
  storeKeys: (name) => typedInvoke(IPC.handle.STORE_KEYS, name),
  storeLength: (name) => typedInvoke(IPC.handle.STORE_LENGTH, name),
  getWindowCount: () => typedInvoke(IPC.handle.GET_WINDOW_COUNT),
  openDirectoryPicker: (opts) => typedInvoke(IPC.handle.OPEN_DIRECTORY_PICKER, opts),
  openFilePicker: (opts) => typedInvoke(IPC.handle.OPEN_FILE_PICKER, opts),
  saveFilePicker: (opts) => typedInvoke(IPC.handle.SAVE_FILE_PICKER, opts),
  openPath: (path, app) => typedInvoke(IPC.handle.OPEN_PATH, path, app),
  readClipboardImage: () => typedInvoke(IPC.handle.READ_CLIPBOARD_IMAGE),
  getWindowFocused: () => typedInvoke(IPC.handle.GET_WINDOW_FOCUSED),
  setWindowFocus: () => typedInvoke(IPC.handle.SET_WINDOW_FOCUS),
  showWindow: () => typedInvoke(IPC.handle.SHOW_WINDOW),
  getZoomFactor: () => typedInvoke(IPC.handle.GET_ZOOM_FACTOR),
  setZoomFactor: (factor) => typedInvoke(IPC.handle.SET_ZOOM_FACTOR, factor),
  getPinchZoomEnabled: () => typedInvoke(IPC.handle.GET_PINCH_ZOOM_ENABLED),
  setPinchZoomEnabled: (enabled) => typedInvoke(IPC.handle.SET_PINCH_ZOOM_ENABLED, enabled),
  setTitlebar: (theme) => typedInvoke(IPC.handle.SET_TITLEBAR, theme),
  runDesktopMenuAction: (action) => typedInvoke(IPC.handle.RUN_DESKTOP_MENU_ACTION, action),
  runUpdater: (alertOnFail) => typedInvoke(IPC.handle.RUN_UPDATER, alertOnFail),
  checkUpdate: () => typedInvoke(IPC.handle.CHECK_UPDATE),
  installUpdate: () => typedInvoke(IPC.handle.INSTALL_UPDATE),
  setBackgroundColor: (color) => typedInvoke(IPC.handle.SET_BACKGROUND_COLOR, color),
  exportDebugLogs: () => typedInvoke(IPC.handle.EXPORT_DEBUG_LOGS),
  recordFatalRendererError: (error) => typedInvoke(IPC.handle.RECORD_FATAL_RENDERER_ERROR, error),
  getDesktopPluginConfig: () => typedInvoke(IPC.handle.GET_DESKTOP_PLUGIN_CONFIG),
  setDesktopPluginConfig: (configs) => typedInvoke(IPC.handle.SET_DESKTOP_PLUGIN_CONFIG, configs),
  getCustomAgents: () => typedInvoke(IPC.handle.GET_DESKTOP_CUSTOM_AGENTS),
  setCustomAgents: (agents) => typedInvoke(IPC.handle.SET_DESKTOP_CUSTOM_AGENTS, agents),
  deleteCustomAgent: (id) => typedInvoke(IPC.handle.DELETE_DESKTOP_CUSTOM_AGENT, id),
  getMcpServers: () => typedInvoke(IPC.handle.GET_DESKTOP_MCP_SERVERS),
  setMcpServers: (servers) => typedInvoke(IPC.handle.SET_DESKTOP_MCP_SERVERS, servers),
  githubStartOAuth: () => typedInvoke(IPC.handle.GITHUB_OAUTH_START),
  githubOAuthCallback: (code, state) => typedInvoke(IPC.handle.GITHUB_OAUTH_CALLBACK, code, state),
  githubGetToken: () => typedInvoke(IPC.handle.GITHUB_GET_TOKEN),
  githubSetToken: (token) => typedInvoke(IPC.handle.GITHUB_SET_TOKEN, token),
  githubClearToken: () => typedInvoke(IPC.handle.GITHUB_CLEAR_TOKEN),
  githubApiProxy: (url, options) => typedInvoke(IPC.handle.GITHUB_API_PROXY, url, options),
  sessionExportData: (data, opts) => typedInvoke(IPC.handle.SESSION_EXPORT_DATA, data, opts),
  sessionImportFile: (opts) => typedInvoke(IPC.handle.SESSION_IMPORT_FILE, opts),
  setLocalePreference: (locale) => typedInvoke(IPC.handle.SET_LOCALE_PREFERENCE, locale),
  getLocalePreference: () => typedInvoke(IPC.handle.GET_LOCALE_PREFERENCE),

  getSafeModeDiagnostics: () => typedInvoke(IPC.handle.GET_SAFE_MODE_DIAGNOSTICS),
  safeModeAction: (action: SafeModeAction) => typedInvoke(IPC.handle.SAFE_MODE_ACTION, action),

  // --- Send methods (fire-and-forget) ---
  openLink: (url) => typedSend(IPC.send.OPEN_LINK, url),
  showNotification: (title, body) => typedSend(IPC.send.SHOW_NOTIFICATION, title, body),
  relaunch: () => typedSend(IPC.send.RELAUNCH),
  loadingWindowComplete: () => typedSend(IPC.send.LOADING_WINDOW_COMPLETE),

  // --- Complex listener methods (keep ipcRenderer.on) ---
  awaitInitialization: (onStep) => {
    const handler = (_: unknown, step: InitStep) => onStep(step)
    ipcRenderer.on(IPC.push.INIT_STEP, handler)
    return typedInvoke(IPC.handle.AWAIT_INITIALIZATION).finally(() => {
      ipcRenderer.removeListener(IPC.push.INIT_STEP, handler)
    })
  },
  onSqliteMigrationProgress: (cb) => {
    const handler = (_: unknown, progress: SqliteMigrationProgress) => cb(progress)
    ipcRenderer.on(IPC.push.SQLITE_MIGRATION_PROGRESS, handler)
    return () => ipcRenderer.removeListener(IPC.push.SQLITE_MIGRATION_PROGRESS, handler)
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
}

contextBridge.exposeInMainWorld("api", api)
