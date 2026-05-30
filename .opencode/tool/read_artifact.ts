import { tool } from "@opencode-ai/plugin"
import { resolve } from "node:path"
import { existsSync, readFileSync } from "node:fs"

function resolvePath(worktree: string, p: string): string { return resolve(worktree, p) }

export default tool({
  description: "Read a curated artifact file and return its content. Consumes artifacts produced by subagents — condensed, agent-optimized summaries.",
  args: {
    path: tool.schema.string().describe("Path to the artifact (session-scoped)"),
    profile: tool.schema.string().optional().describe("Filter content by profile tag (e.g. 'execution', 'cartography')"),
  },
  async execute(args, context) {
    const fullPath = resolvePath(context.worktree, args.path)
    if (!existsSync(fullPath)) return JSON.stringify({ status: "not_found", path: args.path, hint: "Check the path — artifacts are in docs/json/opencode/sessions/<id>/ or docs/json/opencode/plans/" }, null, 2)

    try {
      const content = readFileSync(fullPath, "utf8")
      let data: any
      try { data = JSON.parse(content) } catch { data = { raw: content.slice(0, 2000) } }

      return JSON.stringify({ status: "loaded", path: args.path, artifact: data, size_bytes: content.length }, null, 2)
    } catch {
      return JSON.stringify({ status: "fail", error: "Could not read artifact" }, null, 2)
    }
  },
})
