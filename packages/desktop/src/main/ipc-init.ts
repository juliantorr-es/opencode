import { app, ipcMain } from "electron"
import type { IpcMainInvokeEvent } from "electron"
import { registerIpcHandler } from "./ipc-registration"
import * as path from "node:path"
import { existsSync } from "node:fs"
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
  registerIpcHandler(IPC.handle.KILL_SIDECAR, () => {
    return withIpcResult("init.killSidecar", async () => deps.killSidecar())
  })

  registerIpcHandler(IPC.handle.AWAIT_INITIALIZATION, (event: IpcMainInvokeEvent) => {
    return withIpcResult("init.awaitInitialization", async () => {
      const send = (step: InitStep) => event.sender.send(IPC.push.INIT_STEP, step)
      return deps.awaitInitialization(send)
    })
  })
  registerIpcHandler(IPC.handle.GET_WINDOW_CONFIG, () => {
    return withIpcResult("init.getWindowConfig", async () => deps.getWindowConfig())
  })
  registerIpcHandler(IPC.handle.CONSUME_INITIAL_DEEP_LINKS, () => {
    return withIpcResult("init.consumeInitialDeepLinks", async () => deps.consumeInitialDeepLinks())
  })
  registerIpcHandler(IPC.handle.GET_DEFAULT_SERVER_URL, () => {
    return withIpcResult("init.getDefaultServerUrl", async () => deps.getDefaultServerUrl())
  })
  registerIpcHandler(IPC.handle.SET_DEFAULT_SERVER_URL, (_event: IpcMainInvokeEvent, url: string | null) => {
    return withIpcResult("init.setDefaultServerUrl", async () => deps.setDefaultServerUrl(url))
  })
  registerIpcHandler(IPC.handle.GET_WSL_CONFIG, () => {
    return withIpcResult("init.getWslConfig", async () => deps.getWslConfig())
  })
  registerIpcHandler(IPC.handle.SET_WSL_CONFIG, (_event: IpcMainInvokeEvent, config: WslConfig) => {
    return withIpcResult("init.setWslConfig", async () => deps.setWslConfig(config))
  })
  registerIpcHandler(IPC.handle.GET_DISPLAY_BACKEND, () => {
    return withIpcResult("init.getDisplayBackend", async () => deps.getDisplayBackend())
  })
  registerIpcHandler(IPC.handle.SET_DISPLAY_BACKEND, (_event: IpcMainInvokeEvent, backend: string | null) => {
    return withIpcResult("init.setDisplayBackend", async () => deps.setDisplayBackend(backend))
  })
  registerIpcHandler(IPC.handle.PARSE_MARKDOWN, (_event: IpcMainInvokeEvent, markdown: string) => {
    return withIpcResult("init.parseMarkdown", async () => deps.parseMarkdown(markdown))
  })
  registerIpcHandler(IPC.handle.CHECK_APP_EXISTS, (_event: IpcMainInvokeEvent, appName: string) => {
    return withIpcResult("init.checkAppExists", async () => deps.checkAppExists(appName))
  })
  registerIpcHandler(IPC.handle.WSL_PATH, (_event: IpcMainInvokeEvent, path: string, mode: "windows" | "linux" | null) => {
    return withIpcResult("init.wslPath", async () => deps.wslPath(path, mode))
  })
  registerIpcHandler(IPC.handle.RESOLVE_APP_PATH, (_event: IpcMainInvokeEvent, appName: string) => {
    return withIpcResult("init.resolveAppPath", async () => deps.resolveAppPath(appName))
  })
  ipcMain.on(IPC.send.LOADING_WINDOW_COMPLETE, () => deps.loadingWindowComplete())
  registerIpcHandler(IPC.handle.RUN_UPDATER, (_event: IpcMainInvokeEvent, alertOnFail: boolean) => {
    return withIpcResult("init.runUpdater", async () => deps.runUpdater(alertOnFail))
  })
  registerIpcHandler(IPC.handle.CHECK_UPDATE, () => {
    return withIpcResult("init.checkUpdate", async () => deps.checkUpdate())
  })
  registerIpcHandler(IPC.handle.INSTALL_UPDATE, () => {
    return withIpcResult("init.installUpdate", async () => deps.installUpdate())
  })
  registerIpcHandler(IPC.handle.SET_BACKGROUND_COLOR, (_event: IpcMainInvokeEvent, color: string) => {
    return withIpcResult("init.setBackgroundColor", async () => deps.setBackgroundColor(color))
  })
  registerIpcHandler(IPC.handle.EXPORT_DEBUG_LOGS, () => {
    return withIpcResult("init.exportDebugLogs", async () => deps.exportDebugLogs())
  })
  registerIpcHandler(IPC.handle.RECORD_FATAL_RENDERER_ERROR, (_event: IpcMainInvokeEvent, error: FatalRendererError) => {
    return withIpcResult("init.recordFatalRendererError", async () => deps.recordFatalRendererError(error))
  })

  registerIpcHandler(IPC.handle.GET_SAFE_MODE_DIAGNOSTICS, () => {
    return withIpcResult("init.getSafeModeDiagnostics", async () => deps.getSafeModeDiagnostics())
  })
  registerIpcHandler(IPC.handle.SAFE_MODE_ACTION, (_event: IpcMainInvokeEvent, action: SafeModeAction) => {
    return withIpcResult("init.safeModeAction", async () => deps.safeModeAction(action))
  })

  registerIpcHandler(IPC.handle.OPEN_PROJECT, async (_event: IpcMainInvokeEvent, directory: string) => {
    return withIpcResult("project.open", async () => {
      const resolved = path.resolve(directory)
      if (!existsSync(resolved)) {
        throw new Error(`Directory not found: ${resolved}`)
      }
      const userData = app.getPath("userData")
      if (userData && (resolved === userData || resolved.startsWith(userData + path.sep))) {
        console.warn(
          `[project.open] Directory resolves inside app data directory (userData). ` +
            `This may indicate the user selected the app-data directory instead of a project: ${resolved}`,
        )
      }
      return resolved
    })
  })
}
