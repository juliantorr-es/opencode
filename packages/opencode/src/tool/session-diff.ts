import { Effect, Schema } from "effect"
import * as Tool from "./tool"

const Parameters = Schema.Struct({
  session_id: Schema.optional(Schema.String),
  format: Schema.optional(Schema.String),
})

export const SessionDiffTool = Tool.define(
  "session_diff",
  Effect.succeed({
    description: "Generate a consolidated diff summary of all changes made in this session",
    parameters: Parameters,
    execute: (params: { session_id?: string; format?: string }) =>
      Effect.succeed({
        title: "session_diff",
        metadata: params,
        output: JSON.stringify({ status: "placeholder", note: "Session diff tool not yet implemented" }, null, 2),
      }),
  }),
)
