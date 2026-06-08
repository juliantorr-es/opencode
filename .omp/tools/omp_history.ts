import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent"
import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { setContext, createEnvelope } from "./_lib/envelope.js"
import { buildToolContext } from "./_lib/tool-context.js"
import { createInvocationId, createEventId } from "./_lib/ids.js"
import { appendAuditEvent } from "./_lib/audit.js"
import type {
  OmpToolEnvelopeV1,
  OmpRiskLevel,
  OmpToolEventV1,
  OmpToolContextV1,
} from "./_lib/types.js"
import type {
  ToolInvocationRecordV1,
  ToolFileEffectRecordV1,
  WriteJournalRecordV1,
  SessionRecordV1,
} from "./_lib/store/pglite-types.js"

const TOOL_ID = "omp_history"
const TOOL_VERSION = "1.0.0"
const RISK_LEVEL: OmpRiskLevel = "read"

// ── Types ──

interface OmpHistoryOutput {
  mode: string
  store_available: boolean
  items: Array<Record<string, unknown>>
  count: number
  truncated: boolean
}

type ToolResponse = {
  content: Array<{ type: string; text: string }>
  details?: Record<string, unknown>
}

// Shallow PGlite client for direct queries when store methods don't cover the mode.
// Dynamic import: @electric-sql/pglite may not be installed, so we cannot
// statically import it at module scope.
interface RawDb {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>
  close(): Promise<void>
}

async function createRawDb(dataDir: string): Promise<RawDb | undefined> {
  try {
    const { PGlite } = await import("@electric-sql/pglite")
    const client = new PGlite(dataDir)
    return {
      query: (sql, p) => client.query(sql, p),
      close: () => client.close(),
    }
  } catch {
    return undefined
  }
}

// ── Formatting helpers ──

function fmtInvocation(r: ToolInvocationRecordV1): Record<string, unknown> {
  return {
    invocation_id: r.invocation_id,
    session_id: r.session_id,
    tool_id: r.tool_id,
    tool_version: r.tool_version,
    status: r.status,
    risk_level: r.risk_level,
    started_at: r.started_at,
    finished_at: r.finished_at,
    duration_ms: r.duration_ms,
    error_code: r.error_code,
    error_message: r.error_message,
    input_sha256: r.input_sha256,
    receipt_id: r.receipt_id,
  }
}

function fmtSession(r: SessionRecordV1): Record<string, unknown> {
  return {
    session_id: r.session_id,
    actor_id: r.actor_id,
    status: r.status,
    purpose: r.purpose,
    started_at: r.started_at,
    last_heartbeat_at: r.last_heartbeat_at,
    closed_at: r.closed_at,
  }
}

function fmtFileEffect(r: ToolFileEffectRecordV1): Record<string, unknown> {
  return {
    effect_id: r.effect_id,
    invocation_id: r.invocation_id,
    session_id: r.session_id,
    path: r.path,
    action: r.action,
    before_sha256: r.before_sha256,
    after_sha256: r.after_sha256,
    before_size_bytes: r.before_size_bytes,
    after_size_bytes: r.after_size_bytes,
    diff_path: r.diff_path,
  }
}

function fmtWriteJournal(r: WriteJournalRecordV1): Record<string, unknown> {
  return {
    journal_id: r.journal_id,
    receipt_id: r.receipt_id,
    invocation_id: r.invocation_id,
    session_id: r.session_id,
    status: r.status,
    created_at: r.created_at,
    updated_at: r.updated_at,
    journal_path: r.journal_path,
  }
}

// ── Wrapper ──

function wrapResult(
  mode: string,
  storeAvailable: boolean,
  items: Array<Record<string, unknown>>,
  envelope: OmpToolEnvelopeV1,
): ToolResponse {
  const result: OmpHistoryOutput = {
    mode,
    store_available: storeAvailable,
    items,
    count: items.length,
    truncated: false,
  }
  return {
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    details: envelope as unknown as Record<string, unknown>,
  }
}

// ── Factory ──

const factory: CustomToolFactory = (pi) => ({
  name: TOOL_ID,
  label: "OMP History",
  description:
    "Query session history, invocation history, path effects, conflicts, and pending recovery items from the PGlite coordination store. Read-only introspection for debugging and auditing.",

  parameters: pi.zod.object({
    mode: pi.zod
      .enum(["recent", "session", "path", "failures", "conflicts", "pending"])
      .optional()
      .default("recent")
      .describe("Query mode: recent invocations, specific session, file effects, failures, lock conflicts, pending journals"),
    session_id: pi.zod
      .string()
      .optional()
      .describe("Session ID to inspect (required for mode=session)"),
    path: pi.zod
      .string()
      .optional()
      .describe("File path to inspect (required for mode=path)"),
    limit: pi.zod
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .default(20)
      .describe("Maximum items to return"),
  }),

  async execute(_toolCallId, params, _onUpdate, ctx, signal): Promise<ToolResponse> {
    const startedAt = new Date().toISOString()
    const ompCtx: OmpToolContextV1 = buildToolContext({
      cwd: pi.cwd,
      mode: "loose",
      actor: { kind: "agent", id: ctx.sessionId ?? "unknown" },
    })
    setContext(ompCtx)
    const invocationId = createInvocationId()

    if (signal?.aborted) {
      const envelope = createEnvelope({
        tool_id: TOOL_ID,
        tool_version: TOOL_VERSION,
        invocation_id: invocationId,
        started_at: startedAt,
        status: "refused",
        risk_level: RISK_LEVEL,
        requires_approval: false,
        requires_hash_precondition: false,
        error: { code: "INTERNAL_ERROR", message: "Execution cancelled before work began", retryable: false },
      })
      return {
        content: [{ type: "text", text: "refused: Execution cancelled before work began" }],
        details: envelope as unknown as Record<string, unknown>,
      }
    }

    // Validate mode-specific params
    if (params.mode === "session" && !params.session_id) {
      const envelope = createEnvelope({
        tool_id: TOOL_ID,
        tool_version: TOOL_VERSION,
        invocation_id: invocationId,
        started_at: startedAt,
        status: "error",
        risk_level: RISK_LEVEL,
        requires_approval: false,
        requires_hash_precondition: false,
        result: { mode: params.mode, store_available: false, items: [], count: 0, truncated: false } satisfies OmpHistoryOutput,
        error: { code: "INVALID_INPUT", message: "session_id is required for mode=session", retryable: false },
      })
      return {
        content: [{ type: "text", text: "error: session_id is required for mode=session" }],
        details: envelope as unknown as Record<string, unknown>,
      }
    }

    if (params.mode === "path" && !params.path) {
      const envelope = createEnvelope({
        tool_id: TOOL_ID,
        tool_version: TOOL_VERSION,
        invocation_id: invocationId,
        started_at: startedAt,
        status: "error",
        risk_level: RISK_LEVEL,
        requires_approval: false,
        requires_hash_precondition: false,
        result: { mode: params.mode, store_available: false, items: [], count: 0, truncated: false } satisfies OmpHistoryOutput,
        error: { code: "INVALID_INPUT", message: "path is required for mode=path", retryable: false },
      })
      return {
        content: [{ type: "text", text: "error: path is required for mode=path" }],
        details: envelope as unknown as Record<string, unknown>,
      }
    }

    // ── Initialize store (dynamic import — pglite may not be installed) ──
    type StoreWithMethods = {
      migrate(): Promise<void>
      listRecentInvocations(limit: number): Promise<ToolInvocationRecordV1[]>
      listEffectsForPath(path: string): Promise<ToolFileEffectRecordV1[]>
      findPendingJournals(): Promise<WriteJournalRecordV1[]>
      abandonExpiredSessions(now?: Date): Promise<{ abandoned_count: number; abandoned_session_ids: string[]; expired_lock_count: number; expired_claim_count: number }>
    }

    let store: StoreWithMethods | undefined
    const pglitePkgDir = resolve(pi.cwd, "node_modules/@electric-sql/pglite")

    if (existsSync(pglitePkgDir)) {
      try {
        const mod = await import("./_lib/store/pglite-store.js")
        const s = mod.getPgliteStore({ repoRoot: ompCtx.repo_root })
        await s.migrate()
        store = s as unknown as StoreWithMethods
      } catch {
        // Store not available
      }
    }

    if (!store) {
      const envelope = createEnvelope({
        tool_id: TOOL_ID,
        tool_version: TOOL_VERSION,
        invocation_id: invocationId,
        started_at: startedAt,
        status: "ok",
        risk_level: RISK_LEVEL,
        requires_approval: false,
        requires_hash_precondition: false,
        result: { mode: params.mode, store_available: false, items: [], count: 0, truncated: false } satisfies OmpHistoryOutput,
      })
      return {
        content: [{ type: "text", text: "PGlite coordination store not available. Install @electric-sql/pglite to enable coordination history." }],
        details: envelope as unknown as Record<string, unknown>,
      }
    }

    // ── Mode dispatch ──

    let items: Array<Record<string, unknown>> = []

    try {
      switch (params.mode) {
        case "recent": {
          const recs = await store.listRecentInvocations(params.limit)
          items = recs.map(fmtInvocation)
          break
        }

        case "session": {
          // Direct PGlite query needed — sessions table not exposed via store methods
          const db = await createRawDb(resolve(ompCtx.repo_root, ".omp/state/pglite"))
          if (!db) {
            const envelope = createEnvelope({
              tool_id: TOOL_ID,
              tool_version: TOOL_VERSION,
              invocation_id: invocationId,
              started_at: startedAt,
              status: "error",
              risk_level: RISK_LEVEL,
              requires_approval: false,
              requires_hash_precondition: false,
              error: { code: "STORE_MIGRATION_FAILED", message: "Could not open PGlite database for direct query", retryable: true },
            })
            return {
              content: [{ type: "text", text: "error: Could not open PGlite database for direct query" }],
              details: envelope as unknown as Record<string, unknown>,
            }
          }
          try {
            // Session record
            const sessRows = await db.query(
              "SELECT * FROM sessions WHERE session_id = $1",
              [params.session_id!],
            )
            if (sessRows.rows.length === 0) {
              items = []
            } else {
              const session = fmtSession(sessRows.rows[0] as unknown as SessionRecordV1)

              // Recent invocations for this session
              const invRows = await db.query(
                "SELECT * FROM tool_invocations WHERE session_id = $1 ORDER BY started_at DESC LIMIT $2",
                [params.session_id!, params.limit + 1],
              )
              const invocations = invRows.rows.map((r) => fmtInvocation(r as unknown as ToolInvocationRecordV1))

              // File effects for this session
              const effRows = await db.query(
                "SELECT * FROM tool_file_effects WHERE session_id = $1 ORDER BY effect_id DESC LIMIT $2",
                [params.session_id!, params.limit + 1],
              )
              const effects = effRows.rows.map((r) => fmtFileEffect(r as unknown as ToolFileEffectRecordV1))

              const sid = params.session_id
              items = [{
                _type: "session_summary",
                session_id: sid,
                session,
                recent_invocations: invocations.slice(0, params.limit),
                invocation_count: invocations.length,
                recent_effects: effects.slice(0, params.limit),
                effect_count: effects.length,
              }]
            }
          } finally {
            await db.close()
          }
          break
        }

        case "path": {
          const recs = await store.listEffectsForPath(params.path!)
          items = recs.map(fmtFileEffect)
          break
        }

        case "failures": {
          // Direct query — filtering by status not exposed via store methods
          const db = await createRawDb(resolve(ompCtx.repo_root, ".omp/state/pglite"))
          if (!db) {
            items = []
            break
          }
          try {
            const rows = await db.query(
              "SELECT * FROM tool_invocations WHERE status IN ('error', 'refused') ORDER BY started_at DESC LIMIT $1",
              [params.limit],
            )
            items = rows.rows.map((r) => fmtInvocation(r as unknown as ToolInvocationRecordV1))
          } finally {
            await db.close()
          }
          break
        }

        case "conflicts": {
          // Direct query — path_locks joined with sessions
          const db = await createRawDb(resolve(ompCtx.repo_root, ".omp/state/pglite"))
          if (!db) {
            items = []
            break
          }
          try {
            const rows = await db.query(
              `SELECT pl.*, s.status AS session_status, s.last_heartbeat_at AS session_heartbeat
               FROM path_locks pl
               JOIN sessions s ON pl.session_id = s.session_id
               WHERE pl.status = 'active'
               ORDER BY pl.acquired_at DESC
               LIMIT $1`,
              [params.limit],
            )
            items = rows.rows.map((r) => {
              const { session_status, session_heartbeat, lock_id, path, lock_kind, session_id, status, acquired_at, expires_at, released_at } = r
              return {
                lock_id,
                path,
                lock_kind,
                session_id,
                status,
                acquired_at,
                expires_at,
                released_at,
                session_status,
                session_heartbeat,
              }
            })
          } finally {
            await db.close()
          }
          break
        }

        case "pending": {
          // Find pending write journals
          const journals = await store.findPendingJournals()
          const journalItems = journals.map(fmtWriteJournal)

          // Abandon expired sessions (returns report)
          const report = await store.abandonExpiredSessions()

          items = [
            ...(journalItems.length > 0
              ? [{ _type: "pending_journals", journals: journalItems, count: journalItems.length }]
              : []),
            ...(report.abandoned_count > 0 || report.expired_lock_count > 0 || report.expired_claim_count > 0
              ? [{
                  _type: "expired_sessions_report",
                  abandoned_count: report.abandoned_count,
                  abandoned_session_ids: report.abandoned_session_ids,
                  expired_lock_count: report.expired_lock_count,
                  expired_claim_count: report.expired_claim_count,
                }]
              : []),
          ]
          break
        }
      }
    } catch (err) {
      const envelope = createEnvelope({
        tool_id: TOOL_ID,
        tool_version: TOOL_VERSION,
        invocation_id: invocationId,
        started_at: startedAt,
        status: "error",
        risk_level: RISK_LEVEL,
        requires_approval: false,
        requires_hash_precondition: false,
        error: {
          code: "INTERNAL_ERROR",
          message: `Query failed: ${err instanceof Error ? err.message : String(err)}`,
          retryable: false,
        },
      })
      return {
        content: [{ type: "text", text: `error: Query failed: ${err instanceof Error ? err.message : String(err)}` }],
        details: envelope as unknown as Record<string, unknown>,
      }
    }

    // ── Build envelope ──

    const result: OmpHistoryOutput = {
      mode: params.mode,
      store_available: true,
      items,
      count: items.length,
      truncated: items.length >= params.limit,
    }

    const envelope = createEnvelope({
      tool_id: TOOL_ID,
      tool_version: TOOL_VERSION,
      invocation_id: invocationId,
      started_at: startedAt,
      status: "ok",
      risk_level: RISK_LEVEL,
      requires_approval: false,
      requires_hash_precondition: false,
      result,
    })

    // ── Audit event ──

    const event: OmpToolEventV1 = {
      schema: "omp.tool.event.v1",
      event_id: createEventId(),
      timestamp: new Date().toISOString(),
      invocation_id: invocationId,
      tool_id: TOOL_ID,
      tool_version: TOOL_VERSION,
      status: "ok",
      risk_level: RISK_LEVEL,
      paths: { read: [], written: [], denied: [] },
      input_sha256: "",
    }
    appendAuditEvent(ompCtx, event)

    return wrapResult(params.mode, true, items, envelope)
  },
})
export default factory
