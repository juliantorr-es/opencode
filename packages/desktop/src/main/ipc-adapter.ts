import { ipcMain, type IpcMainInvokeEvent } from "electron"
import { checkSender, type IpcSenderInfo, type IpcFrameInfo, type SenderCheck } from "./ipc-sender"
import { Cause, Effect, Exit, Schema } from "effect"
import { newRequestId } from "../ipc/request"
import type { DesktopRuntime } from "./effect/desktop-runtime"


/** Options for {@link registerIpcEffectHandler}. */
export interface IpcHandlerOptions<P, S> {
  /** Electron ipcMain.handle channel name. */
  readonly channel: string
  /** Schema for decoding the invoke payload. */
  readonly params: Schema.Schema<any>
  /** Schema for encoding the success value. */
  readonly success: Schema.Schema<any>
  /** Timeout in milliseconds (default 30 000). */
  readonly timeout?: number | undefined
  /** Sender verification policy (default `"standard"`). */
  readonly senderPolicy?: "standard" | "strict" | undefined
  /**
   * Map a domain error to a public IPC error.
   * Return `null` (or nothing) to fall through to catch-all handling.
   */
  readonly mapError?: ((error: unknown) => PublicIpcError | null) | undefined
}

// ---------------------------------------------------------------------------
// Helper — build the public-error payload used when we cannot reach mapError
// or the call-back wants a structured shape.
// ---------------------------------------------------------------------------

type ErrorPayload = {
  readonly code:
    | "unavailable"
    | "invalid_request"
    | "permission_denied"
    | "timeout"
    | "not_found"
    | "conflict"
    | "cancelled"
    | "rate_limited"
    | "unsupported"
    | "internal"
  readonly message: string
  readonly recoverability: "recoverable" | "non-recoverable" | "retryable"
}

// Imported via full path for type — desktop must not import from @tribunus/core
import type { PublicIpcError } from "../ipc/errors"

// ---------------------------------------------------------------------------
// registerIpcEffectHandler
// ---------------------------------------------------------------------------

/**
 * Register an Effect-based IPC handler that executes through `DesktopRuntime`.
 *
 * Every invocation goes through:
 * 1. Sender authorization (`checkSender`)
 * 2. Request identity creation (`newRequestId`)
 * 3. Parameter decoding (`Schema.decodeUnknownSync`)
 * 4. Execution through `DesktopRuntime` with optional timeout
 * 5. Typed error mapping (`options.mapError`)
 * 6. Result encoding (`Schema.encodeSync`)
 * 7. Unknown defect redaction to `"internal"`
 *
 * The handler signature is `(params: P) => Effect.Effect<S, never, never>` —
 * all domain errors are expected to be caught/mapped inside the handler or
 * through `options.mapError`.
 */
export function registerIpcEffectHandler<P, S>(
  runtime: DesktopRuntime,
  options: IpcHandlerOptions<P, S>,
  handler: (params: P) => Effect.Effect<S, never, never>,
): void {
  ipcMain.handle(options.channel, async (event: IpcMainInvokeEvent, ...rawArgs: unknown[]) => {
    // 1. Sender authorization ------------------------------------------------
    const frame: IpcFrameInfo | undefined = event?.senderFrame
      ? { url: event.senderFrame.url, isMainFrame: event.senderFrame === event.sender?.mainFrame }
      : undefined
    const senderCheck = checkSender(
      event?.sender as unknown as IpcSenderInfo,
      options.senderPolicy ?? "standard",
      frame,
    )
    if (!senderCheck.allowed) {
      return okError({ requestId: newRequestId(), error: permissionError(senderCheck.reason) })
    }

    // 2. Request identity ----------------------------------------------------
    const requestId = newRequestId()

    // 3. Parameter decoding --------------------------------------------------
    let params: P
    try {
      // beta.66 Schema type mismatch: Schema.Schema<any> vs Decoder<unknown, never>
      const decode = Schema.decodeUnknownSync(options.params as unknown as Parameters<typeof Schema.decodeUnknownSync>[0])
      params = decode(rawArgs)
    } catch {
      return okError({
        requestId,
        error: { code: "invalid_request", message: "Request validation failed", recoverability: "non-recoverable" },
      })
    }

    // 4. Execute through runtime --------------------------------------------
    const timeout = options.timeout ?? 30_000
    const timed = handler(params).pipe(Effect.timeout(timeout))
    const exit: Exit.Exit<any, any> = await runtime.runPromiseExit(timed)

    // 5. Success -------------------------------------------------------------
    if (Exit.isSuccess(exit)) {
      try {
        const encode = Schema.encodeSync(options.success as unknown as Parameters<typeof Schema.encodeSync>[0])
        const encoded = encode(exit.value)
        return okSuccess({ requestId, value: encoded })
      } catch (encodeErr) {
        // Encoding the success value itself failed — redact.
        console.error("[adapter] encode failed for", options.channel, "value:", typeof exit.value, JSON.stringify(exit.value)?.slice(0, 200), "error:", (encodeErr as Error).message)
        return okError({
          requestId,
          error: { code: "internal", message: "Failed to encode response", recoverability: "non-recoverable" },
        })
      }
    }

    // 6. Domain error mapping ------------------------------------------------
    const cause = exit.cause
    const error = squashFailure(cause)
    console.error("[adapter] error mapping for", options.channel, "cause:", !!cause, "error:", typeof error, "mapError:", !!options.mapError, error instanceof Error ? (error as Error).message : String(error).slice(0, 100))
    {
      const mapped = error !== undefined ? options.mapError?.(error) : null
      if (mapped) {
        return okError({ requestId, error: { code: mapped.code, message: mapped.message, recoverability: mapped.recoverability } })
      }
    }

    // 7. Timeout detection ---------------------------------------------------
    if (error !== undefined && typeof error === "object" && error !== null) {
      const tag = (error as Record<string, unknown>)._tag
      if (tag === "TimeoutError") {
        return okError({
          requestId,
          error: { code: "timeout", message: `Operation timed out after ${timeout}ms`, recoverability: "retryable" },
        })
      }
    }

    // 8. Interruption (graceful shutdown) ------------------------------------
    if (Cause.hasInterruptsOnly(cause)) {
      return okError({
        requestId,
        error: { code: "cancelled", message: "Operation cancelled due to shutdown", recoverability: "recoverable" },
      })
    }

    // 9. Unknown defect — redact to internal ---------------------------------
    return okError({
      requestId,
      error: { code: "internal", message: "An unexpected error occurred", recoverability: "non-recoverable" },
    })
  })
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Attempt to extract the first failure value from a `Cause`.
 * Returns `undefined` when the cause is empty or cannot be squashed.
 * Safe to call — never throws.
 */function squashFailure(cause: Cause.Cause<unknown>): unknown {
  try {
    const peeled = Cause.squash(cause)
    return peeled
  } catch (err) {
    console.error("[adapter] squashFailure failed:", (err as Error).message, "cause:", Cause.pretty(cause)?.slice(0, 200))
    return undefined
  }
}

/** Build a success envelope. */
function okSuccess(opts: { requestId: string; value: unknown }) {
  return {
    ok: true as const,
    protocolVersion: 1 as const,
    requestId: opts.requestId,
    value: opts.value,
  }
}

/** Build a failure envelope. */
function okError(opts: { requestId: string; error: ErrorPayload }) {
  return {
    ok: false as const,
    protocolVersion: 1 as const,
    requestId: opts.requestId,
    error: opts.error,
  }
}

/** Shortcut for permission-denied errors. */
function permissionError(reason: string): ErrorPayload {
  return { code: "permission_denied", message: reason, recoverability: "non-recoverable" }
}
