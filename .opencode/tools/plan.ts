import { tool } from "@opencode-ai/plugin"
import { resolve } from "node:path"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"

function r(worktree: string, p: string): string { return resolve(worktree, p) }

export default tool({
  description: "Plan lifecycle — propose new plans or revise existing ones.",
  args: {
    action: tool.schema.string().describe("propose | revise"),
    plan_id: tool.schema.string().optional().describe("Plan ID"),
    title: tool.schema.string().optional().describe("Plan title"),
    content: tool.schema.string().optional().describe("Plan content"),
    reason: tool.schema.string().optional().describe("Revision reason"),
  },
  async execute(args, context) {
    if (args.action === "propose") {
      const pid = args.plan_id || "plan-" + Date.now()
      const dir = r(context.worktree, "docs/json/opencode/plans")
      const path = r(context.worktree, `docs/json/opencode/plans/${pid}.v1.json`)
      if (existsSync(path)) return JSON.stringify({ error: `Plan ${pid} already exists` }, null, 2)
      try { mkdirSync(dir, { recursive: true }) } catch (_) {}
      writeFileSync(path, JSON.stringify({ plan_id: pid, title: args.title, content: args.content, status: "proposed", created_at: new Date().toISOString() }, null, 2), "utf8")
      return JSON.stringify({ action: "propose", plan_id: pid }, null, 2)
    }
    if (args.action === "revise") {
      const path = r(context.worktree, `docs/json/opencode/plans/${args.plan_id}.v1.json`)
      if (!existsSync(path)) return JSON.stringify({ error: `Plan ${args.plan_id} not found` }, null, 2)
      const plan = JSON.parse(readFileSync(path, "utf8"))
      if (args.content) plan.content = args.content
      plan.modified_at = new Date().toISOString()
      writeFileSync(path, JSON.stringify(plan, null, 2), "utf8")
      return JSON.stringify({ action: "revise", plan_id: args.plan_id }, null, 2)
    }
    return JSON.stringify({ error: `Unknown action: '${args.action}'` }, null, 2)
  },
})
