import { tool } from "@opencode-ai/plugin"
import { resolve } from "node:path"
import { statSync, readdirSync } from "node:fs"
import { appendFileSync, existsSync, mkdirSync } from "node:fs"

function resolvePath(worktree: string, p: string): string {
  return resolve(worktree, p)
}

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

function walkDir(
  dir: string,
  root: string,
  pattern: string | null,
  fileType: string | null,
  maxDepth: number,
  maxResults: number,
  newerThanMs: number,
  includeSizes: boolean,
  currentDepth: number = 0,
): any[] {
  const results: any[] = []
  if (maxDepth > 0 && currentDepth > maxDepth) return results

  let entries: string[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return results
  }

  for (const entry of entries) {
    if (results.length >= maxResults) break
    const fullPath = resolve(dir, entry.name)
    const relPath = resolve(root).relative ? 
      fullPath.slice(root.length + 1) : 
      fullPath.replace(root + "/", "")

    if (entry.isDirectory()) {
      if (fileType !== "file") {
        if (!pattern || matchGlob(entry.name, pattern)) {
          results.push({ path: relPath, type: "directory" })
        }
      }
      results.push(...walkDir(fullPath, root, pattern, fileType, maxDepth, maxResults - results.length, newerThanMs, includeSizes, currentDepth + 1))
      continue
    }

    if (fileType === "directory") continue
    if (pattern && !matchGlob(entry.name, pattern)) continue

    let mtime = 0
    let size = 0
    try {
      const st = statSync(fullPath)
      mtime = st.mtimeMs
      size = st.size
    } catch { continue }

    if (newerThanMs > 0 && Date.now() - mtime > newerThanMs) continue

    const fileEntry: any = { path: relPath, type: "file" }
    if (includeSizes) fileEntry.size_bytes = size
    if (newerThanMs > 0) fileEntry.modified_seconds_ago = Math.floor((Date.now() - mtime) / 1000)
    results.push(fileEntry)
  }

  return results
}

function matchGlob(name: string, pattern: string): boolean {
  // Simple glob matching: * matches anything, ? matches single char
  const regex = "^" + pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$"
  try {
    return new RegExp(regex).test(name)
  } catch {
    return name.includes(pattern.replace(/\*/g, ""))
  }
}

export default tool({
  description: "Find files and directories with structured results. Replaces fd/find/ls. Returns file info with sizes, modified times, and counts.",
  args: {
    pattern: tool.schema.string().optional().describe("File pattern to match (e.g. '*.ts', 'dialog-*'). Supports glob."),
    path: tool.schema.string().optional().describe("Directory to search in. Defaults to workspace root."),
    type: tool.schema.string().optional().describe("'file', 'directory', or omit for both"),
    max_depth: tool.schema.number().optional().describe("Max directory depth (default unlimited)"),
    max_results: tool.schema.number().optional().describe("Max results (default 50)"),
    newer_than_minutes: tool.schema.number().optional().describe("Only files modified in the last N minutes"),
    include_sizes: tool.schema.boolean().optional().describe("Include file sizes in bytes"),
  },
  async execute(args, context) {
    hb(context, "smart_find", "started", (args.pattern || "*").slice(0, 80))
    const searchPath = args.path ? resolvePath(context.worktree, args.path) : context.worktree
    const maxResults = args.max_results ?? 50
    const maxDepth = args.max_depth ?? 0
    const newerThanMs = (args.newer_than_minutes ?? 0) * 60 * 1000
    const includeSizes = args.include_sizes ?? false

    if (!existsSync(searchPath)) {
      hb(context, "smart_find", "failed", "path not found")
      return JSON.stringify({ files: [], count: 0, error: `Path not found: ${searchPath}` }, null, 2)
    }

    const results = walkDir(searchPath, searchPath, args.pattern || null, args.type || null, maxDepth, maxResults, newerThanMs, includeSizes)

    // Count by extension
    const byExt: Record<string, number> = {}
    let dirCount = 0
    for (const r of results) {
      if (r.type === "directory") { dirCount++; continue }
      const ext = r.path.includes(".") ? "." + r.path.split(".").pop()! : "(no extension)"
      byExt[ext] = (byExt[ext] || 0) + 1
    }

    const output: Record<string, unknown> = {
      files: results,
      count: results.length,
      directories_found: dirCount,
      truncated: results.length >= maxResults,
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
