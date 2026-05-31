import { tool } from "@opencode-ai/plugin"
import { resolve } from "node:path"
import { existsSync, mkdirSync, appendFileSync } from "node:fs"

function r(worktree: string, p: string): string { return resolve(worktree, p) }

export default tool({
  description: "Report anything — friction, tool feedback, or tool failures. One tool for all feedback.",
  args: {
    action: tool.schema.string().describe("friction | tool | failure"),
    note: tool.schema.string().optional().describe("Freeform note (for friction/tool)"),
    tool_name: tool.schema.string().optional().describe("Tool name (for failure/tool)"),
    error_message: tool.schema.string().optional().describe("Error message (for failure)"),
    severity: tool.schema.string().optional().describe("blocker | major | minor | annoyance"),
  },
  async execute(args, context) {
    const base = `docs/json/opencode/sessions/${context.sessionID}/feedback`
    
    if (args.action === "friction") {
      const dir = r(context.worktree, base)
      const path = r(context.worktree, `${base}/friction.v1.jsonl`)
      try { if (!existsSync(dir)) mkdirSync(dir, { recursive: true }) } catch (_) {}
      try { appendFileSync(path, JSON.stringify({ schema_version: "v1", note: args.note, reporter_session: context.sessionID, reporter_agent: context.agent, recorded_at: new Date().toISOString() }) + "\n", "utf8") } catch (_) {}
      return JSON.stringify({ action: "friction", status: "recorded" }, null, 2)
    }

    if (args.action === "tool") {
      const dir = r(context.worktree, base)
      const path = r(context.worktree, `${base}/tool_feedback.v1.jsonl`)
      try { if (!existsSync(dir)) mkdirSync(dir, { recursive: true }) } catch (_) {}
      try { appendFileSync(path, JSON.stringify({ schema_version: "v2", note: args.note, severity: args.severity, reporter_session: context.sessionID, reporter_agent: context.agent, recorded_at: new Date().toISOString() }) + "\n", "utf8") } catch (_) {}
      return JSON.stringify({ action: "tool", status: "recorded" }, null, 2)
    }

    if (args.action === "failure") {
      const dir = r(context.worktree, `docs/json/opencode/sessions/${context.sessionID}/failures`)
      const path = r(context.worktree, `docs/json/opencode/sessions/${context.sessionID}/failures/failures.v1.jsonl`)
      try { if (!existsSync(dir)) mkdirSync(dir, { recursive: true }) } catch (_) {}
      try { appendFileSync(path, JSON.stringify({ schema_version: "v1", failure_type: "tool", source: args.tool_name, message: args.error_message, session_id: context.sessionID, recorded_at: new Date().toISOString() }) + "\n", "utf8") } catch (_) {}
      return JSON.stringify({ action: "failure", status: "recorded" }, null, 2)
    }

    return JSON.stringify({ error: `Unknown action: '${args.action}'` }, null, 2)
  },
})
