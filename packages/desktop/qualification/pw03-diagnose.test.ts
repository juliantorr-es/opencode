/**
 * PW-03: Baseline reproduction — Electron window attachment diagnostic.
 *
 * Does NOT wait for firstWindow(). Immediately polls BrowserWindow state
 * through electronApp.evaluate() and electronApp.windows() to classify
 * the failure into Category A-F.
 *
 * Usage: cd packages/desktop && bun test qualification/pw03-diagnose.test.ts
 */
import { describe, it, expect } from "bun:test"
import { _electron as electron } from "playwright"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { mkdtempSync, existsSync, writeFileSync } from "node:fs"

const DESKTOP_DIR = resolve(import.meta.dir, "..")
const MAIN_ENTRY = join(DESKTOP_DIR, "out", "main", "index.js")
const REPO_ROOT = resolve(DESKTOP_DIR, "..", "..")
const ELECTRON_PATH = join(
  REPO_ROOT, "node_modules", ".bun", "electron@41.2.1",
  "node_modules", "electron", "dist",
  "Electron.app", "Contents", "MacOS", "Electron",
)

interface DiagnosticResult {
  category: string
  browserWindows: unknown[]
  webContents: unknown[]
  playwrightPages: unknown[]
  evaluateOk: boolean
  launchMs: number
  error?: string
}

async function runDiagnostic(): Promise<DiagnosticResult> {
  const tempDir = mkdtempSync(join(tmpdir(), "tribunus-pw03-"))
  const t0 = Date.now()
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined

  try {
    app = await electron.launch({
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

    const launchMs = Date.now() - t0
    console.log("[pw03] Launched in", launchMs, "ms")

    // Immediately poll BrowserWindow.getAllWindows() through evaluate
    let evaluateOk = false
    let browserWindows: unknown[] = []
    let webContents: unknown[] = []

    try {
      const result = await app.evaluate(async ({ BrowserWindow, webContents: wc }) => {
        const wins = BrowserWindow.getAllWindows()
        const contents = wc.getAllWebContents()
        return {
          windows: wins.map((w: Electron.BrowserWindow) => ({
            id: w.id,
            title: w.getTitle(),
            visible: w.isVisible(),
            destroyed: w.isDestroyed(),
            url: w.webContents.getURL(),
            loading: w.webContents.isLoading(),
          })),
          contents: contents.map((c: Electron.WebContents) => ({
            id: c.id,
            type: c.getType(),
            url: c.getURL(),
            loading: c.isLoading(),
            destroyed: c.isDestroyed(),
          })),
        }
      })
      evaluateOk = true
      browserWindows = result.windows
      webContents = result.contents
      console.log("[pw03] evaluate ok:", result)
    } catch (e) {
      console.error("[pw03] evaluate failed:", String(e).slice(0, 300))
      evaluateOk = false
    }

    // Poll Playwright's window view
    let playwrightPages: unknown[] = []
    try {
      playwrightPages = app.windows().map((p) => ({
        url: p.url(),
        title: p.url(), // Will be overwritten
      }))
      console.log("[pw03] playwright windows:", playwrightPages.length)
    } catch (e) {
      console.error("[pw03] playwright windows failed:", String(e).slice(0, 200))
    }

    // Subscribe to window event and poll BrowserWindow every 2s for 20s
    let windowEvents: unknown[] = []
    app.on("window", (page) => {
      windowEvents.push({ time: Date.now() - t0, url: page.url() })
      console.log("[pw03] window event:", page.url())
    })

    // Poll BrowserWindow via evaluate every 2s for 16s
    for (let i = 0; i < 8; i++) {
      await new Promise((r) => setTimeout(r, 2000))
      try {
        const result = await app.evaluate(async ({ BrowserWindow, webContents: wc }) => {
          const wins = BrowserWindow.getAllWindows()
          return {
            count: wins.length,
            windows: wins.map((w: Electron.BrowserWindow) => ({
              id: w.id,
              title: w.getTitle(),
              visible: w.isVisible(),
              destroyed: w.isDestroyed(),
              url: w.webContents.getURL(),
              loading: w.webContents.isLoading(),
            })),
            contents: wc.getAllWebContents().map((c: Electron.WebContents) => ({
              id: c.id,
              type: c.getType(),
              url: c.getURL(),
              loading: c.isLoading(),
              destroyed: c.isDestroyed(),
            })),
          }
        })
        browserWindows = result.windows
        webContents = result.contents
        console.log(`[pw03] poll +${(i + 1) * 2}s:`, result.count, "windows,", result.contents.length, "webContents")
        if (result.count > 0) break
      } catch (e) {
        console.error(`[pw03] poll +${(i + 1) * 2}s failed:`, String(e).slice(0, 200))
      }
    }

    // Classify
    let category = "unknown"
    if (!evaluateOk) category = "F" // can't control main process
    else if (browserWindows.length === 0) category = "A" // no BrowserWindow
    else if (playwrightPages.length === 0) {
      // Has BrowserWindow but no Playwright Page
      const hasLoaded = browserWindows.some((w: Record<string, unknown>) => w.url && !w.loading)
      category = hasLoaded ? "C" : "B"
    } else if (windowEvents.length === 0 && playwrightPages.length > 0) {
      category = "D" // has Page but no window event
    } else {
      category = "E" // everything works, just slow
    }

    await app.close().catch(() => {})
    return {
      category,
      browserWindows,
      webContents,
      playwrightPages,
      evaluateOk,
      launchMs,
    }
  } catch (e) {
    const result: DiagnosticResult = {
      category: "F",
      browserWindows: [],
      webContents: [],
      playwrightPages: [],
      evaluateOk: false,
      launchMs: Date.now() - t0,
      error: String(e).slice(0, 500),
    }
    if (app) await app.close().catch(() => {})
    return result
  }
}

describe("PW-03: Baseline reproduction", () => {
  it("diagnoses window attachment (run 1)", async () => {
    const r = await runDiagnostic()
    console.log("[pw03] Category:", r.category, "| evaluate:", r.evaluateOk, "| BWs:", r.browserWindows.length, "| WC:", r.webContents.length, "| Pages:", r.playwrightPages.length)
    if (r.error) console.log("[pw03] Error:", r.error)

    // Write receipt
    writeFileSync(
      join(import.meta.dir, "..", "qualification", "receipts", "pw03-baseline-1.json"),
      JSON.stringify(r, null, 2),
    )

    expect(r.evaluateOk).toBe(true)
    console.log("[pw03] Category report:", r.category)
  }, 90_000)
})
