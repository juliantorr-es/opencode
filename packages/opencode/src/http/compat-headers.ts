/**
 * OpenCode → Tribunus Legacy HTTP Header Compatibility
 *
 * Centralized ingress normalization for legacy `x-opencode-*` HTTP headers.
 * Headers emitted from THIS codebase use `x-tribunus-*` exclusively.
 * Legacy `x-opencode-*` headers are accepted at ingress (read/parse) only.
 *
 * Deprecation horizon:
 *   Introduced:        0.2.0
 *   RemoveLegacyRead:  after 0.3.0  (reject `x-opencode-*` at ingress)
 *   RemoveGate:        after 1.0.0  (delete this module)
 */

const TRIBUNUS_PREFIX = "x-tribunus-" as const
const OPENCODE_PREFIX = "x-opencode-" as const

const warnedSuffixes = new Set<string>()

function buildHeaderKey(prefix: string, suffix: string): string {
  // HTTP headers are case-insensitive per spec; we emit lowercase for consistency.
  return `${prefix}${suffix}`
}

/**
 * Resolve a header value preferring the canonical `x-tribunus-{suffix}` over
 * the legacy `x-opencode-{suffix}`. If both are present the tribunus value wins.
 *
 * Emits a one-time deprecation warning when a legacy header is consumed.
 */
export function resolveHeader(headers: Headers, suffix: string): string | undefined {
  const canonical = headers.get(buildHeaderKey(TRIBUNUS_PREFIX, suffix))
  if (canonical !== null) return canonical

  const legacy = headers.get(buildHeaderKey(OPENCODE_PREFIX, suffix))
  if (legacy !== null) {
    if (!warnedSuffixes.has(suffix)) {
      console.warn(
        `[legacy] x-opencode-${suffix} header is deprecated — use x-tribunus-${suffix} instead`,
      )
      warnedSuffixes.add(suffix)
    }
    return legacy
  }

  return undefined
}

/**
 * Read a legacy `x-opencode-{suffix}` header at ingress only.
 *
 * Returns `undefined` when absent, or `{ value, deprecated: true }` when present.
 * Does NOT check for the canonical `x-tribunus-*` variant — use `resolveHeader`
 * when you want the preference-aware fallback.
 *
 * Marked `deprecated: true` so callers can log or track legacy usage.
 */
export function readLegacyHeader(
  headers: Headers,
  suffix: string,
): { value: string; deprecated: true } | undefined {
  const raw = headers.get(buildHeaderKey(OPENCODE_PREFIX, suffix))
  if (raw === null) return undefined
  return { value: raw, deprecated: true as const }
}

/**
 * Build a set of canonical Tribunus-only response/request headers.
 *
 * Accepts key/value pairs where keys are the bare suffix (e.g. `"locale"`),
 * and produces `{ "x-tribunus-locale": "en-GB" }`.
 *
 * NEVER emits `x-opencode-*` headers.
 */
export function emitTribunusHeaders(
  pairs?: Record<string, string>,
): Record<string, string> {
  if (!pairs) return {}
  const out: Record<string, string> = {}
  for (const [suffix, value] of Object.entries(pairs)) {
    out[buildHeaderKey(TRIBUNUS_PREFIX, suffix)] = value
  }
  return out
}
