/**
 * Structured error codes for plugin tools.
 *
 * Tools return JSON strings with an `error_code` field so callers
 * can programmatically classify failures without string-matching.
 */
export enum ErrorCode {
  /** Resource not found — file, plan, roadmap item, session, etc. Use when a lookup returns nothing. */
  NOT_FOUND = "NOT_FOUND",
  /** Permission denied — authorization failure, tool blocked, policy violation. Use when the caller lacks rights. */
  PERMISSION_DENIED = "PERMISSION_DENIED",
  /** Operation timed out — network, subprocess, or lock acquisition exceeded deadline. Use when a wait expires. */
  TIMEOUT = "TIMEOUT",
  /** Transient failure — retryable error like network blip, lock contention, rate limit. Caller should retry. */
  TRANSIENT = "TRANSIENT",
  /** Invalid arguments — missing required fields, wrong types, out-of-range values. Use for input validation failures. */
  INVALID_ARGUMENTS = "INVALID_ARGUMENTS",
  /** Conflict — resource already exists, concurrent modification, duplicate submission. Use when the state prevents the action. */
  CONFLICT = "CONFLICT",
  /** Unknown action — tool received an action string that doesn't match any handler. Use for unsupported operations. */
  UNKNOWN_ACTION = "UNKNOWN_ACTION",
  /** Internal error — unexpected failure, unhandled exception, corruption. Use as a catch-all for truly unexpected errors. */
  INTERNAL_ERROR = "INTERNAL_ERROR",
  /** Cancelled — operation was aborted by signal or user request before completion. */
  CANCELLED = "CANCELLED",
  /** Validation error — input failed schema or business rule validation beyond simple missing/invalid arguments. */
  VALIDATION_ERROR = "VALIDATION_ERROR",
}

/**
 * Runtime guard: throws TypeError if `code` is not a valid ErrorCode value.
 * TypeScript types are erased at runtime — bare strings must be caught.
 */
function assertValidErrorCode(code: string): asserts code is ErrorCode {
  if (!Object.values(ErrorCode).includes(code as ErrorCode)) {
    throw new TypeError(
      `Invalid error code: "${code}". Must be one of: ${Object.values(ErrorCode).join(", ")}`,
    )
  }
}

/** Options for makeError(). */
export interface MakeErrorOptions {
  /**
   * Status field override.
   *
   * Defaults to `"error"`.
   *
   * **Migration support (Phase 2–3):**
   * - `"fail"` — used by 16 tools that currently return `{ status: "fail" }`.
   * - `"blocked"` — used by 5+ tools that currently return `{ status: "blocked" }`.
   *
   * | Status     | Count | Example tool categories                     |
   * |------------|-------|---------------------------------------------|
   * | `"error"`  | ~40   | New tools, most .opencode/tools/            |
   * | `"fail"`   | 16    | git_status, git_diff, smart_grep, etc.      |
   * | `"blocked"`| 5+    | file_lock (acquire conflict), gate (blocked) |
   */
  status?: string
  /** Optional details object attached to the error payload. */
  details?: unknown
}

/** Parsed error structure returned by parseToolError(). */
export interface ParsedError {
  error: string
  status: string
  error_code: string
  details?: unknown
}

/**
 * Produce a structured JSON error string.
 *
 * Output format:
 * ```json
 * {
 *   "error": "<message>",
 *   "status": "error",
 *   "error_code": "NOT_FOUND"
 * }
 * ```
 *
 * @param code - One of the ErrorCode enum values. Runtime-validated.
 * @param message - Human-readable error description.
 * @param opts - Optional overrides for status, details.
 * @returns A JSON string suitable as a tool's error return value.
 *
 * @throws TypeError if `code` is not a valid ErrorCode value.
 */
export function makeError(code: ErrorCode, message: string, opts?: MakeErrorOptions): string {
  assertValidErrorCode(code)
  const payload: Record<string, unknown> = {
    error: message,
    status: opts?.status ?? "error",
    error_code: code,
  }
  if (opts?.details !== undefined) {
    payload.details = opts.details
  }
  try {
    return JSON.stringify(payload, null, 2)
  } catch {
    // Fallback: circular references or non-serializable values.
    // Return minimal error with INTERNAL_ERROR code so tool execution
    // does not crash on a serialization failure.
    return JSON.stringify(
      { error: message, status: "error", error_code: ErrorCode.INTERNAL_ERROR },
      null,
      2,
    )
  }
}

/**
 * Parse a tool output string into a structured error, or `null` if it is not an error.
 *
 * An error is defined as valid JSON with *both* `"error"` and `"error_code"` keys.
 */
export function parseToolError(output: string): ParsedError | null {
  try {
    const parsed = JSON.parse(output)
    if (typeof parsed !== "object" || parsed === null) return null
    if (!("error" in parsed) || !("error_code" in parsed)) return null
    return parsed as ParsedError
  } catch {
    return null
  }
}

/**
 * Returns `true` when the tool output is a success (i.e. *not* a structured error).
 *
 * Success means the string is either valid JSON without an `"error"` + `"error_code"` pair,
 * or non-JSON text.
 */
export function isSuccess(output: string): boolean {
  return parseToolError(output) === null
}

/**
 * Returns `true` when the tool output is a structured error
 * (valid JSON containing both `"error"` and `"error_code"` keys).
 */
export function isError(output: string): boolean {
  return parseToolError(output) !== null
}
