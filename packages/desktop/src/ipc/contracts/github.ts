import * as S from "../schema-compat"
import type { IpcMethodContract } from "../registry"

// ── Parameter schemas ──
const GithubStartOAuthParams = S.Tuple([])
const GithubOAuthCallbackParams = S.Tuple([S.Str, S.Str])
const GithubGetTokenParams = S.Tuple([])
const GithubSetTokenParams = S.Tuple([S.Str])
const GithubClearTokenParams = S.Tuple([])
const GithubApiProxyParams = S.Tuple([
  S.Str,
  S.Optional(
    S.Struct({
      method: S.Optional(S.Str),
      headers: S.Optional(S.Rec(S.Str, S.Str)),
      body: S.Optional(S.Str),
    }),
  ),
])

// ── Success schemas ──
const GithubStartOAuthSuccess = S.Str
const GithubOAuthCallbackSuccess = S.UndefinedConst
const GithubGetTokenSuccess = S.Nullable(S.Str)
const GithubSetTokenSuccess = S.UndefinedConst
const GithubClearTokenSuccess = S.UndefinedConst
const GithubApiProxySuccess = S.Struct({
  status: S.Num,
  body: S.Str,
})

// ── Shared contract fields ──
const githubFields = {
  category: "github" as const,
  sensitivity: "secret" as const,
  senderPolicy: "strict" as const,
  errors: ["invalid_request", "permission_denied", "timeout", "unavailable", "internal"] as const,
}

// ── Contracts ──
export const contracts: readonly IpcMethodContract[] = [
  {
    ...githubFields,
    channel: "tribunus:github-oauth-start",
    method: "github.startOAuth",
    params: GithubStartOAuthParams,
    success: GithubStartOAuthSuccess,
    timeout: "standard",
    description: "Start GitHub OAuth flow — returns the OAuth URL to open",
  },
  {
    ...githubFields,
    channel: "tribunus:github-oauth-callback",
    method: "github.oauthCallback",
    params: GithubOAuthCallbackParams,
    success: GithubOAuthCallbackSuccess,
    timeout: "long",
    description: "Complete GitHub OAuth callback with authorization code and state",
  },
  {
    ...githubFields,
    channel: "tribunus:github-get-token",
    method: "github.getToken",
    params: GithubGetTokenParams,
    success: GithubGetTokenSuccess,
    timeout: "standard",
    description: "Get the stored GitHub access token, or null if not set",
  },
  {
    ...githubFields,
    channel: "tribunus:github-set-token",
    method: "github.setToken",
    params: GithubSetTokenParams,
    success: GithubSetTokenSuccess,
    timeout: "standard",
    description: "Store a GitHub access token",
  },
  {
    ...githubFields,
    channel: "tribunus:github-clear-token",
    method: "github.clearToken",
    params: GithubClearTokenParams,
    success: GithubClearTokenSuccess,
    timeout: "standard",
    description: "Clear the stored GitHub access token",
  },
  {
    ...githubFields,
    channel: "tribunus:github-api-proxy",
    method: "github.apiProxy",
    params: GithubApiProxyParams,
    success: GithubApiProxySuccess,
    timeout: "long",
    description: "Proxy a request to the GitHub API with the stored token",
  },
]
