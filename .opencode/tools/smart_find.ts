import { tool } from "@opencode-ai/plugin"
import { spawnSync } from "node:child_process"
import { resolve } from "node:path"
import { statSync, appendFileSync, existsSync, mkdirSync } from "node:fs"

function resolvePath(worktree: string, p: string): string { return resolve(worktree, p) }

function hb(context: any, tool: string, phase: string, detail: string) {
  try {
    const dir = resolve(context.worktree, "docs/json/opencode/sessions/" + context.sessionID + "/analytics")
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    appendFileSync(dir + "/heartbeat.v1.jsonl",
      JSON.stringify({ at: new Date().toISOString(), session_id: context.sessionID, agent: context.agent, tool, phase, detail: detail.slice(0, 200) }) + "\n", "utf8")
  } catch (_) {}
}

function artifactLog(context: any, event: Record<string, unknown>) {
  try {
    const dir = resolve(context.worktree, `docs/json/opencode/sessions/${context.sessionID}/artifacts`)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    appendFileSync(resolve(dir, `${context.sessionID}.v1.jsonl`),
      JSON.stringify({ at: new Date().toISOString(), ...event }) + "\n", "utf8")
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

function spawnFd(args: string[], cwd: string) {
  const binaries = ["fd", "/opt/homebrew/bin/fd", "/usr/local/bin/fd"]
  for (const bin of binaries) {
    const result = spawnSync(bin, args, {
      cwd, encoding: "utf8", maxBuffer: 1024 * 1024 * 5, timeout: 15000,
    })
    if (!result.error && result.status === 0) return { result, binary: bin }
  }
  const result = spawnSync("fd", args, {
    cwd, encoding: "utf8", maxBuffer: 1024 * 1024 * 5, timeout: 15000,
  })
  return { result, binary: "fd" }
}

export default tool({
  description: "Find files and directories. Uses fd (Rust) for speed — respects .gitignore, 5-20x faster than find. Returns file info with sizes, modified times, and counts.",
  args: {
    pattern: tool.schema.string().optional().describe("Glob pattern (e.g. '*.ts', 'dialog-*'). Supports full glob syntax."),
    path: tool.schema.string().optional().describe("Directory to search. Defaults to workspace root."),
    type: tool.schema.string().optional().describe("'file', 'directory', or omit for both"),
    max_depth: tool.schema.number().optional().describe("Max directory depth (default unlimited)"),
    max_results: tool.schema.number().optional().describe("Max results (default 50)"),
    newer_than_minutes: tool.schema.number().optional().describe("Only files modified in last N minutes"),
    include_sizes: tool.schema.boolean().optional().describe("Include file sizes in bytes"),
  },
  async execute(args, context) {
    hb(context, "smart_find", "started", (args.pattern || "*").slice(0, 80))
    const searchPath = args.path ? resolvePath(context.worktree, args.path) : context.worktree
    const maxResults = args.max_results ?? 50
    const maxDepth = args.max_depth ?? 0
    const newerMin = args.newer_than_minutes ?? 0
    const includeSizes = args.include_sizes ?? false

    if (!existsSync(searchPath)) {
      hb(context, "smart_find", "failed", "path not found")
      return JSON.stringify({ files: [], count: 0, error: `Path not found: ${searchPath}` }, null, 2)
    }

    // Build fd args — the Rust find replacement, 5-20x faster
    const fdArgs = ["--strip-cwd-prefix"]
    
    if (args.type === "file") fdArgs.push("--type", "f")
    else if (args.type === "directory") fdArgs.push("--type", "d")
    
    if (maxDepth > 0) fdArgs.push("--max-depth", String(maxDepth))
    if (args.pattern) fdArgs.push("--glob", args.pattern)
    if (newerMin > 0) fdArgs.push("--changed-within", `${newerMin}m`)
    
    fdArgs.push(".") // search current dir
    fdArgs.push(searchPath)

    const startTime = Date.now()
    const { result, binary } = spawnFd(fdArgs, context.worktree)
    const elapsed = Date.now() - startTime

    // Fall back to Node.js walk if fd isn't available
    if (result.error || (result.status !== 0 && !result.stdout?.trim())) {
      hb(context, "smart_find", "failed", "fd not available")
      return JSON.stringify({
        status: "fail",
        error: "fd not found. Install with: brew install fd",
        hint: "fd is the Rust find replacement — 5-20x faster and respects .gitignore.",
        elapsed_ms: elapsed,
      }, null, 2)
    }

    const stdout = result.stdout?.trim() || ""
    if (!stdout) {
      analytics(context, "smart_find", { pattern: (args.pattern || "*").slice(0, 80), path: (args.path || "").slice(0, 80) })
      hb(context, "smart_find", "completed", (args.pattern || "*").slice(0, 80))
      artifactLog(context, { tool: "smart_find", action: "found", pattern: args.pattern || "*", results: 0 })
      return JSON.stringify({ files: [], count: 0, pattern: args.pattern || "*", elapsed_ms: elapsed, backend: binary }, null, 2)
    }

    const lines = stdout.split("\n").filter(Boolean)
    const results: any[] = []
    const byExt: Record<string, number> = {}
    let dirCount = 0

    for (let i = 0; i < Math.min(lines.length, maxResults); i++) {
      const relPath = lines[i]!
      const fullPath = resolve(searchPath, relPath)
      
      let isDir = false
      let mtime = 0
      let size = 0
      
      try {
        const st = statSync(fullPath)
        isDir = st.isDirectory()
        mtime = st.mtimeMs
        size = st.size
      } catch { continue }

      if (isDir) {
        dirCount++
        if (args.type === "file") continue
        results.push({ path: relPath, type: "directory" })
      } else {
        if (args.type === "directory") continue
        const ext = relPath.includes(".") ? "." + relPath.split(".").pop()! : "(no extension)"
        byExt[ext] = (byExt[ext] || 0) + 1

        const entry: any = { path: relPath, type: "file" }
        if (includeSizes) entry.size_bytes = size
        if (newerMin > 0) entry.modified_seconds_ago = Math.floor((Date.now() - mtime) / 1000)
        results.push(entry)
      }
    }

    const output: Record<string, unknown> = {
      status: "ok",
      files: results,
      count: results.length,
      total_found: lines.length,
      directories_found: dirCount,
      truncated: lines.length > maxResults,
      elapsed_ms: elapsed,
      backend: binary,
      command: `${binary} ${fdArgs.join(" ")}`,
    }
    if (Object.keys(byExt).length > 0) {
      output.by_extension = Object.fromEntries(
        Object.entries(byExt).sort(([, a], [, b]) => b - a).slice(0, 10)
      )
    }

    analytics(context, "smart_find", { pattern: (args.pattern || "*").slice(0, 80), path: (args.path || "").slice(0, 80) })
    hb(context, "smart_find", "completed", (args.pattern || "*").slice(0, 80))
    artifactLog(context, { tool: "smart_find", action: "found", pattern: args.pattern || "*", results: results.length })
    return JSON.stringify(output, null, 2)
  },
})
