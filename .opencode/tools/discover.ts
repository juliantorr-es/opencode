import { tool } from "@opencode-ai/plugin"
import { resolve } from "node:path"
import { existsSync, readFileSync } from "node:fs"

function r(worktree: string, p: string): string { return resolve(worktree, p) }

export default tool({
  description: "Discover findings or inspect failures across sessions.",
  args: {
    action: tool.schema.string().describe("findings | failures"),
    finding_type: tool.schema.string().optional().describe("bug | debt | risk | opportunity (for findings)"),
    session_id: tool.schema.string().optional().describe("Session to inspect (for failures)"),
    limit: tool.schema.number().optional().describe("Max results (default 20)"),
  },
  async execute(args, context) {
    if (args.action === "findings") {
      const fp = r(context.worktree, "docs/json/opencode/knowledge/findings.v1.jsonl")
      const results: any[] = []
      if (existsSync(fp)) {
        try {
          for (const line of readFileSync(fp, "utf8").split("\n").filter(Boolean)) {
            try {
              const f = JSON.parse(line)
              if (args.finding_type && f.finding_type !== args.finding_type) continue
              if (f.expires_at && new Date(f.expires_at) < new Date()) continue
              results.push({ type: f.finding_type, summary: f.summary, file: f.file, session: f.session_id?.slice(0, 12) })
            } catch {}
          }
        } catch {}
      }
      return JSON.stringify({ action: "findings", findings: results.slice(0, args.limit ?? 20), count: results.length }, null, 2)
    }

    if (args.action === "failures") {
      const sid = args.session_id || context.sessionID
      const fp = r(context.worktree, `docs/json/opencode/sessions/${sid}/failures/failures.v1.jsonl`)
      if (!existsSync(fp)) return JSON.stringify({ action: "failures", failures: [], count: 0 }, null, 2)
      let entries: any[] = []
      try { entries = readFileSync(fp, "utf8").split("\n").filter(Boolean).map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean) } catch {}
      return JSON.stringify({ action: "failures", failures: entries.slice(-(args.limit ?? 10)), count: entries.length }, null, 2)
    }

    return JSON.stringify({ error: `Unknown action: '${args.action}'` }, null, 2)
  },
})
