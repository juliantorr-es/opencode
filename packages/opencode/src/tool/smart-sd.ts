import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { InstanceState } from "@/effect/instance-state"
import path from "path"
import DESCRIPTION from "./smart-sd.txt"

const Parameters = Schema.Struct({
  file: Schema.String.annotate({ description: "File to modify" }),
  old: Schema.String.annotate({ description: "Exact text to replace — literal match, no regex" }),
  new: Schema.String.annotate({ description: "Replacement text" }),
  reason: Schema.String.annotate({ description: "Why this replacement is needed" }),
})

export const SmartSdTool = Tool.define(
  "smart_sd",
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
            : path.resolve(instance.directory, params.file)

          const exists = yield* fs.existsSafe(filePath)
          if (!exists) {
            return {
              title: "smart_sd",
              metadata: { status: "fail" },
              output: JSON.stringify(
                {
                  status: "fail",
                  error: `File not found: ${params.file}`,
                  hint: "Check the exact path and retry.",
                },
                null,
                2,
              ),
            }
          }

          const original = yield* fs.readFileString(filePath)
          const count = original.split(params.old).length - 1

          if (count === 0) {
            const lines = original.split("\n")
            const oldFirstLine = params.old.split("\n")[0].trim()
            const similarLines: string[] = []
            for (let i = 0; i < lines.length; i++) {
              if (lines[i].includes(oldFirstLine.slice(0, 20))) {
                similarLines.push(`  line ${i + 1}: ${lines[i].trim().slice(0, 120)}`)
              }
            }
            return {
              title: "smart_sd",
              metadata: { status: "fail" },
              output: JSON.stringify(
                {
                  status: "fail",
                  error: "old text not found in file",
                  hint: "Use read_source to see exact file content. Check whitespace and line endings.",
                  similar_lines: similarLines.slice(0, 5),
                },
                null,
                2,
              ),
            }
          }

          if (count > 1) {
            return {
              title: "smart_sd",
              metadata: { status: "fail" },
              output: JSON.stringify(
                {
                  status: "fail",
                  error: `old text matches ${count} times — must be unique`,
                  hint: "Include more surrounding context to make the match unique.",
                },
                null,
                2,
              ),
            }
          }

          const modified = original.replace(params.old, params.new)
          yield* fs.writeFileString(filePath, modified)

          // Post-write verification
          const verified = yield* fs.readFileString(filePath)
          if (!verified.includes(params.new)) {
            return {
              title: "smart_sd",
              metadata: { status: "fail" },
              output: JSON.stringify(
                {
                  status: "fail",
                  error: "Write verification failed — new text not found after write.",
                  file: params.file,
                },
                null,
                2,
              ),
            }
          }

          // Record edit metadata
          const editsDir = `${instance.directory}/docs/json/opencode/sessions/${ctx.sessionID}/edits`
          yield* fs.ensureDir(editsDir)
          const logLine = JSON.stringify({
            schema_version: "v1",
            session_id: ctx.sessionID,
            agent: ctx.agent,
            file: params.file,
            reason: params.reason,
            change_summary: "literal replacement",
            edited_at: new Date().toISOString(),
          })
          yield* fs.writeFileString(`${editsDir}/edit_log.v1.jsonl`, logLine + "\n", { flag: "a" })

          // Analytics
          const logDir = `${instance.directory}/docs/json/opencode/sessions/${ctx.sessionID}/analytics`
          yield* fs.ensureDir(logDir)
          yield* fs.writeFileString(
            `${logDir}/smart_tool_usage.v1.jsonl`,
            JSON.stringify({
              at: new Date().toISOString(),
              session_id: ctx.sessionID,
              agent: ctx.agent,
              tool: "smart_sd",
              file: params.file.slice(0, 120),
            }) + "\n",
            { flag: "a" },
          )

          return {
            title: "smart_sd",
            metadata: { file: params.file, occurrences_matched: 1 },
            output: JSON.stringify(
              {
                status: "applied",
                file: params.file,
                occurrences_matched: 1,
                reason: params.reason,
                metadata_recorded: true,
              },
              null,
              2,
            ),
          }
        }).pipe(Effect.orDie),
    }
  }),
)

export * as SmartSd from "./smart-sd"
