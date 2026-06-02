import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { DatabaseAdapter } from "@/storage/adapter"
import { eq, and, sql, inArray } from "drizzle-orm"
import {
  CoordinationClaimTable,
  CoordinationReservationTable,
  CoordinationFanOutTable,
} from "./coordination.pg.sql"
export { CoordinationClaimTable, CoordinationReservationTable, CoordinationFanOutTable }

// ── Types ─────────────────────────────────────────────────

export const WaveTypes = [
  "learning",
  "critique",
  "execution",
  "validation",
  "stress",
  "repair",
  "documentation",
  "publish",
  "report",
] as const

export type WaveType = (typeof WaveTypes)[number]

export type TaskClaim = {
  taskId: string
  sessionId: string
  wave: number
  waveType: WaveType | ""
  subagentType: string
  description: string
  status: "claimed" | "released" | "failed"
  result?: string
  error?: string
  createdAt: number
  releasedAt?: number
  expiresAt?: number
}

export type PathReservation = {
  path: string
  taskId: string
  sessionId: string
  status: "reserved" | "released" | "conflicted"
  createdAt: number
  expiresAt?: number
  baseDigest?: string
}

export type FanOutGroup = {
  wave: number
  waveType: WaveType
  taskIds: string[]
  completeCount: number
}



// ── Table initialization ─────────────────────────────────

let _tablesInitialized = false

export const ensureCoordinationTables = Effect.fn("Coordination.ensureCoordinationTables")(function* () {
  if (_tablesInitialized) return
  const adapter = yield* DatabaseAdapter.Service
  yield* adapter.query((db) =>
    db.run(
      `CREATE TABLE IF NOT EXISTS coordination_claim (
        task_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        wave INTEGER NOT NULL DEFAULT 0,
        wave_type TEXT NOT NULL DEFAULT '',
        subagent_type TEXT NOT NULL,
        description TEXT NOT NULL,
        status TEXT NOT NULL,
        result TEXT,
        error TEXT,
        created_at BIGINT NOT NULL,
        expires_at BIGINT,
        released_at BIGINT
      )`,
    ),
  )
  // Migrate existing tables: add expires_at for coordination_claim TTL support
  try {
    yield* adapter.query((db) =>
      db.run(`ALTER TABLE coordination_claim ADD COLUMN expires_at BIGINT`),
    )
  } catch (_) {
    // Column already exists — silently ignore
  }
  // Migrate existing tables: add expires_at for coordination_reservation TTL support
  try {
    yield* adapter.query((db) =>
      db.run(`ALTER TABLE coordination_reservation ADD COLUMN expires_at BIGINT`),
    )
  } catch (_) {
    // Column already exists — silently ignore
  }
  // Migrate existing tables: add base_digest for digest-backed conflict detection
  try {
    yield* adapter.query((db) =>
      db.run(`ALTER TABLE coordination_reservation ADD COLUMN base_digest TEXT`),
    )
  } catch (_) {
    // Column already exists — silently ignore
  }
  yield* adapter.query((db) =>
    db.run(
      `CREATE TABLE IF NOT EXISTS coordination_reservation (
        path TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at BIGINT NOT NULL,
        expires_at BIGINT,
        base_digest TEXT
      )`,
    ),
  )
  yield* adapter.query((db) =>
    db.run(
      `CREATE TABLE IF NOT EXISTS coordination_fan_out (
        session_id TEXT NOT NULL,
        wave INTEGER NOT NULL,
        wave_type TEXT NOT NULL,
        task_ids TEXT NOT NULL,
        complete_count INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (session_id, wave, wave_type)
      )`,
    ),
  )
  _tablesInitialized = true
  yield* Effect.logInfo("coordination tables ensured")
})

// ── Row-to-type helpers ──────────────────────────────────

function claimRowToType(row: {
  task_id: string
  session_id: string
  wave: number
  wave_type: string
  subagent_type: string
  description: string
  status: "claimed" | "released" | "failed"
  result: string | null
  error: string | null
  created_at: number
  expires_at: number | null
  released_at: number | null
}): TaskClaim {
  return {
    taskId: row.task_id,
    sessionId: row.session_id,
    wave: row.wave,
    waveType: row.wave_type as WaveType | "",
    subagentType: row.subagent_type,
    description: row.description,
    status: row.status,
    result: row.result ?? undefined,
    error: row.error ?? undefined,
    createdAt: row.created_at,
    releasedAt: row.released_at ?? undefined,
    expiresAt: row.expires_at ?? undefined,
  }
}

function reservationRowToType(row: {
  path: string
  task_id: string
  session_id: string
  status: "reserved" | "released" | "conflicted"
  created_at: number
  expires_at: number | null
  base_digest: string | null
}): PathReservation {
  return {
    path: row.path,
    taskId: row.task_id,
    sessionId: row.session_id,
    status: row.status,
    createdAt: row.created_at,
    expiresAt: row.expires_at ?? undefined,
    baseDigest: row.base_digest ?? undefined,
  }
}

function fanOutRowToType(row: {
  session_id: string
  wave: number
  wave_type: string
  task_ids: string[] | string
  complete_count: number
}): FanOutGroup {
  return {
    wave: row.wave,
    waveType: row.wave_type as WaveType,
    taskIds: Array.isArray(row.task_ids) ? row.task_ids : JSON.parse(row.task_ids),
    completeCount: row.complete_count,
  }
}

// ── Claim operations ─────────────────────────────────────

export const claimTask = Effect.fn("Coordination.claimTask")(function* (
  taskId: string,
  sessionId: string,
  subagentType: string,
  description: string,
  wave: number = 0,
  waveType: WaveType | "" = "",
) {
  const adapter = yield* DatabaseAdapter.Service
  yield* adapter.transaction(async (tx) => {
    await tx
      .insert(CoordinationClaimTable)
      .values({
        task_id: taskId,
        session_id: sessionId,
        wave,
        wave_type: waveType,
        subagent_type: subagentType,
        description,
        status: "claimed" as const,
        created_at: Date.now(),
        expires_at: Date.now() + 1_800_000,
      })
      .onConflictDoUpdate({
        target: CoordinationClaimTable.task_id,
        set: {
          session_id: sessionId,
          wave,
          wave_type: waveType,
          subagent_type: subagentType,
          description,
          status: "claimed",
          created_at: Date.now(),
          expires_at: Date.now() + 1_800_000,
          result: null,
          error: null,
          released_at: null,
        },
      })
    // Track in fan-out group if this is a wave task
    if (wave > 0 && waveType) {
      const rows = await tx
        .select()
        .from(CoordinationFanOutTable)
        .where(
          and(
            eq(CoordinationFanOutTable.session_id, sessionId),
            eq(CoordinationFanOutTable.wave, wave),
            eq(CoordinationFanOutTable.wave_type, waveType),
          ),
        )
        .limit(1)
      if (rows.length > 0) {
        const existing = rows[0]
        const existingTaskIds: string[] = Array.isArray(existing.task_ids)
          ? existing.task_ids
          : JSON.parse(existing.task_ids)
        await tx
          .update(CoordinationFanOutTable)
          .set({ task_ids: existingTaskIds.includes(taskId) ? existingTaskIds : [...existingTaskIds, taskId] })
          .where(
            and(
              eq(CoordinationFanOutTable.session_id, sessionId),
              eq(CoordinationFanOutTable.wave, wave),
              eq(CoordinationFanOutTable.wave_type, waveType),
            ),
          )
      } else {
        await tx.insert(CoordinationFanOutTable).values({
          session_id: sessionId,
          wave,
          wave_type: waveType,
          task_ids: [taskId],
          complete_count: 0,
        })
      }
    }
  })
})

export const releaseTask = Effect.fn("Coordination.releaseTask")(function* (
  taskId: string,
  result: string,
) {
  const adapter = yield* DatabaseAdapter.Service
  yield* adapter.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(CoordinationClaimTable)
      .where(eq(CoordinationClaimTable.task_id, taskId))
      .limit(1)
    if (rows.length === 0) return
    const claim = rows[0]
    if (claim.status === "released" || claim.status === "failed") return
    await tx
      .update(CoordinationClaimTable)
      .set({
        status: "released",
        result,
        released_at: Date.now(),
      })
      .where(eq(CoordinationClaimTable.task_id, taskId))
    // Update fan-out group - increment complete_count atomically
    if (claim.wave > 0 && claim.wave_type) {
      await tx
        .update(CoordinationFanOutTable)
        .set({
          complete_count: sql`${CoordinationFanOutTable.complete_count} + 1`,
        })
        .where(
          and(
            eq(CoordinationFanOutTable.session_id, claim.session_id),
            eq(CoordinationFanOutTable.wave, claim.wave),
            eq(CoordinationFanOutTable.wave_type, claim.wave_type),
          ),
        )
    }
  })
})

export const failTask = Effect.fn("Coordination.failTask")(function* (
  taskId: string,
  error: string,
) {
  const adapter = yield* DatabaseAdapter.Service
  yield* adapter.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(CoordinationClaimTable)
      .where(eq(CoordinationClaimTable.task_id, taskId))
      .limit(1)
    if (rows.length === 0) return
    const claim = rows[0]
    if (claim.status === "released" || claim.status === "failed") return
    await tx
      .update(CoordinationClaimTable)
      .set({
        status: "failed",
        error,
        released_at: Date.now(),
      })
      .where(eq(CoordinationClaimTable.task_id, taskId))
    // Update fan-out group - increment complete_count atomically
    if (claim.wave > 0 && claim.wave_type) {
      await tx
        .update(CoordinationFanOutTable)
        .set({
          complete_count: sql`${CoordinationFanOutTable.complete_count} + 1`,
        })
        .where(
          and(
            eq(CoordinationFanOutTable.session_id, claim.session_id),
            eq(CoordinationFanOutTable.wave, claim.wave),
            eq(CoordinationFanOutTable.wave_type, claim.wave_type),
          ),
        )
    }
  })
})

export const getClaim = Effect.fn("Coordination.getClaim")(function* (taskId: string) {
  const adapter = yield* DatabaseAdapter.Service
  const rows = yield* adapter.query((db) =>
    db
      .select()
      .from(CoordinationClaimTable)
      .where(eq(CoordinationClaimTable.task_id, taskId))
      .limit(1),
  )
  if (rows.length === 0) return null
  const claim = claimRowToType(rows[0])
  if (claim.status === "claimed" && claim.expiresAt && claim.expiresAt < Date.now()) {
    yield* adapter.query((db) =>
      db
        .update(CoordinationClaimTable)
        .set({ status: "failed", error: "Claim expired (TTL)" })
        .where(eq(CoordinationClaimTable.task_id, taskId)),
    )
    if (claim.wave > 0 && claim.waveType) {
      yield* adapter.query((db) =>
        db
          .update(CoordinationFanOutTable)
          .set({
            complete_count: sql`${CoordinationFanOutTable.complete_count} + 1`,
          })
          .where(
            and(
              eq(CoordinationFanOutTable.session_id, claim.sessionId),
              eq(CoordinationFanOutTable.wave, claim.wave),
              eq(CoordinationFanOutTable.wave_type, claim.waveType),
            ),
          ),
      )
    }
    const refreshed = yield* adapter.query((db) =>
      db
        .select()
        .from(CoordinationClaimTable)
        .where(eq(CoordinationClaimTable.task_id, taskId))
        .limit(1),
    )
    return refreshed.length > 0 ? claimRowToType(refreshed[0]) : null
  }
  return claim
})

export const getSessionClaims = Effect.fn("Coordination.getSessionClaims")(function* (sessionId: string) {
  const adapter = yield* DatabaseAdapter.Service
  const rows = yield* adapter.query((db) =>
    db
      .select()
      .from(CoordinationClaimTable)
      .where(eq(CoordinationClaimTable.session_id, sessionId)),
  )
  const claims = rows.map(claimRowToType)
  const now = Date.now()
  const result: TaskClaim[] = []
  for (const claim of claims) {
    if (claim.status === "claimed" && claim.expiresAt && claim.expiresAt < now) {
      yield* adapter.query((db) =>
        db
          .update(CoordinationClaimTable)
          .set({ status: "failed", error: "Claim expired (TTL)" })
          .where(eq(CoordinationClaimTable.task_id, claim.taskId)),
      )
      if (claim.wave > 0 && claim.waveType) {
        yield* adapter.query((db) =>
          db
            .update(CoordinationFanOutTable)
            .set({
              complete_count: sql`${CoordinationFanOutTable.complete_count} + 1`,
            })
            .where(
              and(
                eq(CoordinationFanOutTable.session_id, claim.sessionId),
                eq(CoordinationFanOutTable.wave, claim.wave),
                eq(CoordinationFanOutTable.wave_type, claim.waveType),
              ),
            ),
        )
      }
      result.push({ ...claim, status: "failed" as const, error: "Claim expired (TTL)" })
    } else {
      result.push(claim)
    }
  }
  return result
})

export const getWaveClaims = Effect.fn("Coordination.getWaveClaims")(function* (
  sessionId: string,
  wave: number,
  waveType: WaveType,
) {
  const adapter = yield* DatabaseAdapter.Service
  const rows = yield* adapter.query((db) =>
    db
      .select()
      .from(CoordinationClaimTable)
      .where(
        and(
          eq(CoordinationClaimTable.session_id, sessionId),
          eq(CoordinationClaimTable.wave, wave),
          eq(CoordinationClaimTable.wave_type, waveType),
        ),
      ),
  )
  return rows.map(claimRowToType)
})

// ── Path reservation operations ──────────────────────────

export const reservePath = Effect.fn("Coordination.reservePath")(function* (
  path: string,
  taskId: string,
  sessionId: string,
  baseDigest?: string,
) {
  const adapter = yield* DatabaseAdapter.Service
  const conflict = yield* adapter.transaction(async (tx) => {
    const existing = await tx
      .select()
      .from(CoordinationReservationTable)
      .where(
        and(
          eq(CoordinationReservationTable.path, path),
          eq(CoordinationReservationTable.status, "reserved"),
        ),
      )
      .limit(1)
    if (existing.length > 0 && existing[0].task_id !== taskId) {
      const isStale = existing[0].expires_at != null && existing[0].expires_at < Date.now()
      if (isStale) {
        // Release stale reservation so the new claim can proceed
        await tx.update(CoordinationReservationTable)
          .set({ status: "released" })
          .where(eq(CoordinationReservationTable.path, path))
      } else {
        return { success: false as const, reason: `Path already reserved by task ${existing[0].task_id}` }
      }
    }
    await tx
      .insert(CoordinationReservationTable)
      .values({
        path,
        task_id: taskId,
        session_id: sessionId,
        status: "reserved" as const,
        created_at: Date.now(),
        expires_at: Date.now() + 1_800_000,
        base_digest: baseDigest ?? null,
      })
      .onConflictDoUpdate({
        target: CoordinationReservationTable.path,
        set: {
          task_id: taskId,
          session_id: sessionId,
          status: "reserved",
          created_at: Date.now(),
          expires_at: Date.now() + 1_800_000,
        },
      })
    return { success: true as const }
  })
  return conflict
})

export const releasePath = Effect.fn("Coordination.releasePath")(function* (path: string, taskId: string) {
  const adapter = yield* DatabaseAdapter.Service
  yield* adapter.query((db) =>
    db
      .update(CoordinationReservationTable)
      .set({ status: "released" })
      .where(
        and(
          eq(CoordinationReservationTable.path, path),
          eq(CoordinationReservationTable.task_id, taskId),
        ),
      ),
  )
})

export const renewPathLease = Effect.fn("Coordination.renewPathLease")(function* (
  path: string,
  taskId: string,
) {
  const adapter = yield* DatabaseAdapter.Service
  const result = yield* adapter.transaction(async (tx) => {
    const existing = await tx
      .select()
      .from(CoordinationReservationTable)
      .where(
        and(
          eq(CoordinationReservationTable.path, path),
          eq(CoordinationReservationTable.task_id, taskId),
          eq(CoordinationReservationTable.status, "reserved"),
        ),
      )
      .limit(1)
    if (existing.length === 0) {
      return { success: false as const, reason: "No active reservation found for this task" }
    }
    await tx
      .update(CoordinationReservationTable)
      .set({ expires_at: Date.now() + 1_800_000 })
      .where(
        and(
          eq(CoordinationReservationTable.path, path),
          eq(CoordinationReservationTable.task_id, taskId),
        ),
      )
    return { success: true as const }
  })
  return result
})

export const checkPathReserved = Effect.fn("Coordination.checkPathReserved")(function* (path: string) {
  const adapter = yield* DatabaseAdapter.Service
  const rows = yield* adapter.query((db) =>
    db
      .select()
      .from(CoordinationReservationTable)
      .where(
        and(
          eq(CoordinationReservationTable.path, path),
          eq(CoordinationReservationTable.status, "reserved"),
        ),
      )
      .limit(1),
  )
  if (rows.length > 0) return reservationRowToType(rows[0])
  return null
})

export const getSessionReservations = Effect.fn("Coordination.getSessionReservations")(function* (sessionId: string) {
  const adapter = yield* DatabaseAdapter.Service
  const rows = yield* adapter.query((db) =>
    db
      .select()
      .from(CoordinationReservationTable)
      .where(
        and(
          eq(CoordinationReservationTable.session_id, sessionId),
          eq(CoordinationReservationTable.status, "reserved"),
        ),
      ),
  )
  return rows.map(reservationRowToType)
})

// ── Fan-out operations ───────────────────────────────────

export const getFanOutGroup = Effect.fn("Coordination.getFanOutGroup")(function* (
  sessionId: string,
  wave: number,
  waveType: WaveType,
) {
  const adapter = yield* DatabaseAdapter.Service
  const rows = yield* adapter.query((db) =>
    db
      .select()
      .from(CoordinationFanOutTable)
      .where(
        and(
          eq(CoordinationFanOutTable.session_id, sessionId),
          eq(CoordinationFanOutTable.wave, wave),
          eq(CoordinationFanOutTable.wave_type, waveType),
        ),
      )
      .limit(1),
  )
  return rows.length > 0 ? fanOutRowToType(rows[0]) : null
})

// ── Structured result formatter ──────────────────────────

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
}

export function formatStructuredResult(claim: TaskClaim): string {
  const lines: string[] = [
    `<task id="${escapeXml(claim.taskId)}" status="${escapeXml(claim.status)}">`,
    `  <description>${escapeXml(claim.description)}</description>`,
    `  <subagent_type>${escapeXml(claim.subagentType)}</subagent_type>`,
  ]
  if (claim.wave > 0) {
    lines.push(`  <wave>${escapeXml(String(claim.wave))}</wave>`)
    if (claim.waveType) lines.push(`  <wave_type>${escapeXml(claim.waveType)}</wave_type>`)
  }
  if (claim.result) {
    lines.push(`  <task_result>${escapeXml(claim.result)}</task_result>`)
  }
  if (claim.error) {
    lines.push(`  <error>${escapeXml(claim.error)}</error>`)
  }
  lines.push(`</task>`)
  return lines.join("\n")
}

// ── Coordination query tool ──────────────────────────────

export const CoordinationParameters = Schema.Struct({
  operation: Schema.Literals(["claims", "reservations", "wave_status", "all"]),
  sessionId: Schema.optional(Schema.String),
  taskId: Schema.optional(Schema.String),
  wave: Schema.optional(Schema.Number),
  waveType: Schema.optional(Schema.String),
})

const DESCRIPTION = `Query and manage orchestration state: task claims, path reservations, and fan-out wave tracking.

Use this tool to inspect the current coordination state, check which tasks are claimed, which file paths are reserved, and view wave-level status for active sessions.

Operations:
- \`claims\` — list all claims, filtered by sessionId or taskId
- \`reservations\` — list all active path reservations
- \`wave_status\` — fan-out progress for a specific wave (requires sessionId, wave, waveType)
- \`all\` — short summary of all coordination state`

export const CoordinationTool = Tool.define(
  "coordination",
  Effect.gen(function* () {
    const adapter = yield* DatabaseAdapter.Service
    yield* ensureCoordinationTables().pipe(Effect.orDie)
    return {
      description: DESCRIPTION,
      parameters: CoordinationParameters,
      execute: (params: Schema.Schema.Type<typeof CoordinationParameters>) =>
        Effect.gen(function* () {
          let output: string

          if (params.operation === "claims") {
            // Auto-release stale claims
            const now = Date.now()
            yield* adapter.query((db) =>
              db.update(CoordinationClaimTable)
                .set({ status: "failed", error: "Claim expired (TTL)" })
                .where(
                  and(
                    eq(CoordinationClaimTable.status, "claimed"),
                    sql`${CoordinationClaimTable.expires_at} IS NOT NULL`,
                    sql`${CoordinationClaimTable.expires_at} < ${now}`,
                  ),
                ),
            )
            if (params.taskId) {
              const claim = yield* adapter.query((db) =>
                db.select().from(CoordinationClaimTable)
                  .where(eq(CoordinationClaimTable.task_id, params.taskId as string))
                  .limit(1),
              )
              output = claim.length > 0
                ? formatStructuredResult(claimRowToType(claim[0]))
                : `No claim found for task ${params.taskId}`
            } else if (params.sessionId) {
              const sessionClaims = yield* adapter.query((db) =>
                db.select().from(CoordinationClaimTable)
                  .where(eq(CoordinationClaimTable.session_id, params.sessionId as string)),
              )
              output = sessionClaims.length
                ? sessionClaims.map((r: typeof CoordinationClaimTable.$inferSelect) => formatStructuredResult(claimRowToType(r))).join("\n")
                : `No claims for session ${params.sessionId}`
            } else {
              const allClaims = yield* adapter.query((db) =>
                db.select().from(CoordinationClaimTable),
              )
              output = allClaims.length
                ? allClaims.map((r: typeof CoordinationClaimTable.$inferSelect) => formatStructuredResult(claimRowToType(r))).join("\n")
                : "No claims recorded"
            }
          } else if (params.operation === "reservations") {
            const active = yield* adapter.query((db) =>
              db.select().from(CoordinationReservationTable)
                .where(eq(CoordinationReservationTable.status, "reserved")),
            )
            const cutoff = Date.now() - 1_800_000
            const nonStale = active.filter((r: { created_at: number }) => r.created_at > cutoff)
            // Auto-release stale reservations for next time
            if (active.length > nonStale.length) {
              yield* adapter.query((db) =>
                db.update(CoordinationReservationTable)
                  .set({ status: "released" })
                  .where(
                    and(
                      eq(CoordinationReservationTable.status, "reserved"),
                      sql`${CoordinationReservationTable.created_at} < ${cutoff}`,
                    ),
                  ),
              )
            }
            output = nonStale.length
              ? nonStale.map((r: { path: string; task_id: string }) => `  ${r.path} (task: ${r.task_id})`).join("\n")
              : "No active path reservations"
          } else if (params.operation === "wave_status") {
            if (!params.sessionId || !params.wave || !params.waveType) {
              output = "wave_status requires sessionId, wave, and waveType parameters"
            } else {
              const groupRows = yield* adapter.query((db) =>
                db.select().from(CoordinationFanOutTable).where(
                  and(
                    eq(CoordinationFanOutTable.session_id, params.sessionId!),
                    eq(CoordinationFanOutTable.wave, params.wave!),
                    eq(CoordinationFanOutTable.wave_type, params.waveType!),
                  ),
                ).limit(1),
              )
              if (groupRows.length === 0) {
                output = `No fan-out group for session ${params.sessionId}, wave ${params.wave}, ${params.waveType}`
              } else {
                const group = groupRows[0]
                const taskIds: string[] = Array.isArray(group.task_ids)
                  ? group.task_ids
                  : JSON.parse(group.task_ids)
                const pending = taskIds.length - group.complete_count
                const runningClaims = pending > 0
                  ? yield* adapter.query((db) =>
                      db.select().from(CoordinationClaimTable)
                        .where(
                          and(
                            eq(CoordinationClaimTable.status, "claimed"),
                            inArray(CoordinationClaimTable.task_id, taskIds),
                          ),
                        ),
                    )
                  : []
                output = [
                  `Wave ${group.wave} (${group.wave_type})`,
                  `  Total tasks: ${taskIds.length}`,
                  `  Complete: ${group.complete_count}`,
                  `  Pending: ${pending}`,
                  ...(runningClaims.length > 0
                    ? [
                        `  Tasks still running:`,
                        ...runningClaims.map((c: { task_id: string; description: string }) => `    ${c.task_id}: ${c.description}`),
                      ]
                    : []),
                ].join("\n")
              }
            }
          } else {
            // "all"
            const parts: string[] = []
            const allClaims = yield* adapter.query((db) =>
              db.select().from(CoordinationClaimTable),
            )
            const activeReservations = yield* adapter.query((db) =>
              db.select().from(CoordinationReservationTable)
                .where(eq(CoordinationReservationTable.status, "reserved")),
            )
            const allFanOuts = yield* adapter.query((db) =>
              db.select().from(CoordinationFanOutTable),
            )
            if (allClaims.length) parts.push(`Claims: ${allClaims.length} (${allClaims.filter((c: { status: string }) => c.status === "claimed").length} active)`)
            if (activeReservations.length) parts.push(`Reservations: ${activeReservations.length} active`)
            parts.push(`Fan-out groups: ${allFanOuts.length}`)
            output = parts.join("\n") || "No coordination state"
          }

          return {
            title: `coordination:${params.operation}`,
            metadata: { operation: params.operation },
            output,
          }
        }).pipe(Effect.orDie),
    }
  }),
)

// ── Namespace re-export ──────────────────────────────────
// Enables `import { Coordination } from "./coordination"`
// where Coordination.claimTask, Coordination.releaseTask, etc. are accessible
export * as Coordination from "./coordination"
