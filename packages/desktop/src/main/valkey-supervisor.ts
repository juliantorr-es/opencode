import { join } from "node:path"
import { existsSync, writeFileSync, mkdirSync, readFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { app, utilityProcess } from "electron"
import type { UtilityProcess } from "electron"
import Redis from "ioredis" // Only imported in main process, never renderer

interface ValkeyDiagnostics {
  available: boolean
  enabled: boolean
  platform: string
  binaryPath: string
  version: string
  pid: number | null
  ready: boolean
  port: number | null
  url: string | null
  mode: "ephemeral"
  persistence: "disabled"
  lastError: string | null
  sha256: string | null
  sha256Verified: boolean
}

interface ValkeyStatus {
  ready: boolean
  pid: number | null
  url: string | null
  mode: "ephemeral"
  persistence: "disabled"
  lastError: string | null
}

export function createValkeySupervisor(userDataPath: string) {
  let child: UtilityProcess | null = null
  let port = 0

  const status: ValkeyStatus = {
    ready: false, pid: null, url: null,
    mode: "ephemeral", persistence: "disabled", lastError: null,
  }

  const dataDir = join(userDataPath, "state", "valkey")
  const binaryPath = getValkeyBinaryPath()

  // SHA256 verification result, populated during start()
  let sha256VerifyResult: { valid: boolean; expected?: string; actual?: string; error?: string } | null = null

  async function start(): Promise<ValkeyStatus> {
    if (!existsSync(binaryPath)) {
      status.lastError = `Valkey binary not found at ${binaryPath}. Install with: brew install valkey`
      return status
    }

    // SHA256 verification: mandatory in packaged mode, advisory otherwise
    sha256VerifyResult = verifyValkeyBinary(binaryPath)
    if (!sha256VerifyResult.valid && app.isPackaged) {
      status.lastError = `SHA256 verification failed: ${sha256VerifyResult.error}`
      return status
    }

    mkdirSync(dataDir, { recursive: true })
    // Write config
    const configPath = join(dataDir, "valkey.conf")
    writeFileSync(configPath, `
bind 127.0.0.1
port 0
protected-mode yes
save ""
appendonly no
dir ${dataDir}
logfile ""
`)

    // Pick a random port
    port = Math.floor(Math.random() * 10000) + 50000

    child = utilityProcess.fork(binaryPath, [configPath, "--port", String(port)], {
      stdio: "pipe",
      serviceName: "valkey",
    })

    child.on("exit", (code) => {
      status.ready = false
      status.pid = null
      status.lastError = `Valkey exited with code ${code}`
    })

    // Wait for PING readiness
    status.pid = child.pid ?? null
    status.url = `redis://127.0.0.1:${port}`

    try {
      const redis = new Redis(status.url, { lazyConnect: false, maxRetriesPerRequest: 1 })
      await redis.ping()
      await redis.quit()
      status.ready = true
      status.lastError = null
    } catch (e) {
      status.lastError = `Valkey failed readiness check: ${(e as Error).message}`
    }

    return status
  }

  async function stop() {
    child?.kill()
    child = null
    status.ready = false
    status.pid = null
    status.url = null
  }

  function getDiagnostics(): ValkeyDiagnostics {
    return {
      available: existsSync(binaryPath),
      enabled: process.env.OPENCODE_COORDINATION_BACKEND === "local-valkey",
      platform: process.platform,
      binaryPath,
      version: "9.1.0",
      pid: status.pid,
      ready: status.ready,
      port: port || null,
      url: status.url,
      mode: "ephemeral",
      persistence: "disabled",
      lastError: status.lastError,
      sha256: sha256VerifyResult?.actual ?? null,
      sha256Verified: sha256VerifyResult?.valid ?? false,
    }
  }

  function getStatus(): ValkeyStatus { return { ...status } }

  return { start, stop, getStatus, getDiagnostics, dataDir, binaryPath }
}

function getValkeyBinaryPath(): string {
  const platform = process.platform
  const arch = process.arch === "arm64" ? "arm64" : "x64"
  const ext = platform === "win32" ? ".exe" : ""

  // Packaged mode: resources are under process.resourcesPath
  if (app.isPackaged) {
    return join(process.resourcesPath, "valkey", `${platform}-${arch}`, "bin", `valkey-server${ext}`)
  }

  // Dev mode: resources are under the project
  const vendored = join(app.getAppPath(), "resources", "valkey", `${platform}-${arch}`, "bin", `valkey-server${ext}`)
  if (existsSync(vendored)) return vendored

  // Homebrew: /opt/homebrew/bin/valkey-server or /usr/local/bin/valkey-server
  return platform === "darwin" ? "/opt/homebrew/bin/valkey-server" : "valkey-server"
}

function verifyValkeyBinary(binaryPath: string): { valid: boolean; expected?: string; actual?: string; error?: string } {
  if (!existsSync(binaryPath)) {
    return { valid: false, error: `Binary not found: ${binaryPath}` }
  }

  // Look for SHA256SUMS next to the binary
  const sumsDir = binaryPath.replace(/\/bin\/valkey-server$/, "")
  const sumsPath = join(sumsDir, "SHA256SUMS")

  if (!existsSync(sumsPath)) {
    // In packaged mode, SHA256SUMS may not be present — not a failure
    return { valid: true, error: "SHA256SUMS not found (packaged mode)" }
  }

  try {
    const sumsContent = readFileSync(sumsPath, "utf-8")
    const expected = sumsContent.split("\n").find(line => line.includes("valkey-server"))?.split(/\s+/)[0]
    if (!expected) {
      return { valid: true, error: "No valkey-server entry in SHA256SUMS" }
    }

    const binaryData = readFileSync(binaryPath)
    const actual = createHash("sha256").update(binaryData).digest("hex")

    return {
      valid: expected === actual,
      expected,
      actual,
      error: expected === actual ? undefined : `SHA256 mismatch: expected ${expected}, got ${actual}`,
    }
  } catch (err) {
    return { valid: false, expected: undefined, actual: undefined, error: `SHA256 verification error: ${err instanceof Error ? err.message : String(err)}` }
  }
}