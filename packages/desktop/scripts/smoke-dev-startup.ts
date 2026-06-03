/**
 * Desktop Dev Startup Smoke Test
 *
 * Starts the Electron app, captures its output, and fails if any of
 * the known startup failure patterns appear in the logs.
 *
 * Usage: bun run packages/desktop/scripts/smoke-dev-startup.ts
 */

import { spawn } from "node:child_process"

const TIMEOUT_MS = 30000
const FORBIDDEN_PATTERNS = [
  "IPC Registry Mismatch",
  "No server available",
  "OPENCODE_STATE_HOME",
  "UnhandledPromiseRejectionWarning",
  "could not be resolved",
  "fatal renderer error",
  "IPC_METHOD_REGISTRY",
  "has no ipcMain.handle registration",
]

const REQUIRED_PATTERNS = [
  "server ready",
  "product:",
]

let output = ""
let failures = 0
let requiredFound = new Set<string>()

function fail(reason: string) {
  failures++
  console.error(`  FAIL: ${reason}`)
}

function pass(reason: string) {
  console.log(`  PASS: ${reason}`)
}

console.log("Tribunus Desktop Dev Startup Smoke Test")
console.log(`Timeout: ${TIMEOUT_MS / 1000}s`)
console.log("")

const proc = spawn("bun", ["run", "dev:desktop"], {
  cwd: process.cwd(),
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, ELECTRON_ENABLE_LOGGING: "1" },
})

const timer = setTimeout(() => {
  fail(`Timeout after ${TIMEOUT_MS / 1000}s`)
  proc.kill()
  process.exit(1)
}, TIMEOUT_MS)

function onData(data: Buffer) {
  const text = data.toString()
  output += text

  // Check forbidden patterns
  for (const pattern of FORBIDDEN_PATTERNS) {
    if (text.includes(pattern)) {
      fail(`Found forbidden pattern: "${pattern}"`)
    }
  }

  // Check required patterns
  for (const pattern of REQUIRED_PATTERNS) {
    if (text.includes(pattern)) {
      requiredFound.add(pattern)
    }
  }

  // If we've found server ready, the app is up
  if (text.includes("server ready") && text.includes("url:")) {
    console.log("  Server detected — app is running")
    // Give it a moment to finish startup, then kill
    setTimeout(() => {
      clearTimeout(timer)
      proc.kill()
      summarize()
    }, 2000)
  }
}

proc.stdout?.on("data", onData)
proc.stderr?.on("data", onData)

proc.on("exit", (code) => {
  clearTimeout(timer)
  summarize()
})

function summarize() {
  console.log("")
  console.log("=== Required patterns ===")
  for (const pattern of REQUIRED_PATTERNS) {
    if (requiredFound.has(pattern)) {
      pass(`Found: ${pattern}`)
    } else {
      fail(`Missing: ${pattern}`)
    }
  }

  console.log("")
  console.log(`Failures: ${failures}`)

  if (failures > 0) {
    console.log("")
    console.log("=== Log excerpt (last 40 lines) ===")
    const lines = output.split("\n").slice(-40)
    for (const line of lines) console.log(line)
    process.exit(1)
  }

  console.log("")
  console.log("Startup smoke test PASSED")
  process.exit(0)
}
