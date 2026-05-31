import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { InstanceState } from "@/effect/instance-state"
import path from "path"
import DESCRIPTION from "./roadmap-deprecate.txt"

const Parameters = Schema.Struct({
  item_id: Schema.String.annotate({ description: "Item ID to deprecate" }),
  reason: Schema.String.annotate({ description: "Why deprecated" }),
  replacement: Schema.optional(Schema.String).annotate({ description: "Replacement item ID" }),
  session_ref: Schema.optional(Schema.String).annotate({ description: "Session ID" }),
})

export const RoadmapDeprecateTool = Tool.define(
  "roadmap_deprecate",
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
              title: "roadmap_deprecate",
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
              title: "roadmap_deprecate",
              metadata: { status: "fail" },
              output: JSON.stringify({ error: `Item '${params.item_id}' not found` }, null, 2),
            }
          }

          const item = items[params.item_id]
          const wasAlreadyDeprecated = item.status === "deprecated"
          const previousReason: string | null = (item.deprecation_reason as string) || null
          const exp = new Date(Date.now() + 30 * 86400000).toISOString()

          item.status = "deprecated"
          item.deprecation_reason = params.reason || item.deprecation_reason || params.reason
          item.deprecation_replacement = params.replacement !== undefined ? params.replacement : (item.deprecation_replacement || null)
          item.deprecation_session = params.session_ref || ctx.sessionID
          item.deprecation_expires = exp

          // Cascade block dependents
          const cascaded: Array<Record<string, unknown>> = []
          for (const [id, depItem] of Object.entries(items)) {
            if (id === params.item_id) continue
            const deps = (depItem.depends_on ?? []) as string[]
            if (deps.includes(params.item_id) && depItem.status !== "deprecated") {
              depItem.status = "blocked"
              depItem.blocked_reason = `Upstream dependency '${params.item_id}' deprecated: ${params.reason}`
              cascaded.push({ id, title: depItem.title })
            }
          }

          yield* fs.writeFileString(ap, JSON.stringify(active, null, 2))
          yield* fs.ensureDir(roadmapDir)

          const progressEntry = {
            schema_version: "v1",
            item_id: params.item_id,
            status: "deprecated",
            note: `DEPRECATED: ${params.reason}` + (params.replacement ? ` → replacement: ${params.replacement}` : ""),
            session_ref: params.session_ref || ctx.sessionID,
            recorded_at: new Date().toISOString(),
          }
          yield* fs.appendLine(pp, JSON.stringify(progressEntry))

          const orphaned = Object.entries(items)
            .filter(([id, i]) => id !== params.item_id && (i.depends_on as string[] | undefined)?.includes(params.item_id))
            .map(([id, i]) => ({ id, title: i.title, blocked_by: params.item_id }))

          return {
            title: "roadmap_deprecate",
            metadata: { item_id: params.item_id, cascaded: cascaded.length },
            output: JSON.stringify(
              {
                status: "deprecated",
                item_id: params.item_id,
                title: item.title,
                reason: params.reason,
                replacement: params.replacement || null,
                was_already_deprecated: wasAlreadyDeprecated,
                previous_reason: previousReason,
                expires_in_30_days: true,
                expires_at: exp,
                cascaded_blocked: cascaded,
                orphaned_dependents: orphaned,
              },
              null,
              2,
            ),
          }
        }).pipe(Effect.orDie),
    }
  }),
)

export * as RoadmapDeprecate from "./roadmap-deprecate"
