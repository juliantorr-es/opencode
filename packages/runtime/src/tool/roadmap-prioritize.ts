import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { AppFileSystem } from "@tribunus/core/filesystem"
import { InstanceState } from "@/effect/instance-state"
import path from "path"
import DESCRIPTION from "./roadmap-prioritize.txt"

const Parameters = Schema.Struct({
  item_id: Schema.String.annotate({ description: "Item ID" }),
  priority: Schema.optional(Schema.Number).annotate({ description: "New priority (lower = higher)" }),
  phase: Schema.optional(Schema.String).annotate({ description: "Move to different phase" }),
  reason: Schema.String.annotate({ description: "Why priority changed" }),
  session_ref: Schema.optional(Schema.String).annotate({ description: "Session ID" }),
})

export const RoadmapPrioritizeTool = Tool.define(
  "roadmap_prioritize",
  Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const ap = path.join(instance.directory, "docs/json/roadmaps/active.v1.json")
          const pp = path.join(instance.directory, "docs/json/roadmaps/progress.v1.jsonl")
          const roadmapDir = path.dirname(ap)

          const activeExists = yield* fs.existsSafe(ap)
          if (!activeExists) {
            return {
              title: "roadmap_prioritize",
              metadata: { status: "fail" },
              output: JSON.stringify({ error: "No active roadmap." }, null, 2),
            }
          }

          const activeContent = yield* fs.readFileString(ap)
          const active = JSON.parse(activeContent) as Record<string, unknown>
          const itemsList = (active.items ?? []) as Array<Record<string, unknown>>
          const items: Record<string, Record<string, unknown>> = {}
          for (const i of itemsList) {
            items[i.id as string] = i
          }

          if (!items[params.item_id]) {
            return {
              title: "roadmap_prioritize",
              metadata: { status: "fail" },
              output: JSON.stringify({ error: `Item '${params.item_id}' not found` }, null, 2),
            }
          }

          // Auto-create phase if needed
          if (params.phase && !active.phases) active.phases = {}
          const phases = active.phases as Record<string, string> | undefined
          const autoCreatedPhase = params.phase && phases && !phases[params.phase]
          if (autoCreatedPhase && params.phase && phases) {
            phases[params.phase] = params.phase
          }

          const item = items[params.item_id]
          const changes: Record<string, unknown> = {}
          if (params.priority !== undefined) {
            changes.priority = { from: item.priority, to: params.priority }
            item.priority = params.priority
          }
          if (params.phase) {
            changes.phase = { from: item.phase, to: params.phase }
            item.phase = params.phase
          }
          if (autoCreatedPhase) changes.auto_created_phase = params.phase

          yield* fs.writeFileString(ap, JSON.stringify(active, null, 2))
          yield* fs.ensureDir(roadmapDir)

          const progressEntry = {
            schema_version: "v1",
            item_id: params.item_id,
            status: item.status,
            note: `REPRIORITIZED: ${params.reason} — changes: ${JSON.stringify(changes)}`,
            session_ref: params.session_ref || ctx.sessionID,
            recorded_at: new Date().toISOString(),
          }
          yield* fs.appendLine(pp, JSON.stringify(progressEntry))

          // Quick next-up
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
          const nextUp = Object.entries(items)
            .filter(([id, i]) => !completedIds.has(id) && !deprecatedIds.has(id) && !(i.depends_on as string[] | undefined)?.filter((d) => !completedIds.has(d)).length)
            .map(([id, i]) => ({
              id,
              title: String(i.title ?? "").slice(0, 80),
              priority: i.priority,
              status: i.status,
              phase: i.phase,
            }))
            .sort((a, b) => ((a.priority as number) || 999) - ((b.priority as number) || 999))
            .slice(0, 5)

          return {
            title: "roadmap_prioritize",
            metadata: { item_id: params.item_id },
            output: JSON.stringify(
              {
                status: "reprioritized",
                item_id: params.item_id,
                title: item.title,
                changes,
                reason: params.reason,
                auto_created_phase: autoCreatedPhase ? params.phase : null,
                next_up: nextUp,
              },
              null,
              2,
            ),
          }
        }).pipe(Effect.orDie),
    }
  }),
)

export * as RoadmapPrioritize from "./roadmap-prioritize"
