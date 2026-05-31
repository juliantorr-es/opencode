import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { Service as BinaryManager } from "@/binary/manager"
import DESCRIPTION from "./binary-info.txt"

const Parameters = Schema.Struct({})

export const BinaryInfoTool = Tool.define(
  "binary_info",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (_params: Record<string, never>, _ctx: Tool.Context) =>
        Effect.gen(function* () {
          const bm = yield* BinaryManager
          const allInfo = yield* bm.info()

          const statusMap: Record<string, unknown> = {}
          for (const bin of allInfo) {
            statusMap[bin.name] = {
              version: bin.version,
              status: bin.status,
              path: bin.path,
            }
          }

          const summary = {
            managed: allInfo.length,
            cached: allInfo.filter((b) => b.status === "cached").length,
            system: allInfo.filter((b) => b.status === "system").length,
            downloadable: allInfo.filter((b) => b.status === "downloadable").length,
            unsupported: allInfo.filter((b) => b.status === "unsupported").length,
          }

          return {
            title: "binary_info",
            metadata: { status: "ok", ...summary },
            output: JSON.stringify({ status: "ok", binaries: statusMap, summary, platform: `${process.platform}-${process.arch}` }, null, 2),
          }
        }).pipe(Effect.orDie),
    }
  }),
)
