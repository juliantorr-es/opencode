import { tool } from "@opencode-ai/plugin"
import { resolve } from "node:path"
import { readFileSync, writeFileSync, existsSync } from "node:fs"

function resolvePath(worktree: string, p: string): string { return resolve(worktree, p) }

export default tool({
  description: "Add a comment to an existing plan artifact.",
  args: {
    plan_id: tool.schema.string().describe("Plan identifier"),
    comment: tool.schema.string().describe("Comment text"),
    author: tool.schema.string().optional().describe("Comment author (defaults to current agent)"),
  },
  async execute(args, context) {
    const path = resolvePath(context.worktree, `docs/json/opencode/plans/${args.plan_id}.v1.json`)
    if (!existsSync(path)) return JSON.stringify({ status: "fail", error: `Plan not found: ${args.plan_id}` }, null, 2)

    const plan = JSON.parse(readFileSync(path, "utf8"))
    if (!plan.comments) plan.comments = []
    plan.comments.push({ author: args.author || context.agent, comment: args.comment, at: new Date().toISOString() })
    writeFileSync(path, JSON.stringify(plan, null, 2), "utf8")
    return JSON.stringify({ status: "commented", plan_id: args.plan_id, comment_count: plan.comments.length }, null, 2)
  },
})
