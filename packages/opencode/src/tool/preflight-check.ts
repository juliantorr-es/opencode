import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { InstanceState } from "@/effect/instance-state"
import path from "path"
import DESCRIPTION from "./preflight-check.txt"

const Parameters = Schema.Struct({
  file: Schema.String.annotate({ description: "File path to check" }),
})

export const PreflightCheckTool = Tool.define(
  "preflight_check",
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
          const verdict = exists ? "allowed" : "new_file"

          return {
            title: "preflight_check",
            metadata: { file: params.file, exists },
            output: JSON.stringify(
              {
                status: "ok",
                file: params.file,
                verdict,
                exists,
                note: verdict === "new_file"
                  ? "File does not exist yet — will be created."
                  : "File exists and is editable.",
              },
              null,
              2,
            ),
          }
        }).pipe(Effect.orDie),
    }
  }),
)

export * as PreflightCheck from "./preflight-check"
