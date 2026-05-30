import { tool } from "@opencode-ai/plugin"
import { resolve } from "node:path"
import { existsSync, mkdirSync, appendFileSync } from "node:fs"

function r(worktree: string, p: string): string { return resolve(worktree, p) }

export default tool({
  description: "Prepublication gate — record admitted, blocked, or inconclusive findings.",
  args: {
    action: tool.schema.string().describe("admitted | blocked | inconclusive"),
    finding_id: tool.schema.string().describe("Finding identifier"),
    reason: tool.schema.string().describe("Why this verdict"),
  },
  async execute(args, context) {
    const dir = r(context.worktree, `docs/json/opencode/sessions/${context.sessionID}/prepublication`)
    const path = r(context.worktree, `docs/json/opencode/sessions/${context.sessionID}/prepublication/${args.action}.v1.jsonl`)
    try { if (!existsSync(dir)) mkdirSync(dir, { recursive: true }) } catch (_) {}
    const record = { schema_version: "v1", finding_id: args.finding_id, reason: args.reason, session_id: context.sessionID, agent: context.agent, recorded_at: new Date().toISOString() }
    try { appendFileSync(path, JSON.stringify(record) + "\n", "utf8") } catch (_) {}
    return JSON.stringify({ action: args.action, finding_id: args.finding_id }, null, 2)
  },
})
