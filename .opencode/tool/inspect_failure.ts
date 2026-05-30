import { tool } from "@opencode-ai/plugin"
import { resolve } from "node:path"
import { existsSync, readFileSync } from "node:fs"

function resolvePath(worktree: string, p: string): string { return resolve(worktree, p) }

export default tool({
  description: "Inspect a tool invocation failure by reading the failure log and providing context.",
  args: {
    session_id: tool.schema.string().optional().describe("Session to inspect (defaults to current)"),
    limit: tool.schema.number().optional().describe("Max failures to return (default 10)"),
  },
  async execute(args, context) {
    const sid = args.session_id || context.sessionID
    const path = resolvePath(context.worktree, `docs/json/opencode/sessions/${sid}/failures/failures.v1.jsonl`)
    if (!existsSync(path)) return JSON.stringify({ failures: [], count: 0 }, null, 2)

    let entries: any[] = []
    try { entries = readFileSync(path, "utf8").split("\n").filter(Boolean).map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean) } catch { return JSON.stringify({ failures: [], count: 0, error: "Parse error" }, null, 2) }

    const limit = args.limit ?? 10
    return JSON.stringify({ failures: entries.slice(-limit), count: entries.length }, null, 2)
  },
})
