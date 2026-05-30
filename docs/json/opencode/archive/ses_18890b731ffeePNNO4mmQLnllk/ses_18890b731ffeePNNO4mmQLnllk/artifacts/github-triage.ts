import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./github-triage.txt"

const Parameters = Schema.Struct({
  owner: Schema.String.annotate({ description: "Repository owner (user or organization)" }),
  repo: Schema.String.annotate({ description: "Repository name" }),
  issue_number: Schema.Number.annotate({ description: "Issue number to assign" }),
  assignee: Schema.optional(Schema.String).annotate({ description: "GitHub username to assign. If omitted, assigns to the token owner." }),
})

function githubToken(): string {
  const token = process.env.GITHUB_TOKEN
  if (!token) throw new Error("GITHUB_TOKEN environment variable is not set")
  return token
}

export const GithubTriageTool = Tool.define(
  "github_triage",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>) =>
        Effect.gen(function* () {
          const token = githubToken()
          const url = `https://api.github.com/repos/${params.owner}/${params.repo}/issues/${params.issue_number}/assignees`
          const body: { assignees: string[] } = {
            assignees: params.assignee ? [params.assignee] : [],
          }

          const response = yield* Effect.promise(() =>
            fetch(url, {
              method: "POST",
              headers: {
                Authorization: `Bearer ${token}`,
                Accept: "application/vnd.github+json",
                "Content-Type": "application/json",
              },
              body: JSON.stringify(body),
            }),
          )

          if (!response.ok) {
            const errorText = yield* Effect.promise(() => response.text())
            return {
              title: "github_triage",
              metadata: {
                status: "error",
                http_status: response.status,
                issue_number: params.issue_number,
              },
              output: `GitHub API error (${response.status}): ${errorText}`,
            }
          }

          const data = yield* Effect.promise(() => response.json() as Promise<Record<string, unknown>>)

          return {
            title: `github_triage: #${params.issue_number}`,
            metadata: {
              status: "assigned",
              issue_number: params.issue_number,
              assignee: params.assignee ?? "(token owner)",
              url: `https://github.com/${params.owner}/${params.repo}/issues/${params.issue_number}`,
            },
            output: JSON.stringify({
              status: "assigned",
              issue_number: params.issue_number,
              assignee: params.assignee ?? "(token owner)",
              url: data.html_url ?? `https://github.com/${params.owner}/${params.repo}/issues/${params.issue_number}`,
            }, null, 2),
          }
        }).pipe(Effect.orDie),
    }
  }),
)

export * as GithubTriage from "./github-triage"
