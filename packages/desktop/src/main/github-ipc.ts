import crypto from "node:crypto"
import { net, safeStorage, shell } from "electron"
import { Effect } from "effect"
import { registerIpcEffectHandler } from "./ipc-adapter"
import type { DesktopRuntime } from "./effect/desktop-runtime"
import { getGithubClientId } from "./app-config"
import { IPC } from "./ipc-channels"
import { getStore } from "./store"
import { setSecret, getSecret, deleteSecret } from "./desktop-secret-store"
import * as S from "../ipc/schema-compat"
import { mapGithubError, GithubDisallowedHostnameError, GithubUnauthenticatedError, GithubInvalidOAuthStateError, GithubOAuthRejectedError } from "./errors/github-errors"
const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token"

type PkceState = {
  code_verifier: string
  state: string
}

const pendingOAuth = new Map<string, PkceState>()

function generateCodeVerifier(): string {
  return crypto.randomBytes(32).toString("base64url")
}

async function generateCodeChallenge(verifier: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))
  return Buffer.from(hash).toString("base64url")
}

export function registerGithubIpcHandlers(runtime: DesktopRuntime) {
  registerIpcEffectHandler(runtime, {
    channel: IPC.handle.GITHUB_OAUTH_START,
    params: S.Tuple([]),
    success: S.Str,
    timeout: 30_000,
    senderPolicy: "strict",
    mapError: mapGithubError,
  }, () => Effect.tryPromise(async () => {
    const codeVerifier = generateCodeVerifier()
    const codeChallenge = await generateCodeChallenge(codeVerifier)
    const state = crypto.randomBytes(16).toString("hex")
    const clientId = getGithubClientId()
    const authorizeUrl = `https://github.com/login/oauth/authorize?client_id=${clientId}&redirect_uri=opencode://github-oauth&scope=repo,user&state=${state}&code_challenge=${codeChallenge}&code_challenge_method=S256`
    pendingOAuth.set(state, { code_verifier: codeVerifier, state })
    await shell.openExternal(authorizeUrl)
    return state
  }))

  registerIpcEffectHandler(runtime, {
    channel: IPC.handle.GITHUB_OAUTH_CALLBACK,
    params: S.Tuple([S.Str, S.Str]),
    success: S.UndefinedConst,
    timeout: 60_000,
    senderPolicy: "strict",
    mapError: mapGithubError,
  }, (params: unknown) => Effect.gen(function* () {
    const arr = params as [string, string]
    const [code, state] = arr
    const pkce = pendingOAuth.get(state)
    if (!pkce) return yield* Effect.fail(new GithubInvalidOAuthStateError())
    pendingOAuth.delete(state)
    const clientId = getGithubClientId()
    const response = yield* Effect.tryPromise(() =>
      net.fetch(GITHUB_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: new URLSearchParams({
          client_id: clientId,
          code,
          redirect_uri: "tribunus://github-oauth",
          code_verifier: pkce.code_verifier,
        }),
      })
    )
    const data = yield* Effect.tryPromise(() => response.json()) as unknown as Record<string, unknown>
    if (data && typeof data === "object" && "access_token" in data) {
      const accessToken = (data as Record<string, unknown>).access_token
      if (typeof accessToken === "string") {
        const encrypted = safeStorage.encryptString(accessToken)
        getStore("github-auth").set("token", encrypted.toString("base64"))
      }
    }
    if (data && typeof data === "object" && "error" in data) {
      const err = (data as Record<string, unknown>).error
      const errDesc = (data as Record<string, unknown>).error_description
      return yield* Effect.fail(new GithubOAuthRejectedError())
    }
    return yield* Effect.succeed(undefined)
  }).pipe(Effect.orDie))

  registerIpcEffectHandler(runtime, {
    channel: IPC.handle.GITHUB_GET_TOKEN,
    params: S.Tuple([]),
    success: S.Nullable(S.Str),
    timeout: 30_000,
    senderPolicy: "strict",
    mapError: mapGithubError,
  }, () => Effect.tryPromise(async () => {
    const result = await getSecret({ namespace: "github", key: "default" })
    if (result !== null) return result

    // Migration: check old electron-store for a token and promote it
    const raw = getStore("github-auth").get("token") as string | undefined
    if (raw) {
      try {
        const token = safeStorage.decryptString(Buffer.from(raw, "base64"))
        await setSecret({ namespace: "github", key: "default" }, token)
        getStore("github-auth").delete("token")
        return token
      } catch {
        return null
      }
    }
    return null
  }))

  registerIpcEffectHandler(runtime, {
    channel: IPC.handle.GITHUB_SET_TOKEN,
    params: S.Tuple([S.Str]),
    success: S.UndefinedConst,
    timeout: 30_000,
    senderPolicy: "strict",
    mapError: mapGithubError,
  }, (params: unknown) => Effect.tryPromise(async () => {
    const [token] = params as [string]
    await setSecret({ namespace: "github", key: "default" }, token)
  }))

  registerIpcEffectHandler(runtime, {
    channel: IPC.handle.GITHUB_CLEAR_TOKEN,
    params: S.Tuple([]),
    success: S.UndefinedConst,
    timeout: 30_000,
    senderPolicy: "strict",
    mapError: mapGithubError,
  }, () => Effect.tryPromise(async () => {
    await deleteSecret({ namespace: "github", key: "default" })
  }))

  registerIpcEffectHandler(runtime, {
    channel: IPC.handle.GITHUB_API_PROXY,
    params: S.Tuple([S.Str, S.Optional(S.Struct({
      method: S.Optional(S.Str),
      headers: S.Optional(S.Rec(S.Str, S.Str)),
      body: S.Optional(S.Str),
    }))]),
    success: S.Struct({ status: S.Num, body: S.Str }),
    timeout: 60_000,
    senderPolicy: "strict",
    mapError: mapGithubError,
  }, (params: unknown) => Effect.gen(function* () {
    const [url, options] = params as [string, { method?: string; headers?: Record<string, string>; body?: string } | undefined]
    const token = yield* Effect.tryPromise(() => getSecret({ namespace: "github", key: "default" }))
    if (!token) return yield* Effect.fail(new GithubUnauthenticatedError())

    const urlObj = new URL(url)
    const allowed = ["api.github.com", "uploads.github.com"]
    if (!allowed.includes(urlObj.hostname)) {
      return yield* Effect.fail(new GithubDisallowedHostnameError(urlObj.hostname))
    }

    const response = yield* Effect.tryPromise(() =>
      net.fetch(url, {
        method: options?.method ?? "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "opencode-desktop",
          ...options?.headers,
        },
        body: options?.body,
      })
    )
    return { status: response.status, body: yield* Effect.tryPromise(() => response.text()) }
  }).pipe(Effect.orDie))
}
