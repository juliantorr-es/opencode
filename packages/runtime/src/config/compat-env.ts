/**
 * ConfigCompat — Centralized Environment Variable Compatibility Resolver
 *
 * TRIBUNUS_* is the **canonical** prefix for all environment variables.
 * OPENCODE_* is the **legacy** prefix, supported as a read-only fallback.
 *
 * All environment variable reads across the codebase should eventually flow
 * through this module. This ensures:
 *   - TRIBUNUS_* takes precedence over OPENCODE_* (one-way migration)
 *   - Legacy reads emit observable deprecation events
 *   - Simultaneous TRIBUNUS_* and OPENCODE_* settings are detectable as conflicts
 *
 * @module
 */

const warnedKeys = new Set<string>()
const deprecationListeners = new Set<(key: string, tribunusKey: string, opencodeKey: string) => void>()

/**
 * Subscribe to deprecation events.
 *
 * Called whenever a legacy `OPENCODE_*` variable is read (via `resolveEnv`,
 * `resolveEnvWithConflict`, or explicit `recordDeprecation`).
 *
 * Returns an unsubscribe function.
 *
 * @example
 * ```ts
 * const unsub = onDeprecation((key, tribunusKey, opencodeKey) => {
 *   logger.warn({ key, tribunusKey, opencodeKey }, "legacy env var read")
 * })
 * // later: unsub()
 * ```
 */
export function onDeprecation(
  listener: (key: string, tribunusKey: string, opencodeKey: string) => void,
): () => void {
  deprecationListeners.add(listener)
  return () => {
    deprecationListeners.delete(listener)
  }
}

function warnAndEmit(key: string, tribunusKey: string, opencodeKey: string): void {
  if (warnedKeys.has(opencodeKey)) return
  warnedKeys.add(opencodeKey)
  console.warn(`[deprecated] ${opencodeKey} is deprecated — use ${tribunusKey} instead`)
  for (const listener of deprecationListeners) {
    listener(key, tribunusKey, opencodeKey)
  }
}

/**
 * Emit a deprecation event for a legacy `OPENCODE_*` variable.
 *
 * Useful when a caller reads a legacy var directly (outside `resolveEnv`)
 * but still wants to participate in the deprecation notification system.
 * The warning is emitted at most once per key per process lifetime.
 */
export function recordDeprecation(key: string): void {
  warnAndEmit(key, `TRIBUNUS_${key}`, `OPENCODE_${key}`)
}

/**
 * Resolve an environment variable by checking `TRIBUNUS_{key}` first,
 * then falling back to `OPENCODE_{key}`.
 *
 * - Returns the canonical TRIBUNUS_ value when set.
 * - Falls back to the legacy OPENCODE_ value (emitting a deprecation event).
 * - Returns `undefined` when neither is set.
 *
 * @example
 * ```ts
 * const db = resolveEnv("DATABASE_URL") ?? ":memory:"
 * ```
 */
export function resolveEnv(key: string): string | undefined {
  const tribunusKey = `TRIBUNUS_${key}`
  const opencodeKey = `OPENCODE_${key}`

  const tribunus = process.env[tribunusKey]
  if (tribunus !== undefined) return tribunus

  const legacy = process.env[opencodeKey]
  if (legacy !== undefined) {
    warnAndEmit(key, tribunusKey, opencodeKey)
  }
  return legacy
}

/**
 * Resolve an environment variable with full diagnostic metadata.
 *
 * Returns the resolved value, its **source**, and whether both
 * `TRIBUNUS_*` and `OPENCODE_*` are **simultaneously set** (a
 * conflict that should be resolved by removing the legacy variable).
 *
 * - `"tribunus"` + `conflict: true` — both are set; TRIBUNUS_ wins
 * - `"tribunus"` + `conflict: false` — only TRIBUNUS_ is set
 * - `"opencode"` + `conflict: false` — only OPENCODE_ is set (deprecated)
 * - `"none"` + `conflict: false` — neither is set
 *
 * @example
 * ```ts
 * const result = resolveEnvWithConflict("STATE_HOME")
 * if (result.conflict) {
 *   logger.warn({ key: "STATE_HOME" }, "OPENCODE_STATE_HOME and TRIBUNUS_STATE_HOME both set")
 * }
 * ```
 */
export function resolveEnvWithConflict(key: string): {
  value: string | undefined
  source: "tribunus" | "opencode" | "none"
  conflict: boolean
} {
  const tribunusKey = `TRIBUNUS_${key}`
  const opencodeKey = `OPENCODE_${key}`

  const tribunus = process.env[tribunusKey]
  const legacy = process.env[opencodeKey]

  if (tribunus !== undefined && legacy !== undefined) {
    return { value: tribunus, source: "tribunus", conflict: true }
  }

  if (tribunus !== undefined) {
    return { value: tribunus, source: "tribunus", conflict: false }
  }

  if (legacy !== undefined) {
    warnAndEmit(key, tribunusKey, opencodeKey)
    return { value: legacy, source: "opencode", conflict: false }
  }

  return { value: undefined, source: "none", conflict: false }
}

/**
 * Reset the module's internal deprecation warning cache.
 *
 * Primarily useful in tests to ensure deprecation warnings are re-emitted
 * across test cases. Not intended for production use.
 */
export function resetDeprecationCache(): void {
  warnedKeys.clear()
}
