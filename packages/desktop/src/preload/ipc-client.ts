import { ipcRenderer } from "electron"
import type { IpcOk, IpcErr } from "../ipc/protocol"

/** Stable renderer-facing error — never exposes raw wire internals. */
export class RenderableIpcError extends Error {
  readonly code: string
  readonly recoverability: "recoverable" | "non-recoverable" | "retryable"
  readonly retryAfterMs?: number
  readonly requestId?: string

  constructor(err: IpcErr["error"], requestId?: string) {
    super(err.message)
    this.name = "IpcError"
    this.code = err.code
    this.recoverability = err.recoverability
    this.retryAfterMs = err.retryAfterMs
    this.requestId = requestId
  }
}

/**
 * Structural validation of the IPC result envelope.
 * Checks ok, protocolVersion, requestId, and error shape.
 * No runtime Schema dependency — works in sandboxed preload.
 */
function validateIpcResult(rawResult: unknown): rawResult is IpcOk | IpcErr {
  if (rawResult === null || typeof rawResult !== "object") return false
  const obj = rawResult as Record<string, unknown>
  if (typeof obj.ok !== "boolean") return false
  if (typeof obj.protocolVersion !== "number") return false
  if (typeof obj.requestId !== "string") return false
  if (obj.ok) return "value" in obj
  if (!("error" in obj)) return false
  const err = obj.error
  if (err === null || typeof err !== "object") return false
  const e = err as Record<string, unknown>
  return typeof e.code === "string" && typeof e.message === "string"
}

/**
 * Invoke an IPC channel through the v2 protocol.
 *
 * Validates the wire envelope in every environment.
 * Success payload validation is deferred to the main process
 * (which decodes against the declared contract schema).
 * Returns the raw value — callers cast to their expected type.
 *
 * Throws RenderableIpcError for any envelope violation or remote error.
 */
export async function typedInvokeV2<S = unknown>(
  channel: string,
  _successSchema: unknown,
  ...args: unknown[]
): Promise<unknown> {
  const rawResult: unknown = await ipcRenderer.invoke(channel, ...args)

  if (!validateIpcResult(rawResult)) {
    throw new RenderableIpcError({
      code: "internal",
      message: "IPC protocol violation: response is not a valid IPC result",
      recoverability: "non-recoverable",
    })
  }

  const result = rawResult as IpcOk | IpcErr

  if (result.protocolVersion !== 1) {
    throw new RenderableIpcError({
      code: "internal",
      message: `IPC protocol version mismatch: got ${result.protocolVersion}`,
      recoverability: "non-recoverable",
    })
  }

  if (result.ok) {
    return result.value
  }

  throw new RenderableIpcError(result.error, result.requestId)
}
