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

function artifactLog(context: any, event: Record<string, unknown>) {
  try {
    const dir = resolve(context.worktree, `docs/json/opencode/sessions/${context.sessionID}/artifacts`)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    appendFileSync(resolve(dir, `${context.sessionID}.v1.jsonl`),
      JSON.stringify({ at: new Date().toISOString(), ...event }) + "\n", "utf8")
  } catch (_) {}
}

export default tool({
  description: "Run bun operations (typecheck, test, install) and return structured results. Replaces bash for all bun commands.",
  args: {
    command: tool.schema.string().describe("typecheck | test | install | run | tsgo | tsc | solidjs-test — the bun operation"),
    cwd: tool.schema.string().optional().describe("Working directory (e.g. 'packages/opencode'). Defaults to workspace root."),
    args: tool.schema.string().optional().describe("Additional args to pass to bun, e.g. '--filter src/storage' or a test file path"),
    timeout_seconds: tool.schema.number().optional().describe("Max execution time (default 120)"),
    test_pattern: tool.schema.string().optional().describe("Test name pattern to filter (maps to --test-name-pattern)"),
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
      "solidjs-test": "test --conditions=browser",
    }
    
    const bunCmd = validCommands[args.command]
    if (!bunCmd) {
      return JSON.stringify({
        status: "error",
        error: `Unknown command: '${args.command}'`,
        valid: Object.keys(validCommands),
        hint: "For SolidJS projects, use command: 'solidjs-test' to auto-configure --conditions=browser",
      }, null, 2)
    }

    // Split multi-word commands (e.g. "run typecheck" → ["run", "typecheck"])
    const cmdArgs = bunCmd.split(/\s+/)
    let shellMode = false
    let shellCmd = ""
    if (args.command === "test" && args.test_pattern) {
      cmdArgs.push("--test-name-pattern", args.test_pattern)
    }
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

    // Parse test output — extract pass/fail counts AND test names
    let testSummary: Record<string, unknown> = {}
    if (args.command === "test" && stdout) {
      const passMatch = stdout.match(/(\d+)\s+pass/)
      const failMatch = stdout.match(/(\d+)\s+fail/)
      const totalMatch = stdout.match(/(\d+)\s+tests/)
      if (passMatch) testSummary.pass = parseInt(passMatch[1])
      if (failMatch) testSummary.fail = parseInt(failMatch[1])
      if (totalMatch) testSummary.total = parseInt(totalMatch[1])
      
      // Extract individual test names from output
      const testLines = stdout.split("\n")
      const passed: string[] = []
      const failed: string[] = []
      for (const line of testLines) {
        const pf = line.match(/^\s*(✓|✗)\s+(.+?)\s+\[([\d.]+)(m?s)\]/)
        if (pf) {
          if (pf[1] === "✓") passed.push(pf[2]!.trim())
          else failed.push(pf[2]!.trim())
        }
      }
      if (passed.length > 0) testSummary.passed_tests = passed.slice(0, 20)
      if (failed.length > 0) testSummary.failed_tests = failed.slice(0, 20)
    }

    // Fallback: if typecheck script not found, try bun x tsgo --noEmit directly
    let fallbackNote = ""
    if (args.command === "typecheck" && result.status !== 0 && (stderr.includes("Script not found") || stderr.includes("script not found") || stderr.includes("Missing script"))) {
      const fbResult = spawnSync("bun", ["x", "tsgo", "--noEmit"], spawnOpts)
      if (fbResult.stdout?.trim() || (fbResult.stderr?.trim() && fbResult.stderr.includes("error TS"))) {
        // Replace result with tsgo fallback
        fallbackNote = `bun run typecheck not found in ${cwd}/package.json. Fell back to bun x tsgo --noEmit.`
        errors = []
        warnings = []
        const fbStderr = fbResult.stderr?.trim() || ""
        const errorRe = /^(.+?)\((\d+),(\d+)\):\s*(error|warning)\s+(TS\d+):\s*(.+)/
        for (const line of fbStderr.split("\n")) {
          const m = line.trim().match(errorRe)
          if (m) {
            errors.push({ file: m[1]!, line: parseInt(m[2]!), col: parseInt(m[3]!), level: m[4]!, code: m[5]!, message: m[6]! })
          } else if (line.trim() && !line.startsWith("bun") && !line.startsWith("tsgo")) {
            warnings.push(line.trim())
          }
        }
        const files = new Set(errors.map((e: any) => e.file))
        errorSummary = { files: files.size, total: errors.length }
        // Use fallback result
        Object.assign(result, { status: fbResult.status, stdout: fbResult.stdout, stderr: fbResult.stderr })
      }
    }

    const output: Record<string, unknown> = {
      command: shellMode ? `bun ${bunCmd} ${args.args}` : `bun ${cmdArgs.join(" ")}`,
      cwd,
      elapsed_ms: elapsed,
      exit_code: result.status,
    }

    // Distinguish typecheck-found-errors (exit 1) from tool failure (exit 2+)
    if (args.command === "typecheck" && result.status === 1 && errors.length > 0) {
      output.status = "type_errors_found"
      output.type_errors = errors.slice(0, 30)
      output.error_summary = errorSummary
      output.note = `Typecheck found ${errorSummary.total} errors in ${errorSummary.files} files. This is expected during development — fix these errors to get exit_code 0.`
    } else if (args.command === "typecheck" && result.status === 0) {
      output.status = "pass"
      output.note = "Typecheck passed — no errors."
    } else if (args.command === "run" && result.status === 2) {
      output.status = "fail"
      output.hint = `bun run failed with exit 2. The script may not exist, or no package.json with scripts was found in ${cwd}. Check available scripts with: smart_find(pattern="package.json") then read_source on the relevant file.`
    } else if (result.status === 0) {
      output.status = "pass"
    } else {
      output.status = "fail"
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

    if (fallbackNote) output.fallback_note = fallbackNote

    // Heartbeat: only mark as failed if tool itself broke, not if typecheck found errors
    const isToolFailure = result.error || (result.status !== 0 && !(args.command === "typecheck" && errors.length > 0))
    hb(context, "smart_bun", isToolFailure ? "failed" : "completed", `${args.command} exit=${result.status}`)

    // Analytics
    const logDir = resolvePath(context.worktree, "docs/json/opencode/sessions/" + context.sessionID + "/analytics")
    try { if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true }) } catch (_) {}
    try {
      appendFileSync(logDir + "/smart_tool_usage.v1.jsonl",
        JSON.stringify({ at: new Date().toISOString(), session_id: context.sessionID, agent: context.agent, tool: "smart_bun", command: args.command, elapsed_ms: elapsed, exit_code: result.status }) + "\n", "utf8")
    } catch (_) {}

    artifactLog(context, { tool: "smart_bun", action: "ran", command: args.command, exit_code: result.status, cwd: args.cwd || "root" })
    return JSON.stringify(output, null, 2)
  },
})
