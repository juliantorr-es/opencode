import { tool } from "@opencode-ai/plugin"
import { spawnSync } from "node:child_process"
import { resolve } from "node:path"
import { readFileSync } from "node:fs"

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

    // Track binary usage
    try {
      const ad = resolve(context.worktree, "docs/json/opencode/sessions/" + context.sessionID + "/analytics")
      if (!existsSync(ad)) mkdirSync(ad, { recursive: true })
      appendFileSync(ad + "/binary_usage.v1.jsonl",
        JSON.stringify({ at: new Date().toISOString(), session_id: context.sessionID, agent: context.agent, binary: "tokei", success: !!used }) + "\n", "utf8")
    } catch (_) {}

    if (!used) {
      // Pure TS fallback: count files by extension
      const { readdirSync, statSync } = require("fs")
      const counts: Record<string, { files: number; lines: number }> = {}
      function walk(dir: string) {
        try {
          for (const name of readdirSync(dir)) {
            const full = resolve(dir, name)
            if (name === ".git" || name === "node_modules" || name === "dist" || name === "out") continue
            try {
              const st = statSync(full)
              if (st.isDirectory()) { walk(full); continue }
              const ext = name.includes(".") ? name.split(".").pop()! : "other"
              if (!counts[ext]) counts[ext] = { files: 0, lines: 0 }
              counts[ext].files++
              try { counts[ext].lines += readFileSync(full, "utf8").split("\n").length } catch {}
            } catch {}
          }
        } catch {}
      }
      walk(searchPath)
      const sorted = Object.entries(counts).sort(([,a], [,b]) => b.lines - a.lines)
      const top = sorted.slice(0, maxLang)
      const totalLines = sorted.reduce((s, [,c]) => s + c.lines, 0)
      const totalFiles = sorted.reduce((s, [,c]) => s + c.files, 0)
      return JSON.stringify({
        status: "ok", backend: "typescript", path: args.path || "root",
        summary: { languages: sorted.length, total_code: totalLines, total_files: totalFiles },
        top_languages: top.map(([lang, c]) => ({ language: lang, code: c.lines, files: c.files })),
        note: "tokei not available — using basic TS file counter. Install tokei for accurate code/comments/blanks breakdown.",
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
