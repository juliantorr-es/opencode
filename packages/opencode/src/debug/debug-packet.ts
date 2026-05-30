import { Schema, Effect, Option } from "effect"
import type { SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import { Permission } from "@/permission"
import { Config } from "@/config/config"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { Git } from "@/git"

/**
 * DebugPacket — a comprehensive snapshot of a session for debugging purposes.
 * All fields are optional with fallback to null on error, so partial failures
 * never crash the whole export.
 */

// ─── Metadata ───────────────────────────────────────────────────────────

export interface DebugPacketMeta {
  version: string
  generatedAt: string
  appVersion: string
  dbSchemaVersion: string
}

export interface NormalizedError {
  code: string
  message: string
  count: number
  firstSeen: string
  lastSeen: string
  sampleIds: string[]
}

export interface ToolCallSummary {
  id: string
  toolName: string
  status: "success" | "error" | "running"
  startedAt: string
  durationMs?: number
  errorCode?: string
}

export interface FileEditSummary {
  path: string
  operation: "create" | "modify" | "delete"
  linesAdded: number
  linesRemoved: number
}

export interface PermissionDecision {
  id: string
  action: string
  decision: "once" | "always" | "reject"
  timestamp: string
  toolName?: string
}

export interface LifecycleTransition {
  phase: string
  enteredAt: string
  durationMs?: number
  status: "running" | "completed" | "failed"
}

export interface McpEvent {
  serverName: string
  eventType: "request" | "response" | "error"
  toolName?: string
  timestamp: string
  durationMs?: number
}

export interface RuntimeEvent {
  id: string
  type: string
  timestamp: string
  sessionId?: string
  correlationId?: string
  status?: string
  errorCode?: string
  summary: Record<string, unknown>
}

export interface DebugPacketSession {
  id: string
  metadata: Record<string, unknown> | null
  messages: unknown[]
  runtimeEvents: RuntimeEvent[]
  toolCalls: ToolCallSummary[]
  fileEdits: FileEditSummary[]
  permissionDecisions: PermissionDecision[]
  lifecycleTransitions: LifecycleTransition[]
  mcpEvents: McpEvent[]
  errors: NormalizedError[]
}

export interface DebugPacket {
  version: string
  generatedAt: string
  appVersion: string
  dbSchemaVersion: string
  session: DebugPacketSession
  duckDbQueries?: Record<string, unknown>
  gitDiff?: string
  redactedConfig: Record<string, unknown>
}

// ─── Sensitive config key patterns to redact ────────────────────────────

const SENSITIVE_PATTERNS = [
  "api_key", "apiKey", "api-key",
  "token", "secret", "password",
  "OPENAI_API_KEY", "ANTHROPIC_API_KEY",
  "OPENCODE_DATABASE_URL",
  "connection_string", "connectionString",
  "oauth", "jwt", "bearer",
  "private_key", "privateKey",
]

function isSensitiveKey(key: string): boolean {
  const lower = key.toLowerCase()
  return SENSITIVE_PATTERNS.some((p) => lower.includes(p.toLowerCase()))
}

function redactConfig(config: Record<string, unknown>, depth = 0): Record<string, unknown> {
  if (depth > 5) return { "(max depth)": true }
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(config)) {
    if (isSensitiveKey(key)) {
      result[key] = "***REDACTED***"
    } else if (value && typeof value === "object" && !Array.isArray(value)) {
      result[key] = redactConfig(value as Record<string, unknown>, depth + 1)
    } else if (Array.isArray(value)) {
      result[key] = value.map((v) =>
        typeof v === "object" && v !== null
          ? redactConfig(v as Record<string, unknown>, depth + 1)
          : v,
      )
    } else {
      result[key] = value
    }
  }
  return result
}

// ─── Value-based secret scanning (complements key-name redaction) ──────

const VALUE_SECRET_PATTERNS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: "bearer token", pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}\b/ },
  { label: "API key", pattern: /\bsk-[A-Za-z0-9][A-Za-z0-9_-]{20,}\b/ },
  { label: "Anthropic API key", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/ },
  { label: "Google API key", pattern: /\bAIza[0-9A-Za-z_-]{20,}\b/ },
  { label: "AWS access key", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { label: "GitHub token", pattern: /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/ },
  { label: "private key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
]

function redactValues(value: unknown, depth = 0): unknown {
  if (depth > 5) return value
  if (typeof value === "string") {
    for (const { pattern } of VALUE_SECRET_PATTERNS) {
      if (pattern.test(value)) return "***REDACTED***"
    }
    return value
  }
  if (Array.isArray(value)) {
    return value.map((v) => redactValues(v, depth + 1))
  }
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      result[key] = redactValues(child, depth + 1)
    }
    return result
  }
  return value
}

// ─── Safe helpers ───────────────────────────────────────────────────────

function isoNow(): string {
  try {
    return new Date().toISOString()
  } catch {
    return ""
  }
}

// ─── Error normalizer ───────────────────────────────────────────────────

const errorCodePatterns: Array<{ pattern: RegExp; code: string }> = [
  { pattern: /rate.limit|too many requests|429/i, code: "RATE_LIMIT" },
  { pattern: /timeout|timed out/i, code: "TIMEOUT" },
  { pattern: /auth|unauthorized|forbidden|401|403/i, code: "AUTH_ERROR" },
  { pattern: /not found|404/i, code: "NOT_FOUND" },
  { pattern: /invalid|bad request|400/i, code: "INVALID_REQUEST" },
  { pattern: /internal|500/i, code: "INTERNAL_ERROR" },
  { pattern: /network|econnrefused|enotfound|econnreset/i, code: "NETWORK_ERROR" },
  { pattern: /quota|exceeded|insufficient/i, code: "QUOTA_EXCEEDED" },
  { pattern: /parse|syntax/i, code: "PARSE_ERROR" },
  { pattern: /context.length|max_tokens|token.limit/i, code: "CONTEXT_LIMIT" },
]

function inferErrorCode(message: string): string {
  for (const { pattern, code } of errorCodePatterns) {
    if (pattern.test(message)) return code
  }
  return "UNKNOWN"
}

// ─── Debug Packet Assembly ──────────────────────────────────────────────

export interface AssembleOptions {
  includeGitDiff?: boolean
  includeDuckDbQueries?: boolean
}

/**
 * Assemble a complete debug packet for a session.
 * Each data source is queried independently with error handling.
 * Partial failures produce null/missing fields rather than crashing the whole export.
 */
export const assembleDebugPacket = (sessionId: SessionID, options?: AssembleOptions) =>
  Effect.gen(function* () {
    const session = yield* Session.Service
    const config = yield* Config.Service

    // Version info
    const appVersion = InstallationVersion

    // Session info + messages
    let sessionInfo: Record<string, unknown> | null = null
    let sessionMessages: unknown[] = []
    try {
      const info = yield* session.get(sessionId).pipe(Effect.option)
      if (Option.isSome(info)) {
        sessionInfo = info.value as unknown as Record<string, unknown>
      }
      const msgs = yield* session.messages({ sessionID: sessionId, limit: 1000 }).pipe(Effect.option)
      if (Option.isSome(msgs)) {
        sessionMessages = msgs.value as unknown as unknown[]
      }
    } catch {
      sessionInfo = null
    }

    // Permission decisions
    let permissionDecisions: PermissionDecision[] = []
    try {
      const perm = yield* Permission.Service
      const requests = yield* perm.list().pipe(Effect.option)
      if (Option.isSome(requests)) {
        permissionDecisions = (requests.value as unknown as Array<Record<string, unknown>>).flatMap((r) => {
          const action = String(r.action ?? "")
          const reply = String(r.reply ?? "once")
          const decision = (reply === "once" || reply === "always" || reply === "reject" ? reply : "once") as PermissionDecision["decision"]
          return {
            id: String(r.id ?? crypto.randomUUID()),
            action,
            decision,
            timestamp: String(r.timestamp ?? isoNow()),
          }
        })
      }
    } catch {
      permissionDecisions = []
    }

    // Lifecycle transitions
    const lifecycleTransitions: LifecycleTransition[] = []

    // Redacted config
    let rawConfig: Record<string, unknown> = {}
    try {
      const info = yield* config.get().pipe(Effect.option)
      if (Option.isSome(info)) {
        rawConfig = info.value as unknown as Record<string, unknown>
      }
    } catch {
      rawConfig = {}
    }
    const redactedConfig = redactValues(redactConfig(rawConfig)) as Record<string, unknown>

    // Git diff (optional)
    let gitDiff: string | undefined
    if (options?.includeGitDiff) {
      try {
        const git = yield* Git.Service
        const diff = yield* git.diff("", "HEAD").pipe(Effect.option)
        if (Option.isSome(diff)) {
          gitDiff = JSON.stringify(diff.value)
        }
      } catch {
        gitDiff = undefined
      }
    }

    // DuckDB queries (placeholder)
    const duckDbQueries = options?.includeDuckDbQueries
      ? { note: "DuckDB query integration deferred — run queries via analytics service" }
      : undefined

    return {
      version: "1",
      generatedAt: isoNow(),
      appVersion,
      dbSchemaVersion: "1",
      session: {
        id: sessionId,
        metadata: sessionInfo,
        messages: sessionMessages,
        runtimeEvents: [],
        toolCalls: [],
        fileEdits: [],
        permissionDecisions,
        lifecycleTransitions,
        mcpEvents: [],
        errors: [],
      },
      duckDbQueries,
      gitDiff,
      redactedConfig,
    } satisfies DebugPacket
  })
