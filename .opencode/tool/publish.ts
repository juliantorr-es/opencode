import { tool } from "@opencode-ai/plugin"
import { resolve } from "node:path"
import { existsSync, mkdirSync, appendFileSync, readFileSync, writeFileSync } from "node:fs"

function r(worktree: string, p: string): string { return resolve(worktree, p) }

export default tool({
  description: "Publish findings or checkpoints to the shared knowledge base.",
  args: {
    action: tool.schema.string().describe("finding | checkpoint"),
    finding_type: tool.schema.string().optional().describe("bug | debt | risk | opportunity (for finding)"),
    summary: tool.schema.string().optional().describe("One-line summary"),
    details: tool.schema.string().optional().describe("Details"),
    file: tool.schema.string().optional().describe("File:line"),
    checkpoint_id: tool.schema.string().optional().describe("Checkpoint ID (for checkpoint)"),
    checkpoint_status: tool.schema.string().optional().describe("published | rejected (for checkpoint)"),
    ttl_days: tool.schema.number().optional().describe("TTL in days (default 30)"),
  },
  async execute(args, context) {
    if (args.action === "finding") {
      const dir = r(context.worktree, "docs/json/opencode/knowledge")
      const path = r(context.worktree, "docs/json/opencode/knowledge/findings.v1.jsonl")
      try { if (!existsSync(dir)) mkdirSync(dir, { recursive: true }) } catch (_) {}
      const ttl = args.ttl_days ?? 30
      const record = { schema_version: "v1", finding_type: args.finding_type, summary: args.summary, details: args.details || null, file: args.file || null, session_id: context.sessionID, agent: context.agent, recorded_at: new Date().toISOString(), expires_at: new Date(Date.now() + ttl * 86400000).toISOString() }
      try { appendFileSync(path, JSON.stringify(record) + "\n", "utf8") } catch (_) {}
      return JSON.stringify({ action: "finding", status: "published", ttl_days: ttl }, null, 2)
    }

    if (args.action === "checkpoint") {
      const cp = r(context.worktree, `docs/json/opencode/sessions/${context.sessionID}/checkpoints/checkpoints.v1.jsonl`)
      if (!existsSync(cp)) return JSON.stringify({ error: "No checkpoints found" }, null, 2)
      let entries: any[] = []
      try { entries = readFileSync(cp, "utf8").split("\n").filter(Boolean).map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean) } catch { return JSON.stringify({ error: "Parse error" }, null, 2) }
      for (const e of entries) {
        if (e.checkpoint_id === args.checkpoint_id) { e.status = args.checkpoint_status; e.published_at = new Date().toISOString() }
      }
      writeFileSync(cp, entries.map(e => JSON.stringify(e)).join("\n") + "\n", "utf8")
      return JSON.stringify({ action: "checkpoint", checkpoint_id: args.checkpoint_id, status: args.checkpoint_status }, null, 2)
    }

    return JSON.stringify({ error: `Unknown action: '${args.action}'` }, null, 2)
  },
})
