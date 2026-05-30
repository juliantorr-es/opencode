import crypto from "node:crypto"
import { safeStorage, net, shell, ipcMain } from "electron"
import { getStore } from "./store"

const GITHUB_CLIENT_ID = "Iv23li7XUy0RKw5TlZ3K"
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

function encryptToken(plaintext: string): string {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error("System keychain not available — cannot encrypt token")
  }
  return safeStorage.encryptString(plaintext).toString("base64")
}

function decryptToken(encoded: string): string {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error("System keychain not available — cannot decrypt token")
  }
  return safeStorage.decryptString(Buffer.from(encoded, "base64"))
}

export function registerGithubIpcHandlers() {
  ipcMain.handle("github-oauth-start", async () => {
    const code_verifier = generateCodeVerifier()
    const code_challenge = await generateCodeChallenge(code_verifier)
    const state = crypto.randomBytes(16).toString("base64url")
    const id = crypto.randomUUID()
    pendingOAuth.set(id, { code_verifier, state })

    const params = new URLSearchParams({
      client_id: GITHUB_CLIENT_ID,
      redirect_uri: "opencode://github-oauth",
      scope: "repo,user",
      state,
      code_challenge,
      code_challenge_method: "S256",
    })
    const authorizeUrl = `https://github.com/login/oauth/authorize?${params.toString()}`
    await shell.openExternal(authorizeUrl)
    return id
  })

  ipcMain.handle("github-oauth-callback", async (_event: Electron.IpcMainInvokeEvent, code: string, state: string) => {
    let foundId: string | undefined
    for (const [id, pkce] of pendingOAuth) {
      if (pkce.state === state) {
        foundId = id
        break
      }
    }
    if (!foundId) throw new Error("OAuth state mismatch — possible CSRF")
    const { code_verifier } = pendingOAuth.get(foundId)!
    pendingOAuth.delete(foundId)

    const body = new URLSearchParams({
      client_id: GITHUB_CLIENT_ID,
      code,
      code_verifier,
      redirect_uri: "opencode://github-oauth",
    })
    const response = await net.fetch(GITHUB_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: body.toString(),
    })
    const data = (await response.json()) as { access_token?: string; error?: string }
    if (!data.access_token) throw new Error(`GitHub OAuth error: ${data.error ?? "unknown"}`)
    const store = getStore("github-auth")
    store.set("access_token", encryptToken(data.access_token))
    return true
  })

  ipcMain.handle("github-get-token", () => {
    const store = getStore("github-auth")
    const encoded = store.get("access_token") as string | undefined
    if (!encoded) return null
    try {
      return decryptToken(encoded)
    } catch {
      store.delete("access_token")
      return null
    }
  })

  ipcMain.handle("github-set-token", (_event: Electron.IpcMainInvokeEvent, token: string) => {
    if (typeof token !== "string" || !token) throw new Error("Invalid token")
    const store = getStore("github-auth")
    store.set("access_token", encryptToken(token))
  })

  ipcMain.handle("github-clear-token", () => {
    const store = getStore("github-auth")
    store.delete("access_token")
  })

  const ALLOWED_GITHUB_HOSTNAMES = ["api.github.com", "uploads.github.com"]

  ipcMain.handle(
    "github-api-proxy",
    async (
      _event: Electron.IpcMainInvokeEvent,
      url: string,
      options?: { method?: string; headers?: Record<string, string>; body?: string },
    ) => {
      if (typeof url !== "string" || !URL.canParse(url)) {
        throw new Error(
          JSON.stringify({
            type: "GitHubProxyError",
            hostname: null,
            allowedHostnames: ALLOWED_GITHUB_HOSTNAMES,
            message: "Invalid URL",
          }),
        )
      }
      const parsed = new URL(url)
      if (!ALLOWED_GITHUB_HOSTNAMES.includes(parsed.hostname)) {
        throw new Error(
          JSON.stringify({
            type: "GitHubProxyError",
            hostname: parsed.hostname,
            allowedHostnames: ALLOWED_GITHUB_HOSTNAMES,
            message: `Hostname not allowed: ${parsed.hostname}`,
          }),
        )
      }

      const store = getStore("github-auth")
      const encoded = store.get("access_token") as string | undefined
      if (!encoded) {
        throw new Error("Not authenticated with GitHub")
      }
      const token = decryptToken(encoded)

      const method = options?.method ?? "GET"
      const headers: Record<string, string> = {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "opencode-desktop",
        ...options?.headers,
      }
      const response = await net.fetch(url, { method, headers, body: options?.body })
      const body = await response.text()
      return { status: response.status, body }
    },
  )
}
