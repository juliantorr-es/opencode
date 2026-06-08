import type { OmpErrorCodeV1, OmpToolEnvelopeV1 } from "./types"

export type { OmpErrorCodeV1 }

export function toolError(
  code: OmpErrorCodeV1,
  message: string,
  opts?: { details?: unknown; retryable?: boolean },
): NonNullable<OmpToolEnvelopeV1["error"]> {
  return {
    code,
    message,
    details: opts?.details,
    retryable: opts?.retryable ?? false,
  }
}

export function policyRefused(
  reason: string,
  code: OmpErrorCodeV1 = "PATH_DENIED",
): NonNullable<OmpToolEnvelopeV1["error"]> {
  return {
    code,
    message: reason,
    retryable: false,
  }
}
