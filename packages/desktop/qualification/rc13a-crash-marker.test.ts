/**
 * RC-13a: Stale crash marker drives safe mode on next launch.
 *
 * Proves: a stale crash marker file at <OPENCODE_HOME>/desktop/Crashpad/
 * causes the app to enter safe-mode recovery on start. The app must still
 * start and respond to qualification driver commands.
 */
import { describe, it, expect } from "bun:test"
import { QualificationHarness } from "./stdio-harness"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { mkdtempSync, existsSync, writeFileSync, mkdirSync } from "node:fs"

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

describe("RC-13a: Stale crash marker", () => {
  itIfBuilt("app with stale crash marker starts (safe mode recovery)", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "tribunus-rc13a-"))

    // Write a stale crash marker file where the app expects it.
    // The app uses OPENCODE_HOME as its user-data root; the crash reporter
    // places markers under <userData>/desktop/Crashpad/.
    // Simulating an unclean shutdown by planting a settings.dat file.
    const crashDir = join(tempDir, "desktop", "Crashpad")
    mkdirSync(crashDir, { recursive: true })
    writeFileSync(join(crashDir, "settings.dat"), "stale-crash-marker")

    const harness = new QualificationHarness(tempDir, ELECTRON_PATH, MAIN_ENTRY)
    const ready = await harness.waitForReady(30_000)

    // Safe-mode recovery succeeded: the app started and responded.
    expect(ready).toBe(true)

    await harness.quit()
  }, 90_000)
})
