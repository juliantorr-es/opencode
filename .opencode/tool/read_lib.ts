import { tool } from "@opencode-ai/plugin"
import { resolve } from "node:path"
import { existsSync, readFileSync } from "node:fs"

function resolvePath(worktree: string, p: string): string { return resolve(worktree, p) }

export default tool({
  description: "Read a library type definition or source file from node_modules. Use this to check actual API signatures before writing code that depends on them.",
  args: {
    package: tool.schema.string().describe("Package name (e.g. 'effect', '@opencode-ai/plugin')"),
    file: tool.schema.string().optional().describe("File within the package (e.g. 'Layer.d.ts', 'Semaphore.d.ts')"),
    symbol: tool.schema.string().optional().describe("Specific symbol to look up (e.g. 'provideMerge', 'withPermit')"),
  },
  async execute(args, context) {
    let pkgPath = resolvePath(context.worktree, `node_modules/${args.package}`)
    if (!existsSync(pkgPath)) {
      // Try parent node_modules
      pkgPath = resolvePath(context.worktree, `../../node_modules/${args.package}`)
    }
    if (!existsSync(pkgPath)) return JSON.stringify({ status: "not_found", package: args.package, hint: "Package not found in node_modules" }, null, 2)

    let filePath = args.file ? resolve(pkgPath, args.file) : resolve(pkgPath, "package.json")
    if (!existsSync(filePath)) {
      // Try common paths
      const candidates = [resolve(pkgPath, "dist", args.file || ""), resolve(pkgPath, "src", args.file || "")]
      for (const c of candidates) { if (existsSync(c)) { filePath = c; break } }
    }
    if (!existsSync(filePath)) return JSON.stringify({ status: "not_found", package: args.package, file: args.file, hint: "File not found — check the exact path" }, null, 2)

    const content = readFileSync(filePath, "utf8")
    if (args.symbol) {
      // Search for the symbol
      const lines = content.split("\n")
      const matches: string[] = []
      for (let i = 0; i < lines.length; i++) {
        if (lines[i]!.includes(args.symbol)) {
          const start = Math.max(0, i - 2)
          const end = Math.min(lines.length, i + 5)
          matches.push(lines.slice(start, end).map((l, j) => `${start + j + 1}: ${l}`).join("\n"))
          if (matches.length >= 3) break
        }
      }
      return JSON.stringify({ status: "found", package: args.package, file: args.file, symbol: args.symbol, matches, match_count: matches.length }, null, 2)
    }

    return JSON.stringify({ status: "loaded", package: args.package, file: args.file, content_preview: content.slice(0, 2000), size_bytes: content.length }, null, 2)
  },
})
