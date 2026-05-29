import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./generate_published_checkpoint_report.txt"
import { Storage } from "@/storage/storage"

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

export const Parameters = Schema.Struct({})

export const GeneratePublishedCheckpointReportTool = Tool.define(
  "generate_published_checkpoint_report",
  Effect.gen(function* () {
    const storage = yield* Storage.Service
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (_params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const items = yield* storage.list(["published_checkpoint", ctx.sessionID])
          const checkpoints = yield* Effect.forEach(
            items,
            (item) => storage.read<CheckpointRecord>(item),
            { concurrency: "unbounded" },
          )
          const output =
            checkpoints.length === 0
              ? "No published checkpoints were found."
              : [
                  `Published checkpoints: ${checkpoints.length}`,
                  "",
                  ...checkpoints.flatMap((item) => [
                    `${item.id} - ${item.title}`,
                    item.report,
                    "",
                  ]),
                ].join("\n").trim()
          return {
            title: "generate_published_checkpoint_report",
            metadata: { count: checkpoints.length, checkpoints },
            output,
          }
        }).pipe(Effect.orDie),
    }
  }),
)
