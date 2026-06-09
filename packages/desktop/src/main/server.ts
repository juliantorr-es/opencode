import { dirname, join } from "node:path"
import { existsSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { app, utilityProcess } from "electron"
import { registerIpcHandler } from "./ipc-registration"
import { withIpcResult } from "./ipc-contract"
import { IPC } from "./ipc-channels"
import type { Details } from "electron"
import { DEFAULT_SERVER_URL_KEY, WSL_ENABLED_KEY } from "./constants"
import { getUserShell, loadShellEnv } from "./shell-env"
import { getStore } from "./store"
import type { StorageMigrationProgress } from "../preload/types"
import { sanitizeEnv } from "./env-blocklist"
import { resolveDesktopAppDataPaths, ensureDesktopAppDataPaths, ensureDirectories, envForDesktopAppData, report } from "./app-data-paths"

export type WslConfig = { enabled: boolean }

export type HealthCheck = { wait: Promise<void> }

type SidecarMessage =
  | { type: "migration-progress"; progress: StorageMigrationProgress }
  | { type: "ready" }
  | { type: "stopped" }
  | { type: "error"; error: { message: string; stack?: string }; component: string }

export type SidecarListener = { stop: () => Promise<void> }

export interface SidecarState {
  pid: number | null
  url: string | null
  startedAt: number | null
  readyAt: number | null
  lastExitCode: number | null
  restartCount: number
  startupPhases: { phase: string; status: string; timestamp: number }[]
}

let sidecarState: SidecarState = {
  pid: null, url: null, startedAt: null, readyAt: null,
  lastExitCode: null, restartCount: 0, startupPhases: [],
}

let currentSidecarChild: ReturnType<typeof utilityProcess.fork> | null = null
let lastSpawnParams: { hostname: string; port: number; password: string; options: SpawnLocalServerOptions } | null = null

const SIDECAR_SERVICE_NAME = "opencode server"
const SIDECAR_START_STALL_TIMEOUT = 60_000
const SIDECAR_STOP_TIMEOUT = 6_000

type SpawnLocalServerOptions = {
  needsMigration: boolean
  userDataPath: string
  onMigrationProgress?: (progress: StorageMigrationProgress) => void
  onStdout?: (message: string) => void
  onStderr?: (message: string) => void
  onExit?: (code: number) => void
}

export function getDefaultServerUrl(): string | null {
  const value = getStore().get(DEFAULT_SERVER_URL_KEY)
  return typeof value === "string" ? value : null
}

export function setDefaultServerUrl(url: string | null) {
  if (url) {
    getStore().set(DEFAULT_SERVER_URL_KEY, url)
    return
  }

  getStore().delete(DEFAULT_SERVER_URL_KEY)
}

export function getWslConfig(): WslConfig {
  const value = getStore().get(WSL_ENABLED_KEY)
  return { enabled: typeof value === "boolean" ? value : false }
}

export function setWslConfig(config: WslConfig) {
  getStore().set(WSL_ENABLED_KEY, config.enabled)
}

export function preferAppEnv(userDataPath: string) {
  const paths = resolveDesktopAppDataPaths(userDataPath)
  ensureDirectories(paths)
  const shell = process.platform === "win32" ? null : getUserShell()
  const shellEnv = shell ? loadShellEnv(shell) : {}
  Object.assign(process.env, {
    ...shellEnv,
    ...envForDesktopAppData(paths),
    OPENCODE_CLIENT: "desktop",
    OPENCODE_EXPERIMENTAL_ICON_DISCOVERY: "true",
    OPENCODE_EXPERIMENTAL_FILEWATCHER: "true",
  })
}

export async function spawnLocalServer(
  hostname: string,
  port: number,
  password: string,
  options: SpawnLocalServerOptions,
) {
  const sidecar = join(dirname(fileURLToPath(import.meta.url)), "sidecar.js")
  const child = utilityProcess.fork(sidecar, [], {
    cwd: process.cwd(),
    env: createSidecarEnv(options.userDataPath),
    serviceName: SIDECAR_SERVICE_NAME,
    stdio: "pipe",
  })
  currentSidecarChild = child
  lastSpawnParams = { hostname, port, password, options }
  sidecarState.pid = child.pid ?? null
  sidecarState.url = `http://${hostname}:${port}`
  sidecarState.startedAt = Date.now()
  sidecarState.readyAt = null
  sidecarState.lastExitCode = null
  sidecarState.startupPhases = [{ phase: "start", status: "sent", timestamp: Date.now() }]
  let exited = false
  const exit = defer<number>()

  const onProcessGone = (_event: unknown, details: Details) => {
    if (details.type !== "Utility" || details.name !== SIDECAR_SERVICE_NAME) return
    options.onStderr?.(`utility process gone reason=${details.reason} exitCode=${details.exitCode}`)
  }

  app.on("child-process-gone", onProcessGone)
  child.once("exit", (code) => {
    sidecarState.lastExitCode = code
    exited = true
    app.off("child-process-gone", onProcessGone)
    options.onExit?.(code)
    exit.resolve(code)
  })
  child.on("error", (error) => options.onStderr?.(`utility process error: ${serializeError(error).message}`))

  child.stdout?.on("data", (chunk: Buffer) => options.onStdout?.(chunk.toString("utf8").trimEnd()))
  child.stderr?.on("data", (chunk: Buffer) => options.onStderr?.(chunk.toString("utf8").trimEnd()))

  await new Promise<void>((resolve, reject) => {
    let done = false
    let timeout: NodeJS.Timeout

    const fail = (error: Error) => {
      if (done) return
      done = true
      cleanup()
      reject(error)
    }

    const refreshTimeout = () => {
      clearTimeout(timeout)
      timeout = setTimeout(() => {
        fail(new Error(`Sidecar did not become ready within ${SIDECAR_START_STALL_TIMEOUT}ms: ${sidecar}`))
      }, SIDECAR_START_STALL_TIMEOUT)
    }

    const onMessage = (message: SidecarMessage) => {
      if (message.type === "migration-progress") {
        sidecarState.startupPhases.push({ phase: "migration-progress", status: message.progress.type, timestamp: Date.now() })
        refreshTimeout()
        options.onMigrationProgress?.(message.progress)
        return
      }
      if (message.type === "ready") {
        if (done) return
        sidecarState.readyAt = Date.now()
        sidecarState.startupPhases.push({ phase: "ready", status: "completed", timestamp: Date.now() })
        done = true
        cleanup()
        resolve()
        return
      }
      if (message.type === "error") {
        sidecarState.startupPhases.push({ phase: "error", status: message.error.message, timestamp: Date.now() })
        const err = new Error(message.error.message)
        ;(err as any).component = message.component ?? "unknown"
        err.stack = message.error.stack
        // Try to read startup trace for additional diagnostics
        try {
          const tracePath = join(options.userDataPath, "sidecar-startup.jsonl")
          if (existsSync(tracePath)) {
            const lines = readFileSync(tracePath, "utf8").trim().split("\n")
            const lastLine = lines[lines.length - 1]
            if (lastLine) {
              const lastEntry = JSON.parse(lastLine)
              ;(err as any).startupPhase = lastEntry.phase
              ;(err as any).errorCode = lastEntry.errorCode
              ;(err as any).startupTrace = tracePath
            }
          }
        } catch {
          // Trace read failure is non-fatal
        }
        fail(err)
      }
    }
    const onExit = (code: number) => {
      // Try to read startup trace for exit diagnostics
      let phaseInfo = ""
      try {
        const tracePath = join(options.userDataPath, "sidecar-startup.jsonl")
        if (existsSync(tracePath)) {
          const lines = readFileSync(tracePath, "utf8").trim().split("\n")
          const lastLine = lines[lines.length - 1]
          if (lastLine) {
            const lastEntry = JSON.parse(lastLine)
            phaseInfo = ` [last phase: ${lastEntry.phase}, errorCode: ${lastEntry.errorCode ?? "none"}]`
          }
        }
      } catch {
        // Trace read failure is non-fatal
      }
      fail(new Error(`Sidecar exited before ready with code ${code}${phaseInfo}`))
    }
    const cleanup = () => {
      clearTimeout(timeout)
      child.off("message", onMessage)
      child.off("exit", onExit)
    }

    child.on("message", onMessage)
    child.on("exit", onExit)
    refreshTimeout()
    child.postMessage({
      type: "start",
      hostname,
      port,
      password,
      userDataPath: options.userDataPath,
      needsMigration: options.needsMigration,
    })
  }).catch((error) => {
    if (!exited) child.kill()
    throw error
  })

  const wait = (async () => {
    const url = `http://${hostname}:${port}`
    let healthy = false
    const gone = exit.promise.then((code) => {
      if (healthy) return
      throw new Error(`Sidecar exited before health check passed with code ${code}`)
    })

    const ready = async () => {
      while (true) {
        await new Promise((resolve) => setTimeout(resolve, 100))
        if (await checkHealth(url, password)) {
          healthy = true
          return
        }
      }
    }

    await Promise.race([ready(), gone])
  })()

  let stopping: Promise<void> | undefined

  return {
    listener: {
      stop: () => {
        if (stopping) return stopping
        if (exited) return Promise.resolve()
        child.postMessage({ type: "stop" })
        stopping = Promise.race([
          exit.promise.then(() => undefined),
          delay(SIDECAR_STOP_TIMEOUT).then(() => {
            if (!exited) child.kill()
          }),
        ])
        return stopping
      },
    },
    health: { wait },
  }
}

export async function checkHealth(url: string, password?: string | null): Promise<boolean> {
  let healthUrl: URL
  try {
    healthUrl = new URL("/global/health", url)
  } catch {
    return false
  }

  const headers = new Headers()
  if (password) {
    const auth = Buffer.from(`tribunus:${password}`).toString("base64")
    headers.set("authorization", `Basic ${auth}`)
  }

  try {
    const res = await fetch(healthUrl, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(3000),
    })
    return res.ok
  } catch {
    return false
  }
}

// ── Secrets Boundary ────────────────────────────────────
// Provider tokens, GitHub tokens, plugin auth, and model API
// keys must not be stored as plain JSON in app-data config.
// Storage target: Electron safeStorage or OS keychain (pending).
// For now, secrets flow from main → sidecar env at spawn time
// and are never persisted to disk by the desktop app.
function createSidecarEnv(userDataPath: string): Record<string, string> {
  const paths = resolveDesktopAppDataPaths(userDataPath)
  ensureDirectories(paths)
  const env = sanitizeEnv({
    ...process.env,
    ...envForDesktopAppData(paths),
    OPENCODE_CLIENT: "desktop-sidecar",
    OPENCODE_DESKTOP_PATHS: JSON.stringify(report(paths)),
  })
  if (process.platform === "linux") delete env.LD_PRELOAD
  return env
}

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

function serializeError(error: unknown) {
  if (error instanceof Error) return { message: error.message, stack: error.stack }
  return { message: String(error) }
}

function defer<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}
registerIpcHandler(IPC.handle.SIDECAR_STATUS, () => {
  return withIpcResult("sidecar.status", async () => sidecarState)
})
registerIpcHandler(IPC.handle.RESTART_SIDECAR, async () => {
  return withIpcResult("sidecar.restart", async () => {
    sidecarState.restartCount++
    currentSidecarChild?.kill()
    if (lastSpawnParams) {
      await spawnLocalServer(
        lastSpawnParams.hostname,
        lastSpawnParams.port,
        lastSpawnParams.password,
        lastSpawnParams.options,
      )
    }
  })
})
