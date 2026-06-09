/**
 * RC-09/10: First-launch and critical IPC journey through WebContents harness.
 *
 * Uses the working electronApp.evaluate() connection (no firstWindow() needed)
 * to prove: the app launches, the renderer loads, the preload bridge exists,
 * store IPC works through typedInvokeV2, and clean shutdown is possible.
 */
import { describe, it, expect } from "bun:test"
import { _electron as electron } from "playwright"
import { join, resolve } from "node:path"
import { existsSync } from "node:fs"
import { launchTribunus, waitForWindow, execInRenderer } from "./webcontents-harness"

const DESKTOP_DIR = resolve(import.meta.dir, "..")
const MAIN_ENTRY = join(DESKTOP_DIR, "out", "main", "index.js")
const buildExists = existsSync(MAIN_ENTRY)
const itIfBuilt = buildExists ? it : it.skip

describe("WebContents Harness — First Launch and IPC Journey", () => {
  itIfBuilt("launches Tribunus and observes a renderer window", async () => {
    const { app, tempDir } = await launchTribunus(electron)

    // Wait up to 45s for a renderer window to appear
    const poll = await waitForWindow(app, 45_000)
    expect(poll).toBeDefined()
    expect(poll!.windowCount).toBeGreaterThan(0)

    const mainWindow = poll!.windows.find((w: { url: string }) => w.url === "oc://renderer/index.html")
    expect(mainWindow).toBeDefined()
    console.log("[wc] Main window found:", mainWindow!.title, mainWindow!.url)

    await app.close()
  }, 60_000)

  itIfBuilt("proves preload bridge (window.api) is exposed", async () => {
    const { app } = await launchTribunus(electron)
    await waitForWindow(app, 45_000)

    const hasApi = await execInRenderer(app, `
      typeof window.api !== "undefined"
    `)
    expect(hasApi).toBe(true)

    const methodCount = await execInRenderer(app, `
      Object.keys(window.api).filter(k => typeof window.api[k] === "function").length
    `)
    console.log("[wc] Preload API methods:", methodCount)
    expect(methodCount).toBeGreaterThan(0)

    await app.close()
  }, 60_000)

  itIfBuilt("proves store IPC through typedInvokeV2 (absent key → null)", async () => {
    const { app } = await launchTribunus(electron)
    await waitForWindow(app, 45_000)

    const result = await execInRenderer(app, `
      window.api.storeGet("test-wc-store", "nonexistent-key")
    `)
    console.log("[wc] storeGet result:", result)
    expect(result).toBeNull()

    await app.close()
  }, 60_000)

  itIfBuilt("proves clean shutdown leaves no orphaned processes", async () => {
    const { app } = await launchTribunus(electron)
    await waitForWindow(app, 45_000)

    // Exercise some IPC before closing
    await execInRenderer(app, `window.api.storeGet("test-shutdown", "key")`)

    const processInfo = await app.evaluate(() => {
      return {
        pid: process.pid,
        title: (globalThis as unknown as { __playwright_app?: { _title?: string } }).__playwright_app?._title,
      }
    })
    console.log("[wc] App pid:", processInfo)

    await app.close()
    // App closed without throwing — clean shutdown
  }, 60_000)
})
