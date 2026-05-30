import { tool } from "@opencode-ai/plugin"
import { resolve } from "node:path"
import { existsSync, mkdirSync, appendFileSync } from "node:fs"

function r(worktree: string, p: string): string { return resolve(worktree, p) }

export default tool({
  description: "Record wave results — execution or stress.",
  args: {
    action: tool.schema.string().describe("execution | stress"),
    wave: tool.schema.string().optional().describe("Wave name (for execution)"),
    lane_id: tool.schema.string().optional().describe("Lane ID"),
    result: tool.schema.string().optional().describe("Result summary"),
    status: tool.schema.string().describe("pass | fail | partial"),
  },
  async execute(args, context) {
    const dir = r(context.worktree, `docs/json/opencode/sessions/${context.sessionID}/waves`)
    const file = args.action === "execution" ? "execution.v1.jsonl" : "stress.v1.jsonl"
    const path = r(context.worktree, `docs/json/opencode/sessions/${context.sessionID}/waves/${file}`)
    try { if (!existsSync(dir)) mkdirSync(dir, { recursive: true }) } catch (_) {}
    const record = { schema_version: "v1", wave: args.wave || args.action, lane_id: args.lane_id, result: args.result, status: args.status, session_id: context.sessionID, agent: context.agent, recorded_at: new Date().toISOString() }
    try { appendFileSync(path, JSON.stringify(record) + "\n", "utf8") } catch (_) {}
    return JSON.stringify({ action: args.action, status: "recorded" }, null, 2)
  },
})
