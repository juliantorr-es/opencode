import { tool } from "@opencode-ai/plugin"
import { resolve } from "node:path"
import { appendFileSync, existsSync, mkdirSync } from "node:fs"

function resolvePath(worktree: string, p: string): string { return resolve(worktree, p) }

export default tool({
  description: "Publish a finding to the shared knowledge base so other sessions can discover it.",
  args: {
    finding_type: tool.schema.string().describe("bug | debt | risk | opportunity | pattern"),
    summary: tool.schema.string().describe("One-line summary"),
    details: tool.schema.string().optional().describe("Detailed description"),
    file: tool.schema.string().optional().describe("File:line where the finding was observed"),
    ttl_days: tool.schema.number().optional().describe("Time-to-live in days (default 30)"),
  },
  async execute(args, context) {
    const dir = resolvePath(context.worktree, "docs/json/opencode/knowledge")
    const path = resolvePath(context.worktree, "docs/json/opencode/knowledge/findings.v1.jsonl")
    try { if (!existsSync(dir)) mkdirSync(dir, { recursive: true }) } catch (_) {}

    // Ensure details is a string, not a path that needs reading
    const details = typeof args.details === "string" ? args.details : null
    const file = typeof args.file === "string" ? args.file : null

    const ttl = args.ttl_days ?? 30
    const expires = new Date(Date.now() + ttl * 86400000).toISOString()
    const record = {
      schema_version: "v1",
      finding_type: args.finding_type,
      summary: args.summary,
      details,
      file,
      session_id: context.sessionID,
      agent: context.agent,
      recorded_at: new Date().toISOString(),
      expires_at: expires,
    }
    try { appendFileSync(path, JSON.stringify(record) + "\n", "utf8") } catch (e: any) {
      return JSON.stringify({ status: "fail", error: e?.message || "write failed" }, null, 2)
    }
    return JSON.stringify({ status: "published", finding_type: args.finding_type, ttl_days: ttl }, null, 2)
  },
})
