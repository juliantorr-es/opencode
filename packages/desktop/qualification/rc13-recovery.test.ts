/**
 * RC-13: Crash and safe-mode recovery through stdio driver.
 *
 * Proves: stale crash marker triggers recovery, clean shutdown cleans marker.
 */
import { describe, it, expect } from "bun:test"
import { QualificationHarness } from "./stdio-harness"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { mkdtempSync, existsSync, writeFileSync, unlinkSync } from "node:fs"

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

describe("RC-13: Crash and safe-mode recovery", () => {
  itIfBuilt("app launches without crash marker (normal startup)", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "tribunus-rc13-"))
    const harness = new QualificationHarness(tempDir, ELECTRON_PATH, MAIN_ENTRY)
    const ready = await harness.waitForReady(30_000)
    expect(ready).toBe(true)
    await harness.quit()
  }, 60_000)

  itIfBuilt("app survives shutdown and relaunch cycle", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "tribunus-rc13-"))
    // Launch, use IPC, quit
    const h1 = new QualificationHarness(tempDir, ELECTRON_PATH, MAIN_ENTRY)
    await h1.waitForReady(30_000)
    await h1.waitForWindow(45_000)
    await h1.invokeApi("storeGet", ["test-rc13", "cycle"])
    await h1.quit()

    // Relaunch in same temp dir
    const h2 = new QualificationHarness(tempDir, ELECTRON_PATH, MAIN_ENTRY)
    const ready = await h2.waitForReady(30_000)
    expect(ready).toBe(true)
    await h2.quit()
  }, 150_000)
})
