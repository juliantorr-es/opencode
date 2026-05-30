import { tool } from "@opencode-ai/plugin"
import { resolve } from "node:path"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"

function resolvePath(worktree: string, p: string): string { return resolve(worktree, p) }

export default tool({
  description: "Generate a session completion report — archives artifacts, summarizes changes, and leaves a clean workspace.",
  args: {
    summary: tool.schema.string().optional().describe("Session summary narrative"),
  },
  async execute(args, context) {
    const dir = resolvePath(context.worktree, `docs/json/opencode/sessions/${context.sessionID}`)
    const reportPath = resolvePath(context.worktree, `docs/json/opencode/sessions/${context.sessionID}/report.v1.json`)

    // Gather basic stats
    const stats: any = { edits: 0, findings: 0, feedback: 0, waves: [] }
    const editPath = resolvePath(context.worktree, `docs/json/opencode/sessions/${context.sessionID}/edits/edit_log.v1.jsonl`)
    if (existsSync(editPath)) { try { stats.edits = readFileSync(editPath, "utf8").split("\n").filter(Boolean).length } catch {} }

    try { mkdirSync(dir, { recursive: true }) } catch (_) {}
    const report = { schema_version: "v1", session_id: context.sessionID, summary: args.summary || null, stats, completed_at: new Date().toISOString() }
    writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf8")
    return JSON.stringify({ status: "generated", session_id: context.sessionID, stats }, null, 2)
  },
})
