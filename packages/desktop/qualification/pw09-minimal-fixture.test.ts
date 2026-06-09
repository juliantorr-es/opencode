/**
 * PW-09: Minimal ordinary Electron fixture.
 *
 * A 10-line Electron app that creates one BrowserWindow with inline HTML.
 * Tests whether Playwright can launch it, evaluate code, find the window,
 * and close it cleanly. Isolates Playwright/Electron 41 compatibility from
 * Tribunus-specific behavior.
 */
import { describe, it, expect } from "bun:test"
import { _electron as electron } from "playwright"
import { join, resolve } from "node:path"

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..")
const ELECTRON_PATH = join(
  REPO_ROOT, "node_modules", ".bun", "electron@41.2.1",
  "node_modules", "electron", "dist",
  "Electron.app", "Contents", "MacOS", "Electron",
)
const FIXTURE_DIR = resolve(import.meta.dir, "minimal-fixture")
const MAIN_ENTRY = join(FIXTURE_DIR, "main.js")

describe("PW-09: Minimal Electron fixture", () => {
  it("launches, evaluates, finds window, captures screenshot, closes", async () => {
    const app = await electron.launch({
      executablePath: ELECTRON_PATH,
      args: [MAIN_ENTRY],
      cwd: FIXTURE_DIR,
      timeout: 30_000,
    })

    // Evaluate in main process
    const appName = await app.evaluate(({ app: electronApp }) => electronApp.getName())
    console.log("[pw09] App name:", appName)
    expect(appName).toBe("Electron")

    // Get first window
    const window = await app.firstWindow()
    expect(window).toBeDefined()
    const title = await window.title()
    console.log("[pw09] Window title:", title)

    // Evaluate in renderer
    const body = await window.evaluate(() => document.body.textContent)
    console.log("[pw09] Body:", body)
    expect(body).toContain("Hello Playwright")

    // Screenshot
    await window.screenshot({ path: join(import.meta.dir, "..", "receipts", "pw09-minimal-fixture.png") })

    // Close
    await app.close()
  }, 60_000)
})
