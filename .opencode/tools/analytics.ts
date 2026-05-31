import { tool } from "@opencode-ai/plugin"
import { resolve } from "node:path"
import { existsSync, readFileSync, readdirSync } from "node:fs"

function resolvePath(worktree: string, p: string): string { return resolve(worktree, p) }

export default tool({
  description: "Aggregate analytics from all sessions — bash usage, smart tool usage, heartbeats, feedback. One place to see everything.",
  args: {
    metric: tool.schema.string().optional().describe("bash | smart | heartbeat | feedback | all"),
    limit: tool.schema.number().optional().describe("Max sessions to scan (default 50)"),
  },
  async execute(args, context) {
    const sessionsDir = resolvePath(context.worktree, "docs/json/opencode/sessions")
    if (!existsSync(sessionsDir)) return JSON.stringify({ sessions: [], summary: "No sessions found" }, null, 2)

    const dirs = readdirSync(sessionsDir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name).slice(-(args.limit ?? 50))
    const metric = args.metric || "all"
    const summary: any = { session_count: dirs.length, bash_calls: 0, smart_calls: 0, heartbeats: 0, feedback: 0 }

    for (const dir of dirs) {
      const analyticsDir = resolvePath(context.worktree, `docs/json/opencode/sessions/${dir}/analytics`)
      if (!existsSync(analyticsDir)) continue

      if (metric === "all" || metric === "bash") {
        const bp = resolve(analyticsDir, "bash_usage.v1.jsonl")
        if (existsSync(bp)) { try { summary.bash_calls += readFileSync(bp, "utf8").split("\n").filter(Boolean).length } catch {} }
      }
      if (metric === "all" || metric === "smart") {
        const sp = resolve(analyticsDir, "smart_tool_usage.v1.jsonl")
        if (existsSync(sp)) { try { summary.smart_calls += readFileSync(sp, "utf8").split("\n").filter(Boolean).length } catch {} }
      }
      if (metric === "all" || metric === "heartbeat") {
        const hp = resolve(analyticsDir, "heartbeat.v1.jsonl")
        if (existsSync(hp)) { try { summary.heartbeats += readFileSync(hp, "utf8").split("\n").filter(Boolean).length } catch {} }
      }
    }

    // Check feedback
    if (metric === "all" || metric === "feedback") {
      for (const dir of dirs) {
        const fp = resolvePath(context.worktree, `docs/json/opencode/sessions/${dir}/feedback/tool_feedback.v1.jsonl`)
        if (existsSync(fp)) { try { summary.feedback += readFileSync(fp, "utf8").split("\n").filter(Boolean).length } catch {} }
      }
    }

    return JSON.stringify({ summary }, null, 2)
  },
})
