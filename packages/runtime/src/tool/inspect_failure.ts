import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./inspect_failure.txt"
import { collectFailures, formatFailureReport } from "./failure-tools"

export const Parameters = Schema.Struct({
  tool: Schema.optional(Schema.String).annotate({
    description: "Optional tool name to filter failures by",
  }),
  callID: Schema.optional(Schema.String).annotate({
    description: "Optional tool call ID to filter failures by",
  }),
})

export const InspectFailureTool = Tool.define(
  "inspect_failure",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.sync(() => {
          const failures = collectFailures(ctx.messages, {
            tool: params.tool?.trim() || undefined,
            callID: params.callID?.trim() || undefined,
          })
          return {
            title: "inspect_failure",
            metadata: {
              count: failures.length,
              failures,
            },
            output: formatFailureReport(failures),
          }
        }),
    }
  }),
)
