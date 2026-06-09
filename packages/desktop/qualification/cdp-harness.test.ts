/**
 * PW-FALLBACK-TEST: Verify the CDP-based harness works with Tribunus.
 */
import { describe, it, expect } from "bun:test"
import { launchElectronViaCdp } from "./cdp-harness"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { mkdtempSync } from "node:fs"

const DESKTOP_DIR = resolve(import.meta.dir, "..")
const MAIN_ENTRY = join(DESKTOP_DIR, "out", "main", "index.js")
const REPO_ROOT = resolve(DESKTOP_DIR, "..", "..")
const ELECTRON_PATH = join(
  REPO_ROOT, "node_modules", ".bun", "electron@41.2.1",
  "node_modules", "electron", "dist",
  "Electron.app", "Contents", "MacOS", "Electron",
)

describe("CDP fallback harness", () => {
  it("launches Tribunus via CDP and interacts with renderer", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "tribunus-cdp-"))
    const harness = await launchElectronViaCdp(ELECTRON_PATH, MAIN_ENTRY, tempDir)

    const page = harness.page
    console.log("[cdp] Page URL:", page.url())

    // Wait for the page to load
    await page.waitForLoadState("domcontentloaded", { timeout: 30_000 })

    // Check the preload bridge is available
    const hasApi = await page.evaluate(() => {
      return typeof (window as unknown as { api?: unknown }).api !== "undefined"
    })
    console.log("[cdp] window.api exists:", hasApi)
    expect(hasApi).toBe(true)

    // Test a store IPC call
    const storeGet = await page.evaluate(async () => {
      const w = window as unknown as {
        api: { storeGet: (name: string, key: string) => Promise<string | null> }
      }
      return w.api.storeGet("test-cdp", "key1")
    })
    console.log("[cdp] storeGet result:", storeGet)
    expect(storeGet).toBeNull()

    // Screenshot
    await page.screenshot({ path: join(import.meta.dir, "..", "receipts", "cdp-tribunus.png") })

    await harness.close()
  }, 60_000)
})
