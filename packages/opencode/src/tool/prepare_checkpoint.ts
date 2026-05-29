import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./prepare_checkpoint.txt"
import { createCheckpointRecord, formatCheckpointRecord } from "./checkpoint-tools"

export const Parameters = Schema.Struct({
  title: Schema.optional(Schema.String).annotate({
    description: "Optional checkpoint title",
  }),
})

export const PrepareCheckpointTool = Tool.define(
  "prepare_checkpoint",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.sync(() => {
          const checkpoint = createCheckpointRecord({
            sessionID: ctx.sessionID,
            messageID: ctx.messageID,
            title: params.title,
            messages: ctx.messages,
          })
          return {
            title: "prepare_checkpoint",
            metadata: checkpoint,
            output: formatCheckpointRecord(checkpoint),
          }
        }),
    }
  }),
)
