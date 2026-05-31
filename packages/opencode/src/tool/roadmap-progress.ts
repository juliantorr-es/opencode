import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { InstanceState } from "@/effect/instance-state"
import path from "path"
import DESCRIPTION from "./roadmap-progress.txt"

const Parameters = Schema.Struct({
  item_id: Schema.String.annotate({ description: "Roadmap item ID (e.g. 'PG-001')" }),
  status: Schema.String.annotate({ description: "not_started | in_progress | completed | blocked | frozen" }),
  completion_pct: Schema.optional(Schema.Number).annotate({ description: "0-100" }),
  note: Schema.String.annotate({ description: "What changed" }),
  session_ref: Schema.optional(Schema.String).annotate({ description: "Session ID for audit trail" }),
})

export const RoadmapProgressTool = Tool.define(
  "roadmap_progress",
  Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const activePath = path.join(instance.directory, "docs/json/roadmaps/active.v1.json")
          const progressPath = path.join(instance.directory, "docs/json/roadmaps/progress.v1.jsonl")
          const roadmapDir = path.dirname(activePath)

          const activeExists = yield* fs.existsSafe(activePath)
          if (!activeExists) {
            return {
              title: "roadmap_progress",
              metadata: { status: "fail" },
              output: JSON.stringify(
                { error: "No active roadmap. Run roadmap_init first." },
                null,
                2,
              ),
            }
          }

          const activeContent = yield* fs.readFileString(activePath)
          const active = JSON.parse(activeContent) as Record<string, unknown>
          const itemsList = (active.items ?? []) as Array<Record<string, unknown>>
          const items: Record<string, Record<string, unknown>> = {}
          for (const item of itemsList) {
            items[item.id as string] = item
          }

          if (!items[params.item_id]) {
            return {
              title: "roadmap_progress",
              metadata: { status: "fail" },
              output: JSON.stringify(
                {
                  error: `Item '${params.item_id}' not found`,
                  available: Object.keys(items).slice(0, 10),
                },
                null,
                2,
              ),
            }
          }

          const item = items[params.item_id]
          const oldStatus = item.status
          const oldPct = (item.completion_pct as number) || 0

          item.status = params.status
          item.completion_pct = params.completion_pct ?? item.completion_pct ?? 0
          if (!item.sessions) item.sessions = [] as Array<Record<string, unknown>>
          const sessions = item.sessions as Array<Record<string, unknown>>
          const truncatedNote = params.note.length > 500 ? params.note.slice(0, 497) + "..." : params.note
          sessions.push({ ref: params.session_ref || ctx.sessionID, note: truncatedNote, pct: params.completion_pct ?? 0 })

          yield* fs.writeFileString(activePath, JSON.stringify(active, null, 2))
          yield* fs.ensureDir(roadmapDir)

          const progressEntry = {
            schema_version: "v1",
            item_id: params.item_id,
            status: params.status,
            completion_pct: params.completion_pct ?? item.completion_pct ?? 0,
            note: truncatedNote,
            session_ref: params.session_ref || ctx.sessionID,
            recorded_at: new Date().toISOString(),
          }
          yield* fs.appendLine(progressPath, JSON.stringify(progressEntry))

          // Check newly unblocked
          const completedIds = new Set(
            Object.entries(items)
              .filter(([, i]) => i.status === "completed" || (i.completion_pct as number) >= 100)
              .map(([id]) => id),
          )
          const newlyUnblocked: Array<Record<string, unknown>> = []
          if ((params.completion_pct ?? 0) >= 100 || params.status === "completed") {
            for (const [id, depItem] of Object.entries(items)) {
              if (id === params.item_id || depItem.status !== "not_started" || !(depItem.depends_on as string[] | undefined)?.length) continue
              const deps = depItem.depends_on as string[]
              if (deps.every((d) => completedIds.has(d))) {
                newlyUnblocked.push({ id, title: depItem.title, was_blocked_by: deps.filter((d) => d === params.item_id) })
              }
            }
          }

          return {
            title: "roadmap_progress",
            metadata: { item_id: params.item_id, new_status: params.status },
            output: JSON.stringify(
              {
                status: "updated",
                item_id: params.item_id,
                title: item.title,
                previous_status: oldStatus,
                new_status: params.status,
                previous_pct: oldPct,
                new_pct: params.completion_pct ?? 0,
                newly_unblocked: newlyUnblocked,
                hint: "Run roadmap_next to see updated priority queue.",
              },
              null,
              2,
            ),
          }
        }).pipe(Effect.orDie),
    }
  }),
)

export * as RoadmapProgress from "./roadmap-progress"
