import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./publish_checkpoint.txt"
import { Storage } from "@/storage/storage"

export const Parameters = Schema.Struct({
  id: Schema.optional(Schema.String).annotate({
    description: "Optional checkpoint ID to publish; defaults to the latest checkpoint",
  }),
})

type CheckpointRecord = {
  id: string
  sessionID: string
  messageID: string
  title: string
  published: boolean
  time: number
  failures: Array<{ tool: string; callID: string; error: string; input: Record<string, unknown> }>
  report: string
}

export const PublishCheckpointTool = Tool.define(
  "publish_checkpoint",
  Effect.gen(function* () {
    const storage = yield* Storage.Service
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const checkpoint = yield* readCheckpoint(storage, ctx.sessionID, params.id)
          const published: CheckpointRecord = { ...checkpoint, published: true }
          yield* storage.write(["published_checkpoint", ctx.sessionID, published.id], published)
          return {
            title: "publish_checkpoint",
            metadata: published,
            output: [
              `Published checkpoint ${published.id}.`,
              `Title: ${published.title}`,
              "",
              published.report,
            ].join("\n"),
          }
        }).pipe(Effect.orDie),
    }
  }),
)

function readCheckpoint(storage: Storage.Interface, sessionID: string, id?: string) {
  return Effect.gen(function* () {
    if (id) {
      return yield* storage.read<CheckpointRecord>(["checkpoint", sessionID, id])
    }

    const items = yield* storage.list(["checkpoint", sessionID])
    const latest = items.at(-1)
    if (!latest) throw new Error("No checkpoint has been created for this session.")
    return yield* storage.read<CheckpointRecord>(["checkpoint", ...latest])
  })
}
