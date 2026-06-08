/**
 * @tribunus/client — Semantic operations
 *
 * Transport-agnostic client wrapping the Transport interface with
 * idempotent semantic operations. Every mutation produces a receipt.
 *
 * Usage:
 *   import { createTribunusClient } from "@tribunus/client";
 *   const client = createTribunusClientHttp("http://localhost:8080");
 *   const result = await client.createProject("my-project");
 */

import type { Transport, TransportResult, Receipt } from "./transport.js"

// ── Helpers ─────────────────────────────────────────────────────────

let idCounter = 0

/** Generate a unique idempotency key for mutation operations. */
function idempotencyKey(): string {
  return `${Date.now().toString(36)}-${(++idCounter).toString(36)}-${crypto.randomUUID().slice(0, 8)}`
}

function ok<T>(data: T, receipt: Receipt, status: number): TransportResult<T> {
  return { data, receipt, status }
}

// ── TribunusClient ──────────────────────────────────────────────────

export class TribunusClient {
  constructor(private readonly transport: Transport) {}

  // ── 1. createProject ────────────────────────────────────────────────

  /**
   * POST /projects
   * Creates a new project. Idempotent (retry-safe).
   */
  async createProject(
    name: string,
    description?: string,
  ): Promise<TransportResult<{ project_id: string }>> {
    const key = idempotencyKey()
    const result = await this.transport.request<{ project_id: string }>("POST", "/projects", {
      body: { name, description },
      headers: { "idempotency-key": key },
    })
    return ok(result.data, result.receipt, result.status)
  }

  // ── 2. openSession ──────────────────────────────────────────────────

  /**
   * POST /projects/{projectId}/sessions
   * Opens a new session within a project.
   */
  async openSession(
    projectId: string,
    config?: { model?: string },
  ): Promise<TransportResult<{ session_id: string }>> {
    const key = idempotencyKey()
    const result = await this.transport.request<{ session_id: string }>(
      "POST",
      `/projects/${encodeURIComponent(projectId)}/sessions`,
      {
        body: { config: config ?? {} },
        headers: { "idempotency-key": key },
      },
    )
    return ok(result.data, result.receipt, result.status)
  }

  // ── 3. enqueueWork ──────────────────────────────────────────────────

  /**
   * POST /sessions/{sessionId}/work
   * Enqueues a work item (tool call, task, query) for a session.
   */
  async enqueueWork(
    sessionId: string,
    work: { type: string; payload: unknown },
  ): Promise<TransportResult<{ work_id: string }>> {
    const key = idempotencyKey()
    const result = await this.transport.request<{ work_id: string }>(
      "POST",
      `/sessions/${encodeURIComponent(sessionId)}/work`,
      {
        body: work,
        headers: { "idempotency-key": key },
      },
    )
    return ok(result.data, result.receipt, result.status)
  }

  // ── 4. observeLifecycle ─────────────────────────────────────────────

  /**
   * GET /{entityType}/{entityId}/lifecycle
   * Fetches the current lifecycle state and history for an entity.
   */
  async observeLifecycle(
    entityType: string,
    entityId: string,
  ): Promise<
    TransportResult<{
      state: string
      history: Array<{ from: string; to: string; timestamp: string }>
    }>
  > {
    const result = await this.transport.request<{
      state: string
      history: Array<{ from: string; to: string; timestamp: string }>
    }>("GET", `/${encodeURIComponent(entityType)}/${encodeURIComponent(entityId)}/lifecycle`)
    return ok(result.data, result.receipt, result.status)
  }

  // ── 5. subscribeToReceipts ──────────────────────────────────────────

  /**
   * Subscribe to receipts for a given entity.
   *
   * Uses `transport.subscribe` when available (WebSocket / SSE),
   * otherwise falls back to polling `GET /receipts/{entityType}/{entityId}`.
   *
   * Returns an unsubscribe function.
   */
  subscribeToReceipts(
    entityType: string,
    entityId: string,
    handler: (receipt: Receipt) => void,
  ): () => void {
    // Prefer native subscription
    if (this.transport.subscribe) {
      const channel = `receipts:${entityType}:${entityId}`
      return this.transport.subscribe(channel, (event) => {
        const receipt = event as Receipt
        if (receipt && typeof receipt === "object" && "receipt_id" in receipt) {
          handler(receipt)
        }
      })
    }

    // ── Polling fallback ──────────────────────────────────────────────
    let lastReceiptId: string | undefined
    let active = true
    const pollIntervalMs = 2000

    const poll = async () => {
      while (active) {
        try {
          const result = await this.transport.request<{ receipts?: Receipt[] }>(
            "GET",
            `/receipts/${encodeURIComponent(entityType)}/${encodeURIComponent(entityId)}${lastReceiptId ? `?after=${encodeURIComponent(lastReceiptId)}` : ""}`,
          )
          const receipts = result.data?.receipts
          if (Array.isArray(receipts)) {
            for (const r of receipts) {
              if (r.receipt_id && r.receipt_id !== lastReceiptId) {
                lastReceiptId = r.receipt_id
                handler(r)
              }
            }
          }
        } catch {
          // Silently retry on next interval
        }

        if (!active) break
        await sleep(pollIntervalMs)
      }
    }

    poll()

    return () => {
      active = false
    }
  }

  // ── 6. requestCapability ────────────────────────────────────────────

  /**
   * POST /sessions/{sessionId}/capabilities
   * Requests a capability (scope) for the session.
   * Idempotent — same { sessionId, capability, scopes } is safe to retry.
   */
  async requestCapability(
    sessionId: string,
    capability: string,
    scopes?: string[],
  ): Promise<TransportResult<{ granted: boolean; receipt_id: string }>> {
    const key = idempotencyKey()
    const result = await this.transport.request<{ granted: boolean; receipt_id: string }>(
      "POST",
      `/sessions/${encodeURIComponent(sessionId)}/capabilities`,
      {
        body: { capability, scopes },
        headers: { "idempotency-key": key },
      },
    )
    return ok(result.data, result.receipt, result.status)
  }

  // ── 7. attachArtifact ───────────────────────────────────────────────

  /**
   * POST /sessions/{sessionId}/artifacts
   * Attaches an artifact (file, data blob, reference) to a session.
   */
  async attachArtifact(
    sessionId: string,
    artifact: { type: string; data: unknown },
  ): Promise<TransportResult<{ artifact_id: string }>> {
    const key = idempotencyKey()
    const result = await this.transport.request<{ artifact_id: string }>(
      "POST",
      `/sessions/${encodeURIComponent(sessionId)}/artifacts`,
      {
        body: artifact,
        headers: { "idempotency-key": key },
      },
    )
    return ok(result.data, result.receipt, result.status)
  }

  // ── 8. publishProjection ────────────────────────────────────────────

  /**
   * POST /projects/{projectId}/projections
   * Publishes a projection (view, materialised query) into the project.
   */
  async publishProjection(
    projectId: string,
    projection: { name: string; data: unknown },
  ): Promise<TransportResult<{ projection_id: string }>> {
    const key = idempotencyKey()
    const result = await this.transport.request<{ projection_id: string }>(
      "POST",
      `/projects/${encodeURIComponent(projectId)}/projections`,
      {
        body: projection,
        headers: { "idempotency-key": key },
      },
    )
    return ok(result.data, result.receipt, result.status)
  }
}

// ── Internal helpers ─────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
