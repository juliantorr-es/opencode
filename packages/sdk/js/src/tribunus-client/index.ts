/**
 * @tribunus/client — TypeScript SDK entry point
 *
 * Transport-agnostic semantic client for the Tribunus protocol.
 *
 * Usage:
 *   import { createTribunusClient, createTribunusClientHttp } from "@tribunus/client";
 *   const client = createTribunusClientHttp("http://localhost:8080");
 *   const { data } = await client.createProject("my-project");
 *   // data.project_id
 */

// ── Re-exports ──────────────────────────────────────────────────────

export { TribunusClient } from "./operations.js"
export { HttpTransport } from "./http-transport.js"
export type { Transport, TransportResult, Receipt, TransportRequestOptions } from "./transport.js"
export {
  TribunusClientError,
  TransportError,
  ValidationError,
  AuthorizationError,
  NotFoundError,
  ConflictError,
  ServerError,
  classifyError,
} from "./errors.js"

// ── Factory functions ───────────────────────────────────────────────

import { TribunusClient } from "./operations.js"
import { classifyError } from "./errors.js"
import type { Transport, TransportResult } from "./transport.js"

/**
 * Create a TribunusClient from any Transport implementation.
 *
 * ```ts
 * const client = createTribunusClient(myTransport)
 * ```
 */
export function createTribunusClient(transport: Transport): TribunusClient {
  return new TribunusClient(transport)
}

/**
 * Create a TribunusClient backed by a basic HTTP Transport.
 *
 * ```ts
 * const client = createTribunusClientHttp("https://api.tribunus.dev", "sk-…")
 * await client.createProject("my-project")
 * ```
 */
export function createTribunusClientHttp(baseUrl: string, token?: string): TribunusClient {
  return new TribunusClient(httpTransport(baseUrl, token))
}

// ── Internal HTTP transport wrapper ─────────────────────────────────

function httpTransport(baseUrl: string, token?: string): Transport {
  const normalizedBase = baseUrl.endsWith("/") ? baseUrl : baseUrl + "/"

  return {
    async request<T>(method: string, path: string, options?: { body?: unknown; headers?: Record<string, string> }) {
      const url = new URL(path.replace(/^\//, ""), normalizedBase)

      const headers: Record<string, string> = {
        ...options?.headers,
      }

      if (token) {
        headers["authorization"] = `Bearer ${token}`
      }

      if (options?.body !== undefined && method !== "GET" && method !== "HEAD") {
        headers["content-type"] = "application/json"
      }

      const res = await fetch(url.toString(), {
        method,
        headers,
        body: options?.body !== undefined ? JSON.stringify(options.body) : undefined,
      })

      const body: unknown = await res.json()
      const status = res.status

      if (status >= 200 && status < 300) {
        return body as TransportResult<T>
      }

      throw classifyError(status, body)
    },

    close() {
      // No-op for fetch-based transport
    },
  }
}
