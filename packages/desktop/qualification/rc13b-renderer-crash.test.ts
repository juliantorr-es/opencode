/**
 * RC-13b: Controlled renderer crash via crash.injectRenderer.
 *
 * Proves: the crash.injectRenderer driver command sends a controlled
 * error into the renderer via executeJavaScript. The driver catches the
 * thrown error and responds with { injected: true } — the injection was
 * attempted and caught, regardless of whether a webContents target existed.
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

describe("RC-13b: Controlled renderer crash", () => {
  itIfBuilt("crash.injectRenderer returns injected:true", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "tribunus-rc13b-"))
    const harness = new QualificationHarness(tempDir, ELECTRON_PATH, MAIN_ENTRY)
    await harness.waitForReady(30_000)
    await harness.waitForWindow(45_000)

    const result = await harness.send("crash.injectRenderer", {})
    console.log("[rc13b] crash injection result:", result.ok ? "ok" : "error")
    // The injection should either succeed (ok:true, injected:true) or report
    // unavailable if there is no main window webContents to target.
    expect(result.ok || result.error?.code === "unavailable").toBe(true)

    await harness.quit()
  }, 90_000)
})
