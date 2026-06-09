export interface GithubIpcErrorMapping {
  readonly code: "invalid_request" | "permission_denied" | "timeout" | "unavailable" | "unsupported" | "internal"
  readonly message: string
  readonly recoverability: "recoverable" | "non-recoverable" | "retryable"
}

export abstract class GithubError extends Error {
  abstract readonly ipc: GithubIpcErrorMapping
  constructor(message: string) { super(message); this.name = "GithubError" }
}

export class GithubUnauthenticatedError extends GithubError {
  readonly ipc: GithubIpcErrorMapping = { code: "permission_denied", message: "Not authenticated with GitHub", recoverability: "non-recoverable" }
  constructor() { super("Not authenticated"); this.name = "GithubUnauthenticatedError" }
}

export class GithubInvalidOAuthStateError extends GithubError {
  readonly ipc: GithubIpcErrorMapping = { code: "invalid_request", message: "Invalid or expired OAuth state", recoverability: "non-recoverable" }
  constructor() { super("Invalid OAuth state"); this.name = "GithubInvalidOAuthStateError" }
}

export class GithubOAuthRejectedError extends GithubError {
  readonly ipc: GithubIpcErrorMapping = { code: "permission_denied", message: "GitHub OAuth authorization was rejected", recoverability: "non-recoverable" }
  constructor() { super("OAuth rejected"); this.name = "GithubOAuthRejectedError" }
}

export class GithubDisallowedHostnameError extends GithubError {
  readonly ipc: GithubIpcErrorMapping
  constructor(hostname: string) {
    super(`Disallowed proxy hostname: ${hostname}`)
    this.name = "GithubDisallowedHostnameError"
    this.ipc = { code: "permission_denied", message: "Hostname not in GitHub API allowlist", recoverability: "non-recoverable" }
  }
}

export class GithubProxyTimeoutError extends GithubError {
  readonly ipc: GithubIpcErrorMapping = { code: "timeout", message: "GitHub API request timed out", recoverability: "retryable" }
  constructor() { super("Proxy timeout"); this.name = "GithubProxyTimeoutError" }
}

export class GithubUpstreamError extends GithubError {
  readonly ipc: GithubIpcErrorMapping = { code: "unavailable", message: "GitHub API is unreachable", recoverability: "retryable" }
  constructor() { super("Upstream unreachable"); this.name = "GithubUpstreamError" }
}

export class GithubResponseTooLargeError extends GithubError {
  readonly ipc: GithubIpcErrorMapping = { code: "unsupported", message: "GitHub API response exceeds size limit", recoverability: "non-recoverable" }
  constructor() { super("Response too large"); this.name = "GithubResponseTooLargeError" }
}

export function mapGithubError(error: unknown): GithubIpcErrorMapping | null {
  if (error instanceof GithubError) return error.ipc
  return null
}
