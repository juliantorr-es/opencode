import { tool } from "@opencode-ai/plugin"
import { resolve } from "node:path"
import { appendFileSync, existsSync, mkdirSync } from "node:fs"

function resolvePath(worktree: string, p: string): string { return resolve(worktree, p) }

export default tool({
  description: "Record a tool invocation failure for diagnostics.",
  args: {
    tool_name: tool.schema.string().describe("Name of the tool that failed"),
    error_message: tool.schema.string().describe("Error message from the tool"),
    args_used: tool.schema.string().optional().describe("JSON of the arguments that were passed"),
    recovery_attempted: tool.schema.boolean().optional().describe("Whether a recovery was attempted"),
  },
  async execute(args, context) {
    const dir = resolvePath(context.worktree, `docs/json/opencode/sessions/${context.sessionID}/failures`)
    const path = resolvePath(context.worktree, `docs/json/opencode/sessions/${context.sessionID}/failures/failures.v1.jsonl`)
    try { if (!existsSync(dir)) mkdirSync(dir, { recursive: true }) } catch (_) {}

    const record = {
      schema_version: "v1", failure_type: "tool",
      source: args.tool_name, message: args.error_message,
      context: JSON.stringify({ args: args.args_used ? (() => { try { return JSON.parse(args.args_used) } catch { return args.args_used } })() : null, recovery_attempted: args.recovery_attempted ?? false }),
      session_id: context.sessionID, recorded_at: new Date().toISOString(),
    }
    try { appendFileSync(path, JSON.stringify(record) + "\n", "utf8") } catch (_) {}
    return JSON.stringify({ status: "ok", tool: args.tool_name, recorded: true }, null, 2)
  },
})
