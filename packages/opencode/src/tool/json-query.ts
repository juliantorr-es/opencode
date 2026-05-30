import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { InstanceState } from "@/effect/instance-state"
import path from "path"
import DESCRIPTION from "./json-query.txt"

const Parameters = Schema.Struct({
  file: Schema.String.annotate({ description: "JSON file to query" }),
  query: Schema.String.annotate({
    description: "Dot-separated path: 'scripts.typecheck' or 'dependencies.effect'",
  }),
})

export const JSONQueryTool = Tool.define(
  "json_query",
  Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, _ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const filePath = path.isAbsolute(params.file)
            ? params.file
            : path.resolve(instance.directory, params.file)

          const exists = yield* fs.existsSafe(filePath)
          if (!exists) {
            return {
              title: "json_query",
              metadata: { status: "fail" },
              output: JSON.stringify(
                { status: "fail", error: `File not found: ${params.file}` },
                null,
                2,
              ),
            }
          }

          let data: unknown
          try {
            const content = yield* fs.readFileString(filePath)
            data = JSON.parse(content)
          } catch {
            return {
              title: "json_query",
              metadata: { status: "fail" },
              output: JSON.stringify({ status: "fail", error: "Invalid JSON" }, null, 2),
            }
          }

          const keys = params.query.split(".")
          let current: unknown = data
          for (const key of keys) {
            if (current && typeof current === "object" && key in (current as Record<string, unknown>)) {
              current = (current as Record<string, unknown>)[key]
            } else {
              current = undefined
              break
            }
          }

          return {
            title: "json_query",
            metadata: {},
            output: JSON.stringify({ file: params.file, query: params.query, value: current }, null, 2),
          }
        }).pipe(Effect.orDie),
    }
  }),
)

export * as JSONQuery from "./json-query"
