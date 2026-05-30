import { tool } from "@opencode-ai/plugin"
import { resolve } from "node:path"
import { appendFileSync, existsSync, mkdirSync } from "node:fs"

function resolvePath(worktree: string, p: string): string { return resolve(worktree, p) }

export default tool({
  description: "Report anything that made your job harder — tool quirks, confusing instructions, missing features, timing issues, broken assumptions. One field. No friction to report friction.",
  args: {
    note: tool.schema.string().describe("What went wrong? What surprised you? What was harder than it should be? Be specific."),
  },
  async execute(args, context) {
    const dir = resolvePath(context.worktree, `docs/json/opencode/sessions/${context.sessionID}/feedback`)
    const path = resolvePath(context.worktree, `docs/json/opencode/sessions/${context.sessionID}/feedback/friction.v1.jsonl`)
    try { if (!existsSync(dir)) mkdirSync(dir, { recursive: true }) } catch (_) {}

    const record = {
      schema_version: "v1",
      note: args.note,
      reporter_session: context.sessionID,
      reporter_agent: context.agent,
      recorded_at: new Date().toISOString(),
    }
    try { appendFileSync(path, JSON.stringify(record) + "\n", "utf8") } catch (_) {
      return JSON.stringify({ status: "fail", error: "Could not write" }, null, 2)
    }
    return JSON.stringify({ status: "recorded", note: "Friction recorded. Thank you." }, null, 2)
  },
})
