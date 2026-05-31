import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { InstanceState } from "@/effect/instance-state"
import path from "path"
import { spawnSync } from "child_process"
import DESCRIPTION from "./smart-bun.txt"

const VALID_COMMANDS: Record<string, string> = {
  typecheck: "run typecheck",
  test: "test",
  install: "install",
  run: "run",
  tsgo: "x tsgo",
  tsc: "x tsc",
}

const Parameters = Schema.Struct({
  command: Schema.String.annotate({
    description: "typecheck | test | install | run | tsgo | tsc — the bun operation",
  }),
  cwd: Schema.optional(Schema.String).annotate({
    description: "Working directory (e.g. 'packages/opencode'). Defaults to workspace root.",
  }),
  args: Schema.optional(Schema.String).annotate({
    description: "Additional args to pass to bun, e.g. '--filter src/storage' or a test file path",
  }),
  timeout_seconds: Schema.optional(Schema.Number).annotate({
    description: "Max execution time (default 120)",
  }),
})

export const SmartBunTool = Tool.define(
  "smart_bun",
  Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const bunCmd = VALID_COMMANDS[params.command]
          if (!bunCmd) {
            return {
              title: "smart_bun",
              metadata: { status: "error" },
              output: JSON.stringify(
                { status: "error", error: `Unknown command: '${params.command}'`, valid: Object.keys(VALID_COMMANDS) },
                null,
                2,
              ),
            }
          }

          const cwd = params.cwd ? path.resolve(instance.directory, params.cwd) : instance.directory
          const timeout = (params.timeout_seconds ?? 120) * 1000
          const startTime = Date.now()

          const cmdArgs = [bunCmd]
          if (params.args) {
            cmdArgs.push(...params.args.split(/\s+/).filter(Boolean))
          }

          const result = yield* Effect.promise(() =>
            new Promise<{ stdout: string; stderr: string; status: number | null; error?: Error }>((resolve) => {
              try {
                const proc = spawnSync("bun", cmdArgs, {
                  cwd,
                  env: sanitizedProcessEnv(),
                  encoding: "utf8" as const,
                  maxBuffer: 1024 * 1024 * 5,
                  timeout,
                  windowsHide: true,
                })
                resolve({
                  stdout: (proc.stdout ?? "") as string,
                  stderr: (proc.stderr ?? "") as string,
                  status: proc.status,
                  error: proc.error ?? undefined,
                })
              } catch (e) {
                resolve({ stdout: "", stderr: "", status: null, error: e as Error })
              }
            }),
          )

          const elapsed = Date.now() - startTime
          const exitCode = result.status ?? -1
          const stdout = result.stdout
          const stderr = result.stderr

          // Parse typecheck output
          let errors: Record<string, unknown>[] = []
          let errorSummary = { files: 0, total: 0 }
          if (params.command === "typecheck" && stderr) {
            const errorRe = /^(.+?)\((\d+),(\d+)\):\s*(error|warning)\s+(TS\d+):\s*(.+)/
            for (const line of stderr.split("\n")) {
              const trimmed = line.trim()
              const m = trimmed.match(errorRe)
              if (m) {
                errors.push({ file: m[1], line: parseInt(m[2]), col: parseInt(m[3]), level: m[4], code: m[5], message: m[6] })
              }
            }
            const files = new Set(errors.map((e: any) => e.file))
            errorSummary = { files: files.size, total: errors.length }
          }

          // Parse test output
          let testSummary: Record<string, unknown> = {}
          if (params.command === "test" && stdout) {
            const passMatch = stdout.match(/(\d+)\s+pass/)
            const failMatch = stdout.match(/(\d+)\s+fail/)
            const totalMatch = stdout.match(/(\d+)\s+tests/)
            if (passMatch) testSummary.pass = parseInt(passMatch[1])
            if (failMatch) testSummary.fail = parseInt(failMatch[1])
            if (totalMatch) testSummary.total = parseInt(totalMatch[1])
          }

          const output: Record<string, unknown> = {
            command: `bun ${cmdArgs.join(" ")}`,
            cwd,
            elapsed_ms: elapsed,
            exit_code: exitCode,
          }

          if (params.command === "typecheck" && exitCode === 1 && errors.length > 0) {
            output.status = "type_errors_found"
            output.type_errors = errors.slice(0, 30)
            output.error_summary = errorSummary
            output.note = `Typecheck found ${errorSummary.total} errors in ${errorSummary.files} files.`
          } else if (params.command === "typecheck" && exitCode === 0) {
            output.status = "pass"
            output.note = "Typecheck passed — no errors."
          } else if (exitCode === 0) {
            output.status = "pass"
          } else {
            output.status = "fail"
          }

          if (errors.length > 0) {
            output.errors = errors.slice(0, 30)
            output.error_summary = errorSummary
          }
          if (Object.keys(testSummary).length > 0) output.test_summary = testSummary

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

          // Analytics
          const logDir = `${instance.directory}/docs/json/opencode/sessions/${ctx.sessionID}/analytics`
          yield* fs.ensureDir(logDir)
          yield* fs.appendLine(
            path.join(logDir, "smart_tool_usage.v1.jsonl"),
            JSON.stringify({
              at: new Date().toISOString(),
              session_id: ctx.sessionID,
              agent: ctx.agent,
              tool: "smart_bun",
              command: params.command,
              elapsed_ms: elapsed,
              exit_code: exitCode,
            }),
          )

          return {
            title: "smart_bun",
            metadata: { command: params.command, exit_code: exitCode },
            output: JSON.stringify(output, null, 2),
          }
        }).pipe(Effect.orDie),
    }
  }),
)

export * as SmartBun from "./smart-bun"
