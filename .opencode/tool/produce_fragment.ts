import { tool } from "@opencode-ai/plugin"
import { resolve } from "node:path"
import { appendFileSync, existsSync, mkdirSync } from "node:fs"

function resolvePath(worktree: string, p: string): string { return resolve(worktree, p) }

export default tool({
  description: "Produce a fragment for a shared file — safe concurrent editing via diff patches. The consolidator assembles all fragments for a file.",
  args: {
    target_file: tool.schema.string().describe("The shared file being edited"),
    lane_id: tool.schema.string().describe("Your lane identifier"),
    anchor_hint: tool.schema.string().describe("Where this fragment should be applied (e.g. 'after line 232', 'before isValidMcpEntry')"),
    content: tool.schema.string().describe("The fragment content to insert or the replacement text"),
    dependencies: tool.schema.string().optional().describe("JSON array of lane IDs this fragment depends on"),
  },
  async execute(args, context) {
    const dir = resolvePath(context.worktree, `docs/json/opencode/sessions/${context.sessionID}/fragments`)
    const path = resolvePath(context.worktree, `docs/json/opencode/sessions/${context.sessionID}/fragments/${args.lane_id}.v1.json`)
    try { if (!existsSync(dir)) mkdirSync(dir, { recursive: true }) } catch (_) {}

    let deps: string[] = []
    if (args.dependencies) { try { deps = JSON.parse(args.dependencies) } catch {} }

    const fragment = { schema_version: "v1", target_file: args.target_file, lane_id: args.lane_id, anchor_hint: args.anchor_hint, content: args.content, dependencies: deps, produced_at: new Date().toISOString() }
    try { appendFileSync(path, JSON.stringify(fragment) + "\n", "utf8") } catch (_) {}
    return JSON.stringify({ status: "produced", target_file: args.target_file, lane_id: args.lane_id }, null, 2)
  },
})
