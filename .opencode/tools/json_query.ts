import { tool } from "@opencode-ai/plugin"
import { spawnSync } from "node:child_process"
import { resolve } from "node:path"
import { existsSync, mkdirSync, appendFileSync } from "node:fs"

export default tool({
  description: "Query JSON files using jql (Rust) — 20x faster than jq. Returns structured results. Use for roadmap queries, config inspection, artifact analysis, and any JSON exploration.",
  args: {
    query: tool.schema.string().describe("jql query expression. Examples: 'items[].status', '.agent.general-man-agent.permission.task', '.[] | select(.status==\"ready\")'"),
    file: tool.schema.string().optional().describe("JSON file to query (relative to project root). If omitted, query is applied to the provided 'json' string."),
    json: tool.schema.string().optional().describe("Inline JSON string to query. Use this instead of 'file' for small/piped JSON."),
    max_results: tool.schema.number().optional().describe("Max results to return (default 100)"),
  },
  async execute(args, context) {
    const maxResults = args.max_results ?? 100
    const jqlBinaries = ["jql", "/opt/homebrew/bin/jql", "/usr/local/bin/jql"]

    let input: string
    if (args.json) {
      input = args.json
    } else if (args.file) {
      const fullPath = resolve(context.worktree, args.file)
      if (!existsSync(fullPath)) {
        return JSON.stringify({ status: "error", error: `File not found: ${args.file}` }, null, 2)
      }
      // Read file and pipe to jql
      const result = spawnSync("cat", [fullPath], { encoding: "utf8", maxBuffer: 1024 * 1024 * 5, timeout: 10000 })
      if (result.error) return JSON.stringify({ status: "error", error: result.error.message }, null, 2)
      input = result.stdout
    } else {
      return JSON.stringify({ error: "Provide either 'file' or 'json' parameter." }, null, 2)
    }

    // Try jql binaries
    let stdout = ""
    let stderr = ""
    let used = ""
    for (const bin of jqlBinaries) {
      const result = spawnSync(bin, [args.query], {
        input, encoding: "utf8", maxBuffer: 1024 * 1024 * 5, timeout: 15000,
      })
      if (!result.error && result.status === 0) {
        stdout = result.stdout?.trim() || ""
        stderr = result.stderr?.trim() || ""
        used = bin
        break
      }
    }

    // Track binary usage
    try {
      const ad = resolve(context.worktree, "docs/json/opencode/sessions/" + context.sessionID + "/analytics")
      if (!existsSync(ad)) mkdirSync(ad, { recursive: true })
      appendFileSync(ad + "/binary_usage.v1.jsonl",
        JSON.stringify({ at: new Date().toISOString(), session_id: context.sessionID, agent: context.agent, binary: "jql", success: !!used }) + "\n", "utf8")
    } catch (_) {}

    if (!used) {
      // Pure TS fallback: parse JSON and do basic filtering
      try {
        const parsed = JSON.parse(input)
        let result = parsed
        // Simple jql-like filtering for common patterns
        if (args.query.startsWith(".") && args.query.length > 1) {
          const keys = args.query.slice(1).split(".").filter(Boolean)
          for (const key of keys) {
            if (result && typeof result === "object") result = result[key]
            else { result = null; break }
          }
        }
        if (result !== null && result !== undefined) {
          return JSON.stringify({ status: "ok", query: args.query, backend: "typescript", results: Array.isArray(result) ? result.slice(0, maxResults) : result, count: Array.isArray(result) ? result.length : 1, note: "jql not available — using basic TS property access. Install jql for full query support." }, null, 2)
        }
      } catch {}
      return JSON.stringify({ status: "error", error: "jql not found and TS fallback failed. Install with: brew install jql", hint: "jql is a fast JSON query tool (Rust, 20x faster than jq)." }, null, 2)
    }

    let parsed: any = stdout
    try { parsed = JSON.parse(stdout) } catch {}

    // Truncate large results
    let truncated = false
    if (Array.isArray(parsed) && parsed.length > maxResults) {
      parsed = parsed.slice(0, maxResults)
      truncated = true
    }

    return JSON.stringify({
      status: "ok",
      query: args.query,
      backend: used,
      results: parsed,
      count: Array.isArray(parsed) ? parsed.length : 1,
      truncated,
    }, null, 2)
  },
})
