import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./coordination.txt"
import { DatabaseAdapter } from "@/storage/adapter"
import { eq, and, sql } from "drizzle-orm"
import {
  CoordinationClaimTable,
  CoordinationReservationTable,
  CoordinationFanOutTable,
} from "@/coordination/coordination.pg.sql"
import { Contention } from "@/coordination/contention"

// --- Types ---

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
}

export type PathReservation = {
  path: string
  taskId: string
  sessionId: string
  status: "reserved" | "released" | "conflicted"
  createdAt: number
}

export type FanOutGroup = {
  wave: number
  waveType: WaveType
  taskIds: string[]
  completeCount: number
}

// --- Table initialization ---

/** Lazy init guard: CREATE TABLE IF NOT EXISTS runs at most once per process. */
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
        created_at INTEGER NOT NULL,
        released_at INTEGER
      )`,
    ),
  )
  yield* adapter.query((db) =>
    db.run(
      `CREATE TABLE IF NOT EXISTS coordination_reservation (
        path TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL
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

// --- Row-to-type helpers ---

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
  }
}

function reservationRowToType(row: {
  path: string
  task_id: string
  session_id: string
  status: "reserved" | "released" | "conflicted"
  created_at: number
}): PathReservation {
  return {
    path: row.path,
    taskId: row.task_id,
    sessionId: row.session_id,
    status: row.status,
    createdAt: row.created_at,
  }
}

function fanOutRowToType(row: {
  session_id: string
  wave: number
  wave_type: string
  task_ids: string[]
  complete_count: number
}): FanOutGroup {
  return {
    wave: row.wave,
    waveType: row.wave_type as WaveType,
    taskIds: row.task_ids,
    completeCount: row.complete_count,
  }
}

// --- Claim operations ---

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
        await tx
          .update(CoordinationFanOutTable)
          .set({ task_ids: [...existing.task_ids, taskId] })
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
  return rows.length > 0 ? claimRowToType(rows[0]) : null
})

export const getSessionClaims = Effect.fn("Coordination.getSessionClaims")(function* (sessionId: string) {
  const adapter = yield* DatabaseAdapter.Service
  const rows = yield* adapter.query((db) =>
    db
      .select()
      .from(CoordinationClaimTable)
      .where(eq(CoordinationClaimTable.session_id, sessionId)),
  )
  return rows.map(claimRowToType)
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

// --- Path reservation operations ---

export const reservePath = Effect.fn("Coordination.reservePath")(function* (
  path: string,
  taskId: string,
  sessionId: string,
) {
  const adapter = yield* DatabaseAdapter.Service
  // Check-and-insert in a transaction to prevent concurrent reservation races
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
      return { success: false as const, reason: `Path already reserved by task ${existing[0].task_id}` }
    }
    await tx
      .insert(CoordinationReservationTable)
      .values({
        path,
        task_id: taskId,
        session_id: sessionId,
        status: "reserved" as const,
        created_at: Date.now(),
      })
      .onConflictDoUpdate({
        target: CoordinationReservationTable.path,
        set: {
          task_id: taskId,
          session_id: sessionId,
          status: "reserved",
          created_at: Date.now(),
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

// --- Fan-out operations ---

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

// --- Structured result injection ---

export function formatStructuredResult(claim: TaskClaim): string {
  const lines: string[] = [
    `<task id="${claim.taskId}" status="${claim.status}">`,
    `  <description>${claim.description}</description>`,
    `  <subagent_type>${claim.subagentType}</subagent_type>`,
  ]
  if (claim.wave > 0) {
    lines.push(`  <wave>${claim.wave}</wave>`)
    if (claim.waveType) lines.push(`  <wave_type>${claim.waveType}</wave_type>`)
  }
  if (claim.result) {
    lines.push(`  <task_result>${claim.result}</task_result>`)
  }
  if (claim.error) {
    lines.push(`  <error>${claim.error}</error>`)
  }
  lines.push(`</task>`)
  return lines.join("\n")
}

// --- Meta-tool for querying coordination state ---

export const CoordinationParameters = Schema.Struct({
  operation: Schema.Literal("claims", "reservations", "wave_status", "contention", "all"),
  sessionId: Schema.optional(Schema.String),
  taskId: Schema.optional(Schema.String),
  wave: Schema.optional(Schema.Number),
  waveType: Schema.optional(Schema.String),
})

export const CoordinationTool = Tool.define(
  "coordination",
  Effect.gen(function* () {
    const adapter = yield* DatabaseAdapter.Service
    // Ensure coordination tables exist on first tool load
    yield* ensureCoordinationTables()
    return {
      description: DESCRIPTION,
      parameters: CoordinationParameters,
      execute: (params: Schema.Schema.Type<typeof CoordinationParameters>) =>
        Effect.gen(function* () {
          let output: string

          if (params.operation === "claims") {
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
              const sid: string = params.sessionId
              const sessionClaims = yield* adapter.query((db) =>
                db.select().from(CoordinationClaimTable)
                  .where(eq(CoordinationClaimTable.session_id, sid)),
              )
              output = sessionClaims.length
                ? sessionClaims.map((r: any) => formatStructuredResult(claimRowToType(r))).join("\n")
                : `No claims for session ${params.sessionId}`
            } else {
              const allClaims: any[] = yield* adapter.query((db) =>
                db.select().from(CoordinationClaimTable),
              )
              output = allClaims.length
                ? allClaims.map((r) => formatStructuredResult(claimRowToType(r))).join("\n")
                : "No claims recorded"
            }
          } else if (params.operation === "reservations") {
            const active = yield* adapter.query((db) =>
              db.select().from(CoordinationReservationTable)
                .where(eq(CoordinationReservationTable.status, "reserved")),
            )
            output = active.length
              ? active.map((r: { path: string; task_id: string }) => `  ${r.path} (task: ${r.task_id})`).join("\n")
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
                const pending = group.task_ids.length - group.complete_count
                const runningClaims = pending > 0
                  ? yield* adapter.query((db) =>
                      db.select().from(CoordinationClaimTable)
                        .where(
                          and(
                            eq(CoordinationClaimTable.status, "claimed"),
                            sql`${CoordinationClaimTable.task_id} = ANY(${group.task_ids})`,
                          ),
                        ),
                    )
                  : []
                output = [
                  `Wave ${group.wave} (${group.wave_type})`,
                  `  Total tasks: ${group.task_ids.length}`,
                  `  Complete: ${group.complete_count}`,
                  `  Pending: ${pending}`,
                  ...(runningClaims.length > 0
                    ? [
                        `  Tasks still running:`,
                        ...runningClaims.map((c: any) => `    ${c.task_id}: ${c.description}`),
                      ]
                    : []),
                ].join("\n")
              }
            }
          } else if (params.operation === "contention") {
            const collisions = yield* Contention.getCollisions()
            if (collisions.length === 0) {
              output = "No active fragment collisions detected"
            } else {
              const lines: string[] = []
              for (const entry of collisions) {
                lines.push(`File: ${entry.targetFile}`)
                for (const col of entry.collisions) {
                  lines.push(`  └ ${col.severity}: conflicts with ${col.conflictingLaneId} (fragment: ${col.conflictingFragmentId})`)
                  lines.push(`    anchor_overlap: ${col.anchorOverlap}`)
                }
              }
              output = lines.join("\n")
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
            const allCollisions = yield* Contention.getCollisions()
            if (allCollisions.length) parts.push(`Contentions: ${allCollisions.length} file(s) with active collisions`)
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

export * as Coordination from "./coordination"
