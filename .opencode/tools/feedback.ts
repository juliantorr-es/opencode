import { tool } from "@opencode-ai/plugin"
import { resolve } from "node:path"
import { existsSync, mkdirSync, appendFileSync } from "node:fs"

function r(worktree: string, p: string): string { return resolve(worktree, p) }

export default tool({
  description: "Report tool friction, failures, or behavioral issues. Severity-based routing: blockers halt the lane, majors need attention, minors are noted, annoyances are logged. Tool failures are tracked for pattern detection across sessions.",
  args: {
    action: tool.schema.string().describe("'friction' for behavioral issues, 'tool' for tool-specific feedback, 'failure' for tool crashes/errors"),
    note: tool.schema.string().optional().describe("What went wrong — be specific"),
    tool_name: tool.schema.string().optional().describe("Which tool (for tool/failure actions)"),
    severity: tool.schema.string().optional().describe("blocker (lane halted) | major (needs fix) | minor (noted) | annoyance (logged)"),
    expected: tool.schema.string().optional().describe("What you expected the tool to do (for tool/failure)"),
    actual: tool.schema.string().optional().describe("What actually happened (for tool/failure)"),
    workaround: tool.schema.string().optional().describe("How you worked around it (for tool/failure)"),
    recoverable: tool.schema.boolean().optional().describe("Was the error recoverable? true if you could continue working."),
  },
  async execute(args, context) {
    const sessionBase = `docs/json/opencode/sessions/${context.sessionID}`
    const crossSessionBase = `docs/json/opencode`

    if (args.action === "friction") {
      const dir = r(context.worktree, `${sessionBase}/feedback`)
      const path = r(context.worktree, `${sessionBase}/feedback/friction.v1.jsonl`)
      try { if (!existsSync(dir)) mkdirSync(dir, { recursive: true }) } catch (_) {}
      const entry = {
        schema_version: "v2",
        note: args.note, severity: args.severity || "minor",
        reporter_session: context.sessionID, reporter_agent: context.agent,
        recorded_at: new Date().toISOString(),
      }
      try { appendFileSync(path, JSON.stringify(entry) + "\n", "utf8") } catch (_) {}

      const response: any = { action: "friction", status: "recorded" }
      if (args.severity === "blocker") response.warning = "Blocker reported — consider escalating to General Man-agent via smart_delegate(action=\"send\", kind=\"blocker\")."
      return JSON.stringify(response, null, 2)
    }

    if (args.action === "tool" || args.action === "failure") {
      const dir = r(context.worktree, `${sessionBase}/feedback`)
      const path = r(context.worktree, `${sessionBase}/feedback/tool_feedback.v1.jsonl`)
      try { if (!existsSync(dir)) mkdirSync(dir, { recursive: true }) } catch (_) {}
      const entry = {
        schema_version: "v2",
        tool: args.tool_name, action: args.action,
        note: args.note, severity: args.severity || "major",
        expected: args.expected, actual: args.actual, workaround: args.workaround,
        recoverable: args.recoverable ?? true,
        reporter_session: context.sessionID, reporter_agent: context.agent,
        recorded_at: new Date().toISOString(),
      }
      try { appendFileSync(path, JSON.stringify(entry) + "\n", "utf8") } catch (_) {}

      // Also write to cross-session failure log for pattern detection
      if (args.severity === "blocker" || args.severity === "major") {
        const csDir = r(context.worktree, `${crossSessionBase}/feedback`)
        const csPath = r(context.worktree, `${crossSessionBase}/feedback/cross_session_failures.v1.jsonl`)
        try { if (!existsSync(csDir)) mkdirSync(csDir, { recursive: true }) } catch (_) {}
        try { appendFileSync(csPath, JSON.stringify(entry) + "\n", "utf8") } catch (_) {}
      }

      return JSON.stringify({
        action: args.action, status: "recorded", severity: args.severity,
        hint: args.recoverable === false
          ? "Non-recoverable failure — consider escalating if this blocks your mission."
          : "Failure recorded. Continue with your workaround.",
      }, null, 2)
    }

    return JSON.stringify({ error: `Unknown action: '${args.action}'. Valid: friction, tool, failure.` }, null, 2)
  },
})
