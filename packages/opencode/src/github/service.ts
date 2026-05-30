import { Context, Effect, Layer, Schema } from "effect"
import type { PullRequest, PullRequestStatus } from "./types"

export class GitHubApiError extends Schema.TaggedErrorClass<GitHubApiError>()("GitHubApiError", {
  message: Schema.String,
  status: Schema.Number,
}) {}

export class GitHubAuthError extends Schema.TaggedErrorClass<GitHubAuthError>()("GitHubAuthError", {
  message: Schema.String,
}) {}

export type Error = GitHubApiError | GitHubAuthError

export interface Interface {
  readonly createPullRequest: (input: {
    owner: string
    repo: string
    title: string
    body?: string
    head: string
    base: string
  }) => Effect.Effect<PullRequest, Error>

  readonly getPullRequestStatus: (input: {
    owner: string
    repo: string
    prNumber: number
  }) => Effect.Effect<PullRequestStatus, Error>

  readonly listPullRequests: (input: {
    owner: string
    repo: string
    state?: "open" | "closed" | "all"
  }) => Effect.Effect<readonly PullRequest[], Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/GitHubService") {}

function githubApiUrl(path: string): string {
  return `https://api.github.com${path}`
}

function githubHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
    "User-Agent": "opencode",
  }
}

async function handleResponse(response: Response): Promise<unknown> {
  if (!response.ok) {
    const body = await response.text().catch(() => "unknown error")
    throw new GitHubApiError({ message: body, status: response.status })
  }
  return response.json()
}

export const layer = (token: string): Layer.Layer<Service> =>
  Layer.effect(
    Service,
    Effect.sync(() =>
      Service.of({
        createPullRequest: Effect.fn("GitHubService.createPullRequest")(function* (input) {
          const response = yield* Effect.tryPromise({
            try: () =>
              fetch(
                githubApiUrl(`/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/pulls`),
                {
                  method: "POST",
                  headers: githubHeaders(token),
                  body: JSON.stringify({
                    title: input.title,
                    body: input.body,
                    head: input.head,
                    base: input.base,
                  }),
                },
              ),
            catch: (error) => new GitHubApiError({ message: String(error), status: 0 }),
          })
          const data = (yield* Effect.tryPromise({
            try: () => handleResponse(response) as Promise<Record<string, unknown>>,
            catch: (error) => error as Error,
          })) as Record<string, unknown>
          return {
            number: data.number as number,
            title: data.title as string,
            body: data.body as string | undefined,
            state: data.state as string,
            html_url: data.html_url as string,
            created_at: data.created_at as string,
            updated_at: data.updated_at as string,
            head_branch: (data.head as Record<string, unknown>).ref as string,
            base_branch: (data.base as Record<string, unknown>).ref as string,
            owner: input.owner,
            repo: input.repo,
          } satisfies PullRequest
        }),

        getPullRequestStatus: Effect.fn("GitHubService.getPullRequestStatus")(function* (input) {
          const prResponse = yield* Effect.tryPromise({
            try: () =>
              fetch(
                githubApiUrl(
                  `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/pulls/${input.prNumber}`,
                ),
                { headers: githubHeaders(token) },
              ),
            catch: (error) => new GitHubApiError({ message: String(error), status: 0 }),
          })

          const prData = (yield* Effect.tryPromise({
            try: () => handleResponse(prResponse) as Promise<Record<string, unknown>>,
            catch: (error) => error as Error,
          })) as Record<string, unknown>

          const head = prData.head as Record<string, unknown> | undefined
          const headSha = head?.sha as string | undefined
          if (!headSha) {
            return {
              state: prData.mergeable_state as string || (prData.state as string),
              mergeable: prData.mergeable as boolean | undefined,
              checks: [],
            } satisfies PullRequestStatus
          }

          const checksResponse = yield* Effect.tryPromise({
            try: () =>
              fetch(
                githubApiUrl(
                  `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/commits/${headSha}/check-runs`,
                ),
                { headers: githubHeaders(token) },
              ),
            catch: (error) => new GitHubApiError({ message: String(error), status: 0 }),
          })

          const checksData = (yield* Effect.tryPromise({
            try: () => handleResponse(checksResponse) as Promise<{ check_runs: Record<string, unknown>[] }>,
            catch: (error) => error as Error,
          })) as { check_runs: Record<string, unknown>[] }

          return {
            state: prData.mergeable_state as string || (prData.state as string),
            mergeable: prData.mergeable as boolean | undefined,
            checks: (checksData.check_runs ?? []).map((run: Record<string, unknown>) => ({
              name: run.name as string,
              conclusion: run.conclusion as string | undefined,
              status: run.status as string,
              started_at: run.started_at as string | undefined,
              completed_at: run.completed_at as string | undefined,
              html_url: run.html_url as string | undefined,
            })),
          } satisfies PullRequestStatus
        }),

        listPullRequests: Effect.fn("GitHubService.listPullRequests")(function* (input) {
          const params = new URLSearchParams()
          if (input.state) params.set("state", input.state)

          const response = yield* Effect.tryPromise({
            try: () =>
              fetch(
                `${githubApiUrl(`/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/pulls`)}?${params.toString()}`,
                { headers: githubHeaders(token) },
              ),
            catch: (error) => new GitHubApiError({ message: String(error), status: 0 }),
          })
          const data = (yield* Effect.tryPromise({
            try: () => handleResponse(response) as Promise<Record<string, unknown>[]>,
            catch: (error) => error as Error,
          })) as Record<string, unknown>[]

          return data.map((pr: Record<string, unknown>) => ({
            number: pr.number as number,
            title: pr.title as string,
            body: pr.body as string | undefined,
            state: pr.state as string,
            html_url: pr.html_url as string,
            created_at: pr.created_at as string,
            updated_at: pr.updated_at as string,
            head_branch: (pr.head as Record<string, unknown>).ref as string,
            base_branch: (pr.base as Record<string, unknown>).ref as string,
            owner: input.owner,
            repo: input.repo,
          } satisfies PullRequest))
        }),
      }),
    ),
  )
