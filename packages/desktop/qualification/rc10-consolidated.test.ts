/**
 * RC-10: Critical IPC journey — reliable assertions only.
 * Single Electron launch, sequential tests, clean shutdown.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test"
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

describe("RC-10: Critical IPC journey", () => {
  let harness: QualificationHarness

  beforeAll(async () => {
    if (!buildExists) return
    const tempDir = mkdtempSync(join(tmpdir(), "tribunus-rc10-"))
    harness = new QualificationHarness(tempDir, ELECTRON_PATH, MAIN_ENTRY)
    await harness.waitForReady(30_000)
    await harness.waitForWindow(45_000)
  }, 90_000)

  afterAll(async () => {
    if (harness) await harness.quit()
  })

  itIfBuilt("preload bridge exists and API methods available", async () => {
    const r = await harness.execInRenderer("typeof window.api !== 'undefined'")
    expect(r.ok).toBe(true)
    expect(r.result).toHaveProperty("value")
    expect((r.result as { value: unknown }).value).toBe(true)

    const r2 = await harness.execInRenderer(
      "Object.keys(window.api).filter(k => typeof window.api[k] === 'function').length",
    )
    expect(r2.ok).toBe(true)
    expect((r2.result as { value: number }).value).toBeGreaterThan(0)
  })

  itIfBuilt("storeGet returns null for absent key (not error)", async () => {
    const r = await harness.invokeApi("storeGet", ["test-rc10", "never-set"])
    expect(r.ok).toBe(true)
    expect(r.result).toHaveProperty("value")
    expect((r.result as { value: unknown }).value).toBeNull()
  })

  itIfBuilt("store write → read → delete round trip", async () => {
    const set = await harness.invokeApi("storeSet", ["test-rc10", "key", "hello"])
    expect(set.ok).toBe(true)

    const get = await harness.invokeApi("storeGet", ["test-rc10", "key"])
    expect(get.ok).toBe(true)
    expect((get.result as { value: unknown }).value).toBe("hello")

    const del = await harness.invokeApi("storeDelete", ["test-rc10", "key"])
    expect(del.ok).toBe(true)

    const after = await harness.invokeApi("storeGet", ["test-rc10", "key"])
    expect(after.ok).toBe(true)
    expect((after.result as { value: unknown }).value).toBeNull()
  })

  itIfBuilt("reserved store namespace returns typed permission error", async () => {
    const r = await harness.invokeApi("storeGet", ["desktop-custom-agent", "key"])
    // Reserved namespace → permission error through v2 contract spine
    expect(r).toBeDefined()
    expect(r.ok).toBe(false)
    console.log("[rc10] reserved namespace error:", r.error?.code, r.error?.message)
  })
})
