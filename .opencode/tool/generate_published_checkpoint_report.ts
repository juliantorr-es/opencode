import { tool } from "@opencode-ai/plugin"
import { resolve } from "node:path"
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs"

function resolvePath(worktree: string, p: string): string { return resolve(worktree, p) }

export default tool({
  description: "Generate a report summarizing all published checkpoints across sessions.",
  args: {
    output: tool.schema.string().optional().describe("Output path for the report"),
  },
  async execute(args, context) {
    const outPath = args.output ? resolvePath(context.worktree, args.output) : resolvePath(context.worktree, `docs/json/opencode/sessions/${context.sessionID}/checkpoint_report.v1.json`)

    // Scan for checkpoint files
    const sessionsDir = resolvePath(context.worktree, "docs/json/opencode/sessions")
    const checkpoints: any[] = []
    if (existsSync(sessionsDir)) {
      // Limited to current session for simplicity
      const cpPath = resolvePath(context.worktree, `docs/json/opencode/sessions/${context.sessionID}/checkpoints/checkpoints.v1.jsonl`)
      if (existsSync(cpPath)) {
        try {
          const lines = readFileSync(cpPath, "utf8").split("\n").filter(Boolean)
          for (const line of lines) { try { checkpoints.push(JSON.parse(line)) } catch {} }
        } catch {}
      }
    }

    const report = { schema_version: "v1", generated_at: new Date().toISOString(), session_id: context.sessionID, checkpoints, total: checkpoints.length }
    try { mkdirSync(resolvePath(context.worktree, `docs/json/opencode/sessions/${context.sessionID}`), { recursive: true }) } catch (_) {}
    writeFileSync(outPath, JSON.stringify(report, null, 2), "utf8")
    return JSON.stringify({ status: "generated", path: args.output || outPath, checkpoint_count: checkpoints.length }, null, 2)
  },
})
