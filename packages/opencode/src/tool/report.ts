import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./report.txt"
import { collectFailures, formatFailureReport } from "./failure-tools"

export const Parameters = Schema.Struct({})

export const ReportTool = Tool.define(
  "report",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (_params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.sync(() => {
          const failures = collectFailures(ctx.messages)
          const output = formatFailureReport(failures)
          return {
            title: "report",
            metadata: {
              count: failures.length,
              failures,
            },
            output,
          }
        }),
    }
  }),
)
