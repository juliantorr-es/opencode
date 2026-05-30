import { tool } from "@opencode-ai/plugin"
import { resolve } from "node:path"
import { appendFileSync, existsSync, mkdirSync } from "node:fs"

function resolvePath(worktree: string, p: string): string { return resolve(worktree, p) }

export default tool({
  description: "Record a critic's review finding against a plan or artifact.",
  args: {
    target: tool.schema.string().describe("Plan ID or artifact path being reviewed"),
    axis: tool.schema.string().describe("Review axis: boundary | coupling | safety | reversibility | surface_area | convention | resilience"),
    finding: tool.schema.string().describe("What the critic found"),
    verdict: tool.schema.string().describe("approved | rejected | informational"),
  },
  async execute(args, context) {
    const dir = resolvePath(context.worktree, `docs/json/opencode/sessions/${context.sessionID}/reviews`)
    const path = resolvePath(context.worktree, `docs/json/opencode/sessions/${context.sessionID}/reviews/criticism.v1.jsonl`)
    try { if (!existsSync(dir)) mkdirSync(dir, { recursive: true }) } catch (_) {}

    const record = { schema_version: "v1", target: args.target, axis: args.axis, finding: args.finding, verdict: args.verdict, session_id: context.sessionID, agent: context.agent, recorded_at: new Date().toISOString() }
    try { appendFileSync(path, JSON.stringify(record) + "\n", "utf8") } catch (_) {}
    return JSON.stringify({ status: "recorded", verdict: args.verdict }, null, 2)
  },
})
