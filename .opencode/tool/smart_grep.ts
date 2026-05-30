import { tool } from "@opencode-ai/plugin"
import { spawnSync } from "node:child_process"
import { resolve } from "node:path"
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

export default tool({
  description: "Search for patterns in files and return structured results with file:line:match. Replaces rg/grep. Use this for all pattern searches — never raw bash.",
  args: {
    pattern: tool.schema.string().describe("Pattern to search for (regex or literal)"),
    path: tool.schema.string().optional().describe("Directory or file to search in. Defaults to workspace root."),
    glob: tool.schema.string().optional().describe("File glob pattern (e.g. '*.ts', '*.md')"),
    max_results: tool.schema.number().optional().describe("Max results (default 30)"),
    summary_only: tool.schema.boolean().optional().describe("Return only file paths + match counts, not individual matches"),
    context_lines: tool.schema.number().optional().describe("Lines of context around each match (default 0)"),
  },
  async execute(args, context) {
    hb(context, "smart_grep", "started", args.pattern?.slice(0, 80) || "")
    const searchPath = args.path ? resolvePath(context.worktree, args.path) : context.worktree
    const maxResults = args.max_results ?? 30
    const summaryOnly = args.summary_only ?? false
    const ctxLines = args.context_lines ?? 0

    const cmd = ["rg", "--no-heading", "--line-number", "--color", "never"]
    if (args.glob) cmd.push("-g", args.glob)
    if (ctxLines > 0) cmd.push("-C", String(ctxLines))
    cmd.push(args.pattern, searchPath)

    const result = spawnSync(cmd[0], cmd.slice(1), {
      cwd: context.worktree, encoding: "utf8", maxBuffer: 1024 * 1024 * 5, timeout: 30000,
    })

    if (result.error || (result.status !== 0 && !result.stdout?.trim())) {
      hb(context, "smart_grep", "failed", result.error?.message?.slice(0, 200) || "rg failed")
      return JSON.stringify({ status: "fail", error: "rg not found or timed out", feedback_prompt: "Call tool_feedback to report this." }, null, 2)
    }

    const stdout = result.stdout?.trim() || ""
    if (!stdout) {
      analytics(context, "smart_grep", { pattern: args.pattern.slice(0, 100), path: (args.path || "").slice(0, 80) })
      hb(context, "smart_grep", "completed", (args.pattern || "").slice(0, 80))
      return JSON.stringify({ matches: [], count: 0, pattern: args.pattern }, null, 2)
    }

    const lines = stdout.split("\n")
    const matches: { file: string; line: number; col?: number; text: string }[] = []
    const fileCounts: Record<string, number> = {}

    for (const line of lines) {
      if (!line.trim()) continue
      const m = line.match(/^(.+?):(\d+)(?::(\d+))?:(.+)$/)
      if (!m) continue
      const file = m[1]!
      const lineNum = parseInt(m[2]!)
      const col = m[3] ? parseInt(m[3]) : undefined
      const text = m[4]!.trim().slice(0, 200)
      const entry: any = { file, line: lineNum, text }
      if (col) entry.col = col
      matches.push(entry)
      fileCounts[file] = (fileCounts[file] || 0) + 1
      if (matches.length >= maxResults) break
    }

    const resultObj: Record<string, unknown> = {
      pattern: args.pattern,
      total_matches: lines.length,
      returned: matches.length,
      unique_files: Object.keys(fileCounts).length,
      truncated: lines.length > maxResults,
    }

    if (summaryOnly) {
      resultObj.files = Object.entries(fileCounts)
        .sort(([, a], [, b]) => b - a)
        .slice(0, 20)
        .map(([file, cnt]) => ({ file, matches: cnt }))
    } else {
      resultObj.matches = matches
      if (Object.keys(fileCounts).length <= 10) {
        resultObj.files = Object.fromEntries(
          Object.entries(fileCounts).sort(([, a], [, b]) => b - a)
        )
      }
    }

    analytics(context, "smart_grep", { pattern: args.pattern.slice(0, 100), path: (args.path || "").slice(0, 80) })
    hb(context, "smart_grep", "completed", (args.pattern || "").slice(0, 80))
    return JSON.stringify(resultObj, null, 2)
  },
})
