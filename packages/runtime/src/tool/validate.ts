import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./validate.txt"
import { InstanceState } from "@/effect/instance-state"
import { resolveScriptCommand, runCommand } from "./project-command"

export const Parameters = Schema.Struct({
  command: Schema.optional(Schema.String).annotate({
    description: "Optional command to run instead of the default project validation script",
  }),
})

export const ValidateTool = Tool.define(
  "validate",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const override = params.command?.trim()
          const resolved = override
            ? undefined
            : yield* resolveScriptCommand({
                root: instance.directory,
                script: "validate",
                fallback: ["bun", "run", "typecheck"],
              })
          const result = yield* runCommand({
            command: resolved?.command ?? "bun",
            args: resolved?.args ?? [],
            cwd: instance.directory,
            shellCommand: override,
          })

          const output = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n\n")
          if (result.exitCode !== 0) {
            throw new Error(
              `Validation failed with exit code ${result.exitCode}${output ? `\n\n${output}` : ""}`,
            )
          }

          return {
            title: "validate",
            metadata: {
              command: override ?? [resolved?.command ?? "bun", ...(resolved?.args ?? [])].join(" ").trim(),
              exitCode: result.exitCode,
              packageManager: resolved?.packageManager ?? "shell",
            },
            output: output ? `Validation passed.\n\n${output}` : "Validation passed.",
          }
        }).pipe(Effect.orDie),
    }
  }),
)
