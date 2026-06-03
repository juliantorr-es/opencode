import { writeFileSync } from "node:fs"
import { join } from "node:path"
import * as http from "node:http"
import * as tls from "node:tls"
import {
  initStartupTrace,
  writePhase,
  writeFailure,
  classifyError,
  redactSecrets,
} from "./sidecar-startup-trace"

type NodeHttpWithEnvProxy = typeof http & {
  setGlobalProxyFromEnv: () => void
}

type NodeTlsWithSystemCertificates = typeof tls & {
  getCACertificates: (type: "default" | "system") => string[]
  setDefaultCACertificates: (certificates: string[]) => void
}

type StartCommand = {
  type: "start"
  hostname: string
  port: number
  password: string
  userDataPath: string
  needsMigration: boolean
}

type StopCommand = { type: "stop" }
type SidecarCommand = StartCommand | StopCommand

type SidecarMessage =
  | { type: "migration-progress"; progress: { type: "InProgress"; value: number } | { type: "Done" } }
  | { type: "ready" }
  | { type: "stopped" }
  | { type: "error"; error: { message: string; stack?: string }; component: string }

type ParentPort = {
  postMessage(message: SidecarMessage): void
  on(event: "message", listener: (event: { data: unknown }) => void): void
}

type Listener = {
  stop(close?: boolean): void | Promise<void>
}

const parentPort = getParentPort()
let listener: Listener | undefined

parentPort.on("message", (event) => {
  const command = parseCommand(event.data)
  if (!command) return
  if (command.type === "stop") {
    void stop()
    return
  }
  void start(command)
})

// Capture last 20 lines of stderr for diagnostics
const stderrLines: string[] = []
let stderrTail = ""
process.stderr.on("data", (chunk: Buffer) => {
  const text = chunk.toString("utf8")
  stderrLines.push(...text.split("\n"))
  while (stderrLines.length > 20) stderrLines.shift()
  stderrTail = stderrLines.join("\n")
})

async function start(command: StartCommand) {
  initStartupTrace(command.userDataPath)
  writePhase("sidecar.spawn.started", "started")
  let lastSuccessfulPhase = "start"

  const fail = (phase: string, error: unknown) => {
    const err = error instanceof Error ? error : new Error(String(error))
    const errorCode = classifyError(err, lastSuccessfulPhase as any)

    // Write durable failure packet to disk FIRST
    writeFailure(errorCode, err.message, {
      port: command.port,
      stderrTail,
      ...(err.stack ? { stderrTail: (stderrTail + "\n" + err.stack).slice(0, 1000) } : {}),
    })

    // Also write the legacy boot-failure.json for backward compat
    try {
      writeFileSync(
        join(command.userDataPath, "sidecar-boot-failure.json"),
        JSON.stringify(
          {
            errorCode,
            phase,
            port: command.port,
            hostname: command.hostname,
            lastSuccessfulPhase,
            errorMessage: err.message,
            errorStack: redactSecrets(err.stack ?? ""),
            exitCode: 1,
            stderrTail: redactSecrets(stderrTail),
            timestamp: new Date().toISOString(),
            platform: process.platform,
            nodeVersion: process.versions.node,
          },
          null,
          2,
        ),
      )
    } catch {
      // Disk write failure is non-fatal
    }

    // IPC message as secondary
    try {
      parentPort.postMessage({
        type: "error",
        error: { message: `${errorCode}: ${err.message}`, stack: err.stack },
        component: phase,
      })
    } catch {
      // IPC failure non-fatal
    }
    setImmediate(() => process.exit(1))
  }

  // Phase 1: env
  try {
    writePhase("sidecar.env.prepare", "started")
    prepareSidecarEnv(command.password, command.userDataPath)
    lastSuccessfulPhase = "env"
    writePhase("sidecar.env.prepare", "completed")
  } catch (error) {
    return fail("env", error)
  }

  // Phase 2: loopback-proxy
  try {
    writePhase("sidecar.env.prepare", "started")
    ensureLoopbackNoProxy()
    lastSuccessfulPhase = "loopback-proxy"
    writePhase("sidecar.env.prepare", "completed")
  } catch (error) {
    return fail("loopback-proxy", error)
  }

  // Phase 3: system-certs
  try {
    writePhase("sidecar.env.prepare", "started")
    useSystemCertificates()
    lastSuccessfulPhase = "system-certs"
    writePhase("sidecar.env.prepare", "completed")
  } catch (error) {
    return fail("system-certs", error)
  }

  // Phase 4: env-proxy
  try {
    writePhase("sidecar.env.prepare", "started")
    useEnvProxy()
    lastSuccessfulPhase = "env-proxy"
    writePhase("sidecar.env.prepare", "completed")
  } catch (error) {
    return fail("env-proxy", error)
  }

  // Phase 5: server import
  let Server: { listen: (opts: Record<string, unknown>) => Promise<{ stop: (close?: boolean) => void | Promise<void> }> }
  let Log: { init: (opts: { level?: string }) => Promise<void> }
  try {
    writePhase("sidecar.config.load", "started")
    const mod = await import("virtual:opencode-server")
    Server = mod.Server
    Log = mod.Log
    lastSuccessfulPhase = "server-import"
    writePhase("sidecar.config.load", "completed")
  } catch (error) {
    return fail("server-import", error)
  }

  // Phase 6: log init
  try {
    writePhase("sidecar.config.load", "started")
    await Log.init({ level: "WARN" })
    lastSuccessfulPhase = "log-init"
    writePhase("sidecar.config.load", "completed")
  } catch (error) {
    return fail("log-init", error)
  }

  // Phase 7: server listen
  try {
    writePhase("sidecar.server.listen", "started")
    listener = await Server.listen({
      port: command.port,
      hostname: command.hostname,
      username: "tribunus",
      password: command.password,
      cors: ["oc://renderer"],
    })
    lastSuccessfulPhase = "server-listen"
    writePhase("sidecar.server.listen", "completed")
  } catch (error) {
    return fail("server-listen", error)
  }

  writePhase("sidecar.ready", "completed")
  parentPort.postMessage({ type: "ready" })
}

async function stop() {
  try {
    await listener?.stop()
  } finally {
    listener = undefined
    parentPort.postMessage({ type: "stopped" })
    setImmediate(() => process.exit(0))
  }
}

function prepareSidecarEnv(password: string, userDataPath: string) {
  Object.assign(process.env, {
    OPENCODE_SERVER_USERNAME: "tribunus",
    OPENCODE_SERVER_PASSWORD: password,
    XDG_STATE_HOME: process.env.XDG_STATE_HOME ?? userDataPath,
  })
}

function ensureLoopbackNoProxy() {
  const loopback = ["127.0.0.1", "localhost", "::1"]
  const upsert = (key: string) => {
    const items = (process.env[key] ?? "")
      .split(",")
      .map((value: string) => value.trim())
      .filter((value: string) => Boolean(value))

    for (const host of loopback) {
      if (items.some((value: string) => value.toLowerCase() === host)) continue
      items.push(host)
    }

    process.env[key] = items.join(",")
  }

  upsert("NO_PROXY")
  upsert("no_proxy")
}

function useSystemCertificates() {
  try {
    const nodeTls = tls as NodeTlsWithSystemCertificates
    nodeTls.setDefaultCACertificates([
      ...new Set([...nodeTls.getCACertificates("default"), ...nodeTls.getCACertificates("system")]),
    ])
  } catch (error) {
    console.warn("failed to load system certificates", error)
  }
}

function useEnvProxy() {
  try {
    ;(http as NodeHttpWithEnvProxy).setGlobalProxyFromEnv()
  } catch (error) {
    console.warn("failed to load proxy environment", error)
  }
}

function parseCommand(value: unknown): SidecarCommand | undefined {
  if (!value || typeof value !== "object") return
  const command = value as Partial<StartCommand | StopCommand>
  if (command.type === "stop") return { type: "stop" }
  if (command.type !== "start") return
  if (typeof command.hostname !== "string") return
  if (typeof command.port !== "number") return
  if (typeof command.password !== "string") return
  if (typeof command.userDataPath !== "string") return
  if (typeof command.needsMigration !== "boolean") return
  return {
    type: "start",
    hostname: command.hostname,
    port: command.port,
    password: command.password,
    userDataPath: command.userDataPath,
    needsMigration: command.needsMigration,
  }
}


function getParentPort() {
  const port = process.parentPort as ParentPort | undefined
  if (!port) throw new Error("Sidecar parent port unavailable")
  return port
}
