import { Effect, Schema } from "effect"
import * as Tool from "./tool"

const Parameters = Schema.Struct({
  owner: Schema.String,
  repo: Schema.String,
  issue_number: Schema.Number,
})

export const GithubTriageTool = Tool.define(
  "github_triage",
  Effect.succeed({
    description: "Triage a GitHub issue by analyzing its content and suggesting labels or actions",
    parameters: Parameters,
    execute: (params: { owner: string; repo: string; issue_number: number }) =>
      Effect.succeed({
        title: "github_triage",
        metadata: params,
        output: JSON.stringify({ status: "placeholder", note: "GitHub triage tool not yet implemented" }, null, 2),
      }),
  }),
)
