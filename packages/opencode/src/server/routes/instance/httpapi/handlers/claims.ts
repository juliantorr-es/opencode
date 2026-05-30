import { CoordinationClaimTable, CoordinationReservationTable } from "@/tool/coordination"
import * as Database from "@/storage/db"
import { and, desc, eq, sql } from "drizzle-orm"
import { DateTime, Effect, Schema } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"

export const claimsHandlers = HttpApiBuilder.group(InstanceHttpApi, "claims", (handlers) =>
  Effect.gen(function* () {
    return handlers
      .handle(
        "list",
        Effect.fn(function* (ctx) {
          const filters: (ReturnType<typeof eq> | ReturnType<typeof and>)[] = []

          if (ctx.query.sessionId) {
            filters.push(eq(CoordinationClaimTable.session_id, ctx.query.sessionId))
          }
          if (ctx.query.status) {
            filters.push(eq(CoordinationClaimTable.status, ctx.query.status))
          }

          const claimRows = Database.use((db) => {
            const query = db.select().from(CoordinationClaimTable)
            if (filters.length > 0) {
              return query.where(and(...filters)).orderBy(desc(CoordinationClaimTable.created_at)).all()
            }
            return query.orderBy(desc(CoordinationClaimTable.created_at)).all()
          })

          const reservationRows = Database.use((db) => {
            let query = db.select().from(CoordinationReservationTable)
            if (ctx.query.sessionId) {
              query = query.where(eq(CoordinationReservationTable.session_id, ctx.query.sessionId))
            }
            return query.orderBy(desc(CoordinationReservationTable.created_at)).all()
          })

          return {
            claims: claimRows.map((row) => ({
              taskId: row.task_id,
              sessionId: row.session_id,
              wave: row.wave,
              waveType: row.wave_type,
              subagentType: row.subagent_type,
              description: row.description,
              status: row.status,
              result: row.result ?? undefined,
              error: row.error ?? undefined,
              createdAt: row.created_at,
              releasedAt: row.released_at ?? undefined,
            })),
            reservations: reservationRows.map((row) => ({
              path: row.path,
              taskId: row.task_id,
              sessionId: row.session_id,
              status: row.status,
              createdAt: row.created_at,
            })),
          }
        }),
      )
      .handle(
        "tree",
        Effect.fn(function* (ctx) {
          const filters: ReturnType<typeof eq>[] = []
          if (ctx.query.sessionId) {
            filters.push(eq(CoordinationReservationTable.session_id, ctx.query.sessionId))
          }

          const reservationRows = Database.use((db) => {
            let query = db.select().from(CoordinationReservationTable)
            if (filters.length > 0) {
              query = (query as any).where(and(...filters))
            }
            return query.orderBy(desc(CoordinationReservationTable.created_at)).all()
          })

          const claimRows = Database.use((db) => {
            let query = db.select().from(CoordinationClaimTable)
            if (ctx.query.sessionId) {
              query = query.where(eq(CoordinationClaimTable.session_id, ctx.query.sessionId))
            }
            return query.orderBy(desc(CoordinationClaimTable.created_at)).all()
          })

          // Build a lookup from session_id+task_id to claim info for reservation-to-claim linking
          const claimById = new Map<string, typeof claimRows[0]>()
          for (const c of claimRows) {
            const key = `${c.session_id}:${c.task_id}`
            claimById.set(key, c)
          }

          // Build a path → status map from reservations, enriched with claim data
          const pathStatus = new Map<
            string,
            { status: string; claim: (typeof claimRows[0]) | null }
          >()

          for (const r of reservationRows) {
            const claimKey = `${r.session_id}:${r.task_id}`
            const claim = claimById.get(claimKey) ?? null
            const displayStatus =
              r.status === "conflicted" ? "conflict" :
              claim?.status === "released" ? "released" :
              r.status === "reserved" ? "claimed_by_other" :
              "unclaimed"
            pathStatus.set(r.path, { status: displayStatus, claim })
          }

          // Organize paths into a tree structure
          const tree = buildPathTree(pathStatus)
          return { nodes: tree }
        }),
      )
  }),
)

function buildPathTree(
  pathStatus: Map<string, { status: string; claim: any }>,
): Array<{
  path: string
  name: string
  type: "file" | "directory"
  status: string
  claim: any
  children?: any[]
}> {
  const root: Record<string, any> = {}

  for (const [filePath, info] of pathStatus) {
    const parts = filePath.split("/")
    let current = root

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]!
      const isLast = i === parts.length - 1
      const pathSoFar = parts.slice(0, i + 1).join("/")

      if (!current[part]) {
        if (isLast) {
          // This is a file claim
          current[part] = {
            file: {
              path: pathSoFar,
              name: part,
              type: "file" as const,
              status: info.status,
              claim: info.claim
                ? {
                    taskId: info.claim.task_id,
                    sessionId: info.claim.session_id,
                    wave: info.claim.wave,
                    waveType: info.claim.wave_type,
                    subagentType: info.claim.subagent_type,
                    description: info.claim.description,
                    status: info.claim.status,
                    createdAt: info.claim.created_at,
                    releasedAt: info.claim.released_at ?? undefined,
                  }
                : undefined,
            },
          }
        } else {
          current[part] = { dir: { children: {} } }
        }
      } else if (isLast && current[part]?.dir) {
        // A claim on a directory path
        current[part].dir.claim = info.claim
        current[part].dir.status = info.status
      }

      current = current[part]?.dir?.children ?? current[part] ?? {}
    }
  }

  function convert(node: Record<string, any>, parentPath: string): any[] {
    const result: any[] = []
    for (const [name, value] of Object.entries(node)) {
      if (value.file) {
        result.push(value.file)
      } else if (value.dir) {
        const dirPath = parentPath ? `${parentPath}/${name}` : name
        const children = value.dir.children ? convert(value.dir.children, dirPath) : []
        result.push({
          path: dirPath,
          name,
          type: "directory" as const,
          status: value.dir.status ?? "unclaimed",
          claim: value.dir.claim
            ? {
                taskId: value.dir.claim.task_id,
                sessionId: value.dir.claim.session_id,
                wave: value.dir.claim.wave,
                waveType: value.dir.claim.wave_type,
                subagentType: value.dir.claim.subagent_type,
                description: value.dir.claim.description,
                status: value.dir.claim.status,
                createdAt: value.dir.claim.created_at,
                releasedAt: value.dir.claim.released_at ?? undefined,
              }
            : undefined,
          children,
        })
      }
    }
    // Sort: directories first, then files, alphabetically
    result.sort((a, b) => {
      if (a.type !== b.type) return a.type === "directory" ? -1 : 1
      return a.name.localeCompare(b.name)
    })
    return result
  }

  return convert(root, "")
}
