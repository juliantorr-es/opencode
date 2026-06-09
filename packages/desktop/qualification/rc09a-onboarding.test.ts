/**
 * RC-09a: Empty-profile first launch (onboarding path).
 *
 * **LIMITATION**: The QualificationHarness constructor hardcodes
 * `TRIBUNUS_TEST_ONBOARDING: "1"` in its env block and does not accept
 * env overrides.  This means the test *cannot* currently exercise a truly
 * empty-profile first launch — the app always receives the test-onboarding
 * flag regardless of what the caller wants.
 *
 * To fix this the harness would need a fourth constructor parameter
 * (e.g. `envOverrides?: Record<string, string | undefined>`) that gets
 * spread *after* the defaults so callers can unset or override any key.
 * That change would let this test pass `{ TRIBUNUS_TEST_ONBOARDING: undefined }`
 * to trigger the real onboarding path.
 *
 * For now the test runs with the default harness env (test-onboarding active)
 * and documents the gap.
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

describe("RC-09a: Empty-profile first launch", () => {
  itIfBuilt("app starts from empty profile (default harness env — test-onboarding active)", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "tribunus-rc09a-"))
    // NOTE: env-override support does not exist yet in QualificationHarness.
    //       See the file-level doc comment for the design of the fix.
    const harness = new QualificationHarness(tempDir, ELECTRON_PATH, MAIN_ENTRY)
    const ready = await harness.waitForReady(30_000)
    expect(ready).toBe(true)
    await harness.quit()
  }, 90_000)
})
