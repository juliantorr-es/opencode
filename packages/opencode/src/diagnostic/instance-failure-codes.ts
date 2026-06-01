import { Cause } from "effect"

// ── Instance failure codes ──────────────────────────────────
// Phase-indexed error taxonomy for bootstrap, storage, and config error sites.
export const INSTANCE_FAILURE_CODES = {
  DB_CONNECTION: "instance.db.connection",
  DB_MIGRATION: "instance.db.migration",
  DB_QUERY: "instance.db.query",
  FILE_NOT_FOUND: "instance.fs.not_found",
  FILE_PERMISSION: "instance.fs.permission",
  FILE_READ: "instance.fs.read",
  FILE_WRITE: "instance.fs.write",
  CONFIG_PARSE: "instance.config.parse",
  CONFIG_FETCH: "instance.config.fetch",
  NETWORK: "instance.network",
  PLUGIN: "instance.plugin",
  SERVICE_INIT: "instance.service.init",
  SCOPE_CLOSED: "instance.scope.closed",
  FIBER_INTERRUPTED: "instance.fiber.interrupted",
  UNKNOWN: "instance.unknown",
} as const

export type InstanceFailureCode = (typeof INSTANCE_FAILURE_CODES)[keyof typeof INSTANCE_FAILURE_CODES]

export interface ClassifiedError {
  code: InstanceFailureCode
  message: string
  phase?: string
  service?: string
}

// ── Message extraction ──────────────────────────────────────

function extractMessage(error: unknown): string {
  if (Cause.isCause(error)) {
    try {
      return Cause.pretty(error)
    } catch {
      return String(error)
    }
  }
  if (error instanceof Error) return error.message
  return String(error)
}

// ── Regex-based classification ──────────────────────────────

const PATTERNS: Array<[RegExp, InstanceFailureCode]> = [
  [/connection refused|ECONNREFUSED|could not connect|connect ECONNREFUSED/i, INSTANCE_FAILURE_CODES.DB_CONNECTION],
  [/database .* does not exist|database .* not found|no such database/i, INSTANCE_FAILURE_CODES.DB_CONNECTION],
  [/migration|relation .* already exists|column .* already exists|duplicate column/i, INSTANCE_FAILURE_CODES.DB_MIGRATION],
  [/syntax error|SQLITE_ERROR|query failed|transaction failed/i, INSTANCE_FAILURE_CODES.DB_QUERY],
  [/ENOENT|no such file|file not found|not found/i, INSTANCE_FAILURE_CODES.FILE_NOT_FOUND],
  [/EACCES|EPERM|permission denied|not permitted/i, INSTANCE_FAILURE_CODES.FILE_PERMISSION],
  [/\bread\b|\breadFile\b/i, INSTANCE_FAILURE_CODES.FILE_READ],
  [/\bwrite\b|\bwriteFile\b/i, INSTANCE_FAILURE_CODES.FILE_WRITE],
  [/JSON|parse|Unexpected token|Expected .* JSON|invalid config/i, INSTANCE_FAILURE_CODES.CONFIG_PARSE],
  [/fetch|HTTP|ECONNRESET|ETIMEDOUT|ENOTFOUND/i, INSTANCE_FAILURE_CODES.NETWORK],
  [/plugin/i, INSTANCE_FAILURE_CODES.PLUGIN],
  [/scope.*closed|ScopeClosed|Scope/i, INSTANCE_FAILURE_CODES.SCOPE_CLOSED],
  [/fiber.*interrupted|Interrupted|FiberInterrupted/i, INSTANCE_FAILURE_CODES.FIBER_INTERRUPTED],
]

function matchCode(message: string): InstanceFailureCode {
  for (const [pattern, code] of PATTERNS) {
    if (pattern.test(message)) return code
  }
  return INSTANCE_FAILURE_CODES.UNKNOWN
}

// ── Public API ──────────────────────────────────────────────

export function classifyError(
  error: unknown,
  phase?: string,
  service?: string,
): ClassifiedError {
  const message = extractMessage(error)
  const code = matchCode(message)
  return { code, message, phase, service }
}

export * as InstanceFailureCodes from "./instance-failure-codes"
