import { tool } from "@opencode-ai/plugin"
import { spawnSync } from "node:child_process"
import { resolve } from "node:path"

export default tool({
  description: "Codebase statistics — lines of code, files, blanks, comments by language. Powered by tokei (Rust), 100x faster than cloc. Use this to understand project structure and size at a glance.",
  args: {
    path: tool.schema.string().optional().describe("Directory to analyze. Defaults to workspace root."),
    format: tool.schema.string().optional().describe("'summary' (default, top languages), 'full' (all languages), 'json' (raw tokei JSON output)"),
    max_languages: tool.schema.number().optional().describe("Max languages in summary (default 10)"),
  },
  async execute(args, context) {
    const searchPath = args.path ? resolve(context.worktree, args.path) : context.worktree
    const binaries = ["tokei", "/opt/homebrew/bin/tokei", "/usr/local/bin/tokei"]

    let stdout = ""
    let used = ""
    for (const bin of binaries) {
      const result = spawnSync(bin, ["--output", "json", searchPath], {
        encoding: "utf8", maxBuffer: 1024 * 1024 * 5, timeout: 30000,
      })
      if (!result.error && result.status === 0) {
        stdout = result.stdout?.trim() || ""
        used = bin
        break
      }
    }

    if (!used) {
      return JSON.stringify({
        status: "error",
        error: "tokei not found. Install with: brew install tokei",
        hint: "tokei is a fast code line counter (Rust, 100x faster than cloc).",
      }, null, 2)
    }

    let raw: any
    try { raw = JSON.parse(stdout) } catch {
      return JSON.stringify({ status: "error", error: "Failed to parse tokei output" }, null, 2)
    }

    const fmt = args.format || "summary"
    const maxLang = args.max_languages ?? 10

    if (fmt === "json") {
      return JSON.stringify({ status: "ok", backend: used, ...raw }, null, 2)
    }

    // Build language summary
    const langs: any[] = []
    let totalCode = 0
    let totalFiles = 0
    let totalComments = 0
    let totalBlanks = 0

    for (const [lang, stats] of Object.entries(raw)) {
      if (lang === "Total") continue
      const s = stats as any
      const code = (s.code || 0)
      const files = (s.stats?.[0] || s.reports?.[0]?.stats?.blobs || 0) || 0
      const comments = (s.comments || 0)
      const blanks = (s.blanks || 0)
      totalCode += code
      totalFiles += files
      totalComments += comments
      totalBlanks += blanks
      langs.push({ language: lang, code, files, comments, blanks, total: code + comments + blanks })
    }

    langs.sort((a, b) => b.code - a.code)
    const top = langs.slice(0, maxLang)

    return JSON.stringify({
      status: "ok",
      backend: used,
      path: args.path || "root",
      summary: {
        languages: langs.length,
        total_code: totalCode,
        total_files: totalFiles,
        total_comments: totalComments,
        total_blanks: totalBlanks,
      },
      top_languages: top,
      all_languages: fmt === "full" ? langs : undefined,
    }, null, 2)
  },
})
