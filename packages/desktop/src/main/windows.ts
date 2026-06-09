import windowState from "electron-window-state"
import { resolveThemeVariant } from "@tribunus/ui/theme/resolve"
import type { DesktopTheme } from "@tribunus/ui/theme/types"
import oc2ThemeJson from "../../../ui/src/theme/themes/oc-2.json"
import { app, BrowserWindow, dialog, net, nativeImage, nativeTheme, protocol, shell } from "electron"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import { existsSync } from "node:fs"
import { fileURLToPath, pathToFileURL } from "node:url"
import type { TitlebarTheme } from "../preload/types"
import { PINCH_ZOOM_ENABLED_KEY } from "./constants"
import { IPC } from "./ipc-channels"
import { exportDebugLogs, write as writeLog } from "./logging"
import { getStore } from "./store"
import { createUnresponsiveSampler } from "./unresponsive"
const root = dirname(fileURLToPath(import.meta.url))
// Use app.getAppPath() instead of import.meta.url so renderer root remains
// stable even if this module is code-split into out/main/chunks.
// app.getAppPath() returns out/main/ in production builds.
// Renderer assets are at out/renderer/ (sibling, not child).
const rendererRoot = join(dirname(app.getAppPath()), "renderer")
const rendererProtocol = "oc"
const rendererHost = "renderer"
const clipboardWritePermission = "clipboard-sanitized-write"
const notificationPermission = "notifications"
const rendererPermissions = new Set([clipboardWritePermission, notificationPermission])
const oc2Theme = oc2ThemeJson as DesktopTheme
const oc2Background = {
  light: resolveThemeVariant(oc2Theme.light, false)["background-base"],
  dark: resolveThemeVariant(oc2Theme.dark, true)["background-base"],
}
const documentPolicyHeader = "Document-Policy"
const jsCallStacksDocumentPolicy = "include-js-call-stacks-in-crash-reports"
const cspHeader = "Content-Security-Policy"
const cspDev = "default-src 'self' oc:; script-src 'self' oc: 'unsafe-eval' 'wasm-unsafe-eval'; style-src 'self' oc: 'unsafe-inline'; img-src 'self' oc: data: https:; font-src 'self' oc: data:; media-src 'self' oc: data:; connect-src * data: ws://localhost:* wss://localhost:*; base-uri 'self'; form-action 'none'; frame-ancestors 'none'; object-src 'none'"
const cspProd = "default-src 'self' oc:; script-src 'self' oc:; style-src 'self' oc: 'unsafe-inline'; img-src 'self' oc: data: https:; font-src 'self' oc: data:; media-src 'self' oc: data:; connect-src oc: data: ws://localhost:* wss://localhost:*; base-uri 'self'; form-action 'none'; frame-ancestors 'none'; object-src 'none'"

protocol.registerSchemesAsPrivileged([
  {
    scheme: rendererProtocol,
    privileges: {
      secure: true,
      standard: true,
      supportFetchAPI: true,
    },
  },
])

let backgroundColor: string | undefined
let relaunchHandler = () => {
  app.relaunch()
  app.exit(0)
}
const titlebarThemes = new WeakMap<BrowserWindow, Partial<TitlebarTheme>>()
const pinchZoomEnabled = new WeakMap<BrowserWindow, boolean>()
const titlebarHeight = 40
const maxZoomLevel = 10
const minZoomLevel = 0.2
 
 /** Window role for deterministic identification */
 export type WindowRole = "main" | "loading" | "safe-mode" | "plugin"
 
 /** Map of window IDs to declared roles */
 const windowRoles = new Map<number, WindowRole>()
 
 /** Create a BrowserWindow with an explicit role */
 export function createWindowWithRole(role: WindowRole, options: Electron.BrowserWindowConstructorOptions): Electron.BrowserWindow {
   const win = new BrowserWindow(options)
   windowRoles.set(win.id, role)
   win.on("closed", () => windowRoles.delete(win.id))
   return win
 }
 
 /** Find a window by its role */
 export function findWindowByRole(role: WindowRole): BrowserWindow | null {
   for (const [id, r] of windowRoles) {
     if (r === role) {
       const win = BrowserWindow.fromId(id)
       if (win && !win.isDestroyed()) return win
     }
   }
   return null
 }
 
 export function getWindowRole(win: BrowserWindow): WindowRole | undefined {
   return windowRoles.get(win.id)
 }

export function setRelaunchHandler(handler: () => void) {
  relaunchHandler = handler
}

export function setBackgroundColor(color: string) {
  backgroundColor = color
  BrowserWindow.getAllWindows().forEach((win) => win.setBackgroundColor(color))
}

export function getBackgroundColor(): string | undefined {
  return backgroundColor
}

function iconsDir() {
  return app.isPackaged ? join(process.resourcesPath, "icons") : join(root, "../../resources/icons")
}

function iconPath() {
  const ext = process.platform === "win32" ? "ico" : "png"
  return join(iconsDir(), `icon.${ext}`)
}

function tone() {
  return nativeTheme.shouldUseDarkColors ? "dark" : "light"
}

function defaultBackgroundColor() {
  return oc2Background[tone()]
}

function overlay(theme: Partial<TitlebarTheme> = {}, zoom = 1) {
  const mode = theme.mode ?? tone()
  return {
    color: "#00000000",
    symbolColor: mode === "dark" ? "white" : "black",
    height: Math.max(titlebarHeight, Math.round(titlebarHeight * zoom)),
  }
}

export function setTitlebar(win: BrowserWindow, theme: Partial<TitlebarTheme> = {}) {
  titlebarThemes.set(win, theme)
  updateTitlebar(win)
}

export function updateTitlebar(win: BrowserWindow) {
  if (process.platform !== "win32") return
  win.setTitleBarOverlay(overlay(titlebarThemes.get(win), win.webContents.getZoomFactor()))
}

export function setPinchZoomEnabled(enabled: boolean) {
  getStore().set(PINCH_ZOOM_ENABLED_KEY, enabled)
  for (const win of BrowserWindow.getAllWindows()) {
    pinchZoomEnabled.set(win, enabled)
    win.webContents.send(IPC.push.PINCH_ZOOM_ENABLED_CHANGED, enabled)
    if (!enabled && win.webContents.getZoomFactor() !== 1) win.webContents.setZoomFactor(1)
    updateZoom(win)
  }
}

export function getPinchZoomEnabled() {
  return getStore().get(PINCH_ZOOM_ENABLED_KEY) === true
}

export function setDockIcon() {
  if (process.platform !== "darwin") return
  const icon = nativeImage.createFromPath(join(iconsDir(), "dock.png"))
  if (!icon.isEmpty()) app.dock?.setIcon(icon)
}

export function createMainWindow() {
  const state = windowState({
    defaultWidth: 1280,
    defaultHeight: 800,
  })

  const mode = tone()
  const win = createWindowWithRole("main", {
    x: state.x,
    y: state.y,
    width: state.width,
    height: state.height,
    show: false,
    autoHideMenuBar: true,
    title: "Tribunus",
    icon: iconPath(),
    backgroundColor: backgroundColor ?? defaultBackgroundColor(),
    ...(process.platform === "darwin"
      ? {
          titleBarStyle: "hidden" as const,
          trafficLightPosition: { x: 12, y: 14 },
        }
      : {}),
    ...(process.platform === "win32"
      ? {
          frame: false,
          titleBarStyle: "hidden" as const,
          titleBarOverlay: overlay({ mode }),
        }
      : {}),
    webPreferences: {
      preload: join(root, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  allowRendererPermissions(win)
  wireWindowRecovery(win, "main")

  // Navigation restrictions: deny in-app navigation to external URLs.
  // Only https is permitted for external links (http in dev).
  // Parse URLs properly — string-prefix checks are foolable.
  const ALLOWED_EXTERNAL_SCHEMES = new Set<string>(["https:"])
  if (!app.isPackaged) ALLOWED_EXTERNAL_SCHEMES.add("http:")
  const DEV_ORIGIN = "http://localhost:5173"

  function safeOpenExternal(raw: string): void {
    let parsed: URL
    try { parsed = new URL(raw) } catch { return }
    if (!ALLOWED_EXTERNAL_SCHEMES.has(parsed.protocol)) return
    // Reject embedded credentials and control characters
    if (parsed.username || parsed.password) return
    if (/[\x00-\x1f\x7f]/.test(raw)) return
    void shell.openExternal(parsed.href)
  }

  win.webContents.setWindowOpenHandler(({ url }) => {
    // oc: is internal custom protocol — allow through. Only check external URLs.
    if (!url.startsWith("oc://")) safeOpenExternal(url)
    return { action: "deny" }
  })

  win.webContents.on("will-navigate", (event, rawUrl) => {
    // Internal navigation: oc: is a custom protocol — URL constructor can't parse it
    if (rawUrl.startsWith("oc://")) return
    let parsed: URL
    try { parsed = new URL(rawUrl) } catch {
      event.preventDefault()
      return
    }
    if (!app.isPackaged && parsed.origin === DEV_ORIGIN) return
    event.preventDefault()
    safeOpenExternal(rawUrl)
  })

  win.webContents.session.webRequest.onBeforeSendHeaders((details, callback) => {
    const { requestHeaders } = details
    upsertKeyValue(requestHeaders, "Access-Control-Allow-Origin", ["*"])
    callback({ requestHeaders })
  })

  win.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    const { responseHeaders = {} } = details
    addRendererHeaders(details.url, responseHeaders)
    callback({ responseHeaders })
  })

  state.manage(win)
  loadWindow(win, "index.html")
  wireZoom(win)

  win.once("ready-to-show", () => {
    win.show()
  })

  return win
}

export function transitionToSafeMode(win: BrowserWindow, error: { message: string; component: string }): BrowserWindow {
  win.setSize(800, 600)
  win.center()
  win.setResizable(true)
  win.setTitle("Tribunus — Safe Mode")
  windowRoles.set(win.id, "safe-mode")
  loadWindow(win, "safe-mode.html")
  return win
}

export function createLoadingWindow() {
  const mode = tone()
  const win = createWindowWithRole("loading", {
    width: 640,
    height: 480,
    resizable: false,
    center: true,
    show: true,
    autoHideMenuBar: true,
    icon: iconPath(),
    backgroundColor: backgroundColor ?? defaultBackgroundColor(),
    ...(process.platform === "darwin" ? { titleBarStyle: "hidden" as const } : {}),
    ...(process.platform === "win32"
      ? {
          frame: false,
          titleBarStyle: "hidden" as const,
          titleBarOverlay: overlay({ mode }),
        }
      : {}),
    webPreferences: {
      preload: join(root, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  allowRendererPermissions(win)
  wireWindowRecovery(win, "loading")

  loadWindow(win, "loading.html")

  return win
}

export function registerRendererProtocol() {
  if (protocol.isProtocolHandled(rendererProtocol)) return

  protocol.handle(rendererProtocol, async (request) => {
    const url = new URL(request.url)
    if (url.host !== rendererHost) {
      writeLog("protocol", "rejected host", { url: request.url }, "warn")
      return new Response("Not found", { status: 404 })
    }

    const file = resolve(rendererRoot, `.${decodeURIComponent(url.pathname)}`)
    const fileExists = existsSync(file)
    console.log("[protocol]", { url: request.url, rendererRoot, file, exists: fileExists })
    if (!fileExists) {
      writeLog("protocol", "file not found", { url: request.url, file, rendererRoot }, "error")
      return new Response("File not found", { status: 404 })
    }
    const rel = relative(rendererRoot, file)
    if (rel.startsWith("..") || isAbsolute(rel)) {
      writeLog("protocol", "rejected path", { url: request.url, file }, "warn")
      return new Response("Not found", { status: 404 })
    }

    try {
      const response = await net.fetch(pathToFileURL(file).toString())
      if (response.status >= 400) {
        writeLog(
          "protocol",
          "fetch failed",
          {
            url: request.url,
            file,
            status: response.status,
            statusText: response.statusText,
          },
          "error",
        )
      }
      return addDocumentPolicy(response, file)
    } catch (error) {
      writeLog("protocol", "fetch error", { url: request.url, file, error }, "error")
      return new Response("Not found", { status: 404 })
    }
  })
}

function loadWindow(win: BrowserWindow, html: string) {
  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (devUrl) {
    const url = new URL(html, devUrl)
    void win.loadURL(url.toString())
    return
  }

  void win.loadURL(`${rendererProtocol}://${rendererHost}/${html}`)
}

function wireWindowRecovery(win: BrowserWindow, name: string) {
  let showing = false
  const sampler = createUnresponsiveSampler(win, name)

  const handle = async (button: string | undefined, wait: boolean) => {
    if (button === "Export Logs") {
      const sampling = sampler.stopAndFlush()
      await exportDebugLogs().catch((error) => writeLog("main", "failed to export debug logs", { error }, "error"))
      if (wait && sampling) sampler.start()
      return true
    }
    if (button === "Relaunch") {
      sampler.stopAndFlush()
      relaunchHandler()
      return false
    }
    if (button === "Quit") {
      sampler.stopAndFlush()
      app.quit()
    }
    return false
  }

  const show = async (message: string, detail: string, wait: boolean) => {
    if (showing || win.isDestroyed()) return
    showing = true
    try {
      while (!win.isDestroyed()) {
        const buttons = wait ? ["Relaunch", "Export Logs", "Keep Waiting"] : ["Relaunch", "Export Logs", "Quit"]
        const result = await dialog.showMessageBox(win, {
          type: "warning",
          buttons,
          defaultId: 0,
          cancelId: 2,
          message,
          detail,
        })
        if (await handle(buttons[result.response], wait)) continue
        return
      }
    } finally {
      showing = false
    }
  }

  const failed = (
    event: string,
    errorCode: number,
    errorDescription: string,
    validatedURL: string,
    isMainFrame: boolean,
  ) => {
    writeLog(
      "window",
      "renderer load failed",
      {
        window: name,
        event,
        errorCode,
        errorDescription,
        validatedURL,
        currentURL: win.webContents.getURL(),
        isMainFrame,
      },
      "error",
    )

    if (!isMainFrame || errorCode === -3) return
    void show(
      "Tribunus failed to load",
      [`Window: ${name}`, `URL: ${validatedURL}`, `Error: ${errorCode} ${errorDescription}`].join("\n"),
      false,
    )
  }

  win.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    failed("did-fail-load", errorCode, errorDescription, validatedURL, isMainFrame)
  })
  win.webContents.on("did-fail-provisional-load", (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    failed("did-fail-provisional-load", errorCode, errorDescription, validatedURL, isMainFrame)
  })
  win.webContents.on("render-process-gone", (_event, details) => {
    sampler.stopAndFlush()
    writeLog(
      "window",
      "renderer process gone",
      { window: name, currentURL: win.webContents.getURL(), details },
      "error",
    )
    void show(
      "Tribunus window terminated unexpectedly",
      [`Window: ${name}`, `Reason: ${details.reason}`, `Code: ${details.exitCode ?? "<unknown>"}`].join("\n"),
      false,
    )
  })
  win.on("unresponsive", () => {
    writeLog("window", "renderer unresponsive", { window: name, currentURL: win.webContents.getURL() }, "error")
    sampler.start()
    void show("Tribunus is not responding", "You can relaunch the app, open the logs, or keep waiting.", true)
  })
  win.on("responsive", () => {
    writeLog("window", "renderer responsive", { window: name, currentURL: win.webContents.getURL() }, "error")
    sampler.stopAndFlush()
  })
  win.webContents.on("console-message", (_event, level, message, line, sourceId) => {
    if (message.toLowerCase().includes("terminal") || sourceId.toLowerCase().includes("terminal")) {
      writeLog("pty", "console", { window: name, level, message, line, sourceId })
    }
  })
  win.webContents.on("preload-error", (_event, preloadPath, error) => {
    writeLog("preload", "preload error", { window: name, preloadPath, error }, "error")
  })
}

function addDocumentPolicy(response: Response, file: string) {
  if (!file.toLowerCase().endsWith(".html")) return response
  const headers = new Headers(response.headers)
  headers.set(documentPolicyHeader, jsCallStacksDocumentPolicy)
  headers.set(cspHeader, app.isPackaged ? cspProd : cspDev)
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}

function allowRendererPermissions(win: BrowserWindow) {
  win.webContents.session.setPermissionRequestHandler((webContents, permission, callback, details) => {
    callback(
      rendererPermissions.has(permission) &&
        isTrustedRendererUrl(details.requestingUrl) &&
        webContents.id === win.webContents.id,
    )
  })
  win.webContents.session.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => {
    if (!rendererPermissions.has(permission)) return false
    if (webContents && webContents.id !== win.webContents.id) return false
    return isTrustedRendererUrl(details.requestingUrl) || isTrustedRendererUrl(requestingOrigin)
  })
}

function isTrustedRendererUrl(value?: string) {
  return isRendererUrl(value)
}

function addRendererHeaders(value: string, headers: Record<string, any>) {
  upsertKeyValue(headers, "Access-Control-Allow-Origin", ["*"])
  upsertKeyValue(headers, "Access-Control-Allow-Headers", ["*"])
  if (isRendererUrl(value, true)) upsertKeyValue(headers, documentPolicyHeader, [jsCallStacksDocumentPolicy])
}

function isRendererUrl(value?: string, html = false) {
  if (!value || !URL.canParse(value)) return false
  const url = new URL(value)
  if (html && !url.pathname.endsWith(".html")) return false
  if (url.protocol === `${rendererProtocol}:` && url.host === rendererHost) return true
  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (!devUrl || !URL.canParse(devUrl)) return false
  return url.origin === new URL(devUrl).origin
}

function wireZoom(win: BrowserWindow) {
  pinchZoomEnabled.set(win, getPinchZoomEnabled())
  win.webContents.setZoomFactor(1)
  win.webContents.on("zoom-changed", (event, zoomDirection) => {
    event.preventDefault()
    if (pinchZoomEnabled.get(win)) {
      win.webContents.setZoomFactor(clampZoom(win.webContents.getZoomFactor() + (zoomDirection === "in" ? 0.2 : -0.2)))
      updateZoom(win)
      return
    }
    if (win.webContents.getZoomFactor() !== 1) win.webContents.setZoomFactor(1)
    updateZoom(win)
  })
}

function clampZoom(value: number) {
  return Math.min(Math.max(value, minZoomLevel), maxZoomLevel)
}

function updateZoom(win: BrowserWindow) {
  updateTitlebar(win)
  win.webContents.send(IPC.push.ZOOM_FACTOR_CHANGED, win.webContents.getZoomFactor())
}

function upsertKeyValue(obj: Record<string, any>, keyToChange: string, value: any) {
  const keyToChangeLower = keyToChange.toLowerCase()
  for (const key of Object.keys(obj)) {
    if (key.toLowerCase() === keyToChangeLower) {
      // Reassign old key
      obj[key] = value
      // Done
      return
    }
  }
  // Insert at end instead
  obj[keyToChange] = value
}
