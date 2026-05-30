import { tool } from "@opencode-ai/plugin"
import { resolve } from "node:path"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"

function resolvePath(worktree: string, p: string): string { return resolve(worktree, p) }

export default tool({
  description: "Curate the active mission context from subagent-produced artifacts. Assembles a living context document that each wave receives.",
  args: {
    profile: tool.schema.string().optional().describe("Profile to filter context for (e.g. 'execution', 'cartography')"),
    findings: tool.schema.string().optional().describe("JSON array of finding summaries to include"),
  },
  async execute(args, context) {
    const dir = resolvePath(context.worktree, `docs/json/opencode/sessions/${context.sessionID}/context`)
    const path = resolvePath(context.worktree, `docs/json/opencode/sessions/${context.sessionID}/context/current.v1.json`)
    try { if (!existsSync(dir)) mkdirSync(dir, { recursive: true }) } catch (_) {}

    let existing: any = { schema_version: "v1", profile: args.profile || "all", entries: [], curated_at: null }
    if (existsSync(path)) { try { existing = JSON.parse(readFileSync(path, "utf8")) } catch {} }

    let findings: any[] = []
    if (args.findings) { try { findings = JSON.parse(args.findings) } catch {} }

    existing.curated_at = new Date().toISOString()
    existing.profile = args.profile || existing.profile || "all"
    for (const f of findings) { existing.entries.push({ ...f, added_at: new Date().toISOString() }) }
    writeFileSync(path, JSON.stringify(existing, null, 2), "utf8")
    return JSON.stringify({ status: "curated", entry_count: existing.entries.length, profile: existing.profile }, null, 2)
  },
})
