import { tool } from "@opencode-ai/plugin"
import { resolve } from "node:path"
import { appendFileSync, existsSync, mkdirSync } from "node:fs"

function resolvePath(worktree: string, p: string): string { return resolve(worktree, p) }

export default tool({
  description: "Record a QA observation that tests exercise the production boundary cleanly.",
  args: {
    test_file: tool.schema.string().describe("Path to the test file"),
    boundary: tool.schema.string().describe("Production boundary being tested"),
    observation: tool.schema.string().describe("What you observed — e.g. '6 test cases, all exercise DatabaseAdapter directly'"),
  },
  async execute(args, context) {
    const dir = resolvePath(context.worktree, `docs/json/opencode/sessions/${context.sessionID}/qa`)
    const path = resolvePath(context.worktree, `docs/json/opencode/sessions/${context.sessionID}/qa/observations.v1.jsonl`)
    try { if (!existsSync(dir)) mkdirSync(dir, { recursive: true }) } catch (_) {}

    const record = {
      schema_version: "v1", test_file: args.test_file, boundary: args.boundary,
      observation: args.observation, session_id: context.sessionID,
      agent: context.agent, recorded_at: new Date().toISOString(),
    }
    try { appendFileSync(path, JSON.stringify(record) + "\n", "utf8") } catch (_) {}
    return JSON.stringify({ status: "recorded", test_file: args.test_file }, null, 2)
  },
})
