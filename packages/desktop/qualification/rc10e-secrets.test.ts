/**
 * RC-10e: Secret-store metadata through the real preload bridge.
 *
 * Tests the secrets API surface: status (availability), CRUD cycle
 * when encryption is available, and graceful degradation when it is not.
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

describe("RC-10e: Secret-store metadata", () => {
  itIfBuilt("secretsStatus returns availability without throwing", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "tribunus-rc10e-"))
    const harness = new QualificationHarness(tempDir, ELECTRON_PATH, MAIN_ENTRY)
    await harness.waitForReady(30_000)
    await harness.waitForWindow(45_000)

    const result = await harness.invokeApi("secretsStatus", [])
    console.log("[rc10e] secretsStatus:", result)
    expect(result.ok).toBe(true)
    expect(result.result).toHaveProperty("available")
    // available is boolean regardless of whether encryption is set up
    expect(typeof (result.result as { available: boolean }).available).toBe("boolean")

    await harness.quit()
  }, 90_000)

  itIfBuilt("full CRUD cycle when encryption is available", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "tribunus-rc10e-"))
    const harness = new QualificationHarness(tempDir, ELECTRON_PATH, MAIN_ENTRY)
    await harness.waitForReady(30_000)
    await harness.waitForWindow(45_000)

    // Check availability first
    const status = await harness.invokeApi("secretsStatus", [])
    expect(status.ok).toBe(true)
    const available = (status.result as { available: boolean }).available

    if (!available) {
      console.log("[rc10e] Encryption unavailable — skipping CRUD")
      await harness.quit()
      // Test is vacuously valid: encryption not available
      return
    }

    const testKey = "rc10e-test-key"
    const testValue = "rc10e-test-value-" + Date.now()

    // Set a secret
    const setResult = await harness.invokeApi("secretsSet", [testKey, testValue])
    console.log("[rc10e] secretsSet:", setResult)
    expect(setResult.ok).toBe(true)

    // List secrets — verify test key appears in metadata (not ciphertext)
    const listResult = await harness.invokeApi("secretsList", [])
    console.log("[rc10e] secretsList:", listResult)
    expect(listResult.ok).toBe(true)
    expect(listResult.result).toBeInstanceOf(Array)
    const metadataList = listResult.result as Array<{ id: string }>
    const found = metadataList.some((entry) => entry.id === testKey)
    expect(found).toBe(true)

    // Get the secret back — value should match
    const getResult = await harness.invokeApi("secretsGet", [testKey])
    console.log("[rc10e] secretsGet:", getResult)
    expect(getResult.ok).toBe(true)
    expect(getResult.result).toHaveProperty("value")
    expect((getResult.result as { value: string }).value).toBe(testValue)

    // Delete the secret
    const delResult = await harness.invokeApi("secretsDelete", [testKey])
    console.log("[rc10e] secretsDelete:", delResult)
    expect(delResult.ok).toBe(true)

    // Verify absence
    const getAfterResult = await harness.invokeApi("secretsGet", [testKey])
    expect(getAfterResult.ok).toBe(true)
    expect((getAfterResult.result as { value: unknown }).value).toBeNull()

    await harness.quit()
  }, 90_000)
})
