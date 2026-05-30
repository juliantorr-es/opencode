import { Schema } from "effect"

export class GitHubConfig extends Schema.Class<GitHubConfig>("GitHubConfig")({
  token: Schema.optional(Schema.String),
}) {}

export class PullRequest extends Schema.Class<PullRequest>("PullRequest")({
  number: Schema.Number,
  title: Schema.String,
  body: Schema.optional(Schema.String),
  state: Schema.String,
  html_url: Schema.String,
  created_at: Schema.String,
  updated_at: Schema.String,
  head_branch: Schema.String,
  base_branch: Schema.String,
  owner: Schema.String,
  repo: Schema.String,
}) {}

export class CheckRun extends Schema.Class<CheckRun>("CheckRun")({
  name: Schema.String,
  conclusion: Schema.optional(Schema.String),
  status: Schema.String,
  started_at: Schema.optional(Schema.String),
  completed_at: Schema.optional(Schema.String),
  html_url: Schema.optional(Schema.String),
}) {}

export class PullRequestStatus extends Schema.Class<PullRequestStatus>("PullRequestStatus")({
  state: Schema.String,
  checks: Schema.Array(Schema.suspend((): Schema.Schema<CheckRun> => CheckRun)),
  mergeable: Schema.optional(Schema.Boolean),
}) {}
