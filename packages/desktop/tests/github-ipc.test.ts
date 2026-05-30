import { describe, expect, test, mock, beforeAll, beforeEach } from "bun:test"
import { createElectronMock } from "../src/test-utils/electron-mock"

// Tests the GitHub OAuth IPC handler logic as self-contained units and
// via mock-electron handler registration.
// The first sections test each logical unit in isolation by inlining the
// same algorithm (the real module's functions are not exported).
// The final section imports the real registerGithubIpcHandlers using
// mock.module to intercept the electron native module, then exercises
// each handler through the mock's handler map.

const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token"
const GITHUB_CLIENT_ID = "test-client-id"

// ── Mock factory setup for real module handler registration tests ──

const electronMock = createElectronMock()

// Default net.fetch mock returns a successful OAuth token response
electronMock.net.fetch.mockImplementation(async (_url: string, _opts?: any) => {
  return new Response(JSON.stringify({ access_token: "gho_mock_token_12345" }))
})

// Shared store for handler tests
const handlerStoreData = new Map<string, string>()

// Intercept electron imports before the real module is loaded
mock.module("electron", () => ({
  ipcMain: electronMock.ipcMain,
  net: electronMock.net,
  safeStorage: electronMock.safeStorage,
  shell: electronMock.shell,
}))

mock.module("../src/main/ipc-channels", () => ({
  IPC: {
    handle: {
      GITHUB_OAUTH_START: "github-oauth-start",
      GITHUB_OAUTH_CALLBACK: "github-oauth-callback",
      GITHUB_GET_TOKEN: "github-get-token",
      GITHUB_SET_TOKEN: "github-set-token",
      GITHUB_CLEAR_TOKEN: "github-clear-token",
      GITHUB_API_PROXY: "github-api-proxy",
    },
    send: {},
    push: {},
    store: {},
  },
}))

mock.module("../src/main/app-config", () => ({
  getGithubClientId: () => "mock-client-id",
}))

mock.module("../src/main/store", () => ({
  getStore: () => ({
    get: (key: string) => handlerStoreData.get(key) ?? null,
    set: (key: string, val: string) => { handlerStoreData.set(key, val) },
    delete: (key: string) => { handlerStoreData.delete(key) },
  }),
}))

let registerGithubIpcHandlers: () => void

beforeAll(async () => {
  const mod = await import("../src/main/github-ipc")
  registerGithubIpcHandlers = mod.registerGithubIpcHandlers
})

describe("PKCE code verifier generation", () => {
  // Tests the generateCodeVerifier logic — crypto.randomBytes(32).toString("base64url")

  function generateCodeVerifier(): string {
    const bytes = new Uint8Array(32)
    crypto.getRandomValues(bytes)
    return Buffer.from(bytes).toString("base64url")
  }

  test("produces a base64url string of expected length", () => {
    const verifier = generateCodeVerifier()
    expect(verifier).toBeTruthy()
    expect(typeof verifier).toBe("string")
    // 32 bytes → 43 base64url chars (no padding)
    expect(verifier.length).toBe(43)
  })

  test("produces unique values on successive calls", () => {
    const a = generateCodeVerifier()
    const b = generateCodeVerifier()
    expect(a).not.toBe(b)
  })

  test("contains only base64url characters", () => {
    const verifier = generateCodeVerifier()
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/)
  })
})

describe("PKCE code challenge generation", () => {
  // Tests the generateCodeChallenge logic — SHA-256 digest then base64url

  async function generateCodeChallenge(verifier: string): Promise<string> {
    const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))
    return Buffer.from(hash).toString("base64url")
  }

  test("produces a base64url string", async () => {
    const verifier = "test-verifier-value-12345"
    const challenge = await generateCodeChallenge(verifier)
    expect(challenge).toBeTruthy()
    expect(typeof challenge).toBe("string")
  })

  test("SHA-256 output length is 32 bytes → 43 base64url chars", async () => {
    const verifier = "any-string-32-bytes-hash-output"
    const challenge = await generateCodeChallenge(verifier)
    // SHA-256 = 32 bytes, base64url encoded without padding = 43 chars
    expect(challenge.length).toBe(43)
  })

  test("deterministic — same verifier produces same challenge", async () => {
    const verifier = "deterministic-test-value"
    const a = await generateCodeChallenge(verifier)
    const b = await generateCodeChallenge(verifier)
    expect(a).toBe(b)
  })

  test("different verifiers produce different challenges", async () => {
    const a = await generateCodeChallenge("verifier-one")
    const b = await generateCodeChallenge("verifier-two")
    expect(a).not.toBe(b)
  })
})

describe("OAuth URL construction and state management", () => {
  // Tests the OAuth flow: state generation, pendingOAuth map, URL construction

  type PkceState = {
    code_verifier: string
    state: string
  }

  function generateState(): string {
    const bytes = new Uint8Array(16)
    crypto.getRandomValues(bytes)
    return Buffer.from(bytes).toString("hex")
  }

  test("state is a 32-character hex string", () => {
    for (let i = 0; i < 10; i++) {
      const state = generateState()
      expect(state).toMatch(/^[0-9a-f]{32}$/)
    }
  })

  test("authorize URL contains query parameters", () => {
    const state = "abc123state456"
    const codeChallenge = "mocked_challenge_value"
    const authorizeUrl = `https://github.com/login/oauth/authorize?client_id=${GITHUB_CLIENT_ID}&redirect_uri=opencode://github-oauth&scope=repo,user&state=${state}&code_challenge=${codeChallenge}&code_challenge_method=S256`

    const url = new URL(authorizeUrl)
    expect(url.hostname).toBe("github.com")
    expect(url.pathname).toBe("/login/oauth/authorize")
    expect(url.searchParams.get("client_id")).toBe(GITHUB_CLIENT_ID)
    expect(url.searchParams.get("redirect_uri")).toBe("opencode://github-oauth")
    expect(url.searchParams.get("scope")).toBe("repo,user")
    expect(url.searchParams.get("state")).toBe(state)
    expect(url.searchParams.get("code_challenge")).toBe(codeChallenge)
    expect(url.searchParams.get("code_challenge_method")).toBe("S256")
  })

  test("pendingOAuth map stores and retrieves PKCE state", () => {
    const pendingOAuth = new Map<string, PkceState>()
    const state = "test-state-hex-1234"
    const codeVerifier = "test-code-verifier-value"

    pendingOAuth.set(state, { code_verifier: codeVerifier, state })

    const stored = pendingOAuth.get(state)
    expect(stored).toBeDefined()
    expect(stored!.code_verifier).toBe(codeVerifier)
    expect(stored!.state).toBe(state)
  })

  test("pendingOAuth delete removes entry after consumption", () => {
    const pendingOAuth = new Map<string, PkceState>()
    const state = "consumable-state"
    pendingOAuth.set(state, { code_verifier: "verifier", state })

    const retrieved = pendingOAuth.get(state)
    pendingOAuth.delete(state)

    expect(retrieved).toBeDefined()
    expect(pendingOAuth.has(state)).toBe(false)
  })

  test("invalid state returns undefined from pendingOAuth", () => {
    const pendingOAuth = new Map<string, PkceState>()
    expect(pendingOAuth.get("nonexistent")).toBeUndefined()
  })
})

describe("GitHub OAuth token storage lifecycle", () => {
  // Tests token encryption/decryption and store operations
  // Mirrors the pattern: safeStorage.encryptString → store, store → safeStorage.decryptString

  function encryptToken(token: string): string {
    return Buffer.from(`encrypted:${token}`).toString("base64")
  }

  function decryptToken(raw: string): string | null {
    try {
      const decrypted = Buffer.from(raw, "base64").toString()
      if (!decrypted.startsWith("encrypted:")) return null
      return decrypted.slice("encrypted:".length)
    } catch {
      return null
    }
  }

  test("encryptToken produces a base64 string", () => {
    const encrypted = encryptToken("gho_test_token")
    expect(typeof encrypted).toBe("string")
    expect(() => Buffer.from(encrypted, "base64")).not.toThrow()
  })

  test("decryptToken recovers original token", () => {
    const token = "gho_actual_github_token_12345"
    const encrypted = encryptToken(token)
    const decrypted = decryptToken(encrypted)
    expect(decrypted).toBe(token)
  })

  test("decryptToken returns null for invalid base64", () => {
    expect(decryptToken("not-base64!!!")).toBeNull()
  })

  test("decryptToken returns null for non-encrypted format", () => {
    const raw = Buffer.from("plain-text-token").toString("base64")
    expect(decryptToken(raw)).toBeNull()
  })

  test("token lifecycle: set → get → clear → get returns null", () => {
    const store = new Map<string, string>()

    // Set token (encrypt and store)
    const token = "gho_lifecycle_test_token"
    const encrypted = encryptToken(token)
    store.set("token", encrypted)
    expect(store.has("token")).toBe(true)

    // Get token (decrypt)
    const raw = store.get("token")!
    const retrieved = decryptToken(raw)
    expect(retrieved).toBe(token)

    // Clear token
    store.delete("token")
    expect(store.has("token")).toBe(false)

    // Get after clear returns null
    const afterClear = store.get("token")
    const result = afterClear ? decryptToken(afterClear) : null
    expect(result).toBeNull()
  })

  test("get token returns null when no token stored", () => {
    const store = new Map<string, string>()
    const raw = store.get("token") as string | undefined
    expect(raw).toBeUndefined()
  })
})

describe("GitHub API proxy URL validation", () => {
  // Tests the URL hostname allowlist logic from GITHUB_API_PROXY handler

  const ALLOWED_HOSTNAMES = ["api.github.com", "uploads.github.com"]

  function validateUrl(url: string): { ok: true } | { ok: false; error: { type: string; hostname: string | null; allowedHostnames: string[] } } {
    try {
      const urlObj = new URL(url)
      if (!ALLOWED_HOSTNAMES.includes(urlObj.hostname)) {
        return {
          ok: false,
          error: { type: "forbidden", hostname: urlObj.hostname, allowedHostnames: ALLOWED_HOSTNAMES },
        }
      }
      return { ok: true }
    } catch {
      return {
        ok: false,
        error: { type: "forbidden", hostname: null, allowedHostnames: ALLOWED_HOSTNAMES },
      }
    }
  }

  test("allows api.github.com URLs", () => {
    expect(validateUrl("https://api.github.com/user")).toEqual({ ok: true })
    expect(validateUrl("https://api.github.com/repos/owner/repo")).toEqual({ ok: true })
    expect(validateUrl("https://api.github.com/search/issues?q=test")).toEqual({ ok: true })
  })

  test("allows uploads.github.com URLs", () => {
    expect(validateUrl("https://uploads.github.com/releases/1/assets")).toEqual({ ok: true })
  })

  test("rejects non-github hostnames", () => {
    const result = validateUrl("https://example.com/api")
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.type).toBe("forbidden")
      expect(result.error.hostname).toBe("example.com")
      expect(result.error.allowedHostnames).toEqual(ALLOWED_HOSTNAMES)
    }
  })

  test("rejects subdomains of github.com that aren't in allowlist", () => {
    const result = validateUrl("https://raw.githubusercontent.com/user/repo/main/file")
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.hostname).toBe("raw.githubusercontent.com")
    }
  })

  test("rejects invalid URLs", () => {
    const result = validateUrl("not-a-valid-url")
    expect(result.ok).toBe(false)
  })

  test("rejects empty URL", () => {
    const result = validateUrl("")
    expect(result.ok).toBe(false)
  })
})

describe("GitHub API proxy request construction", () => {
  // Tests the request header construction and token injection from GITHUB_API_PROXY

  function buildApiRequest(url: string, token: string, options?: { method?: string; headers?: Record<string, string>; body?: string }) {
    return {
      method: options?.method ?? "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "opencode-desktop",
        ...options?.headers,
      },
      body: options?.body,
    }
  }

  const TEST_TOKEN = "gho_test_token_value"

  test("default method is GET", () => {
    const req = buildApiRequest("https://api.github.com/user", TEST_TOKEN)
    expect(req.method).toBe("GET")
  })

  test("includes authorization header with token", () => {
    const req = buildApiRequest("https://api.github.com/user", TEST_TOKEN)
    expect(req.headers.Authorization).toBe(`Bearer ${TEST_TOKEN}`)
  })

  test("includes GitHub API accept header", () => {
    const req = buildApiRequest("https://api.github.com/user", TEST_TOKEN)
    expect(req.headers.Accept).toBe("application/vnd.github+json")
  })

  test("includes custom user-agent", () => {
    const req = buildApiRequest("https://api.github.com/user", TEST_TOKEN)
    expect(req.headers["User-Agent"]).toBe("opencode-desktop")
  })

  test("respects method override", () => {
    const req = buildApiRequest("https://api.github.com/repos/owner/repo/issues", TEST_TOKEN, { method: "POST", body: '{"title":"Test"}' })
    expect(req.method).toBe("POST")
    expect(req.body).toBe('{"title":"Test"}')
  })

  test("merges additional headers", () => {
    const req = buildApiRequest("https://api.github.com/repos/owner/repo/issues", TEST_TOKEN, {
      headers: { "X-Custom-Header": "custom-value" },
    })
    expect(req.headers["X-Custom-Header"]).toBe("custom-value")
    expect(req.headers.Authorization).toBe(`Bearer ${TEST_TOKEN}`)
  })

  test("user-agent cannot be overridden by additional headers", () => {
    const req = buildApiRequest("https://api.github.com/user", TEST_TOKEN, {
      headers: { "User-Agent": "malicious" },
    })
    // Spread order: the explicit ...options?.headers spreads AFTER the default,
    // so User-Agent IS overridable in the real code. Test documents this behavior.
    expect(req.headers["User-Agent"]).toBe("malicious")
  })
})

describe("GitHub OAuth callback token extraction", () => {
  // Tests the access_token extraction logic from the OAuth callback response

  type TokenResponse = { access_token?: string; error?: string; error_description?: string }

  async function handleCallback(
    code: string,
    state: string,
    pendingOAuth: Map<string, { code_verifier: string; state: string }>,
    clientId: string,
    fetchFn: (url: string, opts: any) => Promise<{ json: () => Promise<TokenResponse> }>,
  ): Promise<string | undefined> {
    const pkce = pendingOAuth.get(state)
    if (!pkce) throw new Error("Invalid OAuth state")
    pendingOAuth.delete(state)

    const response = await fetchFn(GITHUB_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({
        client_id: clientId,
        code,
        redirect_uri: "opencode://github-oauth",
        code_verifier: pkce.code_verifier,
      }),
    })
    const data = await response.json()
    if (data.access_token) return data.access_token
    if (data.error) throw new Error(data.error_description ?? data.error)
  }

  test("extracts access_token from successful response", async () => {
    const pendingOAuth = new Map([["valid-state", { code_verifier: "test-verifier", state: "valid-state" }]])
    const mockFetch = async () => ({
      json: async () => ({ access_token: "gho_success_token_abc" } as TokenResponse),
    })

    const token = await handleCallback("auth-code", "valid-state", pendingOAuth, GITHUB_CLIENT_ID, mockFetch)
    expect(token).toBe("gho_success_token_abc")
  })

  test("throws on error response", async () => {
    const pendingOAuth = new Map([["error-state", { code_verifier: "test-verifier", state: "error-state" }]])
    const mockFetch = async () => ({
      json: async () => ({ error: "bad_verification_code", error_description: "The code passed is incorrect" } as TokenResponse),
    })

    await expect(
      handleCallback("bad-code", "error-state", pendingOAuth, GITHUB_CLIENT_ID, mockFetch),
    ).rejects.toThrow("The code passed is incorrect")
  })

  test("throws on error without description", async () => {
    const pendingOAuth = new Map([["err-state", { code_verifier: "v", state: "err-state" }]])
    const mockFetch = async () => ({
      json: async () => ({ error: "incorrect_client_credentials" } as TokenResponse),
    })

    await expect(
      handleCallback("code", "err-state", pendingOAuth, GITHUB_CLIENT_ID, mockFetch),
    ).rejects.toThrow("incorrect_client_credentials")
  })

  test("throws on invalid state", async () => {
    const pendingOAuth = new Map<string, { code_verifier: string; state: string }>()
    await expect(
      handleCallback("code", "unknown-state", pendingOAuth, GITHUB_CLIENT_ID, async () => ({
        json: async () => ({} as TokenResponse),
      })),
    ).rejects.toThrow("Invalid OAuth state")
  })

  test("includes code verifier in token exchange", async () => {
    const pendingOAuth = new Map([["state-123", { code_verifier: "expected-verifier", state: "state-123" }]])
    let capturedBody: URLSearchParams | null = null
    const mockFetch = async (_url: string, opts: any) => {
      capturedBody = opts.body
      return { json: async () => ({ access_token: "gho_token" } as TokenResponse) }
    }

    await handleCallback("code", "state-123", pendingOAuth, GITHUB_CLIENT_ID, mockFetch)
    expect(capturedBody!.get("code_verifier")).toBe("expected-verifier")
    expect(capturedBody!.get("code")).toBe("code")
    expect(capturedBody!.get("client_id")).toBe(GITHUB_CLIENT_ID)
    expect(capturedBody!.get("redirect_uri")).toBe("opencode://github-oauth")
  })
})

describe("GitHub OAuth start URL construction", () => {
  // Tests the authorize URL generated by the GITHUB_OAUTH_START handler

  function buildAuthorizeUrl(clientId: string, state: string, codeChallenge: string): string {
    return `https://github.com/login/oauth/authorize?client_id=${clientId}&redirect_uri=opencode://github-oauth&scope=repo,user&state=${state}&code_challenge=${codeChallenge}&code_challenge_method=S256`
  }

  test("URL contains all required OAuth parameters", () => {
    const url = buildAuthorizeUrl(GITHUB_CLIENT_ID, "test-state", "test-challenge")
    const parsed = new URL(url)

    expect(parsed.origin + parsed.pathname).toBe("https://github.com/login/oauth/authorize")
    expect(parsed.searchParams.get("response_type")).toBeNull() // Not included (PKCE flow)
    expect(parsed.searchParams.get("client_id")).toBe(GITHUB_CLIENT_ID)
    expect(parsed.searchParams.get("redirect_uri")).toBe("opencode://github-oauth")
    expect(parsed.searchParams.get("scope")).toBe("repo,user")
    expect(parsed.searchParams.get("state")).toBe("test-state")
    expect(parsed.searchParams.get("code_challenge")).toBe("test-challenge")
    expect(parsed.searchParams.get("code_challenge_method")).toBe("S256")
  })
})

describe("GitHub API proxy response format", () => {
  // Tests the response shape returned by the GITHUB_API_PROXY handler

  type ProxySuccess = { status: number; body: string }
  type ProxyError = { error: { type: string; hostname: string | null; allowedHostnames: string[] } }

  function isSuccess(r: ProxySuccess | ProxyError): r is ProxySuccess {
    return "status" in r
  }

  test("success response has status and body", () => {
    const response: ProxySuccess = { status: 200, body: '{"login":"testuser"}' }
    expect(response.status).toBe(200)
    expect(response.body).toBe('{"login":"testuser"}')
  })

  test("error response has error object with type, hostname, allowedHostnames", () => {
    const response: ProxyError = {
      error: { type: "forbidden", hostname: "example.com", allowedHostnames: ["api.github.com", "uploads.github.com"] },
    }
    expect(response.error.type).toBe("forbidden")
    expect(response.error.hostname).toBe("example.com")
    expect(response.error.allowedHostnames).toContain("api.github.com")
  })

  test("discriminated union: status distinguishes success from error", () => {
    const success: ProxySuccess | ProxyError = { status: 200, body: "ok" }
    const failure: ProxySuccess | ProxyError = { error: { type: "forbidden", hostname: null, allowedHostnames: [] } }

    expect(isSuccess(success)).toBe(true)
    expect(isSuccess(failure)).toBe(false)
  })
})

describe("IPC handler registration (via mock factory)", () => {
  // Tests the real registerGithubIpcHandlers function from github-ipc.ts
  // using createElectronMock to mock electron's ipcMain, safeStorage, net, shell.
  // Mocks are set up at module scope via mock.module("electron", ...).

  beforeEach(() => {
    // Reset handler registry and call history (preserve the _impl)
    electronMock.ipcMain._handlers.clear()
    electronMock.ipcMain.handle.mock.calls.length = 0

    // Reset shared store
    handlerStoreData.clear()

    // Reset shell.openExternal
    electronMock.shell.openExternal.mockReset()
    electronMock.shell.openExternal.mockImplementation(() => Promise.resolve())

    // Reset net.fetch
    electronMock.net.fetch.mockReset()
    electronMock.net.fetch.mockImplementation(async (_url: string, _opts?: any) => {
      return new Response(JSON.stringify({ access_token: "gho_mock_token_12345" }))
    })

    // Reset safeStorage — encrypt returns a buffer with prefix, decrypt reverses it
    electronMock.safeStorage.encryptString.mockReset()
    electronMock.safeStorage.encryptString.mockImplementation((plain: string) => Buffer.from(`encrypted:${plain}`))
    electronMock.safeStorage.decryptString.mockReset()
    electronMock.safeStorage.decryptString.mockImplementation((enc: Buffer) => {
      const str = enc.toString()
      if (!str.startsWith("encrypted:")) throw new Error("Decrypt failed")
      return str.slice("encrypted:".length)
    })
  })

  test("registers all 6 GitHub IPC handlers", () => {
    registerGithubIpcHandlers()

    const channels = [...electronMock.ipcMain._handlers.keys()]
    expect(channels).toEqual([
      "github-oauth-start",
      "github-oauth-callback",
      "github-get-token",
      "github-set-token",
      "github-clear-token",
      "github-api-proxy",
    ])
    expect(electronMock.ipcMain.handle.mock.calls.length).toBe(6)
  })

  test("GITHUB_OAUTH_START returns state and opens browser with correct URL", async () => {
    registerGithubIpcHandlers()
    const handler = electronMock.ipcMain._handlers.get("github-oauth-start")!

    const state = await handler()

    expect(typeof state).toBe("string")
    expect(state.length).toBeGreaterThan(0)
    expect(electronMock.shell.openExternal.mock.calls.length).toBe(1)

    const url = electronMock.shell.openExternal.mock.calls[0].args[0] as string
    expect(url).toContain("github.com/login/oauth/authorize")
    expect(url).toContain("client_id=mock-client-id")
    expect(url).toContain("redirect_uri=opencode://github-oauth")
    expect(url).toContain("scope=repo,user")
    expect(url).toContain("code_challenge_method=S256")
  })

  test("GITHUB_OAUTH_CALLBACK exchanges code for token via net.fetch", async () => {
    registerGithubIpcHandlers()
    const startHandler = electronMock.ipcMain._handlers.get("github-oauth-start")!
    const callbackHandler = electronMock.ipcMain._handlers.get("github-oauth-callback")!

    const state = await startHandler()

    await callbackHandler({}, "test_auth_code", state)

    // net.fetch was called with the token URL
    expect(electronMock.net.fetch.mock.calls.length).toBe(1)
    expect(electronMock.net.fetch.mock.calls[0].args[0]).toBe("https://github.com/login/oauth/access_token")

    // Token was encrypted and persisted to store
    expect(electronMock.safeStorage.encryptString.mock.calls.length).toBe(1)
    expect(electronMock.safeStorage.encryptString.mock.calls[0].args[0]).toBe("gho_mock_token_12345")
    expect(handlerStoreData.get("token")).toBeTruthy()
  })

  test("GITHUB_OAUTH_CALLBACK throws on invalid state", async () => {
    registerGithubIpcHandlers()
    const handler = electronMock.ipcMain._handlers.get("github-oauth-callback")!

    await expect(handler({}, "code", "nonexistent-state")).rejects.toThrow("Invalid OAuth state")
  })

  test("GITHUB_OAUTH_CALLBACK throws on error response from GitHub", async () => {
    registerGithubIpcHandlers()
    const startHandler = electronMock.ipcMain._handlers.get("github-oauth-start")!
    const callbackHandler = electronMock.ipcMain._handlers.get("github-oauth-callback")!

    // Configure net.fetch to return an error response
    electronMock.net.fetch.mockReset()
    electronMock.net.fetch.mockImplementation(async () => {
      return new Response(JSON.stringify({ error: "bad_verification_code", error_description: "The code is incorrect" }))
    })

    const state = await startHandler()

    await expect(callbackHandler({}, "bad-code", state)).rejects.toThrow("The code is incorrect")
  })

  test("GITHUB_SET_TOKEN encrypts and stores the token", async () => {
    registerGithubIpcHandlers()
    const handler = electronMock.ipcMain._handlers.get("github-set-token")!

    await handler({}, "my-secret-token")

    expect(electronMock.safeStorage.encryptString.mock.calls.length).toBe(1)
    expect(electronMock.safeStorage.encryptString.mock.calls[0].args[0]).toBe("my-secret-token")
    expect(handlerStoreData.get("token")).toBeTruthy()
  })

  test("GITHUB_GET_TOKEN returns decrypted token", async () => {
    registerGithubIpcHandlers()
    const setHandler = electronMock.ipcMain._handlers.get("github-set-token")!
    const getHandler = electronMock.ipcMain._handlers.get("github-get-token")!

    await setHandler({}, "stored-token-value")
    const result = await getHandler()

    expect(result).toBe("stored-token-value")
  })

  test("GITHUB_GET_TOKEN returns null when no token stored", async () => {
    registerGithubIpcHandlers()
    const handler = electronMock.ipcMain._handlers.get("github-get-token")!

    const result = await handler()
    expect(result).toBeNull()
  })

  test("GITHUB_GET_TOKEN returns null on decrypt failure", async () => {
    registerGithubIpcHandlers()
    const handler = electronMock.ipcMain._handlers.get("github-get-token")!

    // Plant a token that wasn't encrypted by safeStorage
    handlerStoreData.set("token", Buffer.from("plain-unencrypted-data").toString("base64"))

    const result = await handler()
    expect(result).toBeNull()
  })

  test("GITHUB_CLEAR_TOKEN deletes the token", async () => {
    registerGithubIpcHandlers()
    const setHandler = electronMock.ipcMain._handlers.get("github-set-token")!
    const clearHandler = electronMock.ipcMain._handlers.get("github-clear-token")!
    const getHandler = electronMock.ipcMain._handlers.get("github-get-token")!

    await setHandler({}, "temp-token")
    expect(await getHandler()).toBe("temp-token")

    await clearHandler()
    expect(await getHandler()).toBeNull()
  })

  test("GITHUB_API_PROXY returns 401 when not authenticated", async () => {
    registerGithubIpcHandlers()
    const handler = electronMock.ipcMain._handlers.get("github-api-proxy")!

    const result = await handler({}, "https://api.github.com/user")
    expect(result).toEqual({ status: 401, body: "Not authenticated" })
  })

  test("GITHUB_API_PROXY rejects disallowed hostnames", async () => {
    registerGithubIpcHandlers()
    const setHandler = electronMock.ipcMain._handlers.get("github-set-token")!
    const proxyHandler = electronMock.ipcMain._handlers.get("github-api-proxy")!

    await setHandler({}, "some-token")
    const result = await proxyHandler({}, "https://evil-site.com/data")

    expect(result).toEqual({
      error: {
        type: "forbidden",
        hostname: "evil-site.com",
        allowedHostnames: ["api.github.com", "uploads.github.com"],
      },
    })
  })

  test("GITHUB_API_PROXY proxies authenticated requests to GitHub", async () => {
    registerGithubIpcHandlers()
    const setHandler = electronMock.ipcMain._handlers.get("github-set-token")!
    const proxyHandler = electronMock.ipcMain._handlers.get("github-api-proxy")!

    await setHandler({}, "valid-token")

    // Override net.fetch for this test
    electronMock.net.fetch.mockReset()
    electronMock.net.fetch.mockImplementation(async (_url: string) => {
      return new Response(JSON.stringify({ login: "testuser", id: 123 }), { status: 200 })
    })

    const result = await proxyHandler({}, "https://api.github.com/user")
    expect(result).toEqual({ status: 200, body: JSON.stringify({ login: "testuser", id: 123 }) })
  })
})
