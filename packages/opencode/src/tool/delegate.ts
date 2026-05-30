import { Effect, Schema } from "effect"
import * as Tool from "./tool"

const Parameters = Schema.Struct({
  subagent_type: Schema.String,
  prompt: Schema.String,
})

export const DelegateTool = Tool.define(
  "delegate",
  Effect.succeed({
    description: "Record a subagent delegation in the coordination ledger and provide instructions for spawning the subagent",
    parameters: Parameters,
    execute: (params: { subagent_type: string; prompt: string }) =>
      Effect.succeed({
        title: "delegate",
        metadata: {},
        output: `Delegation recorded: ${params.subagent_type}`,
      }),
  }),
)
