import { tool } from "@opencode-ai/plugin"
import { resolve, relative, basename } from "node:path"
import { statSync, readdirSync, readFileSync, appendFileSync, existsSync, mkdirSync } from "node:fs"

function r(worktree: string, p: string): string { return resolve(worktree, p) }

function hb(context: any, tool: string, phase: string, detail: string) {
  try {
    const dir = resolve(context.worktree, "docs/json/opencode/sessions/" + context.sessionID + "/analytics")
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    appendFileSync(dir + "/heartbeat.v1.jsonl",
      JSON.stringify({ at: new Date().toISOString(), session_id: context.sessionID, agent: context.agent, tool, phase, detail: detail.slice(0, 200) }) + "\n", "utf8")
  } catch (_) {}
}

function analytics(context: any, tool: string, extra: Record<string, unknown>) {
  try {
    const dir = resolve(context.worktree, "docs/json/opencode/sessions/" + context.sessionID + "/analytics")
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    appendFileSync(dir + "/smart_tool_usage.v1.jsonl",
      JSON.stringify({ at: new Date().toISOString(), session_id: context.sessionID, agent: context.agent, tool, ...extra }) + "\n", "utf8")
  } catch (_) {}
}

// ── .gitignore parser ──────────────────────────────────────
function loadGitignore(worktree: string): { ignored: (p: string) => boolean } {
  const patterns: { pattern: string; negate: boolean }[] = []
  const giPath = r(worktree, ".gitignore")
  if (existsSync(giPath)) {
    try {
      for (const line of readFileSync(giPath, "utf8").split("\n")) {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith("#")) continue
        const negate = trimmed.startsWith("!")
        patterns.push({ pattern: negate ? trimmed.slice(1) : trimmed, negate })
      }
    } catch {}
  }
  // Always ignore .git
  patterns.push({ pattern: ".git", negate: false })
  return {
    ignored(p: string): boolean {
      let ignored = false
      for (const { pattern, negate } of patterns) {
        if (matchGitignore(pattern, p)) ignored = !negate
      }
      return ignored
    }
  }
}

function matchGitignore(pattern: string, path: string): boolean {
  // Convert gitignore pattern to regex
  let re = pattern
    .replace(/\./g, "\\.")
    .replace(/\*\*/g, "§§RECURSIVE§§")
    .replace(/\*/g, "[^/]*")
    .replace(/§§RECURSIVE§§/g, ".*")
    .replace(/\?/g, ".")
  // If pattern doesn't contain /, match at any level
  if (!pattern.includes("/") && !pattern.startsWith("**/")) {
    re = "(^|.*/)" + re + "$"
  } else {
    if (re.startsWith("/")) re = "^" + re.slice(1)
    else re = "(^|.*/)" + re
    if (!re.endsWith("$")) re += "(/.*)?$"
  }
  try {
    return new RegExp(re).test(path)
  } catch {
    return false
  }
}

// ── Glob matcher ───────────────────────────────────────────
function matchGlob(pattern: string, name: string): boolean {
  let re = "^"
  let i = 0
  while (i < pattern.length) {
    if (pattern[i] === "*" && pattern[i+1] === "*") { re += ".*"; i += 2; continue }
    if (pattern[i] === "*") { re += "[^/]*"; i++; continue }
    if (pattern[i] === "?") { re += "."; i++; continue }
    if (".+^${}()|[]\\".includes(pattern[i]!)) { re += "\\" + pattern[i]; i++; continue }
    re += pattern[i]; i++
  }
  re += "$"
  try { return new RegExp(re).test(name) } catch { return false }
}

// ── File walker ────────────────────────────────────────────
interface WalkEntry {
  path: string
  relPath: string
  isDir: boolean
  size: number
  mtimeMs: number
}

function walk(
  dir: string, base: string, ignored: (p: string) => boolean,
  pattern: string | undefined, type: string | undefined,
  maxDepth: number, depth: number, maxResults: number,
  newerMin: number, results: WalkEntry[]
): void {
  if (results.length >= maxResults) return
  if (maxDepth > 0 && depth > maxDepth) return

  let entries: string[]
  try { entries = readdirSync(dir) } catch { return }

  for (const name of entries) {
    if (results.length >= maxResults) break
    const full = resolve(dir, name)
    const rel = relative(base, full)

    // Skip gitignored
    if (ignored(rel) || ignored(rel + "/")) continue

    let isDir = false
    let size = 0
    let mtimeMs = 0
    try {
      const st = statSync(full)
      isDir = st.isDirectory()
      size = st.size
      mtimeMs = st.mtimeMs
    } catch { continue }

    // Newer-than filter
    if (newerMin > 0) {
      const ageMs = Date.now() - mtimeMs
      if (ageMs > newerMin * 60000) continue
    }

    if (isDir) {
      if (type !== "file") {
        if (!pattern || matchGlob(pattern, name)) {
          results.push({ path: full, relPath: rel, isDir: true, size: 0, mtimeMs })
          if (results.length >= maxResults) break
        }
      }
      walk(full, base, ignored, pattern, type, maxDepth, depth + 1, maxResults, newerMin, results)
    } else {
      if (type !== "directory") {
        if (!pattern || matchGlob(pattern, name)) {
          results.push({ path: full, relPath: rel, isDir: false, size, mtimeMs })
        }
      }
    }
  }
}

export default tool({
  description: "Find files and directories. Pure TypeScript — no binary dependency. Respects .gitignore. Returns file info with sizes, modified times, and counts.",
  args: {
    pattern: tool.schema.string().optional().describe("Glob pattern (e.g. '*.ts', 'dialog-*'). Supports wildcards."),
    path: tool.schema.string().optional().describe("Directory to search. Defaults to workspace root."),
    type: tool.schema.string().optional().describe("'file', 'directory', or omit for both"),
    max_depth: tool.schema.number().optional().describe("Max directory depth (default unlimited)"),
    max_results: tool.schema.number().optional().describe("Max results (default 50)"),
    newer_than_minutes: tool.schema.number().optional().describe("Only files modified in last N minutes"),
    include_sizes: tool.schema.boolean().optional().describe("Include file sizes in bytes"),
  },
  async execute(args, context) {
    hb(context, "smart_find", "started", (args.pattern || "*").slice(0, 80))
    const searchPath = args.path ? r(context.worktree, args.path) : context.worktree
    const maxResults = args.max_results ?? 50
    const maxDepth = args.max_depth ?? 0
    const newerMin = args.newer_than_minutes ?? 0
    const includeSizes = args.include_sizes ?? false

    if (!existsSync(searchPath)) {
      hb(context, "smart_find", "failed", "path not found")
      return JSON.stringify({ files: [], count: 0, error: `Path not found: ${searchPath}` }, null, 2)
    }

    const gitignore = loadGitignore(context.worktree)
    const results: WalkEntry[] = []

    const startTime = Date.now()
    walk(searchPath, searchPath, gitignore.ignored, args.pattern, args.type, maxDepth, 0, maxResults, newerMin, results)
    const elapsed = Date.now() - startTime

    const files: any[] = []
    const byExt: Record<string, number> = {}
    let dirCount = 0

    for (const entry of results.slice(0, maxResults)) {
      if (entry.isDir) {
        dirCount++
        files.push({ path: entry.relPath, type: "directory" })
      } else {
        const ext = entry.relPath.includes(".") ? "." + entry.relPath.split(".").pop()! : "(no extension)"
        byExt[ext] = (byExt[ext] || 0) + 1
        const f: any = { path: entry.relPath, type: "file" }
        if (includeSizes) f.size_bytes = entry.size
        if (newerMin > 0) f.modified_seconds_ago = Math.floor((Date.now() - entry.mtimeMs) / 1000)
        files.push(f)
      }
    }

    const output: Record<string, unknown> = {
      status: "ok",
      files,
      count: files.length,
      total_found: results.length,
      directories_found: dirCount,
      truncated: results.length > maxResults,
      elapsed_ms: elapsed,
      backend: "typescript",
    }
    if (Object.keys(byExt).length > 0) {
      output.by_extension = Object.fromEntries(
        Object.entries(byExt).sort(([, a], [, b]) => b - a).slice(0, 10)
      )
    }

    analytics(context, "smart_find", { pattern: (args.pattern || "*").slice(0, 80), path: (args.path || "").slice(0, 80) })
    hb(context, "smart_find", "completed", (args.pattern || "*").slice(0, 80))
    return JSON.stringify(output, null, 2)
  },
})
