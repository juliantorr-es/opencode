import { tool } from "@opencode-ai/plugin"
import { resolve } from "node:path"
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs"

function resolvePath(worktree: string, p: string): string {
  return resolve(worktree, p)
}

export default tool({
  description: "Record a cross-session lesson so future sessions can learn from this one. Use this for: 'don't do that again' signals, discovered codebase patterns, architectural invariants, timing gotchas, and workflow insights. Lessons persist across sessions and are injected into new orchestrator sessions as system context.",
  args: {
    pattern: tool.schema.string().describe("A short, searchable label for this lesson (e.g. 'renderer-fire-and-forget', 'critic-review-timing', 'ipc-shared-file')"),
    lesson: tool.schema.string().describe("One sentence that captures the insight. Concise and actionable."),
    category: tool.schema.string().optional().describe("codebase | workflow | architecture | tool | timing | convention"),
    confidence: tool.schema.number().optional().describe("0.0–1.0 how certain you are this lesson generalizes"),
    context: tool.schema.string().optional().describe("What triggered this lesson — lane ID, file, error message, etc."),
  },
  async execute(args, context) {
    const dir = resolvePath(context.worktree, "docs/json/opencode/knowledge")
    const path = resolvePath(context.worktree, "docs/json/opencode/knowledge/lessons.v1.jsonl")

    try {
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

      const record = JSON.stringify({
        schema_version: "v1",
        pattern: args.pattern,
        lesson: args.lesson,
        category: args.category || null,
        confidence: args.confidence ?? 0.8,
        context: args.context || null,
        source_session: context.sessionID,
        source_agent: context.agent,
        recorded_at: new Date().toISOString(),
      })

      appendFileSync(path, record + "\n", "utf8")

      return JSON.stringify({
        status: "recorded",
        pattern: args.pattern,
        note: "Lesson persisted. Future sessions will see this in their context.",
      }, null, 2)
    } catch (e: any) {
      return JSON.stringify({ status: "fail", error: e?.message || "unknown" }, null, 2)
    }
  },
})
