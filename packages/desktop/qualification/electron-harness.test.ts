/**
 * Electron Playwright qualification harness for Tribunus Desktop.
 *
 * Launches the production-built Electron app in an isolated temporary profile
 * through Playwright's _electron.launch(), verifies semantic readiness,
 * exercises critical IPC, and proves clean shutdown.
 *
 * Usage: cd packages/desktop && bun test qualification/electron-harness.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test"
import { _electron as electron } from "playwright"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { mkdtempSync, existsSync } from "node:fs"

const DESKTOP_DIR = resolve(import.meta.dir, "..")
const MAIN_ENTRY = join(DESKTOP_DIR, "out", "main", "index.js")

// Electron binary from the monorepo node_modules
const REPO_ROOT = resolve(DESKTOP_DIR, "..", "..")
const ELECTRON_PATH = join(
  REPO_ROOT,
  "node_modules", ".bun", "electron@41.2.1",
  "node_modules", "electron", "dist",
  "Electron.app", "Contents", "MacOS", "Electron",
)

const buildExists = existsSync(MAIN_ENTRY)
const itIfBuilt = buildExists ? it : it.skip

describe("Electron Playwright Harness", () => {
  let app: Awaited<ReturnType<typeof electron.launch>>
  let tempDir: string

  beforeAll(() => {
    if (!buildExists) {
      console.warn("[harness] Build output not found at", MAIN_ENTRY)
      console.warn("[harness] Run: cd packages/desktop && bun run build")
    }
  })

  afterAll(async () => {
    if (app) {
      try { await app.close() } catch { /* may already be closed */ }
    }
  })

  itIfBuilt("launches the application and obtains firstWindow", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "tribunus-qual-"))

    app = await electron.launch({
      executablePath: ELECTRON_PATH,
      args: [MAIN_ENTRY],
      cwd: DESKTOP_DIR,
      env: {
        ...process.env,
        OPENCODE_HOME: tempDir,
        OPENCODE_DB: ":memory:",
        TRIBUNUS_DB: ":memory:",
        TRIBUNUS_TEST_ONBOARDING: "1",
        OPENCODE_TEST_ONBOARDING: "1",
        TRIBUNUS_NO_UPDATE: "1",
        TRIBUNUS_CHANNEL: "dev",
        OPENCODE_CHANNEL: "dev",
        ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
      },
      timeout: 45_000,
    })

    expect(app).toBeDefined()

    const window = await app.firstWindow()
    expect(window).toBeDefined()
    const title = await window.title()
    console.log("[harness] Window title:", title)
    expect(title).toBeTruthy()
    await window.waitForLoadState("domcontentloaded")
  }, 60_000)

  itIfBuilt("completes preload handshake (window.api exists)", async () => {
    const window = app.windows()[0]
    expect(window).toBeDefined()

    const api = await window.evaluate(() => {
      return typeof (window as unknown as { api?: unknown }).api !== "undefined"
    })
    expect(api).toBe(true)

    const methods = await window.evaluate(() => {
      const w = window as unknown as { api?: Record<string, unknown> }
      if (!w.api) return [] as string[]
      return Object.keys(w.api).filter((k) => typeof w.api[k] === "function")
    })
    console.log("[harness] Exposed API methods:", methods.length)
    expect(methods.length).toBeGreaterThan(0)
    expect(methods).toContain("storeGet")
    expect(methods).toContain("getWindowConfig")
  }, 30_000)

  itIfBuilt("responds to store IPC through migrated v2 contract", async () => {
    const window = app.windows()[0]
    const result = await window.evaluate(async () => {
      const w = window as unknown as {
        api: { storeGet: (name: string, key: string) => Promise<string | null> }
      }
      return w.api.storeGet("test-qual-store", "nonexistent-key")
    })
    console.log("[harness] storeGet result:", result)
    expect(result).toBeNull()
  }, 30_000)

  itIfBuilt("shuts down cleanly", async () => {
    await app.close()
    app = undefined as unknown as typeof app
    expect(tempDir).toBeDefined()
    console.log("[harness] Temp profile:", tempDir)
  }, 30_000)
})
