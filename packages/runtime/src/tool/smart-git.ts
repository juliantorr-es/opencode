import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { AppFileSystem } from "@tribunus/core/filesystem"
import { InstanceState } from "@/effect/instance-state"
import path from "path"
import { spawnSync } from "child_process"
import { sanitizedProcessEnv } from "@tribunus/core/util/opencode-process"
import DESCRIPTION from "./smart-git.txt"

const VALID_OPS: Record<string, string[]> = {
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

const BLOCKED_ARGS: Record<string, string[]> = {
  push: ["--force", "-f", "--delete"],
  checkout: ["--", "HEAD~"],
  stash: ["drop", "clear"],
  branch: ["-D", "--delete"],
}

const Parameters = Schema.Struct({
  operation: Schema.String.annotate({
    description: "status | diff | add | commit | push | log | branch | rev-parse | stash | checkout | show",
  }),
  args: Schema.optional(Schema.String).annotate({
    description: "Additional args passed directly to git",
  }),
  path: Schema.optional(Schema.String).annotate({
    description: "Limit to a specific file or directory (appended as '-- <path>'). Use this to filter status/diff/log to one file.",
  }),
  files: Schema.optional(Schema.String).annotate({
    description: "JSON array of file paths for add/checkout operations",
  }),
  message: Schema.optional(Schema.String).annotate({
    description: "Commit message (for commit operation)",
  }),
})

export const SmartGitTool = Tool.define(
  "smart_git",
  Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context

          if (!VALID_OPS[params.operation]) {
            return {
              title: "smart_git",
              metadata: { status: "error" },
              output: JSON.stringify(
                { status: "error", error: `Unknown operation: '${params.operation}'`, valid: Object.keys(VALID_OPS) },
                null,
                2,
              ),
            }
          }

          // Block destructive operations
          if (BLOCKED_ARGS[params.operation]) {
            const hasBlocked = BLOCKED_ARGS[params.operation].some((a) => (params.args || "").includes(a))
            if (hasBlocked) {
              return {
                title: "smart_git",
                metadata: { status: "blocked" },
                output: JSON.stringify(
                  { status: "blocked", error: `Destructive git ${params.operation} blocked`, blocked_args: BLOCKED_ARGS[params.operation] },
                  null,
                  2,
                ),
              }
            }
          }

          const cmd = ["git", ...VALID_OPS[params.operation]]

          if (params.operation === "commit" && params.message) {
            cmd.push(params.message)
          }
          if (params.operation === "log" && params.args) {
            cmd.splice(2, 2)
            cmd.push(...params.args.split(/\s+/))
          }
          if (params.args && !["commit", "log"].includes(params.operation)) {
            cmd.push(...params.args.split(/\s+/).filter(Boolean))
          }
          if (params.path && ["status", "diff", "diff-stat", "log"].includes(params.operation)) {
            cmd.push("--", params.path)
          }
          if (params.files) {
            try {
              const files = JSON.parse(params.files) as string[]
              if (Array.isArray(files)) cmd.push(...files)
            } catch { /* skip */ }
          }

          const result = yield* Effect.promise(() =>
            new Promise<{ stdout: string; stderr: string; status: number | null; error?: Error }>((resolve) => {
              try {
                const proc = spawnSync(cmd[0], cmd.slice(1), {
                  cwd: instance.directory,
                  env: sanitizedProcessEnv(),
                  encoding: "utf8" as const,
                  maxBuffer: 1024 * 1024 * 2,
                  timeout: 30000,
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

          const stdout = result.stdout
          const stderr = result.stderr
          const exitCode = result.status ?? -1

          const output: Record<string, unknown> = {
            operation: params.operation,
            command: cmd.join(" "),
            exit_code: exitCode,
            status: exitCode === 0 ? "success" : "error",
          }

          // Parse structured output per operation
          if (params.operation === "status" && stdout) {
            const files = stdout.split("\n").filter(Boolean).map((l) => {
              const st = l.slice(0, 2).trim()
              const file = l.slice(3).trim()
              return { status: st, file, staged: l[0] !== " ", unstaged: l[1] !== " " }
            })
            output.files = files
            output.staged_count = files.filter((f) => f.staged).length
            output.unstaged_count = files.filter((f) => f.unstaged).length
            output.untracked_count = files.filter((f) => f.status === "??").length
          } else if (params.operation === "diff" && stdout) {
            const lines = stdout.split("\n")
            output.summary = `${lines.length} lines changed`
            if (lines.length > 60) {
              output.diff_head = lines.slice(0, 40).join("\n")
              output.diff_tail = lines.slice(-20).join("\n")
              output.diff_truncated = lines.length
            } else {
              output.diff = stdout
            }
          } else if (params.operation === "log" && stdout) {
            output.commits = stdout.split("\n").filter(Boolean).map((l) => {
              const parts = l.split(" ")
              return { sha: parts[0], message: parts.slice(1).join(" ") }
            })
          } else if (params.operation === "rev-parse" && stdout) {
            output.sha = stdout
          } else if (params.operation === "branch") {
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
              tool: "smart_git",
              operation: params.operation,
              exit_code: exitCode,
            }),
          )

          return {
            title: "smart_git",
            metadata: { operation: params.operation, exit_code: exitCode },
            output: JSON.stringify(output, null, 2),
          }
        }).pipe(Effect.orDie),
    }
  }),
)

export * as SmartGit from "./smart-git"
