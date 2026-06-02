import { join } from "path"
import { existsSync, writeFileSync, mkdirSync } from "fs"
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

  async function start(): Promise<ValkeyStatus> {
    if (!existsSync(binaryPath)) {
      status.lastError = `Valkey binary not found at ${binaryPath}. Install with: brew install valkey`
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
    }
  }

  function getStatus(): ValkeyStatus { return { ...status } }

  return { start, stop, getStatus, getDiagnostics, dataDir, binaryPath }
}

function getValkeyBinaryPath(): string {
  const platform = process.platform
  const arch = process.arch === "arm64" ? "arm64" : "x64"
  const ext = platform === "win32" ? ".exe" : ""
  // Check vendored binary first, then fall back to system PATH
  const vendored = join(app.getAppPath(), "resources", "valkey", `${platform}-${arch}`, "bin", `valkey-server${ext}`)
  if (existsSync(vendored)) return vendored
  // Homebrew: /opt/homebrew/bin/valkey-server or /usr/local/bin/valkey-server
  return platform === "darwin" ? "/opt/homebrew/bin/valkey-server" : "valkey-server"
}
