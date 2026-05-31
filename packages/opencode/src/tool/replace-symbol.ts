import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { InstanceState } from "@/effect/instance-state"
import path from "path"
import DESCRIPTION from "./replace-symbol.txt"

const Parameters = Schema.Struct({
  file: Schema.String.annotate({ description: "Path to the source file" }),
  pattern: Schema.String.annotate({ description: "Symbol pattern to replace (literal string, not regex)" }),
  replacement: Schema.String.annotate({ description: "Replacement text" }),
  language: Schema.optional(Schema.String).annotate({
    description: "Source language hint (py, ts, js, rs, etc.)",
  }),
})

export const ReplaceSymbolTool = Tool.define(
  "replace_symbol",
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

          const exists = yield* fs.existsSafe(filePath)
          if (!exists) {
            throw new Error(`File not found: ${params.file}`)
          }

          const content = yield* fs.readFileString(filePath)

          // Count occurrences before replacement
          const count = content.split(params.pattern).length - 1

          if (count === 0) {
            throw new Error(
              `Pattern not found in ${params.file}. Check exact spelling, whitespace, and line endings.`,
            )
          }

          const modified = content.split(params.pattern).join(params.replacement)

          yield* fs.ensureDir(path.dirname(filePath))
          yield* fs.writeFileString(filePath, modified)

          // Record edit metadata
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
            reason: `replace symbol: ${params.pattern} → ${params.replacement}`,
            change_summary: `replaced ${count} occurrence${count === 1 ? "" : "s"}`,
            language: params.language ?? null,
            edited_at: new Date().toISOString(),
          }

          yield* fs.ensureDir(editsDir)
          yield* fs.appendLine(logPath, JSON.stringify(record))

          const result = {
            status: "applied",
            file: filePath,
            occurrences_replaced: count,
            pattern: params.pattern,
            replacement: params.replacement,
            metadata_recorded: true,
          }

          return {
            title: "replace_symbol",
            metadata: {
              file: filePath,
              occurrences_replaced: count,
              pattern: params.pattern,
            },
            output: JSON.stringify(result, null, 2),
          }
        }).pipe(Effect.orDie),
    }
  }),
)

export * as ReplaceSymbol from "./replace-symbol"
