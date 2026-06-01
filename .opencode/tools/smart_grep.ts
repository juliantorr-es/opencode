import { init, heartbeat, logToolUsage } from "./db"
import { tool } from "@opencode-ai/plugin"
import { resolve, relative } from "node:path"
import { readdirSync, readFileSync, statSync, appendFileSync, existsSync, mkdirSync } from "node:fs"

function r(worktree: string, p: string): string { return resolve(worktree, p) }



// ── .gitignore ─────────────────────────────────────────────
function loadGitignore(worktree: string): { ignored: (p: string) => boolean } {
  const patterns: { pattern: string; negate: boolean }[] = []
  const giPath = r(worktree, ".gitignore")
  if (existsSync(giPath)) {
    try {
      for (const line of readFileSync(giPath, "utf8").split("\n")) {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith("#")) continue
        patterns.push({ pattern: trimmed.startsWith("!") ? trimmed.slice(1) : trimmed, negate: trimmed.startsWith("!") })
      }
    } catch {}
  }
  patterns.push({ pattern: ".git", negate: false })
  return {
    ignored(p: string): boolean {
      let result = false
      for (const { pattern, negate } of patterns) {
        if (matchGitignore(pattern, p)) result = !negate
      }
      return result
    }
  }
}

function matchGitignore(pattern: string, path: string): boolean {
  let re = pattern.replace(/\./g, "\\.").replace(/\*\*/g, "§§R§§").replace(/\*/g, "[^/]*").replace(/§§R§§/g, ".*").replace(/\?/g, ".")
  if (!pattern.includes("/") && !pattern.startsWith("**/")) re = "(^|.*/)" + re + "$"
  else {
    if (re.startsWith("/")) re = "^" + re.slice(1); else re = "(^|.*/)" + re
    if (!re.endsWith("$")) re += "(/.*)?$"
  }
  try { return new RegExp(re).test(path) } catch { return false }
}

// ── Glob match ─────────────────────────────────────────────
function matchGlob(pattern: string, name: string): boolean {
  let re = "^"
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] === "*" && pattern[i+1] === "*") { re += ".*"; i++; continue }
    if (pattern[i] === "*") { re += "[^/]*"; continue }
    if (pattern[i] === "?") { re += "."; continue }
    if (".+^${}()|[]\\".includes(pattern[i]!)) { re += "\\" + pattern[i]; continue }
    re += pattern[i]
  }
  re += "$"
  try { return new RegExp(re).test(name) } catch { return false }
}

// ── Collect files ──────────────────────────────────────────
function collectFiles(
  dir: string, base: string, ignored: (p: string) => boolean,
  glob: string | undefined, maxResults: number, results: string[]
): void {
  if (results.length >= maxResults) return
  let entries: string[]
  try { entries = readdirSync(dir) } catch { return }
  for (const name of entries) {
    if (results.length >= maxResults) break
    const full = resolve(dir, name)
    const rel = relative(base, full)
    if (ignored(rel) || ignored(rel + "/")) continue
    try {
      const st = statSync(full)
      if (st.isDirectory()) {
        collectFiles(full, base, ignored, glob, maxResults, results)
      } else if (!glob || matchGlob(glob, name)) {
        // Quick check: is this a text file? Skip binaries
        if (st.size > 1024 * 1024) continue // skip files >1MB
        results.push(full)
      }
    } catch {}
  }
}

function isTextFile(path: string): boolean {
  try {
    const buf = readFileSync(path, { length: 512 })
    // Check for null bytes (binary indicator)
    for (let i = 0; i < buf.length; i++) {
      if (buf[i] === 0) return false
    }
    return true
  } catch { return false }
}

export default tool({
  description: "Search for patterns in files. Pure TypeScript — no binary dependency. Returns structured file:line:match results. Respects .gitignore.",
  args: {
    pattern: tool.schema.string().describe("Pattern to search for (regex or literal)"),
    path: tool.schema.string().optional().describe("Directory or file to search. Defaults to workspace root."),
    glob: tool.schema.string().optional().describe("File glob pattern (e.g. '*.ts', '*.md')"),
    max_results: tool.schema.number().optional().describe("Max results (default 30)"),
    summary_only: tool.schema.boolean().optional().describe("Return only file paths + match counts, not individual matches"),
    context_lines: tool.schema.number().optional().describe("Lines of context around each match (default 0)"),
    word_boundary: tool.schema.boolean().optional().describe("Match whole words only (adds \\b around pattern)"),
  },
  async execute(args, context) {
    const db = init(context.worktree)
    heartbeat(db, context.sessionID, context.agent, "smart_grep", "started", args.pattern?.slice(0, 80) || "")
    const searchPath = args.path ? r(context.worktree, args.path) : context.worktree
    const maxResults = args.max_results ?? 30
    const ctxLines = args.context_lines ?? 0
    const summaryOnly = args.summary_only ?? false

    if (!existsSync(searchPath)) {
      return JSON.stringify({ matches: [], count: 0, error: `Path not found: ${searchPath}` }, null, 2)
    }

    // Build regex
    let regex: RegExp
    try {
      const p = args.word_boundary ? `\\b${args.pattern}\\b` : args.pattern
      regex = new RegExp(p, "g")
    } catch {
      return JSON.stringify({ status: "error", error: `Invalid regex pattern: ${args.pattern}` }, null, 2)
    }

    // Collect files
    const gitignore = loadGitignore(context.worktree)
    const files: string[] = []

    const startTime = Date.now()
    const st = statSync(searchPath)
    if (st.isFile()) {
      if (isTextFile(searchPath)) files.push(searchPath)
    } else {
      collectFiles(searchPath, searchPath, gitignore.ignored, args.glob, 500, files)
    }

    // Search files
    const matches: { file: string; line: number; col?: number; text: string }[] = []
    const fileCounts: Record<string, number> = {}
    let totalHits = 0
    let searchedFiles = 0

    for (const file of files) {
      if (matches.length >= maxResults && !summaryOnly) break
      if (!isTextFile(file)) continue
      searchedFiles++

      try {
        const content = readFileSync(file, "utf8")
        const lines = content.split("\n")
        const relPath = relative(context.worktree, file)
        let fileHits = 0

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i]!
          regex.lastIndex = 0
          let m: RegExpExecArray | null
          while ((m = regex.exec(line)) !== null) {
            totalHits++
            fileHits++
            const text = line.slice(Math.max(0, m.index - 40), m.index + m[0].length + 40).trim()
            if (!summaryOnly && matches.length < maxResults) {
              matches.push({ file: relPath, line: i + 1, col: m.index + 1, text: text.slice(0, 200) })
            }
            if (matches.length >= maxResults && !summaryOnly) break
          }
          if (matches.length >= maxResults && !summaryOnly) break
        }

        if (fileHits > 0) fileCounts[relPath] = fileHits
      } catch {}
    }

    const elapsed = Date.now() - startTime

    // ── Build clean output ──
    if (totalHits === 0) {
      const result = {
        status: "🔍 NO MATCHES",
        pattern: args.pattern,
        searched: `${searchedFiles} files`,
        elapsed_ms: elapsed,
        hint: "No files matched. Try a different pattern, check the path, or widen the glob.",
      }
      analytics(context, "smart_grep", { pattern: args.pattern.slice(0, 100), path: (args.path || "").slice(0, 80) })
      heartbeat(db, context.sessionID, context.agent, "smart_grep", "completed", `0 matches in ${searchedFiles} files`)
      return JSON.stringify(result, null, 2)
    }

    if (summaryOnly) {
      const result = {
        status: `✅ ${totalHits} matches in ${Object.keys(fileCounts).length} files`,
        pattern: args.pattern,
        elapsed_ms: elapsed,
        files: Object.entries(fileCounts)
          .sort(([, a], [, b]) => b - a)
          .slice(0, 20)
          .map(([file, cnt]) => `${file} (${cnt})`),
      }
      analytics(context, "smart_grep", { pattern: args.pattern.slice(0, 100), path: (args.path || "").slice(0, 80) })
      heartbeat(db, context.sessionID, context.agent, "smart_grep", "completed", `${totalHits} matches in ${Object.keys(fileCounts).length} files`)
      return JSON.stringify(result, null, 2)
    }

    const result = {
      status: `✅ ${matches.length} matches shown (${totalHits} total in ${Object.keys(fileCounts).length} files)`,
      pattern: args.pattern,
      elapsed_ms: elapsed,
      matches: matches.map(m => `${m.file}:${m.line} — ${m.text}`),
      truncated: totalHits > maxResults ? `${totalHits - matches.length} more not shown` : undefined,
    }

    analytics(context, "smart_grep", { pattern: args.pattern.slice(0, 100), path: (args.path || "").slice(0, 80) })
    heartbeat(db, context.sessionID, context.agent, "smart_grep", totalHits > 0 ? "completed" : "completed", `${totalHits} matches in ${searchedFiles} files`)
    return JSON.stringify(result, null, 2)
  },
})
