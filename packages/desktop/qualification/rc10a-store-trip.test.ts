/**
 * RC-10a: Store write → read → delete round trip through the real preload bridge.
 *
 * Uses the IPC-over-stdio qualification driver to launch the real Electron app,
 * wait for renderer readiness, and exercise storeSet / storeGet / storeDelete
 * through window.api over the stdio channel.
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

describe("RC-10a: Store write/read/delete round trip", () => {
  itIfBuilt("writes a value, reads it back, deletes it, verifies null", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "tribunus-rc10a-"))
    const harness = new QualificationHarness(tempDir, ELECTRON_PATH, MAIN_ENTRY)
    await harness.waitForReady(30_000)
    await harness.waitForWindow(45_000)

    // 1. Write a value
    const writeResult = await harness.invokeApi("storeSet", ["test-rc10a", "roundtrip-key", "hello-world"])
    console.log("[rc10a] storeSet:", writeResult)
    expect(writeResult.ok).toBe(true)

    // 2. Read it back and verify
    const readResult = await harness.invokeApi("storeGet", ["test-rc10a", "roundtrip-key"])
    console.log("[rc10a] storeGet after write:", readResult)
    expect(readResult.ok).toBe(true)
    expect(readResult.result).toHaveProperty("value")
    expect((readResult.result as { value: unknown }).value).toBe("hello-world")

    // 3. Delete it
    const deleteResult = await harness.invokeApi("storeDelete", ["test-rc10a", "roundtrip-key"])
    console.log("[rc10a] storeDelete:", deleteResult)
    expect(deleteResult.ok).toBe(true)

    // 4. Read again — must be null
    const readAfterDelete = await harness.invokeApi("storeGet", ["test-rc10a", "roundtrip-key"])
    console.log("[rc10a] storeGet after delete:", readAfterDelete)
    expect(readAfterDelete.ok).toBe(true)
    expect(readAfterDelete.result).toHaveProperty("value")
    expect((readAfterDelete.result as { value: unknown }).value).toBeNull()

    await harness.quit()
  }, 90_000)
})
