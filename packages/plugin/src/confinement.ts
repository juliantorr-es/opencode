/**
 * Capability confinement enforcement for @tribunus/plugin.
 *
 * Defines the confinement policy that gates every capability invocation
 * made by an extension host subprocess. The policy acts as a deny-by-default
 * whitelist: unless a capability is explicitly allowed, it is rejected.
 *
 * @module
 */

// ---------------------------------------------------------------------------
// ConfinementPolicy
// ---------------------------------------------------------------------------

/**
 * Seven-gate confinement policy enforced on every capability invocation.
 *
 * Each `deny*` property is a gate that, when `true`, blocks the
 * corresponding resource domain. `allowedPaths` and `allowedOrigins`
 * carve out narrow exceptions to the filesystem and network gates.
 */
export interface ConfinementPolicy {
  // ── Database gates ──────────────────────────────────────────
  /** Prevent raw PGlite (embedded Postgres) access. */
  denyPGlite: boolean
  /** Prevent raw Valkey/Redis access. */
  denyValkey: boolean
  /** Prevent raw DuckDB access. */
  denyDuckDB: boolean

  // ── Filesystem gates ────────────────────────────────────────
  /** Prevent filesystem access outside paths listed in `allowedPaths`. */
  denyRawFilesystem: boolean
  /** Glob patterns or absolute prefixes the plugin MAY read/write. */
  allowedPaths?: string[]

  // ── Network gate ─────────────────────────────────────────────
  /** Prevent network access outside origins listed in `allowedOrigins`. */
  denyRawNetwork: boolean
  /** Origin strings (scheme + hostname + optional port) the plugin MAY connect to. */
  allowedOrigins?: string[]

  // ── System gates ─────────────────────────────────────────────
  /** Prevent shell/process spawning. */
  denyShell: boolean
  /** Prevent reading environment variables or secrets. */
  denySecrets: boolean

  // ── Capability whitelist ─────────────────────────────────────
  /** Exhaustive set of capability names the plugin is allowed to invoke.
   *  An empty array disallows everything beyond the basic host contract. */
  allowedCapabilities: string[]
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/**
 * Default confinement policy: deny all gates, allow no capabilities.
 *
 * Plugins start from this baseline and must be explicitly granted
 * capabilities through the governance pipeline before they can
 * invoke them.
 */
export const DEFAULT_CONFINEMENT: ConfinementPolicy = {
  denyPGlite: true,
  denyValkey: true,
  denyDuckDB: true,
  denyRawFilesystem: true,
  denyRawNetwork: true,
  denyShell: true,
  denySecrets: true,
  allowedCapabilities: [],
}

// ---------------------------------------------------------------------------
// Confinement errors
// ---------------------------------------------------------------------------

/**
 * Reason codes returned by `validateAgainstConfinement` when a capability
 * is disallowed.
 */
export type ConfinementDenyReason =
  | "capability_not_allowed"
  | "database_denied"
  | "filesystem_denied"
  | "filesystem_path_not_allowed"
  | "network_denied"
  | "network_origin_not_allowed"
  | "shell_denied"
  | "secrets_denied"

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Determine whether a requested capability is permitted under the given
 * confinement policy.
 *
 * Returns `{ allowed: true }` when the capability passes every applicable
 * gate, or `{ allowed: false, reason }` with the first failing gate's
 * reason code.
 *
 * The function inspects the capability name against known prefixes:
 *
 * | Prefix              | Gate checked           |
 * |---------------------|------------------------|
 * | `database.pglite`   | `denyPGlite`           |
 * | `database.valkey`   | `denyValkey`           |
 * | `database.duckdb`   | `denyDuckDB`           |
 * | `filesystem.*`      | `denyRawFilesystem`    |
 * | `network.*`         | `denyRawNetwork`       |
 * | `shell.*`           | `denyShell`            |
 * | `secrets.*`         | `denySecrets`          |
 * | anything else       | `allowedCapabilities`  |
 */
export function validateAgainstConfinement(
  requestedCapability: string,
  policy: ConfinementPolicy,
): { allowed: true } | { allowed: false; reason: ConfinementDenyReason } {
  // 1. Capability whitelist — explicit allow-list check.
  if (
    !policy.allowedCapabilities.includes(requestedCapability) &&
    !policy.allowedCapabilities.includes("*")
  ) {
    return { allowed: false, reason: "capability_not_allowed" }
  }

  // 2. Gate-specific checks.
  const gate = classifyCapability(requestedCapability)
  if (!gate) {
    // Unknown domain; the whitelist check above already covered it.
    return { allowed: true }
  }

  switch (gate) {
    case "database.pglite":
      if (policy.denyPGlite) return { allowed: false, reason: "database_denied" }
      break
    case "database.valkey":
      if (policy.denyValkey) return { allowed: false, reason: "database_denied" }
      break
    case "database.duckdb":
      if (policy.denyDuckDB) return { allowed: false, reason: "database_denied" }
      break
    case "filesystem":
      if (policy.denyRawFilesystem) {
        // Even when the gate is closed, check allowedPaths carve-out.
        if (policy.allowedPaths && policy.allowedPaths.length > 0) {
          // The caller should check specific path; we only reason about the gate.
          // Return allowed=false with a distinct reason so the caller can
          // retry with an explicit path scope.
          return { allowed: false, reason: "filesystem_path_not_allowed" }
        }
        return { allowed: false, reason: "filesystem_denied" }
      }
      break
    case "network":
      if (policy.denyRawNetwork) {
        if (policy.allowedOrigins && policy.allowedOrigins.length > 0) {
          return { allowed: false, reason: "network_origin_not_allowed" }
        }
        return { allowed: false, reason: "network_denied" }
      }
      break
    case "shell":
      if (policy.denyShell) return { allowed: false, reason: "shell_denied" }
      break
    case "secrets":
      if (policy.denySecrets) return { allowed: false, reason: "secrets_denied" }
      break
  }

  return { allowed: true }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Map a capability name to its confinement gate domain, or `null` for uncategorised. */
function classifyCapability(cap: string): string | null {
  if (cap.startsWith("database.pglite") || cap.startsWith("database/pglite")) return "database.pglite"
  if (cap.startsWith("database.valkey") || cap.startsWith("database/valkey")) return "database.valkey"
  if (cap.startsWith("database.duckdb") || cap.startsWith("database/duckdb")) return "database.duckdb"
  if (cap.startsWith("database.") || cap.startsWith("database/")) return "database.duckdb" // generic database → strictest
  if (cap.startsWith("filesystem.") || cap.startsWith("filesystem/")) return "filesystem"
  if (cap.startsWith("network.") || cap.startsWith("network/")) return "network"
  if (cap.startsWith("shell.") || cap.startsWith("shell/")) return "shell"
  if (cap.startsWith("secrets.") || cap.startsWith("secrets/")) return "secrets"
  return null
}
