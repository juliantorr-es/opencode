import crypto from "node:crypto"
import { net, safeStorage, shell } from "electron"
import { registerIpcHandler } from "./ipc-registration"
import { getGithubClientId } from "./app-config"
import { IPC } from "./ipc-channels"
import { getStore } from "./store"
import { withIpcResult } from "./ipc-contract"
import { setSecret, getSecret, deleteSecret } from "./desktop-secret-store"
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

export function registerGithubIpcHandlers() {
  registerIpcHandler(IPC.handle.GITHUB_OAUTH_START, async () => {
    return withIpcResult("github.oauth.start", async () => {
      const codeVerifier = generateCodeVerifier()
      const codeChallenge = await generateCodeChallenge(codeVerifier)
      const state = crypto.randomBytes(16).toString("hex")
      const clientId = getGithubClientId()
      const authorizeUrl = `https://github.com/login/oauth/authorize?client_id=${clientId}&redirect_uri=opencode://github-oauth&scope=repo,user&state=${state}&code_challenge=${codeChallenge}&code_challenge_method=S256`
      pendingOAuth.set(state, { code_verifier: codeVerifier, state })
      await shell.openExternal(authorizeUrl)
      return state
    })
  })

  registerIpcHandler(IPC.handle.GITHUB_OAUTH_CALLBACK, async (_event, code: string, state: string) => {
    return withIpcResult("github.oauth.callback", async () => {
      const pkce = pendingOAuth.get(state)
      if (!pkce) throw new Error("Invalid OAuth state")
      pendingOAuth.delete(state)
      const clientId = getGithubClientId()
      const response = await net.fetch(GITHUB_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: new URLSearchParams({
          client_id: clientId,
          code,
          redirect_uri: "tribunus://github-oauth",
          code_verifier: pkce.code_verifier,
        }),
      })
      const data: any = await response.json()
      if (data.access_token) {
        const encrypted = safeStorage.encryptString(data.access_token)
        getStore("github-auth").set("token", encrypted.toString("base64"))
      }
      if (data.error) throw new Error(data.error_description ?? data.error)
    })
  })

  registerIpcHandler(IPC.handle.GITHUB_GET_TOKEN, async () => {
    return withIpcResult("github.token.get", async () => {
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
    })
  })

  registerIpcHandler(IPC.handle.GITHUB_SET_TOKEN, async (_event, token: string) => {
    return withIpcResult("github.token.set", async () => {
      await setSecret({ namespace: "github", key: "default" }, token)
    })
  })

  registerIpcHandler(IPC.handle.GITHUB_CLEAR_TOKEN, async () => {
    return withIpcResult("github.token.clear", async () => {
      await deleteSecret({ namespace: "github", key: "default" })
    })
  })

  registerIpcHandler(IPC.handle.GITHUB_API_PROXY, async (_event, url: string, options?: { method?: string; headers?: Record<string, string>; body?: string }) => {
    return withIpcResult("github.apiProxy", async () => {
      const token = await getSecret({ namespace: "github", key: "default" })
      if (!token) return { status: 401, body: "Not authenticated" }
  
      const urlObj = new URL(url)
      const allowed = ["api.github.com", "uploads.github.com"]
      if (!allowed.includes(urlObj.hostname)) {
        return { error: { type: "forbidden", hostname: urlObj.hostname, allowedHostnames: allowed } }
      }
  
      const response = await net.fetch(url, {
        method: options?.method ?? "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "opencode-desktop",
          ...options?.headers,
        },
        body: options?.body,
      })
      return { status: response.status, body: await response.text() }
    })
  })
}
