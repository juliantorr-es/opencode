import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { InstanceState } from "@/effect/instance-state"
import path from "path"
import DESCRIPTION from "./smart-write.txt"

const Parameters = Schema.Struct({
  file: Schema.String.annotate({ description: "Path to the file to write" }),
  content: Schema.String.annotate({ description: "Content to write" }),
  reason: Schema.String.annotate({ description: "Why this file is being written — one sentence" }),
  plan_step: Schema.optional(Schema.String).annotate({
    description: "Which plan step this corresponds to",
  }),
})

export const SmartWriteTool = Tool.define(
  "smart_write",
  Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const filePath = path.isAbsolute(params.file)
            ? params.file
            : path.join(instance.directory, params.file)

          const existed = yield* fs.existsSafe(filePath)
          yield* fs.ensureDir(path.dirname(filePath))
          yield* fs.writeFileString(filePath, params.content)

          // Record edit metadata to the session edit log
          const editsDir = path.join(
            instance.directory,
            "docs",
            "json",
            "opencode",
            "sessions",
            ctx.sessionID,
            "edits",
          )
          const logPath = path.join(editsDir, "edit_log.v1.jsonl")

          const record = {
            schema_version: "v1",
            session_id: ctx.sessionID,
            agent: ctx.agent,
            file: filePath,
            reason: params.reason,
            change_summary: existed ? "overwritten" : "created",
            plan_step: params.plan_step ?? null,
            bytes_written: params.content.length,
            edited_at: new Date().toISOString(),
          }

          yield* fs.ensureDir(editsDir)
          yield* fs.writeFileString(logPath, JSON.stringify(record) + "\n", { flag: "a" })

          return {
            title: "smart_write",
            metadata: {
              file: filePath,
              existed_before: existed,
              bytes_written: params.content.length,
              metadata_recorded: true,
              agent: ctx.agent,
              reason: params.reason,
            },
            output: JSON.stringify(
              {
                status: existed ? "overwritten" : "created",
                file: filePath,
                bytes_written: params.content.length,
                metadata_recorded: true,
                agent: ctx.agent,
                reason: params.reason,
              },
              null,
              2,
            ),
          }
        }).pipe(Effect.orDie),
    }
  }),
)

export * as SmartWrite from "./smart-write"
