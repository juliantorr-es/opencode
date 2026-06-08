/**
 * @tribunus/client — Error classification
 *
 * Classifies HTTP / transport responses into typed error classes so callers
 * can handle retries, fallbacks, and user-facing messages without parsing
 * raw status codes or response bodies.
 */

import type { Receipt } from "./transport.js"

// ── Base error ──────────────────────────────────────────────────────

export class TribunusClientError extends Error {
  readonly _tag: string
  readonly status: number
  readonly receipt?: Receipt

  constructor(tag: string, message: string, status: number, receipt?: Receipt) {
    super(message)
    this.name = tag
    this._tag = tag
    this.status = status
    this.receipt = receipt
  }
}

// ── Typed error subclasses ──────────────────────────────────────────

export class TransportError extends TribunusClientError {
  readonly _tag = "TransportError" as const

  constructor(message: string, status: number, receipt?: Receipt) {
    super("TransportError", message, status, receipt)
  }
}

export class ValidationError extends TribunusClientError {
  readonly _tag = "ValidationError" as const

  constructor(message: string, status: number, receipt?: Receipt) {
    super("ValidationError", message, status, receipt)
  }
}

export class AuthorizationError extends TribunusClientError {
  readonly _tag = "AuthorizationError" as const

  constructor(message: string, status: number, receipt?: Receipt) {
    super("AuthorizationError", message, status, receipt)
  }
}

export class NotFoundError extends TribunusClientError {
  readonly _tag = "NotFoundError" as const

  constructor(message: string, status: number, receipt?: Receipt) {
    super("NotFoundError", message, status, receipt)
  }
}

export class ConflictError extends TribunusClientError {
  readonly _tag = "ConflictError" as const

  constructor(message: string, status: number, receipt?: Receipt) {
    super("ConflictError", message, status, receipt)
  }
}

export class ServerError extends TribunusClientError {
  readonly _tag = "ServerError" as const

  constructor(message: string, status: number, receipt?: Receipt) {
    super("ServerError", message, status, receipt)
  }
}

// ── Message helpers ─────────────────────────────────────────────────

function extractMessage(body: unknown): string | undefined {
  if (typeof body === "object" && body !== null) {
    const obj = body as Record<string, unknown>
    return (
      (typeof obj.message === "string" && obj.message) ||
      (typeof obj.error === "string" && obj.error) ||
      (typeof obj.name === "string" && obj.name) ||
      undefined
    )
  }
  if (typeof body === "string" && body.length > 0) return body
  return undefined
}

function fallbackMessage(status: number): string {
  if (status === 0 || status === undefined) return "Network error — no response received"
  if (status === 400) return "Bad request — invalid input"
  if (status === 401) return "Unauthorized — missing or invalid credentials"
  if (status === 403) return "Forbidden — insufficient permissions"
  if (status === 404) return "Resource not found"
  if (status === 409) return "Conflict — resource already exists or state mismatch"
  if (status >= 500 && status < 600) return `Server error (${status})`
  if (status >= 400 && status < 500) return `Client error (${status})`
  return `Unexpected response (${status})`
}

// ── Classifier ──────────────────────────────────────────────────────

/**
 * Classify an HTTP status code and optional response body into a typed
 * `TribunusClientError`. Picks the most specific error subclass based
 * on the status code. Extracts human-readable message from the body
 * when available, falling back to a status-derived default.
 */
export function classifyError(
  status: number,
  body?: unknown,
  receipt?: Receipt,
): TribunusClientError {
  const message = extractMessage(body) ?? fallbackMessage(status)

  if (status === 0 || status === undefined || isNaN(status))
    return new TransportError(message, status, receipt)
  if (status === 400) return new ValidationError(message, status, receipt)
  if (status === 401 || status === 403)
    return new AuthorizationError(message, status, receipt)
  if (status === 404) return new NotFoundError(message, status, receipt)
  if (status === 409) return new ConflictError(message, status, receipt)
  if (status >= 500 && status < 600) return new ServerError(message, status, receipt)
  if (status >= 400 && status < 500) return new ValidationError(message, status, receipt)
  return new ServerError(message, status, receipt)
}
