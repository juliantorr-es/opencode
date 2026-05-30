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
  description: "Run bun operations (typecheck, test, install) and return structured results. Replaces bash for all bun commands.",
  args: {
    command: tool.schema.string().describe("typecheck | test | install | run | tsgo | tsc — the bun operation"),
    cwd: tool.schema.string().optional().describe("Working directory (e.g. 'packages/opencode'). Defaults to workspace root."),
    args: tool.schema.string().optional().describe("Additional args to pass to bun, e.g. '--filter src/storage' or a test file path"),
    timeout_seconds: tool.schema.number().optional().describe("Max execution time (default 120)"),
  },
  async execute(args, context) {
    hb(context, "smart_bun", "started", args.command?.slice(0, 80) || "")
    const cwd = args.cwd ? resolvePath(context.worktree, args.cwd) : context.worktree
    const validCommands: Record<string, string> = {
      typecheck: "run typecheck",
      test: "test",
      install: "install",
      run: "run",
      tsgo: "x tsgo",
      tsc: "x tsc",
    }
    
    const bunCmd = validCommands[args.command]
    if (!bunCmd) {
      return JSON.stringify({
        status: "error",
        error: `Unknown command: '${args.command}'`,
        valid: Object.keys(validCommands),
      }, null, 2)
    }

    const cmdArgs = [bunCmd]
    let shellMode = false
    let shellCmd = ""
    if (args.args) {
      // Detect shell operators — switch to shell mode for piping/redirection
      if (/[|><&;]/.test(args.args)) {
        shellMode = true
        // Build clean shell command — strip any duplicate bun/cmd prefix from args
        const cleanArgs = args.args
          .replace(/^bun\s+(run\s+)?/, "")  // strip leading "bun run" or "bun"
          .replace(new RegExp(`^${args.command}\\s*`), "")  // strip leading command name if duplicated
          .trim()
        shellCmd = `bun ${bunCmd} ${cleanArgs}`
      } else {
        cmdArgs.push(...args.args.split(/\s+/).filter(Boolean))
      }
    }

    const timeout = (args.timeout_seconds ?? 120) * 1000
    const startTime = Date.now()
    
    const spawnOpts: any = {
      cwd,
      encoding: "utf8",
      maxBuffer: 1024 * 1024 * 5,
      timeout,
    }
    
    const result = shellMode
      ? spawnSync(shellCmd, [], { ...spawnOpts, shell: true })
      : spawnSync("bun", cmdArgs, spawnOpts)

    const elapsed = Date.now() - startTime
    const stdout = result.stdout?.trim() || ""
    const stderr = result.stderr?.trim() || ""

    // Parse typecheck output for structured errors
    let errors: Record<string, unknown>[] = []
    let warnings: string[] = []
    let errorSummary = { files: 0, total: 0 }
    if (args.command === "typecheck" && stderr) {
      // Bun/tsgo format: "src/file.ts(12,5): error TS2345: message"
      const errorRe = /^(.+?)\((\d+),(\d+)\):\s*(error|warning)\s+(TS\d+):\s*(.+)/
      for (const line of stderr.split("\n")) {
        const trimmed = line.trim()
        const m = trimmed.match(errorRe)
        if (m) {
          errors.push({
            file: m[1],
            line: parseInt(m[2]),
            col: parseInt(m[3]),
            level: m[4],
            code: m[5],
            message: m[6],
          })
        } else if (trimmed && !trimmed.startsWith("bun") && !trimmed.startsWith("tsgo")) {
          warnings.push(trimmed)
        }
      }
      const files = new Set(errors.map((e: any) => e.file))
      errorSummary = { files: files.size, total: errors.length }
    }

    // Parse test output
    let testSummary: Record<string, unknown> = {}
    if (args.command === "test" && stdout) {
      const passMatch = stdout.match(/(\d+)\s+pass/)
      const failMatch = stdout.match(/(\d+)\s+fail/)
      const totalMatch = stdout.match(/(\d+)\s+tests/)
      if (passMatch) testSummary.pass = parseInt(passMatch[1])
      if (failMatch) testSummary.fail = parseInt(failMatch[1])
      if (totalMatch) testSummary.total = parseInt(totalMatch[1])
    }

    const output: Record<string, unknown> = {
      status: result.status === 0 ? "pass" : "fail",
      command: shellMode ? `bun ${bunCmd} ${args.args}` : `bun ${cmdArgs.join(" ")}`,
      cwd,
      elapsed_ms: elapsed,
      exit_code: result.status,
    }

    if (errors.length > 0) {
      output.errors = errors.slice(0, 30)
      output.error_summary = errorSummary
    }
    if (warnings.length > 0) output.warnings = warnings.slice(0, 10)
    if (Object.keys(testSummary).length > 0) output.test_summary = testSummary
    
    // Truncate output
    const outLines = stdout.split("\n")
    if (outLines.length > 50) {
      output.stdout_head = outLines.slice(0, 30).join("\n")
      output.stdout_tail = outLines.slice(-20).join("\n")
      output.stdout_truncated = outLines.length
    } else if (stdout) {
      output.stdout = stdout
    }
    
    if (stderr && !errors.length) {
      const errLines = stderr.split("\n")
      output.stderr = errLines.slice(0, 10).join("\n")
      if (errLines.length > 10) output.stderr_truncated = errLines.length
    }

    if (result.error) {
      output.status = "error"
      output.error = result.error.message
    }

    // Detect "Script not found" — common when cwd doesn't contain the package.json with that script
    if (result.status !== 0 && (stderr.includes("Script not found") || stderr.includes("script not found") || stderr.includes("Missing script"))) {
      output.hint = `Script "${args.command}" not found in ${cwd}/package.json. Try providing cwd to the package that defines this script (e.g. cwd: "packages/opencode"). Use smart_find(pattern="package.json") to locate package.json files.`
    }

    hb(context, "smart_bun", result.status === 0 ? "completed" : "failed", `${args.command} exit=${result.status}`)

    // Analytics
    const logDir = resolvePath(context.worktree, "docs/json/opencode/sessions/" + context.sessionID + "/analytics")
    try { if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true }) } catch (_) {}
    try {
      appendFileSync(logDir + "/smart_tool_usage.v1.jsonl",
        JSON.stringify({ at: new Date().toISOString(), session_id: context.sessionID, agent: context.agent, tool: "smart_bun", command: args.command, elapsed_ms: elapsed, exit_code: result.status }) + "\n", "utf8")
    } catch (_) {}

    return JSON.stringify(output, null, 2)
  },
})
