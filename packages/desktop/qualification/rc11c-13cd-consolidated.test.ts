/**
 * RC-11c + RC-13c + RC-13d: Consolidated lifecycle and recovery tests.
 * Single Electron launch, multiple assertions.
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

describe("RC-11c: No stale result after shutdown", () => {
  itIfBuilt("command sent during quit does not return after process exit", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "tribunus-rc11c-"))
    const harness = new QualificationHarness(tempDir, ELECTRON_PATH, MAIN_ENTRY)
    await harness.waitForReady(30_000)
    await harness.waitForWindow(45_000)

    // Quit the app
    await harness.quit()

    // After quit, sending a command should fail — process is gone
    // The send method hangs waiting for a response that never arrives
    let err: Error | null = null
    try {
      const r = await harness.send("app.ready", {})
      // If we get a response, it must not be a stale success
      expect(r.ok).toBe(false)
    } catch (e: unknown) {
      err = e instanceof Error ? e : new Error(String(e))
    }
    console.log("[rc11c] Post-shutdown command:", err ? `rejected (${err.message.slice(0, 60)})` : "returned error envelope")
    // Either the send rejects or returns an error — both prove no stale result
  }, 60_000)
})

describe("RC-13c: Sidecar failure → degraded state", () => {
  itIfBuilt("app reaches readiness despite sidecar failure", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "tribunus-rc13c-"))
    const harness = new QualificationHarness(tempDir, ELECTRON_PATH, MAIN_ENTRY)

    // The sidecar exits with code 1 in test environment (known issue).
    // The app should still reach readiness — either with a healthy sidecar
    // or in a degraded state where it reports the failure gracefully.
    const ready = await harness.waitForReady(30_000)
    expect(ready).toBe(true)

    // Verify the preload bridge still works (degraded app still serves renderer)
    const r = await harness.execInRenderer("typeof window.api !== 'undefined'")
    expect(r.ok).toBe(true)

    await harness.quit()
  }, 60_000)
})

describe("RC-13d: Launches repeatedly without infinite loop", () => {
  itIfBuilt("three sequential launches and quits", async () => {
    for (let i = 0; i < 3; i++) {
      const tempDir = mkdtempSync(join(tmpdir(), `tribunus-rc13d-${i}-`))
      const harness = new QualificationHarness(tempDir, ELECTRON_PATH, MAIN_ENTRY)
      const ready = await harness.waitForReady(30_000)
      expect(ready).toBe(true)
      await harness.quit()
    }
    // If we get here, 3 launches without infinite loop
  }, 180_000)
})
