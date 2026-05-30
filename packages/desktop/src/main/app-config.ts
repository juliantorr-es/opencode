const GITHUB_CLIENT_ID = "Iv23li7XUy0RKw5TlZ3K"

export function getGithubClientId(): string {
  return process.env.OPENCODE_GITHUB_CLIENT_ID ?? GITHUB_CLIENT_ID
}
