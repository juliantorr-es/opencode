import { tool } from "@opencode-ai/plugin"
import { resolve } from "node:path"
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"

function resolvePath(worktree: string, p: string): string { return resolve(worktree, p) }

export default tool({
  description: "Revise an existing plan artifact. Increments revision number and preserves history.",
  args: {
    plan_id: tool.schema.string().describe("Plan identifier"),
    revised_content: tool.schema.string().describe("Revised plan content"),
    reason: tool.schema.string().describe("Why this revision was needed"),
  },
  async execute(args, context) {
    const path = resolvePath(context.worktree, `docs/json/opencode/plans/${args.plan_id}.v1.json`)
    if (!existsSync(path)) return JSON.stringify({ status: "fail", error: `Plan not found: ${args.plan_id}` }, null, 2)

    const plan = JSON.parse(readFileSync(path, "utf8"))
    plan.content = args.revised_content
    plan.plan_revision = (plan.plan_revision || 1) + 1
    plan.modified_at = new Date().toISOString()
    plan.revision_reason = args.reason
    writeFileSync(path, JSON.stringify(plan, null, 2), "utf8")
    return JSON.stringify({ status: "revised", plan_id: args.plan_id, revision: plan.plan_revision }, null, 2)
  },
})
