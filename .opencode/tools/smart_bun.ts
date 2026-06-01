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

      // Log typecheck results to analytics
      try {
        const logDir = resolvePath(context.worktree, "docs/json/opencode/sessions/" + context.sessionID + "/analytics")
        if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true })
        appendFileSync(logDir + "/typecheck_results.v1.jsonl",
          JSON.stringify({
            at: new Date().toISOString(), session_id: context.sessionID, agent: context.agent,
            command: args.command, cwd: args.cwd || "root", elapsed_ms: elapsed,
            exit_code: result.status, error_count: errors.length, file_count: files.size,
            errors: errors.slice(0, 50),
          }) + "\n", "utf8")
      } catch (_) {}
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
      
      // Extract individual test names AND failure details from output
      const testLines = stdout.split("\n")
      const passed: string[] = []
      const failed: { name: string; details: string[] }[] = []
      let currentFailure: { name: string; details: string[] } | null = null
      for (const line of testLines) {
        const pf = line.match(/^\s*(✓|✗)\s+(.+?)\s+\[([\d.]+)(m?s)\]/)
        if (pf) {
          if (currentFailure) failed.push(currentFailure)
          currentFailure = null
          if (pf[1] === "✓") {
            passed.push(pf[2]!.trim())
          } else {
            currentFailure = { name: pf[2]!.trim(), details: [] }
          }
        } else if (currentFailure && line.trim()) {
          currentFailure.details.push(line.trimEnd())
        }
      }
      if (currentFailure) failed.push(currentFailure)

      if (passed.length > 0) testSummary.passed_tests = passed.slice(0, 20)
      if (failed.length > 0) {
        testSummary.failed_tests = failed.map(f => f.name).slice(0, 20)
        testSummary.failure_details = failed.slice(0, 10).map(f => ({
          test: f.name,
          error: f.details.slice(0, 8).join("\n").slice(0, 500),
        }))
      }

      // Log test results to analytics
      try {
        const logDir = resolvePath(context.worktree, "docs/json/opencode/sessions/" + context.sessionID + "/analytics")
        if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true })
        appendFileSync(logDir + "/test_results.v1.jsonl",
          JSON.stringify({
            at: new Date().toISOString(), session_id: context.sessionID, agent: context.agent,
            command: args.command, cwd: args.cwd || "root", elapsed_ms: elapsed,
            pass: testSummary.pass || 0, fail: testSummary.fail || 0, total: testSummary.total || 0,
            passed_tests: passed, failed_tests: failed.map(f => f.name),
          }) + "\n", "utf8")
      } catch (_) {}
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

    const output: Record<string, unknown> = {}

    // ── Typecheck ──
    if (args.command === "typecheck") {
      if (result.status === 0) {
        output.status = "✅ PASS"
        output.message = "Typecheck passed. No errors. You're good."
        output.elapsed_ms = elapsed
      } else if (errors.length > 0) {
        output.status = "❌ FAIL"
        output.message = `${errors.length} type errors in ${errorSummary.files} files`
        output.elapsed_ms = elapsed
        output.errors = errors.slice(0, 15).map((e: any) => `${e.file}:${e.line}:${e.col} — ${e.message}`)
        if (errors.length > 15) output.truncated = `${errors.length - 15} more errors not shown`
        if (fallbackNote) output.note = fallbackNote
      } else {
        output.status = "💥 TOOL ERROR"
        output.message = `Typecheck command failed (exit ${result.status}). The typecheck script may not exist in ${cwd}.`
        output.hint = "Check package.json scripts or try: smart_bun(command=\"tsgo\", cwd=\"...\")"
      }
    }

    // ── Test ──
    else if (args.command === "test") {
      if (result.status === 0 && testSummary.fail === 0) {
        output.status = "✅ PASS"
        output.message = `All ${testSummary.total || testSummary.pass || "?"} tests passed`
        output.elapsed_ms = elapsed
      } else if (testSummary.fail > 0) {
        output.status = "❌ FAIL"
        output.message = `${testSummary.pass || 0} pass, ${testSummary.fail} fail, ${testSummary.total || "?"} total`
        output.elapsed_ms = elapsed
        if (testSummary.failed_tests) output.failed = testSummary.failed_tests
        if (testSummary.failure_details) output.failure_details = testSummary.failure_details
      } else if (result.status !== 0) {
        output.status = "💥 TOOL ERROR"
        output.message = `Test command failed (exit ${result.status}). The test script may not exist.`
        if (stderr) output.stderr = stderr.slice(0, 300)
      }
    }

    // ── Other commands (install, run) ──
    else {
      output.status = result.status === 0 ? "✅ OK" : "❌ FAIL"
      output.message = result.status === 0 ? `Command completed in ${elapsed}ms` : `Command failed with exit ${result.status}`
      output.elapsed_ms = elapsed
      if (stdout) output.output = stdout.slice(0, 500)
      if (stderr) output.stderr = stderr.slice(0, 300)
    }

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

    // Final analytics: log typecheck and test results regardless of code path
    try {
      const logDir = resolvePath(context.worktree, "docs/json/opencode/sessions/" + context.sessionID + "/analytics")
      if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true })
      if (args.command === "typecheck" && (errors.length > 0 || result.status === 0)) {
        appendFileSync(logDir + "/typecheck_results.v1.jsonl",
          JSON.stringify({ at: new Date().toISOString(), session_id: context.sessionID, agent: context.agent, exit_code: result.status, error_count: errors.length, file_count: errorSummary.files, elapsed_ms: elapsed, fallback: !!fallbackNote }) + "\n", "utf8")
      }
      if (args.command === "test" && Object.keys(testSummary).length > 0) {
        appendFileSync(logDir + "/test_results.v1.jsonl",
          JSON.stringify({ at: new Date().toISOString(), session_id: context.sessionID, agent: context.agent, cwd: args.cwd || "root", elapsed_ms: elapsed, pass: testSummary.pass || 0, fail: testSummary.fail || 0, total: testSummary.total || 0 }) + "\n", "utf8")
      }
    } catch (_) {}

    return JSON.stringify(output, null, 2)
  },
})
