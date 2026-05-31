import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { InstanceState } from "@/effect/instance-state"
import path from "path"
import DESCRIPTION from "./analytics.txt"

const Parameters = Schema.Struct({
  metric: Schema.optional(Schema.String).annotate({
    description: "bash | smart | heartbeat | feedback | tool_invocations | all",
  }),
  limit: Schema.optional(Schema.Number).annotate({
    description: "Max sessions to scan (default 50)",
  }),
})

export const AnalyticsTool = Tool.define(
  "analytics",
  Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, _ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const sessionsDir = `${instance.directory}/docs/json/opencode/sessions`
          const metric = params.metric || "all"
          const limit = params.limit ?? 50

          const exists = yield* fs.existsSafe(sessionsDir)
          if (!exists) {
            return {
              title: "analytics",
              metadata: { session_count: 0 },
              output: JSON.stringify({ sessions: [], summary: "No sessions found" }, null, 2),
            }
          }

          const entries = yield* fs.readDirectory(sessionsDir)
          const dirs = entries
            .filter((entry: string) => entry !== ".gitkeep" && entry !== ".DS_Store")
            .slice(-limit)

          const summary: Record<string, number> = {
            session_count: dirs.length,
            bash_calls: 0,
            smart_calls: 0,
            heartbeats: 0,
            feedback: 0,
            tool_invocations: 0,
          }

          for (const sessionDir of dirs) {
            const analyticsDir = path.join(sessionsDir, sessionDir, "analytics")

            if (metric === "all" || metric === "bash") {
              const bp = path.join(analyticsDir, "bash_usage.v1.jsonl")
              const bpExists = yield* fs.existsSafe(bp)
              if (bpExists) {
                try {
                  const content = yield* fs.readFileString(bp)
                  summary.bash_calls! += content.split("\n").filter(Boolean).length
                } catch { /* skip */ }
              }
            }

            if (metric === "all" || metric === "smart") {
              const sp = path.join(analyticsDir, "smart_tool_usage.v1.jsonl")
              const spExists = yield* fs.existsSafe(sp)
              if (spExists) {
                try {
                  const content = yield* fs.readFileString(sp)
                  summary.smart_calls! += content.split("\n").filter(Boolean).length
                } catch { /* skip */ }
              }
            }

            if (metric === "all" || metric === "heartbeat") {
              const hp = path.join(analyticsDir, "heartbeat.v1.jsonl")
              const hpExists = yield* fs.existsSafe(hp)
              if (hpExists) {
                try {
                  const content = yield* fs.readFileString(hp)
                  summary.heartbeats! += content.split("\n").filter(Boolean).length
                } catch { /* skip */ }
              }
            }

            if (metric === "all" || metric === "feedback") {
              const fp = path.join(analyticsDir, "feedback", "tool_feedback.v1.jsonl")
              const fpExists = yield* fs.existsSafe(fp)
              if (fpExists) {
                try {
                  const content = yield* fs.readFileString(fp)
                  summary.feedback! += content.split("\n").filter(Boolean).length
                } catch { /* skip */ }
              }
            }

            if (metric === "all" || metric === "tool_invocations") {
              const tp = path.join(analyticsDir, "tool_invocations.v1.jsonl")
              const tpExists = yield* fs.existsSafe(tp)
              if (tpExists) {
                try {
                  const content = yield* fs.readFileString(tp)
                  summary.tool_invocations! += content.split("\n").filter(Boolean).length
                } catch { /* skip */ }
              }
            }
          }

          return {
            title: "analytics",
            metadata: { session_count: dirs.length },
            output: JSON.stringify({ summary }, null, 2),
          }
        }).pipe(Effect.orDie),
    }
  }),
)

export * as Analytics from "./analytics"
