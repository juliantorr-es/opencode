import { Schema } from "effect"

/**
 * Public IPC error codes — stable vocabulary.
 *
 * - `unavailable` — required subsystem not ready
 * - `invalid_request` — decoding or precondition failure
 * - `permission_denied` — sender or operation lacks authority
 * - `timeout` — operation exceeded declared boundary timeout
 * - `not_found` — requested public resource does not exist
 * - `conflict` — valid request cannot be applied against current state
 * - `cancelled` — execution interrupted by shutdown or explicit cancellation
 * - `rate_limited` — too many requests
 * - `unsupported` — current platform or build cannot perform the operation
 * - `internal` — unknown defect captured and redacted
 */
export const IpcErrorCode = Schema.Literals([
  "unavailable",
  "invalid_request",
  "permission_denied",
  "timeout",
  "not_found",
  "conflict",
  "cancelled",
  "rate_limited",
  "unsupported",
  "internal",
])
export type IpcErrorCode = typeof IpcErrorCode.Type

/** Recovery classification — whether and how the caller may retry. */
export const Recoverability = Schema.Literals(["recoverable", "non-recoverable", "retryable"])
export type Recoverability = typeof Recoverability.Type

/** Public IPC error with redacted safe message and recovery hints. */
export const PublicIpcError = Schema.Struct({
  code: IpcErrorCode,
  message: Schema.String,
  recoverability: Recoverability,
  retryAfterMs: Schema.optional(Schema.Number),
  details: Schema.optional(Schema.Unknown),
})
export type PublicIpcError = typeof PublicIpcError.Type
