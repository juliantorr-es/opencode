import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { InstanceState } from "@/effect/instance-state"
import path from "path"

const Parameters = Schema.Struct({
  session_id: Schema.optional(Schema.String).annotate({
    description: "Session ID to diff (defaults to current session)",
  }),
  format: Schema.optional(Schema.String).annotate({
    description: "Output format: 'summary' (default) for counts per file, 'full' for all edit details",
  }),
})

export const SessionDiffTool = Tool.define(
  "session_diff",
  Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service

    return {
      description:
        "Generate a consolidated diff summary of all changes made in this session — reads edit_log entries from the session's edit records and groups them by file",
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const sessionId = params.session_id || ctx.sessionID

          const editsDir = path.join(
            instance.directory,
            "docs",
            "json",
            "opencode",
            "sessions",
            sessionId,
            "edits",
          )
          const logPath = path.join(editsDir, "edit_log.v1.jsonl")

          const exists = yield* fs.existsSafe(logPath)
          if (!exists) {
            const result = {
              status: "empty",
              session_id: sessionId,
              note: "No edit log found for this session",
            }
            return {
              title: "session_diff",
              metadata: { session_id: sessionId, edits_found: 0 },
              output: JSON.stringify(result, null, 2),
            }
          }

          const content = yield* fs.readFileString(logPath)
          const lines = content.trim().split("\n").filter(Boolean)

          // Parse all edit records
          const edits: Array<{
            file: string
            agent: string
            reason: string
            change_summary: string
            edited_at: string
          }> = []
          for (const line of lines) {
            try {
              const record = JSON.parse(line)
              edits.push(record)
            } catch {
              // Skip malformed lines
            }
          }

          // Group by file path
          const fileMap = new Map<
            string,
            Array<{
              file: string
              agent: string
              reason: string
              change_summary: string
              edited_at: string
            }>
          >()
          for (const edit of edits) {
            const existing = fileMap.get(edit.file) || []
            existing.push(edit)
            fileMap.set(edit.file, existing)
          }

          const files = Array.from(fileMap.entries())
            .map(([file, fileEdits]) => ({
              file,
              edits_count: fileEdits.length,
              agents: [...new Set(fileEdits.map((e) => e.agent))],
              reasons: [...new Set(fileEdits.map((e) => e.reason))],
              last_edited: fileEdits[fileEdits.length - 1].edited_at,
            }))
            .sort((a, b) => b.edits_count - a.edits_count)

          const format = params.format || "summary"

          if (format === "summary") {
            const result = {
              status: "ok",
              session_id: sessionId,
              total_edits: edits.length,
              files_changed: files.length,
              files,
              summary: `${edits.length} edits across ${files.length} files`,
            }
            return {
              title: "session_diff",
              metadata: {
                session_id: sessionId,
                edits_found: edits.length,
                files_changed: files.length,
              },
              output: JSON.stringify(result, null, 2),
            }
          }

          // Full format includes detailed record listing
          const result = {
            status: "ok",
            session_id: sessionId,
            total_edits: edits.length,
            files_changed: files.length,
            files,
            edits: edits.map((e) => ({
              file: e.file,
              agent: e.agent,
              reason: e.reason,
              change_summary: e.change_summary,
              edited_at: e.edited_at,
            })),
            summary: `${edits.length} edits across ${files.length} files`,
          }
          return {
            title: "session_diff",
            metadata: {
              session_id: sessionId,
              edits_found: edits.length,
              files_changed: files.length,
            },
            output: JSON.stringify(result, null, 2),
          }
        }).pipe(Effect.orDie),
    }
  }),
)

export * as SessionDiff from "./session-diff"
