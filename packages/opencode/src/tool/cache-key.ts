import { Effect } from "effect"
import type { SessionID } from "../session/schema"

/**
 * Deferred freshness check — called at cache-hit time to reject stale entries.
 * Returns `true` if the entry is still fresh, `false` if it should be treated as a miss.
 * This avoids embedding mutable external state (like file mtimes) into the cache key,
 * keeping key derivation pure and independent of AppFileSystem.
 */
export type FreshnessCheck = Effect.Effect<boolean>

/**
 * No-op freshness check — always returns true.
 */
export const alwaysFresh: FreshnessCheck = Effect.succeed(true)

/**
 * Derives a SHA256 cache key from tool invocation context.
 *
 * Includes sessionID + agent to prevent cross-agent contamination:
 * tool outputs depend on permissions, sandbox rules, and agent-specific config.
 *
 * The key does NOT include file mtimes or other mutable filesystem state.
 * Freshness is checked at cache-hit time via a deferred FreshnessCheck.
 */
export const derive = async (input: {
  toolID: string
  args: unknown
  sessionID: SessionID
  agent: string
}): Promise<string> => {
  const normalized = JSON.stringify(input.args, sortedKeys)
  const payload = `${input.toolID}|${input.sessionID}|${input.agent}|${normalized}`
  const data = new TextEncoder().encode(payload)
  const hash = await crypto.subtle.digest("SHA-256", data)
  const bytes = Array.from(new Uint8Array(hash))
  return bytes.map((b) => b.toString(16).padStart(2, "0")).join("")
}

/**
 * JSON.stringify replacer that sorts object keys for deterministic output.
 * Ensures `{a:1,b:2}` and `{b:2,a:1}` produce identical strings.
 */
function sortedKeys(_key: string, value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value
  return Object.keys(value)
    .sort()
    .reduce<Record<string, unknown>>((acc, k) => {
      acc[k] = (value as Record<string, unknown>)[k]
      return acc
    }, {})
}
