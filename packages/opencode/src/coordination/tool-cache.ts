/**
 * Tool Cache — content-addressed caching and single-flight execution.
 *
 * Cache keys are content-addressed, not command-addressed.
 * Same input + same repo/tree state → same cached result (within TTL).
 * Single-flight: first request creates job, subsequent requests attach as waiters.
 */

// ── Cache Key ─────────────────────────────────────────────

export type InvalidationScope =
  | "file_digest"           // invalidated when file sha256 changes
  | "working_tree_snapshot" // invalidated when working tree digest changes
  | "repo_snapshot"         // invalidated when git HEAD changes
  | "config_digest"         // invalidated when relevant config file changes
  | "time_ttl"              // invalidated after TTL expires
  | "provider_state"        // invalidated when provider config changes

export interface ToolCacheKey {
  toolName: string
  /** Content-addressed hash of toolName + args + repo state */
  key: string
  /** Human-readable label for diagnostics */
  label: string
  /** What invalidates this cache entry */
  scopes: InvalidationScope[]
  /** SHA or digest values at submission time */
  digests: Record<string, string>
}

export function buildCacheKey(opts: {
  toolName: string
  idempotencyKey: string
  repoHead?: string
  scopes?: InvalidationScope[]
  label?: string
}): ToolCacheKey {
  const parts = [opts.toolName, opts.idempotencyKey]
  if (opts.repoHead) parts.push(opts.repoHead)
  return {
    toolName: opts.toolName,
    key: parts.join(":"),
    label: opts.label ?? `${opts.toolName}(${opts.idempotencyKey.slice(0, 12)})`,
    scopes: opts.scopes ?? ["working_tree_snapshot"],
    digests: {},
  }
}

// ── Cache Entry ───────────────────────────────────────────

export interface ToolCacheEntry {
  key: string
  result: unknown
  status: ToolJobStatus
  createdAt: number
  expiresAt: number
  ttlMs: number
}

export type ToolJobStatus = "pending" | "admitted" | "running" | "completed" | "failed" | "cancelled" | "timed_out"

// ── Single-Flight Result ──────────────────────────────────

export interface SingleFlightResult<T = unknown> {
  /** Whether this call was the leader (executed the tool) or a waiter */
  role: "leader" | "waiter"
  /** The job ID — same for all waiters */
  jobId: string
  /** The final result */
  result: T
  /** Number of waiters that shared this result */
  waiterCount: number
}

// ── Tool Cache Interface ──────────────────────────────────

export interface ToolCache {
  /** Store a result with TTL. */
  set(key: ToolCacheKey, result: unknown, ttlMs: number): Promise<void>

  /** Get a cached result if not expired. */
  get(key: ToolCacheKey): Promise<ToolCacheEntry | undefined>

  /** Invalidate cache entries matching a scope + digest change. */
  invalidate(scope: InvalidationScope, oldDigest: string): Promise<number>

  /** Cache stats for diagnostics. */
  stats(): Promise<{ entries: number; hits: number; misses: number }>

  dispose(): Promise<void>
}

// ── Cache Policy ──────────────────────────────────────────

/** Returns the recommended TTL for a tool by resource class. */
export function ttlForResourceClass(rc: string): number {
  switch (rc) {
    case "read_light": return 30_000     // 30s
    case "search_medium": return 60_000  // 60s
    case "cpu_heavy": return 300_000     // 5min
    case "io_heavy": return 300_000      // 5min
    case "network": return 120_000        // 2min
    default: return 60_000
  }
}

/** Tools that should NEVER be cached. */
export const UNCACHEABLE_TOOLS: Record<string, true> = {
  write_file: true,
  edit: true,
  git_checkpoint: true,
  npm_install: true,
  migration_execute: true,
  secrets_get: true,
  secrets_set: true,
}

export function isCacheable(toolName: string): boolean {
  return !UNCACHEABLE_TOOLS[toolName]
}
