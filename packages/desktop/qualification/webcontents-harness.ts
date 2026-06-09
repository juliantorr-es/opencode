/**
 * Electron WebContents Harness v1 — fallback for Playwright Page discovery.
 *
 * _electron.launch() connects to the Electron main process but firstWindow()
 * times out (Playwright 1.60 + Electron 41 renderer-target discovery issue,
 * root cause under investigation). This harness uses the working
 * electronApp.evaluate() connection plus Electron's WebContents APIs
 * (executeJavaScript, capturePage) to drive renderer qualification.
 *
 * Removal condition: Remove when firstWindow() returns a Page reliably
 * with Playwright 1.60+ and Electron 41.
 *
 * @see packages/desktop/qualification/pw09-minimal-fixture.test.ts for the
 *      minimal fixture proving the timeout is not Tribunus-specific.
 */
import type { _electron as ElectronApi } from "playwright"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { mkdtempSync, existsSync } from "node:fs"

const DESKTOP_DIR = resolve(import.meta.dir, "..")
const MAIN_ENTRY = join(DESKTOP_DIR, "out", "main", "index.js")
const REPO_ROOT = resolve(DESKTOP_DIR, "..", "..")
const ELECTRON_PATH = join(
  REPO_ROOT, "node_modules", ".bun", "electron@41.2.1",
  "node_modules", "electron", "dist",
  "Electron.app", "Contents", "MacOS", "Electron",
)

const buildExists = existsSync(MAIN_ENTRY)
const itIfBuilt = buildExists ? it : it.skip

/** Observable renderer state */
interface RendererState {
  url: string
  title: string
  loading: boolean
  apiMethods: string[]
}

/** Result of a readiness poll through evaluate() */
interface PollResult {
  windowCount: number
  windows: Array<{ id: number; title: string; url: string; loading: boolean }>
}

export async function launchTribunus(electronModule: typeof ElectronApi) {
  const tempDir = mkdtempSync(join(tmpdir(), "tribunus-wc-"))
  const app = await electronModule.launch({
    executablePath: ELECTRON_PATH,
    args: [MAIN_ENTRY],
    cwd: DESKTOP_DIR,
    env: {
      ...process.env,
      OPENCODE_HOME: tempDir,
      OPENCODE_DB: ":memory:",
      TRIBUNUS_DB: ":memory:",
      TRIBUNUS_TEST_ONBOARDING: "1",
      TRIBUNUS_NO_UPDATE: "1",
      TRIBUNUS_CHANNEL: "dev",
      OPENCODE_CHANNEL: "dev",
      ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
    },
    timeout: 30_000,
  })
  return { app, tempDir }
}

/** Poll BrowserWindow state through evaluate. Returns null if evaluate fails. */
export async function pollWindows(app: { evaluate: (fn: string | Function, ...args: unknown[]) => Promise<unknown> }): Promise<PollResult | null> {
  try {
    const result = await app.evaluate(async ({ BrowserWindow, webContents: wc }: { BrowserWindow: Electron.BrowserWindowConstructor; webContents: typeof Electron.webContents }) => {
      const wins = BrowserWindow.getAllWindows()
      return {
        windowCount: wins.length,
        windows: wins.map((w: Electron.BrowserWindow) => ({
          id: w.id,
          title: w.getTitle(),
          url: w.webContents.getURL(),
          loading: w.webContents.isLoading(),
        })),
      }
    }) as PollResult
    return result
  } catch {
    return null
  }
}

/** Wait for at least one window with a non-empty URL. Returns null on timeout. */
export async function waitForWindow(app: { evaluate: (fn: string | Function, ...args: unknown[]) => Promise<unknown> }, timeoutMs: number = 30_000): Promise<PollResult | null> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const poll = await pollWindows(app)
    if (poll && poll.windowCount > 0 && poll.windows.some((w) => w.url && !w.loading)) {
      return poll
    }
    await new Promise((r) => setTimeout(r, 1000))
  }
  return pollWindows(app)
}

/** Execute JavaScript in the first non-loading renderer window. */
export async function execInRenderer(app: { evaluate: (fn: string | Function, ...args: unknown[]) => Promise<unknown> }, code: string): Promise<unknown> {
  return app.evaluate(async ({ BrowserWindow }: { BrowserWindow: Electron.BrowserWindowConstructor }, js: string) => {
    const wins = BrowserWindow.getAllWindows()
    for (const win of wins) {
      if (!win.isDestroyed() && !win.webContents.isLoading() && win.webContents.getURL()) {
        return win.webContents.executeJavaScript(js)
      }
    }
    throw new Error("No ready renderer window available")
  }, code)
}
