import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./checkpoint.txt"
import { Storage } from "@/storage/storage"
import { createCheckpointRecord, formatCheckpointRecord } from "./checkpoint-tools"

export const Parameters = Schema.Struct({
  title: Schema.optional(Schema.String).annotate({
    description: "Optional checkpoint title",
  }),
})

export const CheckpointTool = Tool.define(
  "checkpoint",
  Effect.gen(function* () {
    const storage = yield* Storage.Service
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const checkpoint = createCheckpointRecord({
            sessionID: ctx.sessionID,
            messageID: ctx.messageID,
            title: params.title,
            messages: ctx.messages,
          })
          yield* storage.write(["checkpoint", ctx.sessionID, checkpoint.id], checkpoint)
          return {
            title: "checkpoint",
            metadata: checkpoint,
            output: formatCheckpointRecord(checkpoint),
          }
        }).pipe(Effect.orDie),
    }
  }),
)
