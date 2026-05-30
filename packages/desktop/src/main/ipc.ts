import { execFile } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"
import { BrowserWindow, Notification, app, clipboard, dialog, ipcMain, shell } from "electron"
import type { IpcMainEvent, IpcMainInvokeEvent } from "electron"
import type { DesktopMenuAction } from "@opencode-ai/app/desktop-menu"
import { IPC } from "./ipc-channels"

import type {
  InitStep,
  FatalRendererError,
  ServerReadyData,
  SqliteMigrationProgress,
  TitlebarTheme,
  WindowConfig,
  WslConfig,
} from "../preload/types"

import { runDesktopMenuAction } from "./desktop-menu-actions"
import { getStore } from "./store"
import { registerGithubIpcHandlers } from "./github-ipc"
import { getPinchZoomEnabled, setPinchZoomEnabled, setTitlebar, updateTitlebar } from "./windows"
import {
  validateAndFilterAgents,
  validateAndFilterMcpServers,
  validateAndFilterPluginConfigs,
} from "./ipc-validation"

const RESERVED_STORE_NAMES: readonly string[] = [IPC.store.DESKTOP_CUSTOM_AGENTS, IPC.store.DESKTOP_MCP_SERVERS, IPC.store.DESKTOP_PLUGIN_CONFIG, IPC.store.GITHUB_AUTH]

const writeQueues = new Map<string, Promise<unknown>>()
let storedLocale: string | null = null

export function getStoredLocale(): string | null {
  return storedLocale
}

function serializedWrite<T = void>(namespace: string, fn: () => T): Promise<T> {
  const prev = writeQueues.get(namespace) ?? Promise.resolve(undefined as unknown as T)
  const next = prev.then(() => fn()).catch((err) => {
    console.error(`Write queue error for "${namespace}":`, err)
    throw err
  })
  writeQueues.set(namespace, next)
  return next
}

const pickerFilters = (ext?: string[]) => {
  if (!ext || ext.length === 0) return undefined
  return [{ name: "Files", extensions: ext }]
}

type Deps = {
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
}

export function registerIpcHandlers(deps: Deps) {
  ipcMain.handle(IPC.handle.KILL_SIDECAR, () => deps.killSidecar())

  ipcMain.handle(IPC.handle.AWAIT_INITIALIZATION, (event: IpcMainInvokeEvent) => {
    const send = (step: InitStep) => event.sender.send(IPC.push.INIT_STEP, step)
    return deps.awaitInitialization(send)
  })
  ipcMain.handle(IPC.handle.GET_WINDOW_CONFIG, () => deps.getWindowConfig())
  ipcMain.handle(IPC.handle.CONSUME_INITIAL_DEEP_LINKS, () => deps.consumeInitialDeepLinks())
  ipcMain.handle(IPC.handle.GET_DEFAULT_SERVER_URL, () => deps.getDefaultServerUrl())
  ipcMain.handle(IPC.handle.SET_DEFAULT_SERVER_URL, (_event: IpcMainInvokeEvent, url: string | null) =>
    deps.setDefaultServerUrl(url),
  )
  ipcMain.handle(IPC.handle.GET_WSL_CONFIG, () => deps.getWslConfig())
  ipcMain.handle(IPC.handle.SET_WSL_CONFIG, (_event: IpcMainInvokeEvent, config: WslConfig) => deps.setWslConfig(config))
  ipcMain.handle(IPC.handle.GET_DISPLAY_BACKEND, () => deps.getDisplayBackend())
  ipcMain.handle(IPC.handle.SET_DISPLAY_BACKEND, (_event: IpcMainInvokeEvent, backend: string | null) =>
    deps.setDisplayBackend(backend),
  )
  ipcMain.handle(IPC.handle.PARSE_MARKDOWN, (_event: IpcMainInvokeEvent, markdown: string) => deps.parseMarkdown(markdown))
  ipcMain.handle(IPC.handle.CHECK_APP_EXISTS, (_event: IpcMainInvokeEvent, appName: string) => deps.checkAppExists(appName))
  ipcMain.handle(IPC.handle.WSL_PATH, (_event: IpcMainInvokeEvent, path: string, mode: "windows" | "linux" | null) =>
    deps.wslPath(path, mode),
  )
  ipcMain.handle(IPC.handle.RESOLVE_APP_PATH, (_event: IpcMainInvokeEvent, appName: string) => deps.resolveAppPath(appName))
  ipcMain.on(IPC.send.LOADING_WINDOW_COMPLETE, () => deps.loadingWindowComplete())
  ipcMain.handle(IPC.handle.RUN_UPDATER, (_event: IpcMainInvokeEvent, alertOnFail: boolean) => deps.runUpdater(alertOnFail))
  ipcMain.handle(IPC.handle.CHECK_UPDATE, () => deps.checkUpdate())
  ipcMain.handle(IPC.handle.INSTALL_UPDATE, () => deps.installUpdate())
  ipcMain.handle(IPC.handle.SET_BACKGROUND_COLOR, (_event: IpcMainInvokeEvent, color: string) => deps.setBackgroundColor(color))
  ipcMain.handle(IPC.handle.EXPORT_DEBUG_LOGS, () => deps.exportDebugLogs())

  ipcMain.handle(
    IPC.handle.SESSION_EXPORT_DATA,
    async (
      _event: IpcMainInvokeEvent,
      data: string,
      opts?: { title?: string; defaultPath?: string; filters?: Array<{ name: string; extensions: string[] }> },
    ) => {
      try {
        const result = await dialog.showSaveDialog({
          title: opts?.title ?? "Export Session",
          defaultPath: opts?.defaultPath,
          filters: opts?.filters,
        })
        if (result.canceled) return null
        writeFileSync(result.filePath!, data, "utf-8")
        return result.filePath
      } catch (e) {
        console.error("session-export-data failed:", e)
        return { error: (e as Error).message }
      }
    },
  )

  ipcMain.handle(
    IPC.handle.SESSION_IMPORT_FILE,
    async (
      _event: IpcMainInvokeEvent,
      opts?: { title?: string; filters?: Array<{ name: string; extensions: string[] }> },
    ) => {
      try {
        const result = await dialog.showOpenDialog({
          title: opts?.title ?? "Import Session",
          filters: opts?.filters,
          properties: ["openFile"],
        })
        if (result.canceled) return null
        const content = readFileSync(result.filePaths[0], "utf-8")
        return content
      } catch (e) {
        console.error("session-import-file failed:", e)
        return { error: (e as Error).message }
      }
    },
  )
  ipcMain.handle(IPC.handle.RECORD_FATAL_RENDERER_ERROR, (_event: IpcMainInvokeEvent, error: FatalRendererError) =>
    deps.recordFatalRendererError(error),
  )
  ipcMain.handle(IPC.handle.STORE_GET, (_event: IpcMainInvokeEvent, name: string, key: string) => {
    if (RESERVED_STORE_NAMES.includes(name)) throw new Error(`Access denied: '${name}' is a reserved store namespace`)
    try {
      const store = getStore(name)
      const value = store.get(key)
      if (value === undefined || value === null) return null
      return typeof value === "string" ? value : JSON.stringify(value)
    } catch {
      return null
    }
  })
  ipcMain.handle(IPC.handle.STORE_SET, (_event: IpcMainInvokeEvent, name: string, key: string, value: string) => {
    if (RESERVED_STORE_NAMES.includes(name)) throw new Error(`Access denied: '${name}' is a reserved store namespace`)
    getStore(name).set(key, value)
  })
  ipcMain.handle(IPC.handle.STORE_DELETE, (_event: IpcMainInvokeEvent, name: string, key: string) => {
    if (RESERVED_STORE_NAMES.includes(name)) throw new Error(`Access denied: '${name}' is a reserved store namespace`)
    getStore(name).delete(key)
  })
  ipcMain.handle(IPC.handle.STORE_CLEAR, (_event: IpcMainInvokeEvent, name: string) => {
    if (RESERVED_STORE_NAMES.includes(name)) throw new Error(`Access denied: '${name}' is a reserved store namespace`)
    getStore(name).clear()
  })
  ipcMain.handle(IPC.handle.STORE_KEYS, (_event: IpcMainInvokeEvent, name: string) => {
    const store = getStore(name)
    return Object.keys(store.store)
  })
  ipcMain.handle(IPC.handle.STORE_LENGTH, (_event: IpcMainInvokeEvent, name: string) => {
    const store = getStore(name)
    return Object.keys(store.store).length
  })

  ipcMain.handle(
    IPC.handle.OPEN_DIRECTORY_PICKER,
    async (_event: IpcMainInvokeEvent, opts?: { multiple?: boolean; title?: string; defaultPath?: string }) => {
      const result = await dialog.showOpenDialog({
        properties: ["openDirectory", ...(opts?.multiple ? ["multiSelections" as const] : []), "createDirectory"],
        title: opts?.title ?? "Choose a folder",
        defaultPath: opts?.defaultPath,
      })
      if (result.canceled) return null
      return opts?.multiple ? result.filePaths : result.filePaths[0]
    },
  )

  ipcMain.handle(
    IPC.handle.OPEN_FILE_PICKER,
    async (
      _event: IpcMainInvokeEvent,
      opts?: { multiple?: boolean; title?: string; defaultPath?: string; accept?: string[]; extensions?: string[] },
    ) => {
      const result = await dialog.showOpenDialog({
        properties: ["openFile", ...(opts?.multiple ? ["multiSelections" as const] : [])],
        title: opts?.title ?? "Choose a file",
        defaultPath: opts?.defaultPath,
        filters: pickerFilters(opts?.extensions),
      })
      if (result.canceled) return null
      return opts?.multiple ? result.filePaths : result.filePaths[0]
    },
  )

  ipcMain.handle(
    IPC.handle.SAVE_FILE_PICKER,
    async (_event: IpcMainInvokeEvent, opts?: { title?: string; defaultPath?: string }) => {
      const result = await dialog.showSaveDialog({
        title: opts?.title ?? "Save file",
        defaultPath: opts?.defaultPath,
      })
      if (result.canceled) return null
      return result.filePath ?? null
    },
  )

  ipcMain.on(IPC.send.OPEN_LINK, (_event: IpcMainEvent, url: string) => {
    void shell.openExternal(url)
  })

  ipcMain.handle(IPC.handle.OPEN_PATH, async (_event: IpcMainInvokeEvent, path: string, app?: string) => {
    if (!app) return shell.openPath(path)
    await new Promise<void>((resolve, reject) => {
      const [cmd, args] =
        process.platform === "darwin" ? (["open", ["-a", app, path]] as const) : ([app, [path]] as const)
      execFile(cmd, args, (err) => (err ? reject(err) : resolve()))
    })
  })

  ipcMain.handle(IPC.handle.READ_CLIPBOARD_IMAGE, () => {
    const image = clipboard.readImage()
    if (image.isEmpty()) return null
    const buffer = image.toPNG().buffer
    const size = image.getSize()
    return { buffer, width: size.width, height: size.height }
  })

  ipcMain.on(IPC.send.SHOW_NOTIFICATION, (_event: IpcMainEvent, title: string, body?: string) => {
    new Notification({ title, body }).show()
  })

  ipcMain.handle(IPC.handle.GET_WINDOW_COUNT, () => BrowserWindow.getAllWindows().length)

  ipcMain.handle(IPC.handle.GET_WINDOW_FOCUSED, (event: IpcMainInvokeEvent) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    return win?.isFocused() ?? false
  })

  ipcMain.handle(IPC.handle.SET_WINDOW_FOCUS, (event: IpcMainInvokeEvent) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    win?.focus()
  })

  ipcMain.handle(IPC.handle.SHOW_WINDOW, (event: IpcMainInvokeEvent) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    win?.show()
  })

  ipcMain.on(IPC.send.RELAUNCH, () => {
    app.relaunch()
    app.exit(0)
  })

  ipcMain.handle(IPC.handle.GET_ZOOM_FACTOR, (event: IpcMainInvokeEvent) => event.sender.getZoomFactor())
  ipcMain.handle(IPC.handle.SET_ZOOM_FACTOR, (event: IpcMainInvokeEvent, factor: number) => {
    event.sender.setZoomFactor(factor)
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return
    updateTitlebar(win)
  })
  ipcMain.handle(IPC.handle.GET_PINCH_ZOOM_ENABLED, () => getPinchZoomEnabled())
  ipcMain.handle(IPC.handle.SET_PINCH_ZOOM_ENABLED, (_event: IpcMainInvokeEvent, enabled: boolean) => {
    setPinchZoomEnabled(enabled)
  })
  ipcMain.handle(IPC.handle.SET_TITLEBAR, (event: IpcMainInvokeEvent, theme: TitlebarTheme) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return
    setTitlebar(win, theme)
  })
  ipcMain.handle(IPC.handle.RUN_DESKTOP_MENU_ACTION, (event: IpcMainInvokeEvent, action: DesktopMenuAction) => {
    runDesktopMenuAction(BrowserWindow.fromWebContents(event.sender), action)
  })

  ipcMain.handle(IPC.handle.GET_DESKTOP_CUSTOM_AGENTS, () => {
    try {
      const store = getStore("desktop-custom-agents")
      return validateAndFilterAgents(store.get("agents"))
    } catch (e) {
      console.error("get-desktop-custom-agents failed:", e)
      throw e
    }
  })
  ipcMain.handle(IPC.handle.SET_DESKTOP_CUSTOM_AGENTS, async (_event: IpcMainInvokeEvent, agents: unknown[]) => {
    try {
      const store = getStore("desktop-custom-agents")
      await serializedWrite("desktop-custom-agents", () => {
        store.set("agents", validateAndFilterAgents(agents))
      })
    } catch (e) {
      console.error("set-desktop-custom-agents failed:", e)
      throw e
    }
  })
  ipcMain.handle(IPC.handle.DELETE_DESKTOP_CUSTOM_AGENT, async (_event: IpcMainInvokeEvent, id: string) => {
    try {
      const store = getStore("desktop-custom-agents")
      await serializedWrite("desktop-custom-agents", () => {
        const agents = validateAndFilterAgents(store.get("agents"))
        store.set("agents", agents.filter((a) => (a as Record<string, unknown>).id !== id))
      })
    } catch (e) {
      console.error("delete-desktop-custom-agent failed:", e)
      throw e
    }
  })

  ipcMain.handle(IPC.handle.GET_DESKTOP_MCP_SERVERS, () => {
    try {
      const store = getStore("desktop-mcp-servers")
      return validateAndFilterMcpServers(store.get("servers"))
    } catch (e) {
      console.error("get-desktop-mcp-servers failed:", e)
      throw e
    }
  })
  ipcMain.handle(IPC.handle.SET_DESKTOP_MCP_SERVERS, async (_event: IpcMainInvokeEvent, servers: unknown[]) => {
    try {
      const store = getStore("desktop-mcp-servers")
      const result = await serializedWrite("desktop-mcp-servers", () => {
        const v = validateAndFilterMcpServers(servers)
        store.set("servers", v.servers)
        return v
      })
      return result
    } catch (e) {
      console.error("set-desktop-mcp-servers failed:", e)
      throw e
    }
  })

  ipcMain.handle(IPC.handle.GET_DESKTOP_PLUGIN_CONFIG, () => {
    try {
      const store = getStore("desktop-plugin-config")
      return validateAndFilterPluginConfigs(store.get("configs"))
    } catch (e) {
      console.error("get-desktop-plugin-config failed:", e)
      throw e
    }
  })
  ipcMain.handle(IPC.handle.SET_DESKTOP_PLUGIN_CONFIG, async (_event: IpcMainInvokeEvent, configs: unknown[]) => {
    try {
      const store = getStore("desktop-plugin-config")
      const result = await serializedWrite("desktop-plugin-config", () => {
        const v = validateAndFilterPluginConfigs(configs)
        store.set("configs", v.configs)
        return v
      })
      return result
    } catch (e) {
      console.error("set-desktop-plugin-config failed:", e)
      throw e
    }
  })

  registerGithubIpcHandlers()

  ipcMain.handle(IPC.handle.SET_LOCALE_PREFERENCE, (_event: IpcMainInvokeEvent, locale: string) => {
    storedLocale = locale
  })
  ipcMain.handle(IPC.handle.GET_LOCALE_PREFERENCE, () => storedLocale)
}

export function sendSqliteMigrationProgress(win: BrowserWindow, progress: SqliteMigrationProgress) {
  win.webContents.send(IPC.push.SQLITE_MIGRATION_PROGRESS, progress)
}

export function sendMenuCommand(win: BrowserWindow, id: string) {
  win.webContents.send(IPC.push.MENU_COMMAND, id)
}

export function sendDeepLinks(win: BrowserWindow, urls: string[]) {
  win.webContents.send(IPC.push.DEEP_LINK, urls)
}
