/**
 * PG-004: Production Postgres connection pool with retry, health checks, and graceful teardown.
 *
 * Wraps `pg.Pool` in a managed class that supports:
 * - Configurable pool size, connection timeout, idle timeout
 * - Connection retry with exponential backoff via Effect Schedule
 * - Health check via `SELECT 1`
 * - Proper shutdown via pool.end()
 */

import { Pool } from "pg"
import { Effect, Schedule } from "effect"
import * as Log from "@opencode-ai/core/util/log"

const log = Log.create({ service: "pg-pool" })

export interface PgPoolConfig {
  connectionString: string
  ssl?: boolean
  min?: number
  max?: number
  connectionTimeoutMs?: number
  idleTimeoutMs?: number
  maxRetries?: number
}

/**
 * A managed Postgres connection pool with health checking and retry-on-connect.
 */
export class PgPool {
  private pool: Pool
  private _healthy: boolean = false
  private config: PgPoolConfig

  private constructor(pool: Pool, config: PgPoolConfig) {
    this.pool = pool
    this.config = config
    this._healthy = true
  }

  /**
   * Create a PgPool with connection validation and retry.
   * - Creates the pg.Pool with config from `PgPoolConfig`
   * - Acquires a connection and runs `SELECT 1` to verify reachability
   * - Retries up to `maxRetries` times with exponential backoff (100ms, 200ms, 400ms, ...)
   * - Returns `PgPool` on success, `Error` if all retries fail
   */
  /**
   * Classify a connection error as retryable or not.
   * - Auth failures (28P01), SSL handshake failures → non-retryable
   * - DNS failures (ENOTFOUND), connection refused (ECONNREFUSED), timeouts → retryable
   */
  private static isRetryableError(cause: unknown): boolean {
    if (cause instanceof Error) {
      const msg = cause.message
      // Auth failures: won't succeed on retry
      if (msg.includes("28P01") || msg.includes("password authentication") || msg.includes("auth")) return false
      // SSL handshake failures: misconfiguration, won't fix on retry
      if (msg.includes("SSL") && !msg.includes("timeout")) return false
      // DNS / transient: may resolve
      if (msg.includes("ENOTFOUND") || msg.includes("ECONNREFUSED") || msg.includes("ECONNRESET")) return true
      // Network timeouts: may resolve
      if (msg.includes("timeout") || msg.includes("ETIMEDOUT") || msg.includes("timed out")) return true
      // "Connection terminated unexpectedly" or pool drained → retry
      if (msg.includes("terminated") || msg.includes("no more connections")) return true
    }
    // Default: retry for unexpected errors
    return true
  }

  static create(config: PgPoolConfig): Effect.Effect<PgPool, Error> {
    const attempt = Effect.tryPromise({
      try: async () => {
        const pool = new Pool({
          connectionString: config.connectionString,
          ssl: config.ssl ? { rejectUnauthorized: true } : false,
          max: config.max ?? 10,
          min: config.min ?? 1,
          connectionTimeoutMillis: config.connectionTimeoutMs ?? 5000,
          idleTimeoutMillis: config.idleTimeoutMs ?? 30000,
        })
        // Verify connectivity by acquiring a client and running SELECT 1
        const client = await pool.connect()
        try {
          await client.query("SELECT 1")
        } finally {
          client.release()
        }
        log.info("PG pool connected and verified", {
          max: config.max ?? 10,
          sanitizedUrl: sanitizeUrl(config.connectionString),
        })
        return new PgPool(pool, config)
      },
      catch: (cause) =>
        new Error(`PG pool connection failed: ${cause instanceof Error ? cause.message : String(cause)}`),
    })

    return attempt.pipe(
      Effect.retry({
        times: config.maxRetries ?? 3,
        schedule: Schedule.exponential("100 millis"),
        while: (error) => PgPool.isRetryableError(error),
      }),
    )
  }

  /** Access the raw pg.Pool (e.g., to pass to drizzle-orm). */
  getPool(): Pool {
    return this.pool
  }

  /** Whether the last health check succeeded. Initially true after create(). */
  isHealthy(): boolean {
    return this._healthy
  }

  /**
   * Run a health check by executing `SELECT 1`.
   * Returns `true` if the query succeeds, `false` otherwise.
   * Updates internal `_healthy` flag.
   */
  async healthCheck(): Promise<boolean> {
    try {
      const client = await this.pool.connect()
      try {
        await client.query("SELECT 1")
        this._healthy = true
        return true
      } finally {
        client.release()
      }
    } catch {
      this._healthy = false
      return false
    }
  }

  /**
   * Gracefully shut down the pool.
   * - Drains all idle connections
   * - Closes all active connections
   * - Rejects any subsequent queries
   */
  async close(): Promise<void> {
    try {
      await this.pool.end()
      this._healthy = false
      log.info("PG pool closed")
    } catch (cause) {
      log.error("Error closing PG pool", { error: String(cause) })
    }
  }
}

/** Sanitize a connection string for logging (hide password). */
function sanitizeUrl(url: string): string {
  try {
    const parsed = new URL(url)
    if (parsed.password) parsed.password = "****"
    return parsed.toString()
  } catch {
    return "(invalid url)"
  }
}
