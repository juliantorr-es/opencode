import { tool } from "@opencode-ai/plugin"
import { resolve } from "node:path"
import { existsSync, readFileSync } from "node:fs"

function resolvePath(worktree: string, p: string): string { return resolve(worktree, p) }

export default tool({
  description: "Query a JSON file with a jq-style path expression. Returns the matched value.",
  args: {
    file: tool.schema.string().describe("JSON file to query"),
    query: tool.schema.string().describe("Dot-separated path: 'scripts.typecheck' or 'dependencies.effect'"),
  },
  async execute(args, context) {
    const path = resolvePath(context.worktree, args.file)
    if (!existsSync(path)) return JSON.stringify({ status: "fail", error: `File not found: ${args.file}` }, null, 2)

    let data: any
    try { data = JSON.parse(readFileSync(path, "utf8")) } catch { return JSON.stringify({ status: "fail", error: "Invalid JSON" }, null, 2) }

    const keys = args.query.split(".")
    let current = data
    for (const key of keys) {
      if (current && typeof current === "object" && key in current) current = current[key]
      else { current = undefined; break }
    }
    return JSON.stringify({ file: args.file, query: args.query, value: current }, null, 2)
  },
})
