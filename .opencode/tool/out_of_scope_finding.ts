import { tool } from "@opencode-ai/plugin"
import { resolve } from "node:path"
import { appendFileSync, existsSync, mkdirSync } from "node:fs"

function resolvePath(worktree: string, p: string): string { return resolve(worktree, p) }

export default tool({
  description: "Record an out-of-scope finding — something observed outside the mission that other sessions should know about.",
  args: {
    file: tool.schema.string().describe("File:line where the finding was observed"),
    finding_type: tool.schema.string().describe("bug | debt | risk | opportunity"),
    summary: tool.schema.string().describe("One-line summary"),
    details: tool.schema.string().optional().describe("Detailed description"),
  },
  async execute(args, context) {
    const dir = resolvePath(context.worktree, `docs/json/opencode/sessions/${context.sessionID}/findings`)
    const path = resolvePath(context.worktree, `docs/json/opencode/sessions/${context.sessionID}/findings/out_of_scope.v1.jsonl`)
    try { if (!existsSync(dir)) mkdirSync(dir, { recursive: true }) } catch (_) {}

    const record = { schema_version: "v1", file: args.file, finding_type: args.finding_type, summary: args.summary, details: args.details || null, session_id: context.sessionID, agent: context.agent, recorded_at: new Date().toISOString() }
    try { appendFileSync(path, JSON.stringify(record) + "\n", "utf8") } catch (_) {}
    return JSON.stringify({ status: "recorded", file: args.file, finding_type: args.finding_type }, null, 2)
  },
})
