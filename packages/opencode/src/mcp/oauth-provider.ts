import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js"
import type {
  OAuthClientMetadata,
  OAuthTokens,
  OAuthClientInformation,
  OAuthClientInformationFull,
} from "@modelcontextprotocol/sdk/shared/auth.js"
import { Effect } from "effect"
import { McpAuth } from "./auth"
import * as Log from "@opencode-ai/core/util/log"

const log = Log.create({ service: "mcp.oauth" })

const OAUTH_CALLBACK_PORT = 19876
const OAUTH_CALLBACK_PATH = "/mcp/oauth/callback"

export interface McpOAuthConfig {
  clientId?: string
  clientSecret?: string
  scope?: string
  callbackPort?: number
  redirectUri?: string
}

export interface McpOAuthCallbacks {
  onRedirect: (url: URL) => void | Promise<void>
}

export class McpOAuthProvider implements OAuthClientProvider {
  constructor(
    private mcpName: string,
    private serverUrl: string,
    private config: McpOAuthConfig,
    private callbacks: McpOAuthCallbacks,
    private auth: McpAuth.Interface,
  ) {}

  get redirectUrl(): string {
    if (this.config.redirectUri) {
      return this.config.redirectUri
    }
    const port = this.config.callbackPort ?? OAUTH_CALLBACK_PORT
    return `http://127.0.0.1:${port}${OAUTH_CALLBACK_PATH}`
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      redirect_uris: [this.redirectUrl],
      client_name: "OpenCode",
      client_uri: "https://opencode.ai",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: this.config.clientSecret ? "client_secret_post" : "none",
      ...(this.config.scope ? { scope: this.config.scope } : {}),
    }
  }

  async clientInformation(): Promise<OAuthClientInformation | undefined> {
    // Check config first (pre-registered client)
    if (this.config.clientId) {
      return {
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
      }
    }

    // Check stored client info (from dynamic registration)
    // Use getForUrl to validate credentials are for the current server URL
    let entry: McpAuth.Entry | undefined
    try {
      entry = await Effect.runPromise(this.auth.getForUrl(this.mcpName, this.serverUrl))
    } catch (error) {
      log.error("failed to get client info for mcp", { mcpName: this.mcpName, error })
      return undefined
    }
    if (entry?.clientInfo) {
      // Check if client secret has expired
      if (entry.clientInfo.clientSecretExpiresAt && entry.clientInfo.clientSecretExpiresAt < Date.now() / 1000) {
        log.info("client secret expired, need to re-register", { mcpName: this.mcpName })
        return undefined
      }
      return {
        client_id: entry.clientInfo.clientId,
        client_secret: entry.clientInfo.clientSecret,
      }
    }

    // No client info or URL changed - will trigger dynamic registration
    return undefined
  }

  async saveClientInformation(info: OAuthClientInformationFull): Promise<void> {
    try {
      await Effect.runPromise(
        this.auth.updateClientInfo(
          this.mcpName,
          {
            clientId: info.client_id,
            clientSecret: info.client_secret,
            clientIdIssuedAt: info.client_id_issued_at,
            clientSecretExpiresAt: info.client_secret_expires_at,
          },
          this.serverUrl,
        ),
      )
    } catch (error) {
      log.error("failed to save client information", { mcpName: this.mcpName, error })
    }
    log.info("saved dynamically registered client", {
      mcpName: this.mcpName,
      clientId: info.client_id,
    })
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    // Use getForUrl to validate tokens are for the current server URL
    let entry: McpAuth.Entry | undefined
    try {
      entry = await Effect.runPromise(this.auth.getForUrl(this.mcpName, this.serverUrl))
    } catch (error) {
      log.error("failed to get tokens entry", { mcpName: this.mcpName, error })
      return undefined
    }
    if (!entry?.tokens) return undefined

    return {
      access_token: entry.tokens.accessToken,
      token_type: "Bearer",
      refresh_token: entry.tokens.refreshToken,
      expires_in: entry.tokens.expiresAt
        ? Math.max(0, Math.floor(entry.tokens.expiresAt - Date.now() / 1000))
        : undefined,
      scope: entry.tokens.scope,
    }
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    try {
      await Effect.runPromise(
        this.auth.updateTokens(
          this.mcpName,
          {
            accessToken: tokens.access_token,
            refreshToken: tokens.refresh_token,
            expiresAt: tokens.expires_in ? Date.now() / 1000 + tokens.expires_in : undefined,
            scope: tokens.scope,
          },
          this.serverUrl,
        ),
      )
    } catch (error) {
      log.error("failed to save tokens", { mcpName: this.mcpName, error })
    }
    log.info("saved oauth tokens", { mcpName: this.mcpName })
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    log.info("redirecting to authorization", { mcpName: this.mcpName, url: authorizationUrl.toString() })
    await this.callbacks.onRedirect(authorizationUrl)
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    try {
      await Effect.runPromise(this.auth.updateCodeVerifier(this.mcpName, codeVerifier))
    } catch (error) {
      log.error("failed to save code verifier", { mcpName: this.mcpName, error })
    }
  }

  async codeVerifier(): Promise<string> {
    let entry: McpAuth.Entry | undefined
    try {
      entry = await Effect.runPromise(this.auth.get(this.mcpName))
    } catch (error) {
      log.error("failed to get code verifier entry", { mcpName: this.mcpName, error })
      throw new Error(`No code verifier saved for MCP server: ${this.mcpName}`)
    }
    if (!entry?.codeVerifier) {
      throw new Error(`No code verifier saved for MCP server: ${this.mcpName}`)
    }
    return entry.codeVerifier
  }

  async saveState(state: string): Promise<void> {
    try {
      await Effect.runPromise(this.auth.updateOAuthState(this.mcpName, state))
    } catch (error) {
      log.error("failed to save oauth state", { mcpName: this.mcpName, error })
    }
  }

  async state(): Promise<string> {
    let entry: McpAuth.Entry | undefined
    try {
      entry = await Effect.runPromise(this.auth.get(this.mcpName))
    } catch (error) {
      log.error("failed to get oauth state", { mcpName: this.mcpName, error })
    }
    if (entry?.oauthState) {
      return entry.oauthState
    }

    // Generate a new state if none exists — the SDK calls state() as a
    // generator, not just a reader, so we need to produce a value even when
    // startAuth() hasn't pre-saved one (e.g. during automatic auth on first
    // connect).
    const newState = Array.from(crypto.getRandomValues(new Uint8Array(32)))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
    try {
      await Effect.runPromise(this.auth.updateOAuthState(this.mcpName, newState))
    } catch (error) {
      log.error("failed to save new oauth state", { mcpName: this.mcpName, error })
    }
    return newState
  }

  async invalidateCredentials(type: "all" | "client" | "tokens"): Promise<void> {
    log.info("invalidating credentials", { mcpName: this.mcpName, type })
    let entry: McpAuth.Entry | undefined
    try {
      entry = await Effect.runPromise(this.auth.get(this.mcpName))
    } catch (error) {
      log.error("failed to get credentials entry for invalidation", { mcpName: this.mcpName, error })
      return
    }
    if (!entry) {
      return
    }

    switch (type) {
      case "all":
        try {
          await Effect.runPromise(this.auth.remove(this.mcpName))
        } catch (error) {
          log.error("failed to remove credentials", { mcpName: this.mcpName, error })
        }
        break
      case "client":
        delete entry.clientInfo
        try {
          await Effect.runPromise(this.auth.set(this.mcpName, entry))
        } catch (error) {
          log.error("failed to save credentials after client removal", { mcpName: this.mcpName, error })
        }
        break
      case "tokens":
        delete entry.tokens
        try {
          await Effect.runPromise(this.auth.set(this.mcpName, entry))
        } catch (error) {
          log.error("failed to save credentials after token removal", { mcpName: this.mcpName, error })
        }
        break
    }
  }
}

export { OAUTH_CALLBACK_PORT, OAUTH_CALLBACK_PATH }

/**
 * Parse a redirect URI to extract port and path for the callback server.
 * Returns defaults if the URI can't be parsed.
 */
export function parseRedirectUri(redirectUri?: string): { port: number; path: string } {
  if (!redirectUri) {
    return { port: OAUTH_CALLBACK_PORT, path: OAUTH_CALLBACK_PATH }
  }

  try {
    const url = new URL(redirectUri)
    const port = url.port ? parseInt(url.port, 10) : url.protocol === "https:" ? 443 : 80
    const path = url.pathname || OAUTH_CALLBACK_PATH
    return { port, path }
  } catch {
    return { port: OAUTH_CALLBACK_PORT, path: OAUTH_CALLBACK_PATH }
  }
}
