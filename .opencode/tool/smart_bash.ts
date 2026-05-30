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

export default tool({
  description: "Run a bash command with structured logging and automatic smart-tool rerouting. Prefer smart_bun, smart_git, smart_grep, smart_find, smart_sd, read_source — use this only for commands without a smart equivalent. This tool auto-reroutes to the right smart tool when it detects a match.",
  args: {
    command: tool.schema.string().describe("The bash command to run"),
    cwd: tool.schema.string().optional().describe("Working directory"),
    reason: tool.schema.string().describe("Why you need bash"),
    timeout_seconds: tool.schema.number().optional().describe("Max execution time (default 60)"),
  },
  async execute(args, context) {
    hb(context, "smart_bash", "started", args.reason?.slice(0, 120) || "")
    let cwd = args.cwd ? resolvePath(context.worktree, args.cwd) : context.worktree
    let cmd = args.command.trim()

    // Block destructive commands entirely
    const destructive = ["rm -rf", "git push --force", "git reset --hard", "git clean -f", "git branch -D", ":(){ :|:& };:"]
    if (destructive.some(d => cmd.includes(d))) {
      hb(context, "smart_bash", "blocked", `destructive: ${cmd.slice(0, 80)}`)
      return JSON.stringify({ status: "blocked", error: "Destructive command blocked", command: cmd.slice(0, 100) }, null, 2)
    }

    // Auto-detect cd prefix: convert "cd <dir> && <cmd>" to use cwd param
    const cdMatch = cmd.match(/^cd\s+(\S+)\s*(?:&&|;)\s*(.+)/)
    if (cdMatch) {
      const cdDir = cdMatch[1]
      const rest = cdMatch[2].trim()
      const nestedCd = rest.match(/^cd\s+(\S+)\s*(?:&&|;)\s*(.+)/)
      if (nestedCd) {
        // Handle chained cd: cd a && cd b && cmd → resolve to b relative to a then a relative to worktree
        return JSON.stringify({
          status: "hint",
          hint: "Use the cwd parameter instead of cd. Example: cwd: 'packages/opencode', command: '" + nestedCd[2].trim().slice(0, 80) + "'",
          original: cmd.slice(0, 100),
        }, null, 2)
      }
      cwd = cdDir ? resolvePath(context.worktree, cdDir) : cwd
      cmd = rest
    }

    const binary = cmd.split(/\s+/)[0]
    
    // Rerouting table: bash binary -> smart tool
    const reroutes: Record<string, { tool: string, extract: (parts: string[]) => Record<string, string> | null }> = {
      "rg":   { tool: "smart_grep",  extract: (p) => { const a = p.filter(x => !x.startsWith("-")); if (a.length < 2) return null; return { pattern: a[0]!, path: a.slice(1).join(" ") } } },
      "grep": { tool: "smart_grep",  extract: (p) => { const a = p.filter(x => !x.startsWith("-")); if (a.length < 2) return null; return { pattern: a[0]!, path: a.slice(1).join(" ") } } },
      "fd":   { tool: "smart_find",  extract: (p) => { const a = p.filter(x => !x.startsWith("-")); return { pattern: a[a.length-1] || "*", path: a.length > 1 ? a[0] : "." } } },
      "find": { tool: "smart_find",  extract: (p) => { const a = p.filter(x => !x.startsWith("-")); return { pattern: a[a.length-1] || "*", path: a.length > 1 ? a[0] : "." } } },
      "ls":   { tool: "smart_find",  extract: (p) => { const a = p.filter(x => !x.startsWith("-")); return { pattern: "*", path: a[0] || "." } } },
      "cat":  { tool: "read_source", extract: (p) => { const a = p.filter(x => !x.startsWith("-")); if (a.length === 0) return null; return { file: a.join(" ") } } },
      "git":  { tool: "smart_git",   extract: (p) => { const ops = ["status","diff","add","commit","push","log","branch","rev-parse","stash","checkout","show"]; const effective = p[0] === "-C" ? p.slice(2) : p; const op = (effective[0]||"").replace("--",""); return ops.includes(op) ? { operation: op, args: effective.slice(1).join(" ") } : null } },
      "bun":  { tool: "smart_bun",   extract: (p) => { const sub = p[0] === "run" ? p[1] : p[0]; return ["typecheck","test","install","run","tsgo","tsc"].includes(sub) ? { command: sub, args: p.slice(sub === "run" ? 2 : 1).join(" ") || undefined } : null } },
      "sd":   { tool: "smart_sd",    extract: (p) => { const a = p.filter(x => !x.startsWith("-")); if (a.length < 3) return null; return { file: a[a.length-1]!, old: a[0]!, new: a[1]!, reason: args.reason } } },
      "sed":  { tool: "smart_sd",    extract: (p) => { const a = p.filter(x => !x.startsWith("-") && !x.startsWith("'")); if (a.length < 2) return null; const file = a[a.length-1]!; const expr = a[0]!; const sMatch = expr.match(/^s([^a-z]).*\1.*\1/); if (!sMatch) return null; return { file, old: expr, new: "", reason: args.reason } } },
    }
    
    const r = reroutes[binary]
    if (r) {
      const parts = cmd.split(/\s+/).slice(1)
      const params = r.extract(parts)
      if (params) {
        hb(context, "smart_bash", "rerouted", `→ ${r.tool}`)
        return JSON.stringify({
          status: "rerouted",
          original: cmd.slice(0, 100),
          to: r.tool,
          params: params,
          hint: `Rerouted to ${r.tool}. Call ${r.tool} directly next time — it's faster and returns structured output.`,
        }, null, 2)
      }
      // Extraction failed — tell the agent why and fall through to bash
      return JSON.stringify({
        status: "reroute_failed",
        original: cmd.slice(0, 100),
        binary: binary,
        hint: `Could not convert '${binary}' command to ${r.tool} format. Running as raw bash instead. Consider calling ${r.tool} directly with the right arguments.`,
      }, null, 2)
    }
    
    const timeout = (args.timeout_seconds ?? 60) * 1000
    const startTime = Date.now()
    const result = spawnSync(args.command, [], { cwd, encoding: "utf8", maxBuffer: 1024 * 1024 * 2, timeout, shell: true })
    const elapsed = Date.now() - startTime
    const stdout = (result.stdout || "").trim()
    const stderr = (result.stderr || "").trim()
    
    const logDir = resolvePath(context.worktree, "docs/json/opencode/sessions/" + context.sessionID + "/analytics")
    try { if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true }) } catch (_) {}
    try {
      appendFileSync(logDir + "/bash_usage.v1.jsonl",
        JSON.stringify({ at: new Date().toISOString(), session_id: context.sessionID, agent: context.agent, binary, command: cmd.slice(0,200), reason: args.reason, elapsed_ms: elapsed, exit_code: result.status }) + "\n", "utf8")
    } catch (_) {}
    
    const output: any = { status: result.status === 0 ? "pass" : "fail", command: cmd.slice(0,200), elapsed_ms: elapsed }
    const lines = stdout.split("\n")
    if (lines.length > 40) { output.head = lines.slice(0,20).join("\n"); output.tail = lines.slice(-20).join("\n"); output.truncated = lines.length }
    else if (stdout) output.stdout = stdout
    if (stderr) output.stderr = stderr.slice(0, 500)
    if (result.error) { output.status = "error"; output.error = result.error.message }
    hb(context, "smart_bash", result.status === 0 ? "completed" : "failed", `${binary} exit=${result.status}`)
    return JSON.stringify(output, null, 2)
  },
})
