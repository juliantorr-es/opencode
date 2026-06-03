/**
 * Browser polyfill for the Electron desktop API (`window.api`).
 *
 * When the app runs in Chrome (via Vite dev server), there is no
 * Electron preload script to populate `window.api` with desktop APIs.
 * This module provides a no-op implementation that:
 *
 * 1. Prevents crashes if a code path misses an optional chaining guard
 * 2. Returns sensible defaults (null, empty arrays, etc.) for data methods
 * 3. Logs calls in dev mode for debugging visibility
 * 4. Uses browser-native equivalents where possible
 *
 * Call `installBrowserApi()` once at app startup before the app renders.
 */

const isDev = typeof import.meta !== "undefined" && import.meta.env?.DEV

function debug(name: string, ...args: unknown[]) {
  if (isDev) {
    console.debug(`[browser-api] ${name}`, ...args)
  }
}

function readJsonStorage<T>(key: string, fallback: T): T {
  if (typeof localStorage === "undefined") return fallback
  const raw = localStorage.getItem(key)
  if (!raw) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

function writeJsonStorage(key: string, value: unknown) {
  if (typeof localStorage === "undefined") return
  localStorage.setItem(key, JSON.stringify(value))
}

function removeStorage(key: string) {
  if (typeof localStorage === "undefined") return
  localStorage.removeItem(key)
}

const CUSTOM_AGENTS_STORAGE_KEY = "opencode-custom-agents"
const MCP_SERVERS_STORAGE_KEY = "opencode-mcp-servers"

/** All methods that the renderer code accesses on `window.api`. */
export interface BrowserApi {
  setTitlebar?: (theme: { mode: "light" | "dark" }) => Promise<void>
  exportDebugLogs?: () => Promise<string>
  getCustomAgents?: () => Promise<unknown[]>
  setCustomAgents?: (agents: unknown[]) => Promise<void>
  deleteCustomAgent?: (id: string) => Promise<void>
  getMcpServers?: () => Promise<unknown[]>
  setMcpServers?: (servers: unknown[]) => Promise<void>
  recordFatalRendererError?: (error: {
    error: string
    url: string
    version?: string
    platform: string
    os?: string
  }) => Promise<void>
  openLink?: (url: string) => void
  openDirectoryPickerDialog?: (opts?: {
    title?: string
    multiple?: boolean
    defaultPath?: string
  }) => Promise<string | string[] | null>
  checkUpdate?: () => Promise<{ updateAvailable: boolean; version?: string }>
  installUpdate?: () => Promise<void>
  runUpdater?: (alertOnFail: boolean) => Promise<void>
  getDefaultServerUrl?: () => Promise<string | null>
  setDefaultServerUrl?: (url: string | null) => Promise<void>
  githubOAuthCallback?: (code: string, state: string) => Promise<void>
  getDependencyStatus?: () => Promise<unknown>
  getGitStatus?: () => Promise<unknown>
  getSessionMemory?: () => Promise<unknown>
  getTestStatus?: () => Promise<unknown>
  getPullRequestStatus?: () => Promise<unknown>
  showNotification?: (title: string, body?: string) => void
  storeGet?: (name: string, key: string) => Promise<string | null>
  storeSet?: (name: string, key: string, value: string) => Promise<void>
  storeDelete?: (name: string, key: string) => Promise<void>
  storeClear?: (name: string) => Promise<void>
  storeKeys?: (name: string) => Promise<string[]>
  getWindowConfig?: () => Promise<{ updaterEnabled: boolean }>
  setLocalePreference?: (locale: string) => Promise<void>
  getLocalePreference?: () => Promise<string | null>
  sessionExportData?: (
    data: string,
    opts?: {
      title?: string
      defaultPath?: string
      filters?: Array<{ name: string; extensions: string[] }>
    },
  ) => Promise<string | { error: string } | null>
  sessionImportFile?: (opts?: {
    title?: string
    filters?: Array<{ name: string; extensions: string[] }>
  }) => Promise<string | { error: string } | null>
  getWindowFocused?: () => Promise<boolean>
  setWindowFocus?: () => Promise<void>
  showWindow?: () => Promise<void>
  onDeepLink?: (cb: (urls: string[]) => void) => () => void
  onMenuCommand?: (cb: (id: string) => void) => () => void
}

export const browserApi: BrowserApi = {
  openLink(url) {
    debug("openLink", url)
    window.open(url, "_blank")
  },

  setTitlebar(_theme) {
    debug("setTitlebar", _theme)
    return Promise.resolve()
  },

  exportDebugLogs() {
    debug("exportDebugLogs")
    return Promise.resolve("No desktop debug logs in browser mode")
  },

  getCustomAgents() {
    debug("getCustomAgents")
    return Promise.resolve(readJsonStorage<unknown[]>(CUSTOM_AGENTS_STORAGE_KEY, []))
  },

  setCustomAgents(agents) {
    debug("setCustomAgents", agents)
    writeJsonStorage(CUSTOM_AGENTS_STORAGE_KEY, agents ?? [])
    return Promise.resolve()
  },

  deleteCustomAgent(id) {
    debug("deleteCustomAgent", id)
    const agents = readJsonStorage<unknown[]>(CUSTOM_AGENTS_STORAGE_KEY, [])
    writeJsonStorage(
      CUSTOM_AGENTS_STORAGE_KEY,
      agents.filter((agent) => {
        if (!agent || typeof agent !== "object") return true
        return (agent as Record<string, unknown>).id !== id
      }),
    )
    return Promise.resolve()
  },

  getMcpServers() {
    debug("getMcpServers")
    return Promise.resolve(readJsonStorage<unknown[]>(MCP_SERVERS_STORAGE_KEY, []))
  },

  setMcpServers(servers) {
    debug("setMcpServers", servers)
    writeJsonStorage(MCP_SERVERS_STORAGE_KEY, servers ?? [])
    return Promise.resolve()
  },

  recordFatalRendererError(_error) {
    debug("recordFatalRendererError", _error)
    return Promise.resolve()
  },

  openDirectoryPickerDialog(_opts) {
    debug("openDirectoryPickerDialog", _opts)
    // Browser doesn't have a native directory picker in all browsers
    // (showDirectoryPicker is Chromium-only). Return null = cancelled.
    return Promise.resolve(null)
  },

  checkUpdate() {
    debug("checkUpdate")
    return Promise.resolve({ updateAvailable: false })
  },

  installUpdate() {
    debug("installUpdate")
    return Promise.resolve()
  },

  runUpdater(_alertOnFail) {
    debug("runUpdater", _alertOnFail)
    return Promise.resolve()
  },

  getDefaultServerUrl() {
    debug("getDefaultServerUrl")
    // Fall back to localStorage if the Platform didn't set one
    const stored = localStorage.getItem("opencode-default-server-url")
    return Promise.resolve(stored)
  },

  setDefaultServerUrl(url) {
    debug("setDefaultServerUrl", url)
    if (url !== null) {
      localStorage.setItem("opencode-default-server-url", url)
    } else {
      removeStorage("opencode-default-server-url")
    }
    return Promise.resolve()
  },

  githubOAuthCallback(_code, _state) {
    debug("githubOAuthCallback", _code, _state)
    return Promise.resolve()
  },

  getDependencyStatus() {
    debug("getDependencyStatus")
    return Promise.resolve(null)
  },

  getGitStatus() {
    debug("getGitStatus")
    return Promise.resolve(null)
  },

  getSessionMemory() {
    debug("getSessionMemory")
    return Promise.resolve(null)
  },

  getTestStatus() {
    debug("getTestStatus")
    return Promise.resolve(null)
  },

  getPullRequestStatus() {
    debug("getPullRequestStatus")
    return Promise.resolve(null)
  },

  showNotification(title, body) {
    debug("showNotification", title, body)
    if (!("Notification" in window)) return
    if (Notification.permission !== "granted") return
    new Notification(title, { body })
  },

  storeGet(_name, _key) {
    debug("storeGet", _name, _key)
    // In the browser, there's no electron-store, so return null
    return Promise.resolve(null)
  },

  storeSet(_name, _key, _value) {
    debug("storeSet", _name, _key, _value)
    return Promise.resolve()
  },

  storeDelete(_name, _key) {
    debug("storeDelete", _name, _key)
    return Promise.resolve()
  },

  storeClear(_name) {
    debug("storeClear", _name)
    return Promise.resolve()
  },

  storeKeys(_name) {
    debug("storeKeys", _name)
    return Promise.resolve([])
  },

  getWindowConfig() {
    debug("getWindowConfig")
    return Promise.resolve({ updaterEnabled: false })
  },

  setLocalePreference(locale) {
    debug("setLocalePreference", locale)
    localStorage.setItem("opencode-locale", locale)
    return Promise.resolve()
  },

  getLocalePreference() {
    debug("getLocalePreference")
    return Promise.resolve(localStorage.getItem("opencode-locale"))
  },

  sessionExportData(_data, _opts) {
    debug("sessionExportData")
    // Browser: trigger a download via Blob + anchor trick
    try {
      const blob = new Blob([_data], { type: "application/json" })
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      a.download = _opts?.defaultPath ?? "export.opencode-session"
      a.click()
      URL.revokeObjectURL(url)
      return Promise.resolve(_data)
    } catch {
      return Promise.resolve({ error: "Failed to create download" })
    }
  },

  sessionImportFile(_opts) {
    debug("sessionImportFile")
    // Browser: show a file picker and read the file
    return new Promise((resolve) => {
      const input = document.createElement("input")
      input.type = "file"
      if (_opts?.filters?.[0]?.extensions) {
        input.accept = _opts.filters[0].extensions.map((e) => `.${e}`).join(",")
      }
      input.onchange = async () => {
        const file = input.files?.[0]
        if (!file) {
          resolve(null)
          return
        }
        try {
          const text = await file.text()
          resolve(text)
        } catch {
          resolve({ error: "Failed to read file" })
        }
      }
      input.oncancel = () => resolve(null)
      input.click()
    })
  },

  getWindowFocused() {
    debug("getWindowFocused")
    return Promise.resolve(document.hasFocus())
  },

  setWindowFocus() {
    debug("setWindowFocus")
    window.focus()
    return Promise.resolve()
  },

  showWindow() {
    debug("showWindow")
    window.focus()
    return Promise.resolve()
  },

  onDeepLink(_cb) {
    debug("onDeepLink")
    // No deep links in browser mode — return a no-op cleanup function
    return () => {}
  },

  onMenuCommand(_cb) {
    debug("onMenuCommand")
    // No desktop menu commands in browser mode
    return () => {}
  },
}

/**
 * Install the browser API polyfill on `window.api`.
 *
 * This does NOT override an existing `api` that was set by an Electron
 * preload script — it only fills in if `api` is undefined.
 *
 * Call this early in your app's entry point, before rendering.
 */
export function installBrowserApi(): void {
  if (typeof window === "undefined") return

  const w = window as unknown as Record<string, unknown>
  const existing = w.api
  if (existing) {
    debug("window.api already exists — skipping browser polyfill")
    return
  }

  w.api = browserApi
  debug("Browser API polyfill installed")
}
