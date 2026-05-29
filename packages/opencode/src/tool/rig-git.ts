import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { Git } from "@/git"
import { InstanceState } from "@/effect/instance-state"
import DESCRIPTION from "./rig-git.txt"

const Command = Schema.Literal("status", "diff", "log", "branch", "show", "ls-files")

const Parameters = Schema.Struct({
  command: Command.annotate({ description: "The git command to run" }),
  path: Schema.optional(Schema.String).annotate({ description: "File path filter (for diff, show, ls-files)" }),
  ref: Schema.optional(Schema.String).annotate({ description: "Git ref (for show, diff against a ref, or log range)" }),
  max: Schema.optional(Schema.Number).annotate({ description: "Max results (for log: max commits, default 20)" }),
  all: Schema.optional(Schema.Boolean).annotate({ description: "Include remote branches (for branch)" }),
  staged: Schema.optional(Schema.Boolean).annotate({ description: "Show staged diff instead of unstaged (for diff)" }),
  context: Schema.optional(Schema.Number).annotate({ description: "Diff context lines (for diff, default 3)" }),
})

const MAX_OUTPUT_BYTES = 50 * 1024 // 50KB
const MAX_LOG_LINES = 500

export const RigGitTool = Tool.define(
  "rig_git",
  Effect.gen(function* () {
    const git = yield* Git.Service
    const instance = yield* InstanceState.context

    const run = Effect.fnUntraced(function* (params: Schema.Schema.Type<typeof Parameters>) {
      const cwd = instance.directory
      const args: string[] = []

      if (params.command === "status") {
        args.push("status", "--porcelain=v1", "--untracked-files=all", "--no-renames")
        if (params.path) args.push("--", params.path)
      } else if (params.command === "diff") {
        if (params.staged) args.push("diff", "--staged")
        else args.push("diff")
        args.push("--no-ext-diff", `--unified=${params.context ?? 3}`, "--no-renames")
        if (params.ref) args.push(params.ref)
        if (params.path) args.push("--", params.path)
      } else if (params.command === "log") {
        const maxCount = Math.min(Math.max(params.max ?? 20, 1), 100)
        args.push("log", `--max-count=${maxCount}`, "--oneline", "--no-decorate")
        if (params.ref) args.push(params.ref)
        if (params.path) args.push("--", params.path)
      } else if (params.command === "branch") {
        args.push("branch")
        if (params.all) args.push("--all")
      } else if (params.command === "show") {
        const ref = params.ref ?? "HEAD"
        if (params.path) {
          args.push("show", `${ref}:${params.path}`)
        } else {
          args.push("show", "--oneline", "--no-patch", ref)
        }
      } else if (params.command === "ls-files") {
        args.push("ls-files")
        if (params.path) args.push("--", params.path)
      }

      const result = yield* git.run(args, { cwd, maxOutputBytes: MAX_OUTPUT_BYTES })
      const text = result.text().trim()
      const lines = text.split("\n")
      const truncated = result.truncated || lines.length > MAX_LOG_LINES
      const output = truncated
        ? lines.slice(0, MAX_LOG_LINES).join("\n") + `\n\n(Output truncated at ${MAX_LOG_LINES} lines)`
        : text

      return {
        title: `git ${params.command}`,
        metadata: {
          command: params.command,
          exitCode: result.exitCode,
          truncated,
          lineCount: lines.length,
        },
        output: result.exitCode === 0
          ? output || "(empty)"
          : `git ${params.command} exited with code ${result.exitCode}:\n${result.stderr.toString("utf8").trim()}`,
      }
    })

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>) => run(params).pipe(Effect.orDie),
    }
  }),
)

export * as RigGit from "./rig-git"
