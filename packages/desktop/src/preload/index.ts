import { contextBridge, ipcRenderer } from "electron"
import type { ElectronAPI, InitStep, SqliteMigrationProgress } from "./types"
import { IPC } from "../main/ipc-channels"

const api: ElectronAPI = {
  killSidecar: () => ipcRenderer.invoke(IPC.handle.KILL_SIDECAR),
  awaitInitialization: (onStep) => {
    const handler = (_: unknown, step: InitStep) => onStep(step)
    ipcRenderer.on(IPC.push.INIT_STEP, handler)
    return ipcRenderer.invoke(IPC.handle.AWAIT_INITIALIZATION).finally(() => {
      ipcRenderer.removeListener(IPC.push.INIT_STEP, handler)
    })
  },
  getWindowConfig: () => ipcRenderer.invoke(IPC.handle.GET_WINDOW_CONFIG),
  consumeInitialDeepLinks: () => ipcRenderer.invoke(IPC.handle.CONSUME_INITIAL_DEEP_LINKS),
  getDefaultServerUrl: () => ipcRenderer.invoke(IPC.handle.GET_DEFAULT_SERVER_URL),
  setDefaultServerUrl: (url) => ipcRenderer.invoke(IPC.handle.SET_DEFAULT_SERVER_URL, url),
  getWslConfig: () => ipcRenderer.invoke(IPC.handle.GET_WSL_CONFIG),
  setWslConfig: (config) => ipcRenderer.invoke(IPC.handle.SET_WSL_CONFIG, config),
  getDisplayBackend: () => ipcRenderer.invoke(IPC.handle.GET_DISPLAY_BACKEND),
  setDisplayBackend: (backend) => ipcRenderer.invoke(IPC.handle.SET_DISPLAY_BACKEND, backend),
  parseMarkdownCommand: (markdown) => ipcRenderer.invoke(IPC.handle.PARSE_MARKDOWN, markdown),
  checkAppExists: (appName) => ipcRenderer.invoke(IPC.handle.CHECK_APP_EXISTS, appName),
  wslPath: (path, mode) => ipcRenderer.invoke(IPC.handle.WSL_PATH, path, mode),
  resolveAppPath: (appName) => ipcRenderer.invoke(IPC.handle.RESOLVE_APP_PATH, appName),
  storeGet: (name, key) => ipcRenderer.invoke(IPC.handle.STORE_GET, name, key),
  storeSet: (name, key, value) => ipcRenderer.invoke(IPC.handle.STORE_SET, name, key, value),
  storeDelete: (name, key) => ipcRenderer.invoke(IPC.handle.STORE_DELETE, name, key),
  storeClear: (name) => ipcRenderer.invoke(IPC.handle.STORE_CLEAR, name),
  storeKeys: (name) => ipcRenderer.invoke(IPC.handle.STORE_KEYS, name),
  storeLength: (name) => ipcRenderer.invoke(IPC.handle.STORE_LENGTH, name),

  getWindowCount: () => ipcRenderer.invoke(IPC.handle.GET_WINDOW_COUNT),
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

  openDirectoryPicker: (opts) => ipcRenderer.invoke(IPC.handle.OPEN_DIRECTORY_PICKER, opts),
  openFilePicker: (opts) => ipcRenderer.invoke(IPC.handle.OPEN_FILE_PICKER, opts),
  saveFilePicker: (opts) => ipcRenderer.invoke(IPC.handle.SAVE_FILE_PICKER, opts),
  openLink: (url) => ipcRenderer.send(IPC.send.OPEN_LINK, url),
  openPath: (path, app) => ipcRenderer.invoke(IPC.handle.OPEN_PATH, path, app),
  readClipboardImage: () => ipcRenderer.invoke(IPC.handle.READ_CLIPBOARD_IMAGE),
  showNotification: (title, body) => ipcRenderer.send(IPC.send.SHOW_NOTIFICATION, title, body),
  getWindowFocused: () => ipcRenderer.invoke(IPC.handle.GET_WINDOW_FOCUSED),
  setWindowFocus: () => ipcRenderer.invoke(IPC.handle.SET_WINDOW_FOCUS),
  showWindow: () => ipcRenderer.invoke(IPC.handle.SHOW_WINDOW),
  relaunch: () => ipcRenderer.send(IPC.send.RELAUNCH),
  getZoomFactor: () => ipcRenderer.invoke(IPC.handle.GET_ZOOM_FACTOR),
  setZoomFactor: (factor) => ipcRenderer.invoke(IPC.handle.SET_ZOOM_FACTOR, factor),
  getPinchZoomEnabled: () => ipcRenderer.invoke(IPC.handle.GET_PINCH_ZOOM_ENABLED),
  setPinchZoomEnabled: (enabled) => ipcRenderer.invoke(IPC.handle.SET_PINCH_ZOOM_ENABLED, enabled),
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
  setTitlebar: (theme) => ipcRenderer.invoke(IPC.handle.SET_TITLEBAR, theme),
  runDesktopMenuAction: (action) => ipcRenderer.invoke(IPC.handle.RUN_DESKTOP_MENU_ACTION, action),
  loadingWindowComplete: () => ipcRenderer.send(IPC.send.LOADING_WINDOW_COMPLETE),
  runUpdater: (alertOnFail) => ipcRenderer.invoke(IPC.handle.RUN_UPDATER, alertOnFail),
  checkUpdate: () => ipcRenderer.invoke(IPC.handle.CHECK_UPDATE),
  installUpdate: () => ipcRenderer.invoke(IPC.handle.INSTALL_UPDATE),
  setBackgroundColor: (color: string) => ipcRenderer.invoke(IPC.handle.SET_BACKGROUND_COLOR, color),
  exportDebugLogs: () => ipcRenderer.invoke(IPC.handle.EXPORT_DEBUG_LOGS),
  recordFatalRendererError: (error) => ipcRenderer.invoke(IPC.handle.RECORD_FATAL_RENDERER_ERROR, error),
  getDesktopPluginConfig: () => ipcRenderer.invoke(IPC.handle.GET_DESKTOP_PLUGIN_CONFIG),
  setDesktopPluginConfig: (configs) => ipcRenderer.invoke(IPC.handle.SET_DESKTOP_PLUGIN_CONFIG, configs),
  getCustomAgents: () => ipcRenderer.invoke(IPC.handle.GET_DESKTOP_CUSTOM_AGENTS),
  setCustomAgents: (agents) => ipcRenderer.invoke(IPC.handle.SET_DESKTOP_CUSTOM_AGENTS, agents),
  deleteCustomAgent: (id) => ipcRenderer.invoke(IPC.handle.DELETE_DESKTOP_CUSTOM_AGENT, id),
  getMcpServers: () => ipcRenderer.invoke(IPC.handle.GET_DESKTOP_MCP_SERVERS),
  setMcpServers: (servers) => ipcRenderer.invoke(IPC.handle.SET_DESKTOP_MCP_SERVERS, servers),
  githubStartOAuth: () => ipcRenderer.invoke(IPC.handle.GITHUB_OAUTH_START),
  githubOAuthCallback: (code, state) => ipcRenderer.invoke(IPC.handle.GITHUB_OAUTH_CALLBACK, code, state),
  githubGetToken: () => ipcRenderer.invoke(IPC.handle.GITHUB_GET_TOKEN),
  githubSetToken: (token) => ipcRenderer.invoke(IPC.handle.GITHUB_SET_TOKEN, token),
  githubClearToken: () => ipcRenderer.invoke(IPC.handle.GITHUB_CLEAR_TOKEN),
  githubApiProxy: (url, options) => ipcRenderer.invoke(IPC.handle.GITHUB_API_PROXY, url, options),
  sessionExportData: (data, opts) => ipcRenderer.invoke(IPC.handle.SESSION_EXPORT_DATA, data, opts),
  sessionImportFile: (opts) => ipcRenderer.invoke(IPC.handle.SESSION_IMPORT_FILE, opts),
  setLocalePreference: (locale) => ipcRenderer.invoke(IPC.handle.SET_LOCALE_PREFERENCE, locale),
  getLocalePreference: () => ipcRenderer.invoke(IPC.handle.GET_LOCALE_PREFERENCE),
}

contextBridge.exposeInMainWorld("api", api)
