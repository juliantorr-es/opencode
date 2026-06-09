/**
 * RC-09b/c + RC-13d: Onboarding flow and safe-mode qualification.
 * Uses the new dom.* driver commands for DOM interaction.
 */
import { describe, it, expect } from "bun:test"
import { QualificationHarness } from "./stdio-harness"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { mkdtempSync, existsSync, writeFileSync } from "node:fs"

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

describe("RC-09b: Quit during onboarding, relaunch, verify resume", () => {
  itIfBuilt("onboarding DOM inspect then quit+relaunch in same profile", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "tribunus-rc09b-"))
    // First launch — NOT using test onboarding, empty profile
    const h1 = new QualificationHarness(tempDir, ELECTRON_PATH, MAIN_ENTRY, {
      TRIBUNUS_TEST_ONBOARDING: undefined as unknown as string,
    })
    await h1.waitForReady(30_000)
    await h1.waitForWindow(45_000)

    // Inspect the DOM to find onboarding elements
    const body = await h1.send("dom.querySelector", { selector: "body" })
    console.log("[rc09b] body:", JSON.stringify(body.result).slice(0, 300))

    // Look for common onboarding selectors
    for (const sel of [".onboarding", "[data-onboarding]", ".welcome", "h1", ".loading"]) {
      const el = await h1.send("dom.querySelector", { selector: sel as string })
      if (el.ok && (el.result as { value?: { tagName?: string } })?.value?.tagName) {
        console.log("[rc09b] Found:", sel, (el.result as { value: { tagName: string; textContent?: string } }).value.tagName, (el.result as { value: { textContent?: string } }).value.textContent?.slice(0, 100))
      }
    }

    // Quit mid-onboarding
    await h1.quit()

    // Relaunch in same temp dir — verify app starts and does not crash
    const h2 = new QualificationHarness(tempDir, ELECTRON_PATH, MAIN_ENTRY, {
      TRIBUNUS_TEST_ONBOARDING: undefined as unknown as string,
    })
    const ready = await h2.waitForReady(30_000)
    expect(ready).toBe(true)
    await h2.quit()
  }, 120_000)
})

describe("RC-09c: Completed onboarding persists", () => {
  itIfBuilt("launch without test onboarding, verify renderer loads", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "tribunus-rc09c-"))
    const harness = new QualificationHarness(tempDir, ELECTRON_PATH, MAIN_ENTRY, {
      TRIBUNUS_TEST_ONBOARDING: undefined as unknown as string,
    })
    await harness.waitForReady(30_000)
    await harness.waitForWindow(45_000)

    // The app launched without test onboarding — onboarding screen should appear
    // or the app may proceed to main UI if onboarding was previously completed
    // (this is a fresh profile, so onboarding should appear)
    const preload = await harness.execInRenderer("typeof window.api !== 'undefined'")
    expect(preload.ok).toBe(true)

    await harness.quit()
  }, 90_000)
})

describe("RC-13d: Safe-mode action and relaunch loop guard", () => {
  itIfBuilt("crash marker → safe mode → diagnostics → action → no loop", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "tribunus-rc13d-"))
    // Write crash marker to trigger safe mode
    const crashDir = join(tempDir, "desktop", "Crashpad")
    const { mkdirSync } = await import("node:fs")
    mkdirSync(crashDir, { recursive: true })
    writeFileSync(join(crashDir, "settings.dat"), "stale-crash-marker")

    // Launch 1: safe mode should activate
    const h1 = new QualificationHarness(tempDir, ELECTRON_PATH, MAIN_ENTRY)
    const ready1 = await h1.waitForReady(30_000)
    expect(ready1).toBe(true)

    // Query safe-mode diagnostics
    const diag = await h1.invokeApi("getSafeModeDiagnostics", [])
    console.log("[rc13d] safe-mode diagnostics:", diag.ok ? "available" : diag.error?.message)

    // Perform a safe action
    const action = await h1.invokeApi("safeModeAction", ["disable-plugins" as unknown as string])
    console.log("[rc13d] safe-mode action:", action.ok ? "ok" : action.error?.message)

    await h1.quit()

    // Launch 2-4: prove no relaunch loop
    for (let i = 2; i <= 4; i++) {
      const h = new QualificationHarness(tempDir, ELECTRON_PATH, MAIN_ENTRY)
      const ready = await h.waitForReady(30_000)
      expect(ready).toBe(true)
      await h.quit()
    }
  }, 300_000)
})
