import { tool, makeError, ErrorCode } from "@opencode-ai/plugin"
import { resolve } from "node:path"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"

function r(worktree: string, p: string): string { return resolve(worktree, p) }

export const modeDescriptions = {
  architect: "Design lifecycle plans: propose new plans, revise existing ones, with boundary constraints and consumer-purpose anchoring. Validate against claim atoms before publication.",
  "architecture-reviewer": "Review architectural plans for structural soundness, convention adherence, and consistency with existing patterns.",
} as const

export default tool({
  description: "Plan lifecycle — propose new plans or revise existing ones.",
  args: {
    action: tool.schema.string().describe("propose | revise"),
    plan_id: tool.schema.string().optional().describe("Plan ID (auto-generated for propose, required for revise)"),
    title: tool.schema.string().optional().describe("Plan title (for propose)"),
    boundary: tool.schema.string().optional().describe("Boundary name (for propose)"),
    consumer_purpose: tool.schema.string().optional().describe("Consumer purpose (for propose)"),
    claim_atoms: tool.schema.string().optional().describe("Claim atoms (for propose)"),
    content: tool.schema.string().optional().describe("Plan content"),
    reason: tool.schema.string().optional().describe("Revision reason"),
    dry_run: tool.schema.boolean().optional().describe("Preview without writing"),
  },
  async execute(args, context) {
    if (args.action === "propose") {
      const raw = args.claim_atoms || ""
      let atoms: string[] = []
      const parseInput = (input: any): string[] | null => {
        if (Array.isArray(input)) return input.filter((a: any) => typeof a === "string")
        if (typeof input !== "string" || !input.trim()) return null
        try { const p = JSON.parse(input.trim()); if (Array.isArray(p)) return p.filter((a: any) => typeof a === "string") } catch {}
        try { const u = JSON.parse(input.trim()); if (typeof u === "string") { const i = JSON.parse(u); if (Array.isArray(i)) return i.filter((a: any) => typeof a === "string") } } catch {}
        if (!input.trim().startsWith("[")) return input.split(",").map(s => s.trim()).filter(Boolean)
        return null
      }
      const result = parseInput(raw)
      if (!result || result.length === 0) return makeError(ErrorCode.INVALID_ARGUMENTS, "claim_atoms could not be parsed")
      atoms = result

      const pid = args.plan_id || (args.boundary || "plan").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
      const dir = r(context.worktree, "docs/json/opencode/plans")
      const path = r(context.worktree, `docs/json/opencode/plans/${pid}.v1.json`)
      if (existsSync(path)) return makeError(ErrorCode.CONFLICT, `Plan ${pid} already exists. Use action='revise'.`)
      if (args.dry_run) return JSON.stringify({ action: "propose", dry_run: true, plan_id: pid, preview: args.content?.slice(0, 300) }, null, 2)
      try { mkdirSync(dir, { recursive: true }) } catch (_) {}
      const now = new Date().toISOString()
      writeFileSync(path, JSON.stringify({ schema_version: "v1", plan_id: pid, plan_revision: 1, title: args.title, boundary: args.boundary, consumer_purpose: args.consumer_purpose, claim_atoms: atoms, content: args.content, status: "proposed", created_at: now, modified_at: now }, null, 2), "utf8")
      return JSON.stringify({ action: "propose", plan_id: pid, claim_count: atoms.length }, null, 2)
    }

    if (args.action === "revise") {
      const path = r(context.worktree, `docs/json/opencode/plans/${args.plan_id}.v1.json`)
      if (!existsSync(path)) return makeError(ErrorCode.NOT_FOUND, `Plan ${args.plan_id} not found`)
      const plan = JSON.parse(readFileSync(path, "utf8"))
      if (args.content) plan.content = args.content
      plan.plan_revision = (plan.plan_revision || 1) + 1
      plan.modified_at = new Date().toISOString()
      plan.revision_reason = args.reason
      writeFileSync(path, JSON.stringify(plan, null, 2), "utf8")
      return JSON.stringify({ action: "revise", plan_id: args.plan_id, revision: plan.plan_revision }, null, 2)
    }

    return makeError(ErrorCode.UNKNOWN_ACTION, `Unknown action: '${args.action}'`)
  },
})
