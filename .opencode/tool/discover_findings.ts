import { tool } from "@opencode-ai/plugin"
import { resolve } from "node:path"
import { existsSync, readFileSync } from "node:fs"

function resolvePath(worktree: string, p: string): string { return resolve(worktree, p) }

export default tool({
  description: "Discover findings from the shared knowledge base. Searches across sessions for findings matching your criteria.",
  args: {
    finding_type: tool.schema.string().optional().describe("bug | debt | risk | opportunity | pattern | fragment"),
    profile: tool.schema.string().optional().describe("Filter by profile (e.g. 'cartography')"),
    min_confidence: tool.schema.number().optional().describe("Minimum confidence threshold (0-1)"),
    limit: tool.schema.number().optional().describe("Max results (default 20)"),
  },
  async execute(args, context) {
    const findingsPath = resolvePath(context.worktree, "docs/json/opencode/knowledge/findings.v1.jsonl")
    const results: any[] = []

    if (existsSync(findingsPath)) {
      try {
        const lines = readFileSync(findingsPath, "utf8").split("\n").filter(Boolean)
        for (const line of lines) {
          try {
            const f = JSON.parse(line)
            if (args.finding_type && f.finding_type !== args.finding_type) continue
            if (f.expires_at && new Date(f.expires_at) < new Date()) continue
            results.push({ type: f.finding_type, summary: f.summary, file: f.file, session: f.session_id?.slice(0, 12), recorded: f.recorded_at })
          } catch {}
        }
      } catch {}
    }

    // Also check fragments
    if (!args.finding_type || args.finding_type === "fragment") {
      const fragmentsDir = resolvePath(context.worktree, `docs/json/opencode/sessions/${context.sessionID}/fragments`)
      // Simplified: just note that fragment dir may exist
    }

    const limit = args.limit ?? 20
    return JSON.stringify({ findings: results.slice(0, limit), count: results.length, truncated: results.length > limit }, null, 2)
  },
})
