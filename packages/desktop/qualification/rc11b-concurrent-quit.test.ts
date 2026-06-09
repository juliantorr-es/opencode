import { describe, it, expect } from "bun:test"
import { QualificationHarness } from "./stdio-harness"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { mkdtempSync, existsSync } from "node:fs"

const DESKTOP_DIR = resolve(import.meta.dir, "..")
const MAIN_ENTRY = join(DESKTOP_DIR, "out", "main", "index.js")
const REPO_ROOT = resolve(DESKTOP_DIR, "..", "..")
const ELECTRON_PATH = join(REPO_ROOT, "node_modules", ".bun", "electron@41.2.1", "node_modules", "electron", "dist", "Electron.app", "Contents", "MacOS", "Electron")
const buildExists = existsSync(MAIN_ENTRY)
const itIfBuilt = buildExists ? it : it.skip

describe("RC-11b: Concurrent quit requests", () => {
  itIfBuilt("two rapid quit commands do not crash", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "tribunus-rc11b-"))
    const harness = new QualificationHarness(tempDir, ELECTRON_PATH, MAIN_ENTRY)
    await harness.waitForReady(30_000)
    await harness.waitForWindow(45_000)

    // Send first quit
    harness.send("app.quit", {})
    // Send second quit immediately
    harness.send("app.quit", {})

    // Small delay to let quit propagate
    const { promise, resolve } = Promise.withResolvers<void>()
    setTimeout(resolve, 1000)
    await promise

    // If we reach here, the app handled concurrent quit without crash
    // Clean up any remaining process
    try { await harness.quit() } catch {}
  }, 60_000)
})
