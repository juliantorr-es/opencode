import { ipcMain } from "electron"
import type { IpcMainInvokeEvent } from "electron"
import { IPC } from "./ipc-channels"
import { withIpcResult } from "./ipc-contract"
import type {
  InitStep,
  FatalRendererError,
  SafeModeAction,
  SafeModeDiagnostics,
  ServerReadyData,
  WindowConfig,
  WslConfig,
} from "../preload/types"

export type Deps = {
  killSidecar: () => Promise<void> | void
  awaitInitialization: (sendStep: (step: InitStep) => void) => Promise<ServerReadyData>
  getWindowConfig: () => Promise<WindowConfig> | WindowConfig
  consumeInitialDeepLinks: () => Promise<string[]> | string[]
  getDefaultServerUrl: () => Promise<string | null> | string | null
  setDefaultServerUrl: (url: string | null) => Promise<void> | void
  getWslConfig: () => Promise<WslConfig>
  setWslConfig: (config: WslConfig) => Promise<void> | void
  getDisplayBackend: () => Promise<string | null>
  setDisplayBackend: (backend: string | null) => Promise<void> | void
  parseMarkdown: (markdown: string) => Promise<string> | string
  checkAppExists: (appName: string) => Promise<boolean> | boolean
  wslPath: (path: string, mode: "windows" | "linux" | null) => Promise<string>
  resolveAppPath: (appName: string) => Promise<string | null>
  loadingWindowComplete: () => void
  runUpdater: (alertOnFail: boolean) => Promise<void> | void
  checkUpdate: () => Promise<{ updateAvailable: boolean; version?: string }>
  installUpdate: () => Promise<void> | void
  setBackgroundColor: (color: string) => void
  exportDebugLogs: () => Promise<string>
  recordFatalRendererError: (error: FatalRendererError) => Promise<void> | void

  getSafeModeDiagnostics: () => Promise<SafeModeDiagnostics>
  safeModeAction: (action: SafeModeAction) => Promise<void>
}

/**
 * Register IPC handlers that delegate through the `deps` object.
 * These are thin wrappers — the actual logic lives in index.ts
 * and its dependencies.
 */
export function registerInitIpcHandlers(deps: Deps) {
  ipcMain.handle(IPC.handle.KILL_SIDECAR, () => {
    return withIpcResult("init.killSidecar", async () => deps.killSidecar())
  })

  ipcMain.handle(IPC.handle.AWAIT_INITIALIZATION, (event: IpcMainInvokeEvent) => {
    return withIpcResult("init.awaitInitialization", async () => {
      const send = (step: InitStep) => event.sender.send(IPC.push.INIT_STEP, step)
      return deps.awaitInitialization(send)
    })
  })
  ipcMain.handle(IPC.handle.GET_WINDOW_CONFIG, () => {
    return withIpcResult("init.getWindowConfig", async () => deps.getWindowConfig())
  })
  ipcMain.handle(IPC.handle.CONSUME_INITIAL_DEEP_LINKS, () => {
    return withIpcResult("init.consumeInitialDeepLinks", async () => deps.consumeInitialDeepLinks())
  })
  ipcMain.handle(IPC.handle.GET_DEFAULT_SERVER_URL, () => {
    return withIpcResult("init.getDefaultServerUrl", async () => deps.getDefaultServerUrl())
  })
  ipcMain.handle(IPC.handle.SET_DEFAULT_SERVER_URL, (_event: IpcMainInvokeEvent, url: string | null) => {
    return withIpcResult("init.setDefaultServerUrl", async () => deps.setDefaultServerUrl(url))
  })
  ipcMain.handle(IPC.handle.GET_WSL_CONFIG, () => {
    return withIpcResult("init.getWslConfig", async () => deps.getWslConfig())
  })
  ipcMain.handle(IPC.handle.SET_WSL_CONFIG, (_event: IpcMainInvokeEvent, config: WslConfig) => {
    return withIpcResult("init.setWslConfig", async () => deps.setWslConfig(config))
  })
  ipcMain.handle(IPC.handle.GET_DISPLAY_BACKEND, () => {
    return withIpcResult("init.getDisplayBackend", async () => deps.getDisplayBackend())
  })
  ipcMain.handle(IPC.handle.SET_DISPLAY_BACKEND, (_event: IpcMainInvokeEvent, backend: string | null) => {
    return withIpcResult("init.setDisplayBackend", async () => deps.setDisplayBackend(backend))
  })
  ipcMain.handle(IPC.handle.PARSE_MARKDOWN, (_event: IpcMainInvokeEvent, markdown: string) => {
    return withIpcResult("init.parseMarkdown", async () => deps.parseMarkdown(markdown))
  })
  ipcMain.handle(IPC.handle.CHECK_APP_EXISTS, (_event: IpcMainInvokeEvent, appName: string) => {
    return withIpcResult("init.checkAppExists", async () => deps.checkAppExists(appName))
  })
  ipcMain.handle(IPC.handle.WSL_PATH, (_event: IpcMainInvokeEvent, path: string, mode: "windows" | "linux" | null) => {
    return withIpcResult("init.wslPath", async () => deps.wslPath(path, mode))
  })
  ipcMain.handle(IPC.handle.RESOLVE_APP_PATH, (_event: IpcMainInvokeEvent, appName: string) => {
    return withIpcResult("init.resolveAppPath", async () => deps.resolveAppPath(appName))
  })
  ipcMain.on(IPC.send.LOADING_WINDOW_COMPLETE, () => deps.loadingWindowComplete())
  ipcMain.handle(IPC.handle.RUN_UPDATER, (_event: IpcMainInvokeEvent, alertOnFail: boolean) => {
    return withIpcResult("init.runUpdater", async () => deps.runUpdater(alertOnFail))
  })
  ipcMain.handle(IPC.handle.CHECK_UPDATE, () => {
    return withIpcResult("init.checkUpdate", async () => deps.checkUpdate())
  })
  ipcMain.handle(IPC.handle.INSTALL_UPDATE, () => {
    return withIpcResult("init.installUpdate", async () => deps.installUpdate())
  })
  ipcMain.handle(IPC.handle.SET_BACKGROUND_COLOR, (_event: IpcMainInvokeEvent, color: string) => {
    return withIpcResult("init.setBackgroundColor", async () => deps.setBackgroundColor(color))
  })
  ipcMain.handle(IPC.handle.EXPORT_DEBUG_LOGS, () => {
    return withIpcResult("init.exportDebugLogs", async () => deps.exportDebugLogs())
  })
  ipcMain.handle(IPC.handle.RECORD_FATAL_RENDERER_ERROR, (_event: IpcMainInvokeEvent, error: FatalRendererError) => {
    return withIpcResult("init.recordFatalRendererError", async () => deps.recordFatalRendererError(error))
  })

  ipcMain.handle(IPC.handle.GET_SAFE_MODE_DIAGNOSTICS, () => {
    return withIpcResult("init.getSafeModeDiagnostics", async () => deps.getSafeModeDiagnostics())
  })
  ipcMain.handle(IPC.handle.SAFE_MODE_ACTION, (_event: IpcMainInvokeEvent, action: SafeModeAction) => {
    return withIpcResult("init.safeModeAction", async () => deps.safeModeAction(action))
  })
}
