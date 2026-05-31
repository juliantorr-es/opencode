import { tool } from "@opencode-ai/plugin"
import { resolve } from "node:path"
import { existsSync, mkdirSync, appendFileSync } from "node:fs"

function r(worktree: string, p: string): string { return resolve(worktree, p) }

export default tool({
  description: "Publication gates — publish findings/checkpoints or record prepublication verdicts.",
  args: {
    action: tool.schema.string().describe("publish-finding | publish-checkpoint | prepub"),
    // publish
    finding_type: tool.schema.string().optional().describe("bug | debt | risk | opportunity"),
    summary: tool.schema.string().optional().describe("One-line summary"),
    details: tool.schema.string().optional().describe("Details"),
    file: tool.schema.string().optional().describe("File:line reference"),
    checkpoint_id: tool.schema.string().optional().describe("Checkpoint ID"),
    checkpoint_status: tool.schema.string().optional().describe("published | rejected"),
    ttl_days: tool.schema.number().optional().describe("TTL in days (default 30)"),
    // prepub
    prepub_action: tool.schema.string().optional().describe("admitted | blocked | inconclusive (for prepub)"),
    finding_id: tool.schema.string().optional().describe("Finding ID (for prepub)"),
    reason: tool.schema.string().optional().describe("Reason (for prepub)"),
  },
  async execute(args, context) {
    const base = `docs/json/opencode/sessions/${context.sessionID}`

    if (args.action === "publish-finding") {
      const dir = r(context.worktree, "docs/json/opencode/knowledge")
      const path = r(context.worktree, "docs/json/opencode/knowledge/findings.v1.jsonl")
      try { if (!existsSync(dir)) mkdirSync(dir, { recursive: true }) } catch (_) {}
      const ttl = args.ttl_days ?? 30
      try { appendFileSync(path, JSON.stringify({ schema_version: "v1", finding_type: args.finding_type, summary: args.summary, details: args.details || null, file: args.file || null, session_id: context.sessionID, agent: context.agent, recorded_at: new Date().toISOString(), expires_at: new Date(Date.now() + ttl * 86400000).toISOString() }) + "\n", "utf8") } catch (_) {}
      return JSON.stringify({ action: "publish-finding", status: "published" }, null, 2)
    }

    if (args.action === "publish-checkpoint") {
      const cp = r(context.worktree, `${base}/checkpoints/checkpoints.v1.jsonl`)
      if (!existsSync(cp)) return JSON.stringify({ error: "No checkpoints found" }, null, 2)
      // Simplified: just record the publication status
      const dir = r(context.worktree, `${base}/checkpoints`)
      try { if (!existsSync(dir)) mkdirSync(dir, { recursive: true }) } catch (_) {}
      try { appendFileSync(cp, JSON.stringify({ schema_version: "v1", checkpoint_id: args.checkpoint_id, status: args.checkpoint_status || "published", published_at: new Date().toISOString() }) + "\n", "utf8") } catch (_) {}
      return JSON.stringify({ action: "publish-checkpoint", checkpoint_id: args.checkpoint_id, status: "published" }, null, 2)
    }

    if (args.action === "prepub") {
      const pa = args.prepub_action || "admitted"
      const dir = r(context.worktree, `${base}/prepublication`)
      const path = r(context.worktree, `${base}/prepublication/${pa}.v1.jsonl`)
      try { if (!existsSync(dir)) mkdirSync(dir, { recursive: true }) } catch (_) {}
      try { appendFileSync(path, JSON.stringify({ schema_version: "v1", finding_id: args.finding_id, reason: args.reason, session_id: context.sessionID, agent: context.agent, recorded_at: new Date().toISOString() }) + "\n", "utf8") } catch (_) {}
      return JSON.stringify({ action: "prepub", verdict: pa, finding_id: args.finding_id }, null, 2)
    }

    return JSON.stringify({ error: `Unknown action: '${args.action}'` }, null, 2)
  },
})
