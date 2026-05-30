import { tool } from "@opencode-ai/plugin"
import { resolve } from "node:path"
import { appendFileSync, existsSync, mkdirSync } from "node:fs"

function resolvePath(worktree: string, p: string): string { return resolve(worktree, p) }

export default tool({
  description: "Record an activity line to the session's knowledge graph. Call this whenever you create, modify, discover, or block something.",
  args: {
    action: tool.schema.string().describe("created | modified | discovered | blocked | delegated | verified"),
    target: tool.schema.string().describe("File path, artifact path, or subagent name"),
    details: tool.schema.string().optional().describe("JSON object with note, pattern, services_used, etc."),
  },
  async execute(args, context) {
    const dir = resolvePath(context.worktree, `docs/json/opencode/knowledge/sessions/${context.sessionID}`)
    const path = resolvePath(context.worktree, `docs/json/opencode/knowledge/sessions/${context.sessionID}/activities.v1.jsonl`)
    try { if (!existsSync(dir)) mkdirSync(dir, { recursive: true }) } catch (_) {}

    let details: any = {}
    if (args.details) {
      try { details = JSON.parse(args.details) } catch { details = { note: args.details } }
    }

    const record = {
      schema_version: "v1", at: new Date().toISOString(),
      session_id: context.sessionID, agent: context.agent,
      action: args.action, target: args.target, details,
    }
    try { appendFileSync(path, JSON.stringify(record) + "\n", "utf8") } catch (_) {}
    return JSON.stringify({ status: "logged", action: args.action, target: args.target }, null, 2)
  },
})
