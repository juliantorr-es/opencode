import { tool } from "@opencode-ai/plugin"
import { resolve } from "node:path"
import { existsSync, mkdirSync, appendFileSync } from "node:fs"

function r(worktree: string, p: string): string { return resolve(worktree, p) }

export default tool({
  description: "Record structured observations — lessons learned, activity logs, and pre-existing findings. All records feed into the cross-session knowledge base for future sessions.",
  args: {
    action: tool.schema.string().describe("'lesson' for cross-session patterns, 'activity' for what you just did, 'finding' for pre-existing issues discovered"),
    summary: tool.schema.string().optional().describe("One-sentence summary of the lesson or finding"),
    detail: tool.schema.string().optional().describe("Full description (for lessons and findings)"),
    file_path: tool.schema.string().optional().describe("File that was modified or where finding was discovered (for activity/finding)"),
    action_type: tool.schema.string().optional().describe("created | modified | discovered | blocked (for activity)"),
    severity: tool.schema.string().optional().describe("blocker | major | minor | info (for findings)"),
    category: tool.schema.string().optional().describe("Tag for categorization: permissions, tools, agents, workflow, config, debug"),
  },
  async execute(args, context) {
    const sessionBase = `docs/json/opencode/sessions/${context.sessionID}`

    if (args.action === "lesson") {
      const dir = r(context.worktree, "docs/json/opencode/knowledge")
      const path = r(context.worktree, "docs/json/opencode/knowledge/lessons.v1.jsonl")
      try { if (!existsSync(dir)) mkdirSync(dir, { recursive: true }) } catch (_) {}
      const entry = {
        schema_version: "v2",
        summary: args.summary, detail: args.detail, category: args.category,
        recorded_by: context.agent, session_id: context.sessionID,
        recorded_at: new Date().toISOString(),
      }
      try { appendFileSync(path, JSON.stringify(entry) + "\n", "utf8") } catch (_) {}
      return JSON.stringify({ action: "lesson", status: "recorded", summary: args.summary?.slice(0, 80) }, null, 2)
    }

    if (args.action === "activity") {
      const dir = r(context.worktree, `${sessionBase}/analytics`)
      const path = r(context.worktree, `${sessionBase}/analytics/activity.v1.jsonl`)
      try { if (!existsSync(dir)) mkdirSync(dir, { recursive: true }) } catch (_) {}
      const entry = {
        schema_version: "v2",
        action: args.action_type, target: args.file_path, summary: args.summary,
        agent: context.agent, session_id: context.sessionID,
        recorded_at: new Date().toISOString(),
      }
      try { appendFileSync(path, JSON.stringify(entry) + "\n", "utf8") } catch (_) {}
      return JSON.stringify({ action: "activity", status: "recorded", activity: args.action_type, target: args.file_path }, null, 2)
    }

    if (args.action === "finding") {
      const dir = r(context.worktree, `${sessionBase}/findings`)
      const path = r(context.worktree, `${sessionBase}/findings/findings.v1.jsonl`)
      try { if (!existsSync(dir)) mkdirSync(dir, { recursive: true }) } catch (_) {}
      const entry = {
        schema_version: "v2",
        summary: args.summary, detail: args.detail, file_path: args.file_path,
        severity: args.severity || "info", category: args.category,
        discovered_by: context.agent, session_id: context.sessionID,
        recorded_at: new Date().toISOString(),
      }
      try { appendFileSync(path, JSON.stringify(entry) + "\n", "utf8") } catch (_) {}
      return JSON.stringify({
        action: "finding", status: "recorded", severity: args.severity,
        hint: args.severity === "blocker"
          ? "Blocker finding — consider escalating to General Man-agent via smart_delegate(action=\"send\", kind=\"blocker\")."
          : "Finding recorded. Continue working around it.",
      }, null, 2)
    }

    return JSON.stringify({ error: `Unknown action: '${args.action}'. Valid: lesson, activity, finding.` }, null, 2)
  },
})
