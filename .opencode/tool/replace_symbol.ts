import { tool } from "@opencode-ai/plugin"
import { resolve } from "node:path"
import { readFileSync, writeFileSync, existsSync } from "node:fs"

function resolvePath(worktree: string, p: string): string { return resolve(worktree, p) }

export default tool({
  description: "Replace a symbol reference across one or more files. Finds all imports and usages of the old symbol and replaces with the new symbol.",
  args: {
    file: tool.schema.string().describe("File to edit"),
    old_symbol: tool.schema.string().describe("Symbol to replace"),
    new_symbol: tool.schema.string().describe("Replacement symbol"),
    reason: tool.schema.string().describe("Why this replacement is needed"),
  },
  async execute(args, context) {
    const path = resolvePath(context.worktree, args.file)
    if (!existsSync(path)) return JSON.stringify({ status: "fail", error: `File not found: ${args.file}` }, null, 2)

    const content = readFileSync(path, "utf8")
    const count = content.split(args.old_symbol).length - 1
    if (count === 0) return JSON.stringify({ status: "fail", error: "Symbol not found", hint: "Check exact spelling and casing" }, null, 2)

    const modified = content.replaceAll(args.old_symbol, args.new_symbol)
    writeFileSync(path, modified, "utf8")
    return JSON.stringify({ status: "applied", file: args.file, occurrences: count, old_symbol: args.old_symbol, new_symbol: args.new_symbol }, null, 2)
  },
})
