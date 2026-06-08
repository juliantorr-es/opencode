import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { AppFileSystem } from "@tribunus/core/filesystem"
import { InstanceState } from "@/effect/instance-state"
import path from "path"
import DESCRIPTION from "./roadmap-init.txt"

const Parameters = Schema.Struct({
  show_all: Schema.optional(Schema.Boolean).annotate({
    description: "Include completed and blocked items too",
  }),
  phase: Schema.optional(Schema.String).annotate({
    description: "Filter to a specific phase",
  }),
})

export const RoadmapInitTool = Tool.define(
  "roadmap_init",
  Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, _ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const blueprintPath = path.join(instance.directory, "docs/json/roadmaps/opencode-desktop-phase3-roadmap.v1.json")
          const activePath = path.join(instance.directory, "docs/json/roadmaps/active.v1.json")
          const progressPath = path.join(instance.directory, "docs/json/roadmaps/progress.v1.jsonl")
          const roadmapDir = path.dirname(activePath)

          const readJson = (fp: string) =>
            Effect.gen(function* () {
              if (!(yield* fs.existsSafe(fp))) return null
              try {
                return JSON.parse(yield* fs.readFileString(fp)) as Record<string, unknown>
              } catch { return null }
            })

          let blueprint = yield* readJson(blueprintPath)
          if (!blueprint) {
            blueprint = yield* readJson(activePath)
          }
          if (!blueprint) {
            return {
              title: "roadmap_init",
              metadata: { status: "fail" },
              output: JSON.stringify(
                {
                  error: "No roadmap artifacts found. Run propose_plan or create blueprint first.",
                  blueprint_path: blueprintPath,
                  active_path: activePath,
                },
                null,
                2,
              ),
            }
          }

          const bpItems = (blueprint.items ?? []) as Array<Record<string, unknown>>
          const items: Record<string, Record<string, unknown>> = {}
          for (const item of bpItems) {
            items[item.id as string] = { ...item }
          }

          // Replay progress audit over blueprint
          const progressExists = yield* fs.existsSafe(progressPath)
          if (progressExists) {
            try {
              const progressContent = yield* fs.readFileString(progressPath)
              const lines = progressContent.split("\n").filter(Boolean)
              for (const line of lines) {
                try {
                  const entry = JSON.parse(line) as Record<string, unknown>
                  const id = entry.item_id as string | undefined
                  if (id && items[id]) {
                    items[id].status = entry.status || items[id].status
                    items[id].completion_pct = (entry.completion_pct ?? items[id].completion_pct) as number
                    if (!items[id].sessions) items[id].sessions = []
                    ;(items[id].sessions as Array<unknown>).push({
                      ref: entry.session_ref || "",
                      note: entry.note || "",
                      pct: entry.completion_pct || 0,
                    })
                  }
                } catch { /* skip */ }
              }
            } catch { /* skip */ }
          }

          // Write active snapshot
          const active: Record<string, unknown> = {
            schema_version: "v1",
            title: blueprint.title,
            phases: blueprint.phases || {},
            items: Object.values(items),
          }
          yield* fs.ensureDir(roadmapDir)
          yield* fs.writeFileString(activePath, JSON.stringify(active, null, 2))

          // Resolve dependencies
          const completedIds = new Set(
            Object.entries(items)
              .filter(([, i]) => i.status === "completed" || (i.completion_pct as number) >= 100)
              .map(([id]) => id),
          )
          const depFail = new Set(
            Object.entries(items)
              .filter(([, i]) => {
                const deps = (i.depends_on ?? []) as string[]
                return deps.length > 0 && !deps.every((d) => completedIds.has(d))
              })
              .map(([id]) => id),
          )

          const effortOrder: Record<string, number> = { low: 0, moderate: 1, high: 2 }
          const actionable: Array<Record<string, unknown>> = []
          const blocked: Array<Record<string, unknown>> = []
          const completedList: Array<Record<string, unknown>> = []

          for (const [id, item] of Object.entries(items)) {
            if (params.phase && item.phase !== params.phase) continue
            const entry: Record<string, unknown> = {
              id,
              title: item.title,
              phase: item.phase,
              priority: item.priority,
              status: item.status,
              completion_pct: item.completion_pct || 0,
              depends_on: item.depends_on || [],
              blocked_by: ((item.depends_on ?? []) as string[]).filter((d) => !completedIds.has(d)),
              effort: item.effort,
              context_summary: ((item.context_summary as string) || "").slice(0, 200),
              next_step: item.next_step || "",
              session_count: ((item.sessions ?? []) as Array<unknown>).length,
            }
            if (item.status === "completed" || (item.completion_pct as number) >= 100) completedList.push(entry)
            else if (item.status === "deprecated") continue
            else if (depFail.has(id)) blocked.push(entry)
            else actionable.push(entry)
          }

          actionable.sort(
            (a, b) =>
              ((a.priority as number) || 999) - ((b.priority as number) || 999) ||
              (effortOrder[(a.effort as string) || "moderate"] || 1) - (effortOrder[(b.effort as string) || "moderate"] || 1),
          )

          const result: Record<string, unknown> = params.show_all
            ? { actionable, blocked, completed: completedList, total: Object.keys(items).length }
            : {
                actionable,
                blocked_count: blocked.length,
                completed_count: completedList.length,
                total: Object.keys(items).length,
              }

          result.summary = `${actionable.length} actionable, ${blocked.length} blocked, ${completedList.length} completed of ${Object.keys(items).length} total`
          result.phases = blueprint.phases || {}

          return {
            title: "roadmap_init",
            metadata: { actionable: actionable.length, blocked: blocked.length },
            output: JSON.stringify(result, null, 2),
          }
        }).pipe(Effect.orDie),
    }
  }),
)

export * as RoadmapInit from "./roadmap-init"
