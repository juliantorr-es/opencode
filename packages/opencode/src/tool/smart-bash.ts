import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { InstanceState } from "@/effect/instance-state"
import path from "path"
import { spawnSync } from "child_process"
import { sanitizedProcessEnv } from "@opencode-ai/core/util/opencode-process"
import { scanToolOutput } from "./secret-scanner"
import DESCRIPTION from "./smart-bash.txt"

const Parameters = Schema.Struct({
  command: Schema.String.annotate({ description: "The bash command to run" }),
  cwd: Schema.optional(Schema.String).annotate({ description: "Working directory" }),
  reason: Schema.String.annotate({ description: "Why you need bash" }),
  timeout_seconds: Schema.optional(Schema.Number).annotate({
    description: "Max execution time (default 60)",
  }),
})

const DESTRUCTIVE = ["rm -rf", "git push --force", "git reset --hard", "git clean -f", "git branch -D", ":(){ :|:& };:"]

export const SmartBashTool = Tool.define(
  "smart_bash",
  Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          let cwd = params.cwd ? path.resolve(instance.directory, params.cwd) : instance.directory
          let cmd = params.command.trim()

          // Block destructive commands
          if (DESTRUCTIVE.some((d) => cmd.includes(d))) {
            return {
              title: "smart_bash",
              metadata: { status: "blocked" },
              output: JSON.stringify(
                { status: "blocked", error: "Destructive command blocked", command: cmd.slice(0, 100) },
                null,
                2,
              ),
            }
          }

          // Auto-detect cd prefix
          const cdMatch = cmd.match(/^cd\s+(\S+)\s*(?:&&|;)\s*(.+)/)
          if (cdMatch) {
            const cdDir = cdMatch[1]
            const rest = cdMatch[2].trim()
            const nestedCd = rest.match(/^cd\s+(\S+)\s*(?:&&|;)\s*(.+)/)
            if (nestedCd) {
              return {
                title: "smart_bash",
                metadata: { status: "hint" },
                output: JSON.stringify(
                  {
                    status: "hint",
                    hint: "Use the cwd parameter instead of cd.",
                    original: cmd.slice(0, 100),
                  },
                  null,
                  2,
                ),
              }
            }
            cwd = cdDir ? path.resolve(instance.directory, cdDir) : cwd
            cmd = rest
          }

          const binary = cmd.split(/\s+/)[0]
          const timeout = (params.timeout_seconds ?? 60) * 1000
          const startTime = Date.now()

          const result = yield* Effect.promise(() =>
            new Promise<{ stdout: string; stderr: string; status: number | null; error?: Error }>((resolve) => {
              try {
                const proc = spawnSync(params.command, [], {
                  cwd,
                  env: sanitizedProcessEnv(),
                  encoding: "utf8" as const,
                  maxBuffer: 1024 * 1024 * 2,
                  timeout,
                  shell: true,
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

          // Write analytics
          const logDir = `${instance.directory}/docs/json/opencode/sessions/${ctx.sessionID}/analytics`
          const logEntry = JSON.stringify({
            at: new Date().toISOString(),
            session_id: ctx.sessionID,
            agent: ctx.agent,
            binary,
            reason: params.reason,
            elapsed_ms: elapsed,
            exit_code: result.status,
          })
          yield* fs.ensureDir(logDir)
          yield* fs.appendLine(path.join(logDir, "bash_usage.v1.jsonl"), logEntry)

          const output: Record<string, unknown> = {
            status: result.status === 0 ? "pass" : "fail",
            command: cmd.slice(0, 200),
            elapsed_ms: elapsed,
          }

          const lines = result.stdout.split("\n")
          if (lines.length > 40) {
            output.head = lines.slice(0, 20).join("\n")
            output.tail = lines.slice(-20).join("\n")
            output.truncated = lines.length
          } else if (result.stdout) {
            output.stdout = result.stdout
          }
          if (result.stderr) output.stderr = result.stderr.slice(0, 500)
          if (result.error) {
            output.status = "error"
            output.error = result.error.message
          }

          // Scan output for secrets
          if (result.stdout || result.stderr) {
            const scan = scanToolOutput([result.stdout, result.stderr].filter(Boolean).join("\n"))
            if (scan.hadSecrets) {
              output.secret_findings = scan.findings
            }
          }

          return {
            title: "smart_bash",
            metadata: { exit_code: result.status ?? -1, binary },
            output: JSON.stringify(output, null, 2),
          }
        }).pipe(Effect.orDie),
    }
  }),
)

export * as SmartBash from "./smart-bash"
