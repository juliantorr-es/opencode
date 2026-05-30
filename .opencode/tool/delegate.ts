import { tool } from "@opencode-ai/plugin"
import { resolve } from "node:path"
import { appendFileSync, existsSync, mkdirSync } from "node:fs"

function resolvePath(worktree: string, p: string): string { return resolve(worktree, p) }

export default tool({
  description: "Record a delegation intent — what task is being delegated to which agent. The actual execution happens via task().",
  args: {
    agent: tool.schema.string().describe("Target agent name"),
    task: tool.schema.string().describe("Task description"),
    wave: tool.schema.string().optional().describe("Wave name"),
    background: tool.schema.boolean().optional().describe("Whether this runs in background (default true)"),
  },
  async execute(args, context) {
    const dir = resolvePath(context.worktree, "docs/json/opencode/coordination")
    const path = resolvePath(context.worktree, "docs/json/opencode/coordination/delegations.v1.jsonl")
    try { if (!existsSync(dir)) mkdirSync(dir, { recursive: true }) } catch (_) {}

    const record = { schema_version: "v1", agent: args.agent, task: args.task, wave: args.wave || null, background: args.background ?? true, session_id: context.sessionID, delegated_by: context.agent, delegated_at: new Date().toISOString() }
    try { appendFileSync(path, JSON.stringify(record) + "\n", "utf8") } catch (_) {}
    return JSON.stringify({ status: "delegated", agent: args.agent, background: args.background ?? true, hint: "Now call task() to actually execute this delegation." }, null, 2)
  },
})
