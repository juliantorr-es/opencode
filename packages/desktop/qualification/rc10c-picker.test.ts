/**
 * RC-10c: Filesystem picker cancellation returns null (not an error).
 *
 * With no GUI user in the test harness, pickers immediately cancel or
 * return null.  The key invariant: the result is null on cancellation,
 * not a thrown ReadableIpcError.
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

describe("RC-10c: Filesystem picker cancellation", () => {
  itIfBuilt("openDirectoryPicker returns null on cancellation", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "tribunus-rc10c-"))
    const harness = new QualificationHarness(tempDir, ELECTRON_PATH, MAIN_ENTRY)
    await harness.waitForReady(30_000)
    await harness.waitForWindow(45_000)

    const result = await harness.invokeApi("openDirectoryPicker", [])
    console.log("[rc10c] openDirectoryPicker:", result)
    expect(result.ok).toBe(true)
    // Cancellation → null, NOT an error
    expect(result.result).toBeNull()

    await harness.quit()
  }, 90_000)

  itIfBuilt("openFilePicker returns null on cancellation", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "tribunus-rc10c-"))
    const harness = new QualificationHarness(tempDir, ELECTRON_PATH, MAIN_ENTRY)
    await harness.waitForReady(30_000)
    await harness.waitForWindow(45_000)

    const result = await harness.invokeApi("openFilePicker", [])
    console.log("[rc10c] openFilePicker:", result)
    expect(result.ok).toBe(true)
    expect(result.result).toBeNull()

    await harness.quit()
  }, 90_000)

  itIfBuilt("saveFilePicker returns null on cancellation", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "tribunus-rc10c-"))
    const harness = new QualificationHarness(tempDir, ELECTRON_PATH, MAIN_ENTRY)
    await harness.waitForReady(30_000)
    await harness.waitForWindow(45_000)

    const result = await harness.invokeApi("saveFilePicker", [])
    console.log("[rc10c] saveFilePicker:", result)
    expect(result.ok).toBe(true)
    expect(result.result).toBeNull()

    await harness.quit()
  }, 90_000)

  itIfBuilt("readClipboardImage returns null on cancellation", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "tribunus-rc10c-"))
    const harness = new QualificationHarness(tempDir, ELECTRON_PATH, MAIN_ENTRY)
    await harness.waitForReady(30_000)
    await harness.waitForWindow(45_000)

    const result = await harness.invokeApi("readClipboardImage", [])
    console.log("[rc10c] readClipboardImage:", result)
    expect(result.ok).toBe(true)
    // readClipboardImage returns object | null; cancellation → null
    expect(result.result).toBeNull()

    await harness.quit()
  }, 90_000)
})
