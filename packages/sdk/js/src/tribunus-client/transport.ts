/**
 * @tribunus/client — Transport abstraction
 *
 * Minimal transport interface for any protocol backend (HTTP, WebSocket, RPC).
 * Implementors provide request/response plumbing; the client layer adds
 * idempotency, error classification, and receipt envelopes on top.
 *
 * A Transport implementation MUST forward the `Idempotency-Key` header
 * on mutation requests so the server can deduplicate retries.
 */

// ── Receipt ──────────────────────────────────────────────────────────

export interface Receipt {
  receipt_id: string
  timestamp: string
  entity_type: string
  entity_id: string
  outcome: "success" | "failure" | "pending"
}

// ── Transport request options ────────────────────────────────────────

export interface TransportRequestOptions {
  /** JSON-serialisable body to send */
  body?: unknown
  /** Additional headers (transport may merge its own auth headers) */
  headers?: Record<string, string>
}

// ── Transport result envelope (wire format) ──────────────────────────

export interface TransportResult<T = unknown> {
  data: T
  receipt: Receipt
  status: number
}

// ── Transport interface ──────────────────────────────────────────────

export interface Transport {
  request<T>(
    method: string,
    path: string,
    options?: TransportRequestOptions,
  ): Promise<TransportResult<T>>

  /**
   * Optional streaming subscription.
   * Returns an unsubscribe function.
   */
  subscribe?(channel: string, handler: (event: unknown) => void): () => void

  /** Release any held resources (abort pending requests, close sockets). */
  close(): void
}
