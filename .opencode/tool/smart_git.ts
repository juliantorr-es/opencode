import { tool } from "@opencode-ai/plugin"
import { spawnSync } from "node:child_process"
import { resolve } from "node:path"
import { appendFileSync, existsSync, mkdirSync } from "node:fs"

function resolvePath(worktree: string, p: string): string {
  return resolve(worktree, p)
}
function summarize(output: string): string {
  return output.trim() || "no output"
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
  description: "Run git operations (status, diff, add, commit, push, log, branch) with structured output. Replaces all git bash commands.",
  args: {
    operation: tool.schema.string().describe("status | diff | add | commit | push | log | branch | rev-parse | stash | checkout | show"),
    args: tool.schema.string().optional().describe("Additional args passed directly to git"),
    path: tool.schema.string().optional().describe("Limit to a specific file or directory (appended as '-- <path>'). Use this to filter status/diff/log to one file instead of the whole repo."),
    files: tool.schema.string().optional().describe("JSON array of file paths for add/checkout operations"),
    message: tool.schema.string().optional().describe("Commit message (for commit operation)"),
  },
  async execute(args, context) {
    hb(context, "smart_git", "started", args.operation?.slice(0, 80) || "")
    const validOps: Record<string, string[]> = {
      status: ["status", "--porcelain"],
      diff: ["diff"],
      "diff-stat": ["diff", "--stat"],
      add: ["add"],
      commit: ["commit", "-m"],
      push: ["push"],
      log: ["log", "--oneline", "-10"],
      branch: ["branch", "--show-current"],
      "rev-parse": ["rev-parse", "HEAD"],
      stash: ["stash"],
      checkout: ["checkout"],
      show: ["show"],
    }

    if (!validOps[args.operation]) {
      hb(context, "smart_git", "failed", `unknown op: ${args.operation}`)
      return JSON.stringify({ status: "error", error: `Unknown operation: '${args.operation}'`, valid: Object.keys(validOps) }, null, 2)
    }

    // Block destructive operations
    const blockedArgs: Record<string, string[]> = {
      "push": ["--force", "-f", "--delete"],
      "checkout": ["--", "HEAD~"],
      "stash": ["drop", "clear"],
      "branch": ["-D", "--delete"],
    }
    if (blockedArgs[args.operation]) {
      const hasBlocked = blockedArgs[args.operation].some(a => (args.args || "").includes(a))
      if (hasBlocked) { hb(context, "smart_git", "blocked", `${args.operation}: ${args.args}`); return JSON.stringify({ status: "blocked", error: `Destructive git ${args.operation} blocked`, blocked_args: blockedArgs[args.operation] }, null, 2) }
    }

    const cmd = ["git", ...validOps[args.operation]]
    
    if (args.operation === "commit" && args.message) {
      cmd.push(args.message)
    }
    if (args.operation === "log" && args.args) {
      // Replace the default -10 with user args
      cmd.splice(2, 2)
      cmd.push(...args.args.split(/\s+/))
    }
    if (args.args && !["commit", "log"].includes(args.operation)) {
      cmd.push(...args.args.split(/\s+/).filter(Boolean))
    }
    if (args.path && ["status", "diff", "diff-stat", "log"].includes(args.operation)) {
      cmd.push("--", args.path)
    }
    if (args.files) {
      try {
        const files = JSON.parse(args.files)
        if (Array.isArray(files)) cmd.push(...files)
      } catch {}
    }

    const result = spawnSync(cmd[0], cmd.slice(1), {
      cwd: context.worktree,
      encoding: "utf8",
      maxBuffer: 1024 * 1024 * 2,
      timeout: 30000,
    })

    const stdout = result.stdout?.trim() || ""
    const stderr = result.stderr?.trim() || ""

    const output: Record<string, unknown> = {
      operation: args.operation,
      command: cmd.join(" "),
      exit_code: result.status,
    }

    // Parse structured output per operation
    if (args.operation === "status" && stdout) {
      const files = stdout.split("\n").map(l => {
        const status = l.slice(0, 2).trim()
        const file = l.slice(3).trim()
        const staged = l[0] !== " " 
        const unstaged = l[1] !== " "
        return { status, file, staged: staged && status, unstaged: unstaged && l[1] !== " " ? l[1] : undefined }
      })
      output.files = files
      output.staged_count = files.filter(f => f.staged).length
      output.unstaged_count = files.filter(f => f.unstaged).length
      output.untracked_count = files.filter(f => f.status === "??").length
    } else if (args.operation === "diff" && stdout) {
      const lines = stdout.split("\n")
      output.summary = `${lines.length} lines changed`
      if (lines.length > 60) {
        output.diff_head = lines.slice(0, 40).join("\n")
        output.diff_tail = lines.slice(-20).join("\n")
        output.diff_truncated = lines.length
      } else {
        output.diff = stdout
      }
    } else if (args.operation === "log" && stdout) {
      output.commits = stdout.split("\n").map(l => {
        const parts = l.split(" ")
        return { sha: parts[0], message: parts.slice(1).join(" ") }
      })
    } else if (args.operation === "rev-parse" && stdout) {
      output.sha = stdout
    } else if (args.operation === "branch") {
      output.branch = stdout
    } else if (stdout) {
      const lines = stdout.split("\n")
      if (lines.length > 30) {
        output.output_head = lines.slice(0, 20).join("\n")
        output.output_truncated = lines.length
      } else {
        output.output = stdout
      }
    }

    if (stderr) output.stderr = stderr
    if (result.error) { hb(context, "smart_git", "failed", result.error.message); output.status = "error"; output.error = result.error.message }
    else { hb(context, "smart_git", result.status === 0 ? "completed" : "failed", `${args.operation} exit=${result.status}`); output.status = result.status === 0 ? "success" : "error" }

    return JSON.stringify(output, null, 2)
  },
})
