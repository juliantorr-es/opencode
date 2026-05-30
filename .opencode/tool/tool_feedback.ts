import { tool } from "@opencode-ai/plugin"
import { resolve } from "node:path"
import { appendFileSync, existsSync, mkdirSync } from "node:fs"

function resolvePath(worktree: string, p: string): string {
  return resolve(worktree, p)
}

export default tool({
  description: "Share feedback about anything that caused friction — tool issues, process problems, confusing prompts, missing features, timing problems, cross-lane conflicts. Write it as a narrative note. Call this at the end of your session or whenever you hit a wall.",
  args: {
    note: tool.schema.string().describe("Freeform narrative about what went wrong, what surprised you, what was harder than it should be, or what you wish existed. Be specific: include lane IDs, file names, tool names, timestamps when relevant."),
    severity: tool.schema.string().optional().describe("blocker | major | minor | annoyance"),
    category: tool.schema.string().optional().describe("tool | process | prompt | timing | schema | protocol | other"),
  },
  async execute(args, context) {
    const dir = resolvePath(context.worktree, `docs/json/opencode/sessions/${context.sessionID}/feedback`)
    const path = resolvePath(context.worktree, `docs/json/opencode/sessions/${context.sessionID}/feedback/tool_feedback.v1.jsonl`)

    try { if (!existsSync(dir)) mkdirSync(dir, { recursive: true }) } catch (_) {}

    const dedupKey = Buffer.from(`${args.note.slice(0, 80)}|${context.sessionID}`).toString("hex").slice(0, 16)
    const record = {
      schema_version: "v2",
      dedup_key: dedupKey,
      note: args.note,
      severity: args.severity || null,
      category: args.category || null,
      reporter_session: context.sessionID,
      reporter_agent: context.agent,
      recorded_at: new Date().toISOString(),
    }

    try {
      appendFileSync(path, JSON.stringify(record) + "\n", "utf8")
    } catch (_) {
      return JSON.stringify({ status: "fail", error: "Could not write feedback file" }, null, 2)
    }

    return JSON.stringify({
      status: "recorded",
      note: "Feedback recorded — thank you. This will be reviewed post-run.",
      severity: args.severity,
    }, null, 2)
  },
})
