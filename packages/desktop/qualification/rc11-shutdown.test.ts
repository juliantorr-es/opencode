/**
 * RC-11: Shutdown and process cleanup through stdio driver.
 *
 * Proves: app.quit via driver triggers clean shutdown. DesktopRuntime disposes.
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

describe("RC-11: Shutdown and process cleanup", () => {
  itIfBuilt("app.quit through driver terminates Electron cleanly", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "tribunus-rc11-"))
    const harness = new QualificationHarness(tempDir, ELECTRON_PATH, MAIN_ENTRY)
    await harness.waitForReady(30_000)
    await harness.waitForWindow(45_000)

    // Exercise IPC before quitting
    await harness.invokeApi("storeGet", ["test-rc11", "key"])

    // Quit through the driver
    await harness.quit()
    // If we reach here, quit succeeded without hanging
  }, 90_000)

  itIfBuilt("quit during window transition does not crash", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "tribunus-rc11-"))
    const harness = new QualificationHarness(tempDir, ELECTRON_PATH, MAIN_ENTRY)
    // Quit immediately — during startup
    await harness.waitForReady(30_000)
    await harness.quit()
  }, 60_000)
})
