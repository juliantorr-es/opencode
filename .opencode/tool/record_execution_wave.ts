import { tool } from "@opencode-ai/plugin"
import { resolve } from "node:path"
import { appendFileSync, existsSync, mkdirSync } from "node:fs"

function resolvePath(worktree: string, p: string): string { return resolve(worktree, p) }

export default tool({
  description: "Record the results of an execution wave for a lane.",
  args: {
    wave: tool.schema.string().describe("Wave name: learning | plan | review | execution | validation | stress | repair"),
    lane_id: tool.schema.string().describe("Lane identifier"),
    result: tool.schema.string().describe("Wave result summary"),
    status: tool.schema.string().describe("pass | fail | partial"),
  },
  async execute(args, context) {
    const dir = resolvePath(context.worktree, `docs/json/opencode/sessions/${context.sessionID}/waves`)
    const path = resolvePath(context.worktree, `docs/json/opencode/sessions/${context.sessionID}/waves/execution.v1.jsonl`)
    try { if (!existsSync(dir)) mkdirSync(dir, { recursive: true }) } catch (_) {}

    const record = { schema_version: "v1", wave: args.wave, lane_id: args.lane_id, result: args.result, status: args.status, session_id: context.sessionID, agent: context.agent, recorded_at: new Date().toISOString() }
    try { appendFileSync(path, JSON.stringify(record) + "\n", "utf8") } catch (_) {}
    return JSON.stringify({ status: "recorded", wave: args.wave }, null, 2)
  },
})
