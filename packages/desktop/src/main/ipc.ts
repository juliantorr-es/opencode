import { execFile } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"
import { BrowserWindow, Notification, app, clipboard, dialog, ipcMain, shell, safeStorage, net } from "electron"
import type { IpcMainEvent, IpcMainInvokeEvent } from "electron"
import type { DesktopMenuAction } from "@opencode-ai/app/desktop-menu"

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
import { getPinchZoomEnabled, setPinchZoomEnabled, setTitlebar, updateTitlebar } from "./windows"

import crypto from "node:crypto"

const GITHUB_CLIENT_ID = "Iv23li7XUy0RKw5TlZ3K"
const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token"

type PkceState = {
  code_verifier: string
  state: string
}

const pendingOAuth = new Map<string, PkceState>()

function generateCodeVerifier(): string {
  return crypto.randomBytes(32).toString("base64url")
}

async function generateCodeChallenge(verifier: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))
  return Buffer.from(hash).toString("base64url")
}

function encryptToken(plaintext: string): string {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error("System keychain not available — cannot encrypt token")
  }
  return safeStorage.encryptString(plaintext).toString("base64")
}

function decryptToken(encoded: string): string {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error("System keychain not available — cannot decrypt token")
  }
  return safeStorage.decryptString(Buffer.from(encoded, "base64"))
}

const RESERVED_STORE_NAMES = ["desktop-custom-agents", "desktop-mcp-servers", "desktop-plugin-config", "github-auth"]

function isValidAgentDef(val: unknown): val is Record<string, unknown> {
  if (typeof val !== "object" || val === null) return false
  const obj = val as Record<string, unknown>
  return typeof obj.id === "string" && typeof obj.name === "string" && typeof obj.prompt === "string"
}

function validateAndFilterAgents(raw: unknown): unknown[] {
  if (!Array.isArray(raw)) return []
  return raw.filter((item): item is Record<string, unknown> => {
    if (isValidAgentDef(item)) return true
    console.warn("Dropping invalid agent entry:", item)
    return false
  })
}

function isValidMcpEntry(val: unknown): val is Record<string, unknown> {
  if (typeof val !== "object" || val === null) return false
  const obj = val as Record<string, unknown>
  if (typeof obj.name !== "string") return false
  const config = obj.config as Record<string, unknown> | undefined
  if (!config || typeof config !== "object") return false
  if (config.type === "local" && !Array.isArray(config.command)) return false
  if (config.type === "remote" && typeof config.url !== "string") return false
  return config.type === "local" || config.type === "remote"
}

function isValidPluginConfigEntry(val: unknown): val is Record<string, unknown> {
  if (typeof val !== "object" || val === null) return false
  const obj = val as Record<string, unknown>
  return typeof obj.name === "string" && typeof obj.path === "string" && typeof obj.enabled === "boolean"
}

function validateAndFilterPluginConfigs(raw: unknown): { configs: unknown[]; dropped: number } {
  if (!Array.isArray(raw)) return { configs: [], dropped: 0 }
  const original = raw.length
  const configs = raw.filter((item): item is Record<string, unknown> => {
    if (isValidPluginConfigEntry(item)) return true
    console.warn("Dropping invalid plugin config entry:", item)
    return false
  })
  return { configs, dropped: original - configs.length }
}

function validateAndFilterMcpServers(raw: unknown): unknown[] {
  if (!Array.isArray(raw)) return []
  return raw.filter((item): item is Record<string, unknown> => {
    if (isValidMcpEntry(item)) return true
    console.warn("Dropping invalid MCP server entry:", item)
    return false
  })
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
  ipcMain.handle("kill-sidecar", () => deps.killSidecar())

  ipcMain.handle("await-initialization", (event: IpcMainInvokeEvent) => {
    const send = (step: InitStep) => event.sender.send("init-step", step)
    return deps.awaitInitialization(send)
  })
  ipcMain.handle("get-window-config", () => deps.getWindowConfig())
  ipcMain.handle("consume-initial-deep-links", () => deps.consumeInitialDeepLinks())
  ipcMain.handle("get-default-server-url", () => deps.getDefaultServerUrl())
  ipcMain.handle("set-default-server-url", (_event: IpcMainInvokeEvent, url: string | null) =>
    deps.setDefaultServerUrl(url),
  )
  ipcMain.handle("get-wsl-config", () => deps.getWslConfig())
  ipcMain.handle("set-wsl-config", (_event: IpcMainInvokeEvent, config: WslConfig) => deps.setWslConfig(config))
  ipcMain.handle("get-display-backend", () => deps.getDisplayBackend())
  ipcMain.handle("set-display-backend", (_event: IpcMainInvokeEvent, backend: string | null) =>
    deps.setDisplayBackend(backend),
  )
  ipcMain.handle("parse-markdown", (_event: IpcMainInvokeEvent, markdown: string) => deps.parseMarkdown(markdown))
  ipcMain.handle("check-app-exists", (_event: IpcMainInvokeEvent, appName: string) => deps.checkAppExists(appName))
  ipcMain.handle("wsl-path", (_event: IpcMainInvokeEvent, path: string, mode: "windows" | "linux" | null) =>
    deps.wslPath(path, mode),
  )
  ipcMain.handle("resolve-app-path", (_event: IpcMainInvokeEvent, appName: string) => deps.resolveAppPath(appName))
  ipcMain.on("loading-window-complete", () => deps.loadingWindowComplete())
  ipcMain.handle("run-updater", (_event: IpcMainInvokeEvent, alertOnFail: boolean) => deps.runUpdater(alertOnFail))
  ipcMain.handle("check-update", () => deps.checkUpdate())
  ipcMain.handle("install-update", () => deps.installUpdate())
  ipcMain.handle("set-background-color", (_event: IpcMainInvokeEvent, color: string) => deps.setBackgroundColor(color))
  ipcMain.handle("export-debug-logs", () => deps.exportDebugLogs())

  ipcMain.handle(
    "session-export-data",
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
    "session-import-file",
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
  ipcMain.handle("record-fatal-renderer-error", (_event: IpcMainInvokeEvent, error: FatalRendererError) =>
    deps.recordFatalRendererError(error),
  )
  ipcMain.handle("store-get", (_event: IpcMainInvokeEvent, name: string, key: string) => {
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
  ipcMain.handle("store-set", (_event: IpcMainInvokeEvent, name: string, key: string, value: string) => {
    if (RESERVED_STORE_NAMES.includes(name)) throw new Error(`Access denied: '${name}' is a reserved store namespace`)
    getStore(name).set(key, value)
  })
  ipcMain.handle("store-delete", (_event: IpcMainInvokeEvent, name: string, key: string) => {
    if (RESERVED_STORE_NAMES.includes(name)) throw new Error(`Access denied: '${name}' is a reserved store namespace`)
    getStore(name).delete(key)
  })
  ipcMain.handle("store-clear", (_event: IpcMainInvokeEvent, name: string) => {
    if (RESERVED_STORE_NAMES.includes(name)) throw new Error(`Access denied: '${name}' is a reserved store namespace`)
    getStore(name).clear()
  })
  ipcMain.handle("store-keys", (_event: IpcMainInvokeEvent, name: string) => {
    const store = getStore(name)
    return Object.keys(store.store)
  })
  ipcMain.handle("store-length", (_event: IpcMainInvokeEvent, name: string) => {
    const store = getStore(name)
    return Object.keys(store.store).length
  })

  ipcMain.handle(
    "open-directory-picker",
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
    "open-file-picker",
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
    "save-file-picker",
    async (_event: IpcMainInvokeEvent, opts?: { title?: string; defaultPath?: string }) => {
      const result = await dialog.showSaveDialog({
        title: opts?.title ?? "Save file",
        defaultPath: opts?.defaultPath,
      })
      if (result.canceled) return null
      return result.filePath ?? null
    },
  )

  ipcMain.on("open-link", (_event: IpcMainEvent, url: string) => {
    void shell.openExternal(url)
  })

  ipcMain.handle("open-path", async (_event: IpcMainInvokeEvent, path: string, app?: string) => {
    if (!app) return shell.openPath(path)
    await new Promise<void>((resolve, reject) => {
      const [cmd, args] =
        process.platform === "darwin" ? (["open", ["-a", app, path]] as const) : ([app, [path]] as const)
      execFile(cmd, args, (err) => (err ? reject(err) : resolve()))
    })
  })

  ipcMain.handle("read-clipboard-image", () => {
    const image = clipboard.readImage()
    if (image.isEmpty()) return null
    const buffer = image.toPNG().buffer
    const size = image.getSize()
    return { buffer, width: size.width, height: size.height }
  })

  ipcMain.on("show-notification", (_event: IpcMainEvent, title: string, body?: string) => {
    new Notification({ title, body }).show()
  })

  ipcMain.handle("get-window-count", () => BrowserWindow.getAllWindows().length)

  ipcMain.handle("get-window-focused", (event: IpcMainInvokeEvent) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    return win?.isFocused() ?? false
  })

  ipcMain.handle("set-window-focus", (event: IpcMainInvokeEvent) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    win?.focus()
  })

  ipcMain.handle("show-window", (event: IpcMainInvokeEvent) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    win?.show()
  })

  ipcMain.on("relaunch", () => {
    app.relaunch()
    app.exit(0)
  })

  ipcMain.handle("get-zoom-factor", (event: IpcMainInvokeEvent) => event.sender.getZoomFactor())
  ipcMain.handle("set-zoom-factor", (event: IpcMainInvokeEvent, factor: number) => {
    event.sender.setZoomFactor(factor)
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return
    updateTitlebar(win)
  })
  ipcMain.handle("get-pinch-zoom-enabled", () => getPinchZoomEnabled())
  ipcMain.handle("set-pinch-zoom-enabled", (_event: IpcMainInvokeEvent, enabled: boolean) => {
    setPinchZoomEnabled(enabled)
  })
  ipcMain.handle("set-titlebar", (event: IpcMainInvokeEvent, theme: TitlebarTheme) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return
    setTitlebar(win, theme)
  })
  ipcMain.handle("run-desktop-menu-action", (event: IpcMainInvokeEvent, action: DesktopMenuAction) => {
    runDesktopMenuAction(BrowserWindow.fromWebContents(event.sender), action)
  })

  ipcMain.handle("get-desktop-custom-agents", () => {
    const store = getStore("desktop-custom-agents")
    return validateAndFilterAgents(store.get("agents"))
  })
  ipcMain.handle("set-desktop-custom-agents", (_event: IpcMainInvokeEvent, agents: unknown[]) => {
    const store = getStore("desktop-custom-agents")
    store.set("agents", validateAndFilterAgents(agents))
  })

  ipcMain.handle("get-desktop-mcp-servers", () => {
    const store = getStore("desktop-mcp-servers")
    return validateAndFilterMcpServers(store.get("servers"))
  })
  ipcMain.handle("set-desktop-mcp-servers", (_event: IpcMainInvokeEvent, servers: unknown[]) => {
    const store = getStore("desktop-mcp-servers")
    store.set("servers", validateAndFilterMcpServers(servers))
  })

  ipcMain.handle("get-desktop-plugin-config", () => {
    const store = getStore("desktop-plugin-config")
    return validateAndFilterPluginConfigs(store.get("configs"))
  })
  ipcMain.handle("set-desktop-plugin-config", (_event: IpcMainInvokeEvent, configs: unknown[]) => {
    const store = getStore("desktop-plugin-config")
    const result = validateAndFilterPluginConfigs(configs)
    store.set("configs", result.configs)
    return result
  })

  ipcMain.handle("github-oauth-start", async () => {
    const code_verifier = generateCodeVerifier()
    const code_challenge = await generateCodeChallenge(code_verifier)
    const state = crypto.randomBytes(16).toString("base64url")
    const id = crypto.randomUUID()
    pendingOAuth.set(id, { code_verifier, state })

    const params = new URLSearchParams({
      client_id: GITHUB_CLIENT_ID,
      redirect_uri: "opencode://github-oauth",
      scope: "repo,user",
      state,
      code_challenge,
      code_challenge_method: "S256",
    })
    const authorizeUrl = `https://github.com/login/oauth/authorize?${params.toString()}`
    await shell.openExternal(authorizeUrl)
    return id
  })

  ipcMain.handle("github-oauth-callback", async (_event, code: string, state: string) => {
    let foundId: string | undefined
    for (const [id, pkce] of pendingOAuth) {
      if (pkce.state === state) {
        foundId = id
        break
      }
    }
    if (!foundId) throw new Error("OAuth state mismatch — possible CSRF")
    const { code_verifier } = pendingOAuth.get(foundId)!
    pendingOAuth.delete(foundId)

    const body = new URLSearchParams({
      client_id: GITHUB_CLIENT_ID,
      code,
      code_verifier,
      redirect_uri: "opencode://github-oauth",
    })
    const response = await net.fetch(GITHUB_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: body.toString(),
    })
    const data = (await response.json()) as { access_token?: string; error?: string }
    if (!data.access_token) throw new Error(`GitHub OAuth error: ${data.error ?? "unknown"}`)
    const store = getStore("github-auth")
    store.set("access_token", encryptToken(data.access_token))
    return true
  })

  ipcMain.handle("github-get-token", () => {
    const store = getStore("github-auth")
    const encoded = store.get("access_token") as string | undefined
    if (!encoded) return null
    try {
      return decryptToken(encoded)
    } catch {
      store.delete("access_token")
      return null
    }
  })

  ipcMain.handle("github-set-token", (_event, token: string) => {
    if (typeof token !== "string" || !token) throw new Error("Invalid token")
    const store = getStore("github-auth")
    store.set("access_token", encryptToken(token))
  })

  ipcMain.handle("github-clear-token", () => {
    const store = getStore("github-auth")
    store.delete("access_token")
  })

  const ALLOWED_GITHUB_HOSTNAMES = ["api.github.com", "uploads.github.com"]

  ipcMain.handle("github-api-proxy", async (_event, url: string, options?: { method?: string; headers?: Record<string, string>; body?: string }) => {
    if (typeof url !== "string" || !URL.canParse(url)) {
      throw new Error(JSON.stringify({ type: "GitHubProxyError", hostname: null, allowedHostnames: ALLOWED_GITHUB_HOSTNAMES, message: "Invalid URL" }))
    }
    const parsed = new URL(url)
    if (!ALLOWED_GITHUB_HOSTNAMES.includes(parsed.hostname)) {
      throw new Error(JSON.stringify({ type: "GitHubProxyError", hostname: parsed.hostname, allowedHostnames: ALLOWED_GITHUB_HOSTNAMES, message: `Hostname not allowed: ${parsed.hostname}` }))
    }

    const store = getStore("github-auth")
    const encoded = store.get("access_token") as string | undefined
    if (!encoded) {
      throw new Error("Not authenticated with GitHub")
    }
    const token = decryptToken(encoded)

    const method = options?.method ?? "GET"
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "opencode-desktop",
      ...options?.headers,
    }
    const response = await net.fetch(url, { method, headers, body: options?.body })
    const body = await response.text()
    return { status: response.status, body }
  })
}

export function sendSqliteMigrationProgress(win: BrowserWindow, progress: SqliteMigrationProgress) {
  win.webContents.send("sqlite-migration-progress", progress)
}

export function sendMenuCommand(win: BrowserWindow, id: string) {
  win.webContents.send("menu-command", id)
}

export function sendDeepLinks(win: BrowserWindow, urls: string[]) {
  win.webContents.send("deep-link", urls)
}
