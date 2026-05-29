import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { InstanceState } from "@/effect/instance-state"
import path from "path"
import DESCRIPTION from "./smart-edit.txt"

const Parameters = Schema.Struct({
  file: Schema.String.annotate({ description: "Path to the file to edit" }),
  oldText: Schema.String.annotate({ description: "Exact text to replace — must match uniquely in the file" }),
  newText: Schema.String.annotate({ description: "Replacement text" }),
  reason: Schema.String.annotate({ description: "Why this edit is being made — one sentence" }),
  plan_step: Schema.optional(Schema.String).annotate({
    description: "Which plan step or repair directive this corresponds to",
  }),
})

export const SmartEditTool = Tool.define(
  "smart_edit",
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

          if (!(yield* fs.existsSafe(filePath))) {
            return {
              title: "smart_edit",
              metadata: { status: "fail" },
              output: JSON.stringify(
                { status: "fail", error: `File not found: ${filePath}` },
                null,
                2,
              ),
            }
          }

          const original = yield* fs.readFileString(filePath)

          // Count occurrences and validate uniqueness
          let count = 0
          let index = 0
          while (true) {
            index = original.indexOf(params.oldText, index)
            if (index === -1) break
            count++
            index += params.oldText.length
          }

          if (count === 0) {
            return {
              title: "smart_edit",
              metadata: { status: "fail" },
              output: JSON.stringify(
                {
                  status: "fail",
                  error: "oldText not found in file",
                  hint: "Check exact whitespace and line endings",
                },
                null,
                2,
              ),
            }
          }

          if (count > 1) {
            return {
              title: "smart_edit",
              metadata: { status: "fail" },
              output: JSON.stringify(
                {
                  status: "fail",
                  error: `oldText matches ${count} times — must be unique`,
                  hint: "Include more surrounding context to make the match unique",
                },
                null,
                2,
              ),
            }
          }

          // Apply the edit (exactly once)
          const modified = original.replace(params.oldText, params.newText)
          yield* fs.writeFileString(filePath, modified)

          // Count changed lines
          const origLines = original.split("\n")
          const modLines = modified.split("\n")
          let linesChanged = 0
          const maxLen = Math.max(origLines.length, modLines.length)
          for (let i = 0; i < maxLen; i++) {
            if (origLines[i] !== modLines[i]) {
              linesChanged++
            }
          }

          // Record edit metadata
          const sessionDir = path.join(
            instance.directory,
            "docs", "json", "opencode", "sessions", ctx.sessionID, "edits",
          )
          const logPath = path.join(sessionDir, "edit_log.v1.jsonl")
          const relPath = path.relative(instance.directory, filePath)
          const now = new Date().toISOString()

          const record = {
            schema_version: "v1",
            session_id: ctx.sessionID,
            agent: ctx.agent,
            file: filePath,
            reason: params.reason,
            change_summary: `${linesChanged} lines changed`,
            plan_step: params.plan_step ?? null,
            diff_snapshot: `--- a/${relPath}\n+++ b/${relPath}\n@@ -1 +1 @@\n-${params.oldText.split("\n").length} lines\n+${params.newText.split("\n").length} lines`,
            edited_at: now,
          }

          yield* fs.ensureDir(sessionDir)
          yield* fs.writeFileString(logPath, JSON.stringify(record) + "\n", { flag: "a" })

          const result = {
            status: "applied",
            file: filePath,
            occurrences_matched: 1,
            lines_changed: linesChanged,
            metadata_recorded: true,
            agent: ctx.agent,
            reason: params.reason,
          }

          return {
            title: path.basename(filePath),
            metadata: {
              status: "applied",
              file: filePath,
              lines_changed: linesChanged,
            },
            output: JSON.stringify(result, null, 2),
          }
        }).pipe(Effect.orDie),
    }
  }),
)

export * as SmartEdit from "./smart-edit"
