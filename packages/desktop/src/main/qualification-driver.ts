import { Schema } from "effect"
import { app, BrowserWindow } from "electron"
import { findWindowByRole } from "./windows"

export function registerQualificationDriver(): void {
  if (process.env.TRIBUNUS_QUALIFICATION_DRIVER !== "1") return
  if (app.isPackaged) {
    console.error("[qual:driver] Refusing to activate in packaged build")
    return
  }

  // When spawned with {stdio: ["ignore", "inherit", "inherit", "ipc"]},
  // process.send is available on the IPC channel.
  const ipcSend = (msg: Record<string, unknown>) => {
    if (typeof process.send === "function") process.send(msg)
    else console.error("[qual:driver] process.send not available")
  }

// ── Command schema ──
const CommandSchema = Schema.Struct({
  id: Schema.String,
  command: Schema.Literals([
    "app.ready",
    "app.quit",
    "app.relaunch",
    "window.list",
    "window.screenshot",
    "renderer.execute",
    "renderer.invokeApi",
    "sidecar.status",
    "crash.injectRenderer",
    "dom.querySelector",
    "dom.clickSelector",
    "dom.waitForSelector",
  ]),
  params: Schema.Unknown,
})

const SuccessResponse = Schema.Struct({
  ok: Schema.Literal(true),
  id: Schema.String,
  result: Schema.Unknown,
})

const ErrorResponse = Schema.Struct({
  ok: Schema.Literal(false),
  id: Schema.String,
  error: Schema.Struct({
    code: Schema.String,
    message: Schema.String,
  }),
})

// ── Handler ──
function respond(id: string, result: unknown) {
  const envelope = { ok: true, id, result }
  ipcSend(envelope)
}

function reject(id: string, code: string, message: string) {
  const envelope = { ok: false, id, error: { code, message } }
  ipcSend(envelope)
}

function findMainWindow(): BrowserWindow | null {
  return findWindowByRole("main")
}

function findSafeModeWindow(): BrowserWindow | null {
  return findWindowByRole("safe-mode")
}

process.on("message", async (raw: unknown) => {
  const msg = raw as Record<string, unknown>
  console.log("[qual:driver] received:", msg.id, msg.command)
  try {
    const decoded = Schema.decodeUnknownSync(CommandSchema)(msg as unknown as Parameters<typeof Schema.decodeUnknownSync>[0])
    if ((decoded as unknown as { _tag?: string })._tag === "Failure") {
      reject(msg.id as string, "invalid_request", "Invalid command schema")
      return
    }
    const { id, command, params } = msg as { id: string; command: string; params: Record<string, unknown> }

    switch (command) {
      case "app.ready":
        respond(id, { ready: app.isReady(), pid: process.pid })
        break
      case "app.quit":
        app.quit()
        respond(id, { ok: true })
        break
      case "app.relaunch":
        app.relaunch()
        respond(id, { ok: true })
        break
      case "window.list": {
        const wins = BrowserWindow.getAllWindows().map(w => ({
          id: w.id, title: w.getTitle(), url: w.webContents.getURL(),
          visible: w.isVisible(), loading: w.webContents.isLoading(), destroyed: w.isDestroyed(),
        }))
        respond(id, { windows: wins, count: wins.length })
        break
      }
      case "window.screenshot": {
        const win = findMainWindow() ?? findSafeModeWindow()
        if (!win) { reject(id, "unavailable", "No main renderer window"); break }
        try {
          const image = await win.webContents.capturePage()
          const png = image.toPNG()
          respond(id, { data: Buffer.from(png).toString("base64"), mime: "image/png" })
        } catch (e: unknown) {
          reject(id, "internal", (e as Error).message ?? "Screenshot failed")
        }
        break
      }
      case "renderer.execute": {
        const win = findMainWindow() ?? findSafeModeWindow()
        if (!win) { reject(id, "unavailable", "No main renderer window"); break }
        const code = params.code as string
        if (!code || code.length > 10000) { reject(id, "invalid_request", "Code too long or empty"); break }
        try {
          const result = await win.webContents.executeJavaScript(code)
          respond(id, { value: result === undefined ? null : JSON.parse(JSON.stringify(result)) })
        } catch (e: unknown) {
          reject(id, "internal", (e as Error).message ?? "Execution failed")
        }
        break
      }
      case "renderer.invokeApi": {
        const win = findMainWindow() ?? findSafeModeWindow()
        if (!win) { reject(id, "unavailable", "No main renderer window"); break }
        const method = params.method as string
        const args = (params.args as unknown[]) ?? []
        // Build a safe invocation: window.api.METHOD(...args)
        const code = `(async () => { return await window.api["${method.replace(/"/g, "\\\"")}"](...${JSON.stringify(args)}) })()`
        try {
          const result = await win.webContents.executeJavaScript(code)
          respond(id, { value: result === undefined ? null : JSON.parse(JSON.stringify(result)) })
        } catch (e: unknown) {
          reject(id, "internal", (e as Error).message ?? "API invocation failed")
        }
        break
      }
      case "sidecar.status": {
        // Returns a simple unix-timestamp health check — the sidecar module
        // manages its own lifecycle. This just confirms the driver is alive.
        respond(id, { alive: true, process: process.pid })
        break
      }
      case "crash.injectRenderer": {
        const win = findMainWindow() ?? findSafeModeWindow()
        if (!win) { reject(id, "unavailable", "No main renderer window"); break }
        try {
          await win.webContents.executeJavaScript("throw new Error('Qualification crash injection')")
          respond(id, { injected: true })
        } catch (e: unknown) {
          // Expected — crash throws, that's the point
          respond(id, { injected: true, caught: (e as Error).message })
        }
        break
      }
      case "dom.querySelector": {
        const win = findMainWindow() ?? findSafeModeWindow()
        if (!win) { reject(id, "unavailable", "No main renderer window"); break }
        const selector = params.selector as string
        if (!selector || selector.length > 256) { reject(id, "invalid_request", "Invalid selector"); break }
        try {
          const result = await win.webContents.executeJavaScript(
            `(function() {
              const el = document.querySelector("${selector.replace(/"/g, "\\\"")}");
              if (!el) return null;
              return { tagName: el.tagName, textContent: el.textContent?.slice(0, 500), className: el.className, id: el.id };
            })()`
          )
          respond(id, { value: result === undefined ? null : JSON.parse(JSON.stringify(result)) })
        } catch (e: unknown) {
          reject(id, "internal", (e as Error).message ?? "DOM query failed")
        }
        break
      }
      case "dom.clickSelector": {
        const win = findMainWindow() ?? findSafeModeWindow()
        if (!win) { reject(id, "unavailable", "No main renderer window"); break }
        const selector = params.selector as string
        if (!selector || selector.length > 256) { reject(id, "invalid_request", "Invalid selector"); break }
        try {
          const result = await win.webContents.executeJavaScript(
            `(function() {
              const el = document.querySelector("${selector.replace(/"/g, "\\\"")}");
              if (!el) return { clicked: false, reason: "not found" };
              (el as HTMLElement).click();
              return { clicked: true };
            })()`
          )
          respond(id, { value: result === undefined ? null : JSON.parse(JSON.stringify(result)) })
        } catch (e: unknown) {
          reject(id, "internal", (e as Error).message ?? "DOM click failed")
        }
        break
      }
      case "dom.waitForSelector": {
        const win = findMainWindow() ?? findSafeModeWindow()
        if (!win) { reject(id, "unavailable", "No main renderer window"); break }
        const selector = params.selector as string
        const timeout = (params.timeout as number) ?? 10_000
        if (!selector || selector.length > 256) { reject(id, "invalid_request", "Invalid selector"); break }
        try {
          const result = await win.webContents.executeJavaScript(
            `new Promise((resolve) => {
              const el = document.querySelector("${selector.replace(/"/g, "\\\"")}");
              if (el) { resolve({ found: true, textContent: el.textContent?.slice(0, 500) }); return; }
              let elapsed = 0;
              const interval = setInterval(() => {
                elapsed += 200;
                const el = document.querySelector("${selector.replace(/"/g, "\\\"")}");
                if (el) { clearInterval(interval); resolve({ found: true, textContent: el.textContent?.slice(0, 500) }); return; }
                if (elapsed >= ${timeout}) { clearInterval(interval); resolve({ found: false }); }
              }, 200);
            })`
          )
          respond(id, { value: result === undefined ? null : JSON.parse(JSON.stringify(result)) })
        } catch (e: unknown) {
          reject(id, "internal", (e as Error).message ?? "DOM wait failed")
        }
        break
      }
      default:
        reject(id, "unsupported", `Unknown command: ${command}`)
    }
  } catch (e: unknown) {
    reject(msg.id as string, "internal", (e as Error).message ?? "Unexpected error")
  }
  })
}
