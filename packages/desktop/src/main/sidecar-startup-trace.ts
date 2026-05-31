// ═══════════════════════════════════════════════════════════════
// Sidecar Startup Trace — durable, typed, survives exit(1)
//
// Writes a JSONL file to <userDataPath>/sidecar-startup.jsonl
// with one entry per startup phase. On failure, the last entry
// is a typed failure packet that survives process exit.
//
// This is NOT a general logging framework. It is a minimal
// diagnostic spine for sidecar boot failures only.
// ═══════════════════════════════════════════════════════════════
import { appendFileSync } from "node:fs"
import { join } from "node:path"

// ── Failure Taxonomy ──────────────────────────────────────────

export const SIDECAR_FAILURE_CODES = {
  PORT_CONFLICT: "sidecar.port_conflict",
  CONFIG_PARSE_FAILED: "sidecar.config_parse_failed",
  DB_INIT_FAILED: "sidecar.db_init_failed",
  DB_MIGRATION_FAILED: "sidecar.db_migration_failed",
  DUCKDB_INIT_FAILED: "sidecar.duckdb_init_failed",
  NATIVE_MODULE_FAILED: "sidecar.native_module_failed",
  PLUGIN_INIT_FAILED: "sidecar.plugin_init_failed",
  MCP_INIT_FAILED: "sidecar.mcp_init_failed",
  PERMISSION_DENIED: "sidecar.permission_denied",
  PATH_MISSING: "sidecar.path_missing",
  ENV_INVALID: "sidecar.env_invalid",
  PROCESS_EXITED_BEFORE_READY: "sidecar.process_exited_before_ready",
  TIMEOUT_BEFORE_READY: "sidecar.timeout_before_ready",
  UNKNOWN_FATAL: "sidecar.unknown_fatal",
} as const

export type SidecarFailureCode = (typeof SIDECAR_FAILURE_CODES)[keyof typeof SIDECAR_FAILURE_CODES]

// ── Trace Entry Types ─────────────────────────────────────────

export type StartupPhase =
  | "sidecar.spawn.prepare"
  | "sidecar.spawn.started"
  | "sidecar.env.prepare"
  | "sidecar.config.load"
  | "sidecar.storage.init"
  | "sidecar.db.init"
  | "sidecar.db.migrate"
  | "sidecar.duckdb.init"
  | "sidecar.plugins.init"
  | "sidecar.mcp.init"
  | "sidecar.server.listen"
  | "sidecar.ipc.ready"
  | "sidecar.ready"
  | "sidecar.failed"
  | "sidecar.exited"

export type StartupTraceEntry = {
  timestamp: string
  phase: StartupPhase
  status: "started" | "completed" | "failed" | "degraded"
  errorCode?: SidecarFailureCode
  message?: string
  safeDetails?: Record<string, string | number | boolean | null>
}

export type StartupFailurePacket = StartupTraceEntry & {
  status: "failed"
  errorCode: SidecarFailureCode
  exitCode?: number
  signal?: string
  pid?: number
  command?: string
  cwd?: string
  envSummary?: string
  port?: number
  configPath?: string
  dbPath?: string
  schemaVersion?: string
  lastSuccessfulPhase?: StartupPhase
  stderrTail?: string
  stdoutTail?: string
  remediationHint?: string
}

// ── Writer ────────────────────────────────────────────────────

let tracePath: string | null = null
let lastPhase: StartupPhase | null = null

export function initStartupTrace(userDataPath: string): void {
  tracePath = join(userDataPath, "sidecar-startup.jsonl")
  writeEntry({
    timestamp: new Date().toISOString(),
    phase: "sidecar.spawn.prepare",
    status: "started",
    safeDetails: {
      pid: process.pid,
      cwd: process.cwd(),
      nodeVersion: process.version,
      platform: process.platform,
    },
  })
}

export function writePhase(phase: StartupPhase, status: "started" | "completed" | "degraded" = "started", message?: string): void {
  lastPhase = phase
  writeEntry({
    timestamp: new Date().toISOString(),
    phase,
    status,
    ...(message ? { message } : {}),
  })
}

export function writeFailure(
  errorCode: SidecarFailureCode,
  message: string,
  details?: {
    exitCode?: number
    signal?: string
    port?: number
    configPath?: string
    dbPath?: string
    schemaVersion?: string
    stderrTail?: string
    stdoutTail?: string
    remediationHint?: string
  },
): void {
  const packet: StartupFailurePacket = {
    timestamp: new Date().toISOString(),
    phase: "sidecar.failed",
    status: "failed",
    errorCode,
    message: redactSecrets(message),
    exitCode: details?.exitCode,
    signal: details?.signal,
    pid: process.pid,
    command: "sidecar.js",
    cwd: process.cwd(),
    envSummary: summarizeEnv(),
    port: details?.port,
    configPath: details?.configPath,
    dbPath: details?.dbPath,
    schemaVersion: details?.schemaVersion,
    lastSuccessfulPhase: lastPhase ?? undefined,
    stderrTail: details?.stderrTail ? redactSecrets(details.stderrTail) : undefined,
    stdoutTail: details?.stdoutTail ? redactSecrets(details.stdoutTail) : undefined,
    remediationHint: details?.remediationHint,
  }
  writeEntry(packet)
}

export function classifyError(error: unknown, phase: StartupPhase): SidecarFailureCode {
  const msg = error instanceof Error ? error.message : String(error)
  const lower = msg.toLowerCase()

  if (/port.*(?:in use|already|occupied|conflict|unavailable)|eaddrinuse/i.test(msg)) {
    return SIDECAR_FAILURE_CODES.PORT_CONFLICT
  }
  if (/(?:config|configuration).*(?:parse|invalid|malformed|syntax|not found|missing)|malformed.*(?:config|configuration)/i.test(msg)) {
    return SIDECAR_FAILURE_CODES.CONFIG_PARSE_FAILED
  }
  if (/migration.*fail|migrate.*fail|migrat.*error/i.test(msg)) {
    return SIDECAR_FAILURE_CODES.DB_MIGRATION_FAILED
  }
  if (/pglite.*(?:init|fail|error|not found)|database.*(?:init|connect|fail|error)|db.*init.*fail/i.test(msg)) {
    return SIDECAR_FAILURE_CODES.DB_INIT_FAILED
  }
  if (/duckdb.*(?:init|fail|error)/i.test(msg)) {
    return SIDECAR_FAILURE_CODES.DUCKDB_INIT_FAILED
  }
  if (/native.*(?:module|addon|binding).*(?:fail|error|not found|load)|(?:addon|binding).*(?:fail|error)/i.test(msg)) {
    return SIDECAR_FAILURE_CODES.NATIVE_MODULE_FAILED
  }
  if (/plugin.*(?:init|load|fail|error)/i.test(msg)) {
    return SIDECAR_FAILURE_CODES.PLUGIN_INIT_FAILED
  }
  if (/mcp.*(?:init|start|connect|fail|error)/i.test(msg)) {
    return SIDECAR_FAILURE_CODES.MCP_INIT_FAILED
  }
  if (/permission.*(?:denied|error)|eacces/i.test(msg)) {
    return SIDECAR_FAILURE_CODES.PERMISSION_DENIED
  }
  if (/enoent|not found|no such file|path.*missing/i.test(msg)) {
    return SIDECAR_FAILURE_CODES.PATH_MISSING
  }
  if (/env(?:ironment)?.*(?:invalid|missing|required)/i.test(msg)) {
    return SIDECAR_FAILURE_CODES.ENV_INVALID
  }

  return SIDECAR_FAILURE_CODES.UNKNOWN_FATAL
}

// ── Internals ─────────────────────────────────────────────────

function writeEntry(entry: Record<string, unknown>): void {
  if (!tracePath) return
  try {
    appendFileSync(tracePath, JSON.stringify(entry) + "\n")
  } catch {
    // Can't log if trace file itself fails — this is the last resort
  }
}

export function redactSecrets(text: string): string {
  return text
    .replace(/Bearer\s+[^\s"',;]+/gi, "Bearer ***")
    .replace(/Basic\s+[^\s"',;]+/gi, "Basic ***")
    .replace(/["']?authorization["']?\s*[:=]\s*["']?[^\s"',;]+["']?/gi, 'authorization=***')
    .replace(/["']?api[_-]?key["']?\s*[:=]\s*["']?[^\s"',;]+["']?/gi, 'api_key=***')
    .replace(/["']?token["']?\s*[:=]\s*["']?[^\s"',;]+["']?/gi, 'token=***')
    .replace(/["']?secret["']?\s*[:=]\s*["']?[^\s"',;]+["']?/gi, 'secret=***')
    .replace(/["']?password["']?\s*[:=]\s*["']?[^\s"',;]+["']?/gi, 'password=***')
    .replace(/-----BEGIN[^-]*PRIVATE KEY-----[^-]*-----END[^-]*PRIVATE KEY-----/gi, "***PRIVATE KEY***")
}

function summarizeEnv(): string {
  const keys = Object.keys(process.env)
    .filter((k) => !isSecretEnvKey(k))
    .sort()
  const count = keys.length
  if (count <= 10) return keys.join(", ")
  return `${keys.slice(0, 10).join(", ")} ... (${count} total)`
}

function isSecretEnvKey(key: string): boolean {
  const upper = key.toUpperCase()
  return (
    upper.includes("TOKEN") ||
    upper.includes("SECRET") ||
    upper.includes("PASSWORD") ||
    upper.includes("KEY") ||
    upper.includes("AUTH") ||
    upper.includes("CERT") ||
    upper.includes("CREDENTIAL") ||
    upper === "OPENCODE_SERVER_PASSWORD"
  )
}
