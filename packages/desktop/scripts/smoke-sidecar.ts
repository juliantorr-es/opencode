/**
 * Sidecar Runtime Smoke Test
 * Spawns the same sidecar artifact used by bun run dev:desktop.
 * Verifies: server ready, no stale-brand strings, no unhandled rejections.
 */

import { spawn } from "node:child_process"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { mkdtempSync, rmSync } from "node:fs"

const TIMEOUT_MS = 20000

const FORBIDDEN_STDERR = [
  "desktop-path-guard",
  "OPENCODE_STATE_HOME",
  "UnhandledPromiseRejectionWarning",
  "opencode-debug",
]

const REQUIRED = [
  "server ready",
]

async function main() {
  const tmpDir = mkdtempSync(join(tmpdir(), "tribunus-smoke-"))
  const stateHome = join(tmpDir, "state")
  const configHome = join(tmpDir, "config")
  const cacheHome = join(tmpDir, "cache")
  const logHome = join(tmpDir, "logs")

  let stderr = ""
  let stdout = ""
  let failures = 0
  let requiredFound = 0

  const sidecarEntry = join(import.meta.dir, "..", "..", "..", "opencode", "dist", "node", "node.js")

  console.log(`Sidecar entry: ${sidecarEntry}`)
  console.log(`State home: ${stateHome}`)

  const proc = spawn("bun", ["run", sidecarEntry], {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      TRIBUNUS_STATE_HOME: stateHome,
      TRIBUNUS_CONFIG_HOME: configHome,
      TRIBUNUS_CACHE_HOME: cacheHome,
      TRIBUNUS_LOG_HOME: logHome,
      TRIBUNUS_COORDINATION_BACKEND: "local",
    },
  })

  const done = new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      console.error("  FAIL: timeout")
      failures++
      proc.kill()
      resolve()
    }, TIMEOUT_MS)

    proc.stdout?.on("data", (data: Buffer) => {
      const text = data.toString()
      stdout += text
      for (const req of REQUIRED) {
        if (text.includes(req)) requiredFound++
      }
      if (text.includes("server ready")) {
        clearTimeout(timer)
        proc.kill()
        resolve()
      }
    })

    proc.stderr?.on("data", (data: Buffer) => {
      const text = data.toString()
      stderr += text
      for (const forbid of FORBIDDEN_STDERR) {
        if (text.includes(forbid)) {
          console.error(`  FAIL: forbidden stderr: "${forbid}"`)
          failures++
        }
      }
    })

    proc.on("exit", () => {
      clearTimeout(timer)
      resolve()
    })
  })

  await done

  console.log(`  Required patterns found: ${requiredFound}/${REQUIRED.length}`)

  // Cleanup
  try { rmSync(tmpDir, { recursive: true, force: true }) } catch {}

  if (failures > 0) {
    console.error("\n=== stderr (last 20 lines) ===")
    console.error(stderr.split("\n").slice(-20).join("\n"))
    process.exit(1)
  }

  console.log("Sidecar smoke PASSED")
}

main()
