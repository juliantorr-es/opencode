import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { InstanceState } from "@/effect/instance-state"
import { createHash } from "node:crypto"
import path from "path"
import DESCRIPTION from "./tool-feedback.txt"

const Parameters = Schema.Struct({
  tool_name: Schema.String.annotations({ description: "Name of the tool that has an issue" }),
  issue: Schema.String.annotations({
    description:
      "What went wrong — be specific: 'parameter X was ignored', 'output was truncated', 'returned stale data', 'timeout before completion'",
  }),
  expected: Schema.String.annotations({ description: "What you expected the tool to do" }),
  actual: Schema.String.annotations({ description: "What the tool actually did" }),
  severity: Schema.String.annotations({ description: "blocker | major | minor | annoyance" }),
  workaround: Schema.optional(Schema.String).annotate({
    description: "What you did instead to get the job done",
  }),
  context: Schema.optional(Schema.String).annotate({
    description: "What you were trying to accomplish when this failed",
  }),
})

const SEVERITY_EMOJI: Record<string, string> = {
  blocker: "🔴",
  major: "🟠",
  minor: "🟡",
  annoyance: "🔵",
}

export const ToolFeedbackTool = Tool.define(
  "tool_feedback",
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
            "docs", "json", "opencode", "sessions", ctx.sessionID, "feedback",
          )
          const jsonlPath = path.join(sessionDir, "tool_feedback.v1.jsonl")

          // Dedup key: SHA-256 hash of tool_name|issue|sessionID, truncated to 16 hex chars
          const dedupKey = createHash("sha256")
            .update(`${params.tool_name}|${params.issue}|${ctx.sessionID}`)
            .digest("hex")
            .substring(0, 16)

          const now = new Date().toISOString()
          let updated = false
          let occurrences = 1

          // Check for existing entry with the same dedup key
          const exists = yield* fs.existsSafe(jsonlPath)
          if (exists) {
            const content = yield* fs.readFileString(jsonlPath)
            const lines = content.trim().split("\n").filter(Boolean)
            const newLines: string[] = []

            for (const line of lines) {
              try {
                const entry = JSON.parse(line)
                if (entry.dedup_key === dedupKey) {
                  entry.occurrences = (entry.occurrences ?? 1) + 1
                  entry.last_seen = now
                  if (params.workaround && !entry.workaround) {
                    entry.workaround = params.workaround
                  }
                  occurrences = entry.occurrences
                  updated = true
                  newLines.push(JSON.stringify(entry))
                } else {
                  newLines.push(line)
                }
              } catch {
                newLines.push(line)
              }
            }

            if (updated) {
              yield* fs.writeFileString(jsonlPath, newLines.join("\n") + "\n")
              return {
                title: "tool_feedback",
                metadata: {
                  status: "updated",
                  tool: params.tool_name,
                  severity: params.severity,
                  occurrences,
                },
                output: JSON.stringify(
                  {
                    status: "updated",
                    note: `Updated existing feedback (occurrence #${occurrences})`,
                    tool: params.tool_name,
                    severity: params.severity,
                    occurrences,
                  },
                  null,
                  2,
                ),
              }
            }
          }

          // New entry
          const record = {
            schema_version: "v1",
            dedup_key: dedupKey,
            tool_name: params.tool_name,
            issue: params.issue,
            expected: params.expected,
            actual: params.actual,
            severity: params.severity,
            workaround: params.workaround ?? null,
            context: params.context ?? null,
            reporter_session: ctx.sessionID,
            reporter_agent: ctx.agent,
            occurrences: 1,
            first_seen: now,
            last_seen: now,
          }

          yield* fs.ensureDir(sessionDir)
          yield* fs.writeFileString(jsonlPath, JSON.stringify(record) + "\n", { flag: "a" })

          const emoji = SEVERITY_EMOJI[params.severity] ?? "⚪"
          return {
            title: "tool_feedback",
            metadata: { status: "recorded", tool: params.tool_name, severity: params.severity },
            output: JSON.stringify(
              {
                status: "recorded",
                note: `${emoji} Feedback recorded for ${params.tool_name} — thank you. This will be reviewed post-run.`,
                tool: params.tool_name,
                severity: params.severity,
              },
              null,
              2,
            ),
          }
        }).pipe(Effect.orDie),
    }
  }),
)

export * as Feedback from "./tool-feedback"
