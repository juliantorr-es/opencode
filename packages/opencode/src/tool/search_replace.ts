import path from "path"
import { Effect, Schema } from "effect"
import { createTwoFilesPatch } from "diff"
import * as Tool from "./tool"
import DESCRIPTION from "./search_replace.txt"
import { InstanceState } from "@/effect/instance-state"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { assertExternalDirectoryEffect } from "./external-directory"
import { Ripgrep } from "@/file/ripgrep"

export const Parameters = Schema.Struct({
  find: Schema.String.annotate({
    description: "The literal text to search for",
  }),
  replace: Schema.String.annotate({
    description: "The literal text to insert in place of the search text",
  }),
  filePaths: Schema.optional(Schema.Array(Schema.String)).annotate({
    description: "Optional list of files to update; if omitted, search the current project for matches",
  }),
})

export const SearchReplaceTool = Tool.define(
  "search_replace",
  Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service
    const ripgrep = yield* Ripgrep.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          if (!params.find.length) {
            throw new Error("find is required")
          }

          if (params.find === params.replace) {
            throw new Error("find and replace must differ")
          }

          const instance = yield* InstanceState.context
          const files = params.filePaths?.length
            ? params.filePaths.map((item) => (path.isAbsolute(item) ? item : path.join(instance.directory, item)))
            : (
                yield* ripgrep.search({
                  cwd: instance.directory,
                  pattern: params.find,
                  limit: 2000,
                  follow: true,
                })
              ).items.map((item) => item.path.text)

          const unique = [...new Set(files)]
          const changes: Array<{ file: string; before: string; after: string }> = []

          for (const file of unique) {
            yield* assertExternalDirectoryEffect(ctx, file)
            const exists = yield* fs.existsSafe(file)
            if (!exists) continue

            const before = yield* fs.readFileString(file)
            if (!before.includes(params.find)) continue
            const after = before.split(params.find).join(params.replace)
            if (after === before) continue

            changes.push({ file, before, after })
          }

          if (!changes.length) {
            return {
              title: "search_replace",
              metadata: {
                count: 0,
                files: [] as string[],
                diff: "",
              },
              output: "No files changed.",
            }
          }

          const diff = changes
            .map((change) => createTwoFilesPatch(change.file, change.file, change.before, change.after))
            .join("\n")
          const relativeFiles = changes.map((change) => path.relative(instance.worktree, change.file).replaceAll("\\", "/"))

          yield* ctx.ask({
            permission: "edit",
            patterns: relativeFiles,
            always: ["*"],
            metadata: {
              filepath: relativeFiles.join(", "),
              diff,
            },
          })

          for (const change of changes) {
            yield* fs.writeWithDirs(change.file, change.after)
          }

          return {
            title: "search_replace",
            metadata: {
              count: changes.length,
              files: relativeFiles,
              diff,
            },
            output: [
              `Replaced ${params.find} with ${params.replace} in ${changes.length} file${changes.length === 1 ? "" : "s"}.`,
              ...relativeFiles.map((file) => `- ${file}`),
            ].join("\n"),
          }
        }).pipe(Effect.orDie),
    }
  }),
)
