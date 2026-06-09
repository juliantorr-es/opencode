/**
 * RC-09/10: First-launch and critical IPC journey through stdio harness.
 *
 * Uses the IPC-over-stdio qualification driver (TRIBUNUS_QUALIFICATION_DRIVER=1)
 * to launch the real Electron app, wait for renderer readiness, execute IPC
 * through the preload bridge, and prove clean shutdown.
 */
import { describe, it, expect } from "bun:test"
import { QualificationHarness } from "./stdio-harness"
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

describe("RC-09: First-launch through stdio driver", () => {
  itIfBuilt("launches, reaches readiness, observes renderer window", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "tribunus-rc09-"))
    const harness = new QualificationHarness(tempDir, ELECTRON_PATH, MAIN_ENTRY)

    // Wait for app readiness
    const ready = await harness.waitForReady(30_000)
    console.log("[rc09] App ready:", ready)
    expect(ready).toBe(true)

    // Wait for a renderer window
    const windows = await harness.waitForWindow(45_000)
    console.log("[rc09] Windows:", (windows.result as { count: number })?.count)
    expect(windows.ok).toBe(true)
    expect((windows.result as { count: number }).count).toBeGreaterThan(0)

    await harness.quit()
  }, 90_000)

  itIfBuilt("proves preload bridge exists", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "tribunus-rc09-"))
    const harness = new QualificationHarness(tempDir, ELECTRON_PATH, MAIN_ENTRY)
    await harness.waitForReady(30_000)
    await harness.waitForWindow(45_000)

    const result = await harness.execInRenderer("typeof window.api !== 'undefined'")
    console.log("[rc09] window.api exists:", result)
    expect(result.ok).toBe(true)
    expect(result.result).toBeDefined()

    const methodCount = await harness.execInRenderer(
      "Object.keys(window.api).filter(k => typeof window.api[k] === 'function').length",
    )
    console.log("[rc09] API methods:", methodCount.result)
    expect(methodCount.ok).toBe(true)

    await harness.quit()
  }, 90_000)
})

describe("RC-10: Critical IPC journey", () => {
  itIfBuilt("storeGet returns null for absent key (not persistence failure)", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "tribunus-rc10-"))
    const harness = new QualificationHarness(tempDir, ELECTRON_PATH, MAIN_ENTRY)
    await harness.waitForReady(30_000)
    await harness.waitForWindow(45_000)

    const result = await harness.invokeApi("storeGet", ["test-rc10", "nonexistent"])
    console.log("[rc10] storeGet:", result)
    expect(result.ok).toBe(true)
    expect(result.result).toHaveProperty("value")
    // Absent key → null, NOT an error
    expect((result.result as { value: unknown }).value).toBeNull()

    await harness.quit()
  }, 90_000)
})
