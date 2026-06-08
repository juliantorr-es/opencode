import { Effect, Schema } from "effect"
import * as Tool from "./tool"

const Parameters = Schema.Struct({
  query: Schema.String,
  max_results: Schema.optional(Schema.Number),
})

export const GithubPrSearchTool = Tool.define(
  "github_pr_search",
  Effect.succeed({
    description: "Search GitHub pull requests using the GitHub API",
    parameters: Parameters,
    execute: (params: { query: string; max_results?: number }) =>
      Effect.succeed({
        title: "github_pr_search",
        metadata: params,
        output: JSON.stringify({ status: "placeholder", note: "GitHub PR search tool not yet implemented" }, null, 2),
      }),
  }),
)
