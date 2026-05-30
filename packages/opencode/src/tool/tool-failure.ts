import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { InstanceState } from "@/effect/instance-state"
import path from "path"
import DESCRIPTION from "./tool-failure.txt"

const Parameters = Schema.Struct({
  tool_name: Schema.String.annotate({ description: "Name of the tool that failed" }),
  error_message: Schema.String.annotate({ description: "Error message from the tool" }),
  args_used: Schema.optional(Schema.String).annotate({
    description: "JSON of the arguments that were passed",
  }),
  recovery_attempted: Schema.optional(Schema.Boolean).annotate({
    description: "Whether a recovery was attempted",
  }),
})

export const ToolFailureTool = Tool.define(
  "tool_failure",
  Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const sessionDir = path.join(
            instance.directory,
            "docs", "json", "opencode", "sessions", ctx.sessionID, "failures",
          )
          const jsonlPath = path.join(sessionDir, "failures.v1.jsonl")

          // Parse args_used if provided
          let parsedArgs: unknown = null
          if (params.args_used) {
            try {
              parsedArgs = JSON.parse(params.args_used)
            } catch {
              parsedArgs = params.args_used
            }
          }

          const record = {
            schema_version: "v1",
            failure_type: "tool",
            source: params.tool_name,
            message: params.error_message,
            context: JSON.stringify({
              args: parsedArgs,
              recovery_attempted: params.recovery_attempted ?? false,
            }),
            session_id: ctx.sessionID,
            recorded_at: new Date().toISOString(),
          }

          yield* fs.ensureDir(sessionDir)
          yield* fs.writeFileString(jsonlPath, JSON.stringify(record) + "\n", { flag: "a" })

          return {
            title: "tool_failure",
            metadata: { status: "ok", tool: params.tool_name, recorded: true },
            output: JSON.stringify({ status: "ok", tool: params.tool_name, recorded: true }, null, 2),
          }
        }).pipe(Effect.orDie),
    }
  }),
)

export * as Failure from "./tool-failure"
