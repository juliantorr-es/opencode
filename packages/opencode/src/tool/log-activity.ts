import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { InstanceState } from "@/effect/instance-state"
import path from "path"
import DESCRIPTION from "./log-activity.txt"

const Parameters = Schema.Struct({
  action: Schema.String.annotate({
    description: "created | modified | discovered | blocked | delegated | verified",
  }),
  target: Schema.String.annotate({
    description: "File path, artifact path, or subagent name",
  }),
  details: Schema.optional(Schema.String).annotate({
    description: "JSON object with note, pattern, services_used, etc.",
  }),
})

export const LogActivityTool = Tool.define(
  "log_activity",
  Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const dir = `${instance.directory}/docs/json/opencode/knowledge/sessions/${ctx.sessionID}`
          const logPath = `${dir}/activities.v1.jsonl`

          let details: Record<string, unknown> = {}
          if (params.details) {
            try {
              details = JSON.parse(params.details) as Record<string, unknown>
            } catch {
              details = { note: params.details }
            }
          }

          const record = {
            schema_version: "v1",
            at: new Date().toISOString(),
            session_id: ctx.sessionID,
            agent: ctx.agent,
            action: params.action,
            target: params.target,
            details,
          }

          yield* fs.ensureDir(dir)
          yield* fs.writeFileString(logPath, JSON.stringify(record) + "\n", { flag: "a" })

          return {
            title: "log_activity",
            metadata: { action: params.action, target: params.target },
            output: JSON.stringify(
              { status: "logged", action: params.action, target: params.target },
              null,
              2,
            ),
          }
        }).pipe(Effect.orDie),
    }
  }),
)

export * as LogActivity from "./log-activity"
