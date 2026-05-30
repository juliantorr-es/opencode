import { tool } from "@opencode-ai/plugin"
import { resolve } from "node:path"
import { appendFileSync, existsSync, mkdirSync } from "node:fs"

function resolvePath(worktree: string, p: string): string { return resolve(worktree, p) }

export default tool({
  description: "Record that a prepublication check blocked a finding — it must be addressed before publication.",
  args: {
    finding_id: tool.schema.string().describe("Finding identifier"),
    reason: tool.schema.string().describe("Why this finding blocks publication"),
  },
  async execute(args, context) {
    const dir = resolvePath(context.worktree, `docs/json/opencode/sessions/${context.sessionID}/prepublication`)
    const path = resolvePath(context.worktree, `docs/json/opencode/sessions/${context.sessionID}/prepublication/blocked.v1.jsonl`)
    try { if (!existsSync(dir)) mkdirSync(dir, { recursive: true }) } catch (_) {}

    const record = { schema_version: "v1", finding_id: args.finding_id, reason: args.reason, session_id: context.sessionID, agent: context.agent, recorded_at: new Date().toISOString() }
    try { appendFileSync(path, JSON.stringify(record) + "\n", "utf8") } catch (_) {}
    return JSON.stringify({ status: "recorded", finding_id: args.finding_id }, null, 2)
  },
})
