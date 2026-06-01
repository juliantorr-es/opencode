import { tool } from "@opencode-ai/plugin"
import { spawnSync } from "node:child_process"
import { resolve } from "node:path"
import { existsSync, mkdirSync } from "node:fs"
import { init, heartbeat, logToolUsage, logTypecheck, logTestResults } from "./db"

function resolvePath(worktree: string, p: string): string { return resolve(worktree, p) }

export default tool({
  description: "Run bun operations (typecheck, test, install) and return structured results. Uses SQLite for analytics.",
  args: {
    command: tool.schema.string().describe("typecheck | test | install | run | tsgo | tsc"),
    cwd: tool.schema.string().optional().describe("Working directory (e.g. 'packages/opencode')."),
    args: tool.schema.string().optional().describe("Additional args (e.g. test file path)."),
    timeout_seconds: tool.schema.number().optional().describe("Max execution time (default 120)."),
  },
  async execute(args, context) {
    const db = init(context.worktree)
    heartbeat(db, context.sessionID, context.agent, "smart_bun", "started", args.command?.slice(0, 80) || "")
    const cwd = args.cwd ? resolvePath(context.worktree, args.cwd) : context.worktree

    // Detect package.json for test/typecheck script fallback
    const pkgPath = resolve(cwd, "package.json")
    let shellMode = false
    let shellCmd = ""
    if (args.command === "test" || args.command === "typecheck") {
      if (existsSync(pkgPath)) {
        try {
          const pkg = JSON.parse(require("fs").readFileSync(pkgPath, "utf8"))
          if (pkg.scripts?.[args.command]) {
            shellMode = true
            shellCmd = `bun run ${args.command}`
          }
        } catch {}
      }
    }

    const cmdArgs = shellMode ? [] : [args.command, ...(args.args ? args.args.split(/\s+/) : [])]
    const spawnOpts = { cwd, encoding: "utf8" as const, maxBuffer: 1024 * 1024 * 4, timeout: (args.timeout_seconds ?? 120) * 1000 }
    const startTime = Date.now()

    const result = shellMode
      ? spawnSync("bun", ["run", args.command], spawnOpts)
      : spawnSync("bun", cmdArgs, spawnOpts)

    const elapsed = Date.now() - startTime
    const stdout = result.stdout?.trim() || ""
    const stderr = result.stderr?.trim() || ""

    // ── Typecheck parsing ──
    let errors: Record<string, unknown>[] = []
    let errorSummary = { files: 0, total: 0 }
    if (args.command === "typecheck" && stderr) {
      const errorRe = /^(.+?)\((\d+),(\d+)\):\s*(error|warning)\s+(TS\d+):\s*(.+)/
      for (const line of stderr.split("\n")) {
        const m = line.trim().match(errorRe)
        if (m) errors.push({ file: m[1], line: parseInt(m[2]), col: parseInt(m[3]), level: m[4], code: m[5], message: m[6] })
      }
      const files = new Set(errors.map((e: any) => e.file))
      errorSummary = { files: files.size, total: errors.length }
      logTypecheck(db, context.sessionID, context.agent, result.status, errors.length, files.size, elapsed, false)
    }

    // ── Test parsing ──
    let testSummary: Record<string, unknown> = {}
    if (args.command === "test" && stdout) {
      const passMatch = stdout.match(/(\d+)\s+pass/)
      const failMatch = stdout.match(/(\d+)\s+fail/)
      const totalMatch = stdout.match(/(\d+)\s+tests/)
      if (passMatch) testSummary.pass = parseInt(passMatch[1])
      if (failMatch) testSummary.fail = parseInt(failMatch[1])
      if (totalMatch) testSummary.total = parseInt(totalMatch[1])

      const testLines = stdout.split("\n")
      const passed: string[] = []
      const failed: { name: string; details: string[] }[] = []
      let currentFailure: { name: string; details: string[] } | null = null
      for (const line of testLines) {
        const pf = line.match(/^\s*(✓|✗)\s+(.+?)\s+\[([\d.]+)(m?s)\]/)
        if (pf) {
          if (currentFailure) failed.push(currentFailure)
          currentFailure = null
          if (pf[1] === "✓") passed.push(pf[2]!.trim())
          else currentFailure = { name: pf[2]!.trim(), details: [] }
        } else if (currentFailure && line.trim()) {
          currentFailure.details.push(line.trimEnd())
        }
      }
      if (currentFailure) failed.push(currentFailure)

      if (passed.length > 0) testSummary.passed_tests = passed.slice(0, 20)
      if (failed.length > 0) {
        testSummary.failed_tests = failed.map(f => f.name).slice(0, 20)
        testSummary.failure_details = failed.slice(0, 10).map(f => ({
          test: f.name, error: f.details.slice(0, 8).join("\n").slice(0, 500),
        }))
      }
      logTestResults(db, context.sessionID, context.agent, args.cwd, elapsed,
        (testSummary.pass as number) || 0, (testSummary.fail as number) || 0, (testSummary.total as number) || 0)
    }

    // ── Tool usage ──
    logToolUsage(db, context.sessionID, context.agent, "smart_bun", {
      command: args.command, elapsed_ms: elapsed, exit_code: result.status, cwd: args.cwd || "root",
    })

    // ── Heartbeat completion ──
    const isToolFailure = result.error || (result.status !== 0 && !(args.command === "typecheck" && errors.length > 0))
    heartbeat(db, context.sessionID, context.agent, "smart_bun", isToolFailure ? "failed" : "completed",
      `${args.command} exit=${result.status}`)

    // ── Build output ──
    const output: Record<string, unknown> = {}

    if (args.command === "typecheck") {
      if (result.status === 0) {
        output.status = "✅ PASS"; output.message = "Typecheck passed."; output.elapsed_ms = elapsed
      } else if (errors.length > 0) {
        output.status = "❌ FAIL"; output.message = `${errors.length} type errors in ${errorSummary.files} files`
        output.elapsed_ms = elapsed
        output.errors = errors.slice(0, 15).map((e: any) => `${e.file}:${e.line}:${e.col} — ${e.message}`)
        if (errors.length > 15) output.truncated = `${errors.length - 15} more errors not shown`
      } else {
        output.status = "💥 TOOL ERROR"; output.message = `Typecheck failed (exit ${result.status}).`
      }
    } else if (args.command === "test") {
      if (result.status === 0 && testSummary.fail === 0) {
        output.status = "✅ PASS"; output.message = `All ${testSummary.total || testSummary.pass || "?"} tests passed`; output.elapsed_ms = elapsed
      } else if (testSummary.fail as number > 0) {
        output.status = "❌ FAIL"; output.message = `${testSummary.pass || 0} pass, ${testSummary.fail} fail`
        output.elapsed_ms = elapsed
        if (testSummary.failed_tests) output.failed = testSummary.failed_tests
        if (testSummary.failure_details) output.failure_details = testSummary.failure_details
      } else {
        output.status = "💥 TOOL ERROR"; output.message = `Test command failed (exit ${result.status}).`
        if (stderr) output.stderr = stderr.slice(0, 2000)
      }
    } else {
      output.status = result.status === 0 ? "✅ OK" : "❌ FAIL"
      output.message = result.status === 0 ? `Completed in ${elapsed}ms` : `Failed with exit ${result.status}`
      output.elapsed_ms = elapsed
      if (stdout) output.output = stdout.slice(0, 500)
      if (stderr) output.stderr = stderr.slice(0, 2000)
    }

    return JSON.stringify(output, null, 2)
  },
})
