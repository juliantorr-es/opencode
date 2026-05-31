import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { InstanceState } from "@/effect/instance-state"
import { Service as BinaryManager } from "@/binary/manager"
import { spawnSync } from "child_process"
import DESCRIPTION from "./smart-grep.txt"

const Parameters = Schema.Struct({
  pattern: Schema.String.annotate({ description: "Pattern to search for (regex or literal)" }),
  path: Schema.optional(Schema.String).annotate({
    description: "Directory or file to search in. Defaults to workspace root.",
  }),
  glob: Schema.optional(Schema.String).annotate({
    description: "File glob pattern (e.g. '*.ts', '*.md')",
  }),
  max_results: Schema.optional(Schema.Number).annotate({
    description: "Max results (default 30)",
  }),
  summary_only: Schema.optional(Schema.Boolean).annotate({
    description: "Return only file paths + match counts, not individual matches",
  }),
  context_lines: Schema.optional(Schema.Number).annotate({
    description: "Lines of context around each match (default 0)",
  }),
})

export const SmartGrepTool = Tool.define(
  "smart_grep",
  Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service
    const binaryManager = yield* BinaryManager
    const rgPath = yield* binaryManager.resolve("rg")

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const searchPath = params.path
            ? (params.path.startsWith("/") ? params.path : `${instance.directory}/${params.path}`)
            : instance.directory
          const maxResults = params.max_results ?? 30
          const summaryOnly = params.summary_only ?? false
          const ctxLines = params.context_lines ?? 0

          const cmd = [rgPath, "--no-heading", "--line-number", "--color", "never"]
          if (params.glob) cmd.push("-g", params.glob)
          if (ctxLines > 0) cmd.push("-C", String(ctxLines))
          cmd.push(params.pattern, searchPath)

          const startTime = Date.now()
          const result = yield* Effect.promise(() =>
            new Promise<{ stdout: string; stderr: string; status: number | null; error?: Error }>((resolve) => {
              try {
                const proc = spawnSync(cmd[0], cmd.slice(1), {
                  cwd: instance.directory,
                  encoding: "utf8" as const,
                  maxBuffer: 1024 * 1024 * 5,
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

          const cmdStr = cmd.join(" ")
          const elapsed = Date.now() - startTime

          if (result.error || result.status === 2 || (result.status !== 0 && result.status !== 1 && !result.stdout?.trim())) {
            return {
              title: "smart_grep",
              metadata: { status: "fail" },
              output: JSON.stringify(
                {
                  status: "fail",
                  error: result.error?.message || result.stderr?.trim() || `rg exited with code ${result.status}`,
                  command: cmdStr,
                  elapsed_ms: elapsed,
                },
                null,
                2,
              ),
            }
          }

          const stdout = result.stdout?.trim() || ""
          if (!stdout) {
            return {
              title: "smart_grep",
              metadata: { count: 0 },
              output: JSON.stringify(
                {
                  matches: [],
                  count: 0,
                  pattern: params.pattern,
                  command: cmdStr,
                  elapsed_ms: elapsed,
                  hint: "No matches found.",
                },
                null,
                2,
              ),
            }
          }

          const rawLines = stdout.split("\n")
          const matches: { file: string; line: number; text: string }[] = []
          const fileCounts: Record<string, number> = {}

          for (const line of rawLines) {
            if (!line.trim()) continue
            const m = line.match(/^(.+?):(\d+):(.+)$/)
            if (!m) continue
            const file = m[1]
            const lineNum = parseInt(m[2])
            const text = m[3].trim().slice(0, 200)
            matches.push({ file, line: lineNum, text })
            fileCounts[file] = (fileCounts[file] || 0) + 1
            if (matches.length >= maxResults) break
          }

          const resultObj: Record<string, unknown> = {
            status: "ok",
            pattern: params.pattern,
            command: cmdStr,
            elapsed_ms: elapsed,
            total_matches: rawLines.length,
            returned: matches.length,
            unique_files: Object.keys(fileCounts).length,
            truncated: rawLines.length > maxResults,
          }

          if (summaryOnly) {
            resultObj.files = Object.entries(fileCounts)
              .sort(([, a], [, b]) => b - a)
              .slice(0, 20)
              .map(([file, cnt]) => ({ file, matches: cnt }))
          } else {
            resultObj.matches = matches
            if (Object.keys(fileCounts).length <= 10) {
              resultObj.files = Object.fromEntries(
                Object.entries(fileCounts).sort(([, a], [, b]) => b - a),
              )
            }
          }

          // Analytics
          const logDir = `${instance.directory}/docs/json/opencode/sessions/${ctx.sessionID}/analytics`
          yield* fs.ensureDir(logDir)
          yield* fs.writeFileString(
            `${logDir}/smart_tool_usage.v1.jsonl`,
            JSON.stringify({
              at: new Date().toISOString(),
              session_id: ctx.sessionID,
              agent: ctx.agent,
              tool: "smart_grep",
              pattern: params.pattern.slice(0, 100),
              path: (params.path || "").slice(0, 80),
            }) + "\n",
            { flag: "a" },
          )

          return {
            title: "smart_grep",
            metadata: { count: matches.length },
            output: JSON.stringify(resultObj, null, 2),
          }
        }).pipe(Effect.orDie),
    }
  }),
)

export * as SmartGrep from "./smart-grep"
