import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./github-pr-search.txt"

const Parameters = Schema.Struct({
  owner: Schema.String.annotate({ description: "Repository owner (user or organization)" }),
  repo: Schema.String.annotate({ description: "Repository name" }),
  query: Schema.String.annotate({ description: "Search query for PR titles and descriptions" }),
  state: Schema.optional(Schema.Literals(["open", "closed", "all"])).annotate({
    description: 'PR state filter: "open", "closed", or "all" (default "open")',
  }),
  limit: Schema.optional(Schema.Number).annotate({ description: "Maximum number of results (default 10)" }),
  offset: Schema.optional(Schema.Number).annotate({ description: "Number of results to skip for pagination (default 0)" }),
})

export const GithubPrSearchTool = Tool.define(
  "github_pr_search",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, _ctx: Tool.Context) =>
        Effect.gen(function* () {
          const token = process.env.GITHUB_TOKEN
          if (!token) {
            throw new Error(
              "GITHUB_TOKEN environment variable is not set. Set it to a GitHub personal access token with repo scope.",
            )
          }

          const state = params.state ?? "open"
          const limit = params.limit ?? 10
          const page = params.offset ? Math.floor(params.offset / limit) + 1 : 1
          const query = `${params.query} repo:${params.owner}/${params.repo} type:pr state:${state}`
          const url = `https://api.github.com/search/issues?q=${encodeURIComponent(query)}&per_page=${limit}&page=${page}&sort=updated&order=desc`

          const response = yield* Effect.promise(() =>
            fetch(url, {
              headers: {
                Authorization: `Bearer ${token}`,
                Accept: "application/vnd.github.v3+json",
                "User-Agent": "opencode",
              },
            }),
          )

          if (response.status === 403) {
            const rateLimit = response.headers.get("X-RateLimit-Remaining")
            if (rateLimit === "0") {
              const resetTime = response.headers.get("X-RateLimit-Reset")
              const resetDate = resetTime
                ? new Date(parseInt(resetTime) * 1000).toISOString()
                : "unknown"
              throw new Error(`GitHub API rate limit exceeded. Resets at ${resetDate}`)
            }
            throw new Error(
              "GitHub API returned 403 Forbidden. Check your token permissions and scope.",
            )
          }

          if (!response.ok) {
            const body = yield* Effect.promise(() => response.text())
            throw new Error(`GitHub API error (${response.status}): ${body}`)
          }

          const data: { items: Array<Record<string, unknown>> } = yield* Effect.promise(() =>
            response.json(),
          )

          const prs = data.items.map((item) => ({
            title: String(item.title ?? ""),
            url: String(item.html_url ?? ""),
            state: String(item.state ?? ""),
            labels: ((item.labels as Array<{ name: string }>) ?? []).map((l) => l.name),
          }))

          return {
            title: `github_pr_search: ${prs.length} PRs found`,
            metadata: { count: prs.length },
            output: JSON.stringify(prs, null, 2),
          }
        }).pipe(Effect.orDie),
    }
  }),
)

export * as GithubPrSearch from "./github-pr-search"
