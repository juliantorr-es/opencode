/**
 * @tribunus/client — HTTP transport implementation
 *
 * Default Transport backed by the Fetch API. Handles JSON serialisation,
 * auth headers, receipt extraction, and delegates error classification
 * to `classifyError`.
 */

import type { Transport, TransportResult, Receipt, TransportRequestOptions } from "./transport.js"
import { classifyError, TransportError } from "./errors.js"

export class HttpTransport implements Transport {
  constructor(
    private baseUrl: string,
    private token?: string,
  ) {}

  async request<T>(
    method: string,
    path: string,
    options?: TransportRequestOptions,
  ): Promise<TransportResult<T>> {
    const url = new URL(path.replace(/^\//, ""), normalizedBase(this.baseUrl))

    const headers: Record<string, string> = {
      accept: "application/json",
      ...(options?.headers ?? {}),
    }

    if (this.token) {
      headers["authorization"] = `Bearer ${this.token}`
    }

    const body = options?.body
    if (body !== undefined && method !== "GET" && method !== "HEAD") {
      headers["content-type"] = "application/json"
    }

    let res: Response
    try {
      res = await fetch(url.toString(), {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      })
    } catch (err) {
      throw new TransportError(
        err instanceof Error ? err.message : "Network error — request failed",
        0,
      )
    }

    let parsed: unknown
    const ct = res.headers.get("content-type") ?? ""
    if (ct.includes("application/json")) {
      try {
        parsed = await res.json()
      } catch {
        parsed = await res.text()
      }
    } else {
      parsed = await res.text()
    }

    const receipt = extractReceipt(res, parsed)

    if (!res.ok) {
      throw classifyError(res.status, parsed, receipt)
    }

    return {
      data: parsed as T,
      receipt: receipt ?? {
        receipt_id: "",
        timestamp: new Date().toISOString(),
        entity_type: "",
        entity_id: "",
        outcome: "success" as const,
      },
      status: res.status,
    }
  }

  close(): void {
    // No persistent resources to release for fetch-based transport.
  }
}

// ── Helpers ─────────────────────────────────────────────────────────

function extractReceipt(res: Response, body: unknown): Receipt | undefined {
  const id = res.headers.get("x-receipt-id")
  if (id) {
    return {
      receipt_id: id,
      timestamp: res.headers.get("x-receipt-timestamp") ?? new Date().toISOString(),
      entity_type: res.headers.get("x-receipt-entity-type") ?? "",
      entity_id: res.headers.get("x-receipt-entity-id") ?? "",
      outcome: (res.headers.get("x-receipt-outcome") as Receipt["outcome"]) ?? "success",
    }
  }

  if (typeof body === "object" && body !== null) {
    const obj = body as Record<string, unknown>
    const r = obj.receipt as Record<string, unknown> | undefined
    if (r && typeof r.receipt_id === "string") {
      return {
        receipt_id: r.receipt_id,
        timestamp: (r.timestamp as string) ?? new Date().toISOString(),
        entity_type: (r.entity_type as string) ?? "",
        entity_id: (r.entity_id as string) ?? "",
        outcome: (r.outcome as Receipt["outcome"]) ?? "success",
      }
    }
  }

  return undefined
}

function normalizedBase(raw: string): string {
  return raw.endsWith("/") ? raw : raw + "/"
}
