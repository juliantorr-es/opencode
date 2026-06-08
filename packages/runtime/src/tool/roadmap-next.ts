import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { AppFileSystem } from "@tribunus/core/filesystem"
import { InstanceState } from "@/effect/instance-state"
import path from "path"
import DESCRIPTION from "./roadmap-next.txt"

const Parameters = Schema.Struct({
  limit: Schema.optional(Schema.Number).annotate({ description: "Max items (default 5)" }),
  phase: Schema.optional(Schema.String).annotate({ description: "Filter to phase" }),
  show_blocked: Schema.optional(Schema.Boolean).annotate({
    description: "Include blocked items in results with their blockers",
  }),
})

export const RoadmapNextTool = Tool.define(
  "roadmap_next",
  Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, _ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const activePath = path.join(instance.directory, "docs/json/roadmaps/active.v1.json")

          const exists = yield* fs.existsSafe(activePath)
          if (!exists) {
            return {
              title: "roadmap_next",
              metadata: { status: "fail" },
              output: JSON.stringify(
                { error: "No active roadmap. Run roadmap_init first." },
                null,
                2,
              ),
            }
          }

          const content = yield* fs.readFileString(activePath)
          const active = JSON.parse(content) as Record<string, unknown>
          const itemsList = (active.items ?? []) as Array<Record<string, unknown>>
          const items: Record<string, Record<string, unknown>> = {}
          for (const item of itemsList) {
            items[item.id as string] = item
          }

          const completedIds = new Set(
            Object.entries(items)
              .filter(([, i]) => i.status === "completed" || (i.completion_pct as number) >= 100)
              .map(([id]) => id),
          )
          const deprecatedIds = new Set(
            Object.entries(items)
              .filter(([, i]) => i.status === "deprecated")
              .map(([id]) => id),
          )

          const effortOrder: Record<string, number> = { low: 0, moderate: 1, high: 2 }
          const ready: Array<Record<string, unknown>> = []
          const inProgress: Array<Record<string, unknown>> = []
          const blocked: Array<Record<string, unknown>> = []

          for (const [id, item] of Object.entries(items)) {
            if (completedIds.has(id) || deprecatedIds.has(id)) continue
            if (params.phase && item.phase !== params.phase) continue

            const deps = (item.depends_on ?? []) as string[]
            const unmet = deps.filter((d) => !completedIds.has(d))
            const phases = active.phases as Record<string, string> | undefined
            const entry: Record<string, unknown> = {
              id,
              title: item.title,
              phase: item.phase,
              phase_name: (phases || {})[item.phase as string] || "",
              priority: item.priority,
              status: item.status,
              completion_pct: item.completion_pct || 0,
              effort: item.effort,
              context_summary: ((item.context_summary as string) || "").slice(0, 300),
              next_step: item.next_step || "",
              depends_on: deps,
              unmet_dependencies: unmet,
              session_count: ((item.sessions ?? []) as Array<unknown>).length,
            }

            if (item.status === "in_progress") inProgress.push(entry)
            else if (unmet.length) {
              if (params.show_blocked) blocked.push(entry)
            } else ready.push(entry)
          }

          ready.sort(
            (a, b) =>
              ((a.priority as number) || 999) - ((b.priority as number) || 999) ||
              (effortOrder[(a.effort as string) || "moderate"] || 1) - (effortOrder[(b.effort as string) || "moderate"] || 1),
          )
          inProgress.sort(
            (a, b) => ((a.priority as number) || 999) - ((b.priority as number) || 999),
          )

          const limit = params.limit ?? 5
          const nextUp = [...inProgress, ...ready].slice(0, limit)
          const recommendation = inProgress[0]
            ? `Continue: ${inProgress[0].id} — ${String(inProgress[0].title).slice(0, 80)} (${inProgress[0].completion_pct}% done)`
            : ready[0] ? `Start: ${ready[0].id} — ${String(ready[0].title).slice(0, 80)}` : null

          const result: Record<string, unknown> = {
            next: nextUp,
            total_ready: ready.length,
            total_in_progress: inProgress.length,
            total_blocked: blocked.length + (params.show_blocked ? 0 : itemsList.length - completedIds.size - deprecatedIds.size - ready.length - inProgress.length),
            total_completed: completedIds.size,
            recommendation,
            hint: "Use roadmap_init(show_all=true) to see full picture.",
          }
          if (params.show_blocked) result.blocked = blocked

          return {
            title: "roadmap_next",
            metadata: { ready: ready.length, in_progress: inProgress.length },
            output: JSON.stringify(result, null, 2),
          }
        }).pipe(Effect.orDie),
    }
  }),
)

export * as RoadmapNext from "./roadmap-next"
