import { tool } from "@opencode-ai/plugin"
import { resolve } from "node:path"
import { appendFileSync, existsSync, mkdirSync } from "node:fs"

function r(worktree: string, p: string): string { return resolve(worktree, p) }

// ── Schemas ──
const BASE = (ctx: any) => ({
  schema: "v1",
  recorded_at: new Date().toISOString(),
  session_id: ctx.sessionID,
  agent: ctx.agent,
})

export default tool({
  description: "Record anything — activity, finding, review, comment, QA observation. All records follow a consistent schema with session and agent attribution.",
  args: {
    action: tool.schema.string().describe("activity | finding | review | comment | qa"),
    // activity
    activity_action: tool.schema.string().optional().describe("created | modified | discovered | blocked (for activity)"),
    target: tool.schema.string().optional().describe("File path, artifact path, or plan ID"),
    details: tool.schema.string().optional().describe("JSON details object (for activity)"),
    // finding
    finding_type: tool.schema.string().optional().describe("bug | debt | risk | opportunity (for finding)"),
    summary: tool.schema.string().optional().describe("One-line summary (for finding/QA)"),
    file: tool.schema.string().optional().describe("File:line reference (for finding)"),
    // review
    axis: tool.schema.string().optional().describe("boundary | coupling | safety | reversibility | surface_area | convention | resilience (for review)"),
    finding: tool.schema.string().optional().describe("Review finding text (for review)"),
    verdict: tool.schema.string().optional().describe("approved | rejected | informational (for review)"),
    // comment
    comment: tool.schema.string().optional().describe("Comment text (for comment)"),
    // qa
    test_file: tool.schema.string().optional().describe("Test file path (for qa)"),
    boundary: tool.schema.string().optional().describe("Production boundary tested (for qa)"),
    observation: tool.schema.string().optional().describe("QA observation (for qa)"),
  },
  async execute(args, context) {
    const base = `docs/json/opencode/sessions/${context.sessionID}`
    let dir: string, path: string, record: any

    // ── ACTIVITY ──
    if (args.action === "activity") {
      dir = r(context.worktree, `docs/json/opencode/knowledge/sessions/${context.sessionID}`)
      path = r(context.worktree, `docs/json/opencode/knowledge/sessions/${context.sessionID}/activities.v1.jsonl`)
      let details: any = {}
      if (args.details) { try { details = JSON.parse(args.details) } catch { details = { note: args.details } } }
      record = {
        ...BASE(context),
        type: "activity",
        action: args.activity_action || "discovered",
        target: args.target || "",
        details,
      }
    }

    // ── FINDING ──
    else if (args.action === "finding") {
      dir = r(context.worktree, `${base}/findings`)
      path = r(context.worktree, `${base}/findings/out_of_scope.v1.jsonl`)
      record = {
        ...BASE(context),
        type: "finding",
        finding_type: args.finding_type || "debt",
        summary: args.summary || "",
        file: args.file || null,
        details: args.details || null,
      }
    }

    // ── REVIEW ──
    else if (args.action === "review") {
      dir = r(context.worktree, `${base}/reviews`)
      path = r(context.worktree, `${base}/reviews/criticism.v1.jsonl`)
      record = {
        ...BASE(context),
        type: "review",
        target: args.target || "",
        axis: args.axis || "boundary",
        finding: args.finding || "",
        verdict: args.verdict || "informational",
      }
    }

    // ── COMMENT ──
    else if (args.action === "comment") {
      dir = r(context.worktree, "docs/json/opencode/plans")
      path = r(context.worktree, `docs/json/opencode/plans/${args.target}.v1.json`)
      if (!existsSync(path)) return JSON.stringify({ error: `Plan not found: ${args.target}` }, null, 2)
      const plan = JSON.parse(require("fs").readFileSync(path, "utf8"))
      if (!plan.comments) plan.comments = []
      plan.comments.push({ author: context.agent, comment: args.comment, at: new Date().toISOString() })
      require("fs").writeFileSync(path, JSON.stringify(plan, null, 2), "utf8")
      return JSON.stringify({ action: "comment", plan_id: args.target, comments: plan.comments.length }, null, 2)
    }

    // ── QA ──
    else if (args.action === "qa") {
      dir = r(context.worktree, `${base}/qa`)
      path = r(context.worktree, `${base}/qa/observations.v1.jsonl`)
      record = {
        ...BASE(context),
        type: "qa",
        test_file: args.test_file || "",
        boundary: args.boundary || "",
        observation: args.observation || args.summary || "",
      }
    }

    else {
      return JSON.stringify({ error: `Unknown action: '${args.action}'. Valid: activity, finding, review, comment, qa.` }, null, 2)
    }

    // Write
    try { if (!existsSync(dir)) mkdirSync(dir, { recursive: true }) } catch (_) {}
    try { appendFileSync(path, JSON.stringify(record) + "\n", "utf8") } catch (_) {}
    return JSON.stringify({ action: args.action, status: "recorded", schema: record.type }, null, 2)
  },
})
