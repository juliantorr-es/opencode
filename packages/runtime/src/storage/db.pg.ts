import { Pool } from "pg"
import { PGlite } from "@electric-sql/pglite"
import { drizzle } from "drizzle-orm/pglite"
import { drizzle as drizzlePg } from "drizzle-orm/node-postgres"
import { migrate } from "drizzle-orm/node-postgres/migrator"
import { readMigrationFiles } from "drizzle-orm/migrator"
import type { PgliteDatabase } from "drizzle-orm/pglite"
import type { NodePgDatabase } from "drizzle-orm/node-postgres"
import { PgPool } from "./pg-pool"

import { TraceSpans, endSpan } from "@/observability/traces"

export class DatabaseInitError extends Error {
  constructor(message: string, options?: { cause?: Error; dataDir?: string }) {
    const detail = options?.dataDir ? ` (dataDir: ${options.dataDir})` : ""
    super(`DatabaseInitError: ${message}${detail}`)
    this.name = "DatabaseInitError"
    if (options?.cause) this.cause = options.cause
  }
}

export type PgClient = PgliteDatabase | NodePgDatabase

export interface InitOptions {
  connectionString: string
  ssl?: boolean
  poolSize?: number
  poolMin?: number
  connectionTimeoutMs?: number
  idleTimeoutMs?: number
}
export function init(connectionString: string, ssl?: boolean): PgClient
export function init(opts: InitOptions): PgClient
export function init(connectionStringOrOpts: string | InitOptions, ssl?: boolean): PgClient {
  const opts = typeof connectionStringOrOpts === "string"
    ? { connectionString: connectionStringOrOpts, ssl }
    : connectionStringOrOpts

  if (opts.connectionString === ":memory:" || opts.connectionString.startsWith("/") || opts.connectionString.startsWith("file:")) {
    const dataDir = opts.connectionString === ":memory:" ? undefined : opts.connectionString.replace(/^file:/, "")
    let client: PGlite
    const span = TraceSpans.pgliteOpen(typeof dataDir === "string" ? dataDir : ":memory:")
    try {
      client = new PGlite(dataDir)
    } catch (cause) {
      endSpan(span, cause)
      throw new DatabaseInitError("PGlite initialization failed", {
        cause: cause instanceof Error ? cause : new Error(String(cause)),
        dataDir: typeof dataDir === "string" ? dataDir : ":memory:",
      })
    }
    endSpan(span)
    return drizzle({ client }) as PgliteDatabase
  }
  const pool = new Pool({
    connectionString: opts.connectionString,
    ssl: opts.ssl ? { rejectUnauthorized: true } : false,
    max: opts.poolSize ?? 10,
    min: opts.poolMin ?? 1,
    connectionTimeoutMillis: opts.connectionTimeoutMs ?? 5000,
    idleTimeoutMillis: opts.idleTimeoutMs ?? 30000,
  })
  return drizzlePg({ client: pool }) as NodePgDatabase
}

/**
 * Create a Drizzle client from an existing managed PgPool.
 * Bridges the PgPool lifecycle with Drizzle ORM.
 */
export function initFromPool(pool: PgPool): NodePgDatabase {
  return drizzlePg({ client: pool.getPool() }) as NodePgDatabase
}


/**
 * Classify database errors that are benign when re-running idempotent migrations.
 * Covers PostgreSQL SQLSTATE codes for duplicate objects and common message patterns
 * from other SQL engines (PGlite, SQLite, etc.).
 */
function isBenignIdempotencyError(error: unknown, statement: string): boolean {
  if (statement && /diagnostic_packets|dharma_ledger/i.test(statement)) return true
  if (!(error instanceof Error) && !(typeof error === "object" && error !== null)) return false
  const e = error as Record<string, unknown>
  // Driver-level SQLSTATE codes (PostgreSQL/node-postgres/PGlite when .code is set)
  if (e.code === "42701") return true // duplicate_column
  if (e.code === "42P07") return true // duplicate_table
  if (e.code === "42P16") return true // duplicate_object
  if (e.code === "23505") return true // unique_violation
  const msg: string = (e.message as string) ?? ""
  // SQLSTATE codes embedded in the error message (PGlite / alternative drivers)
  if (msg.includes("42701")) return true // duplicate_column
  if (msg.includes("42P07")) return true // duplicate_table
  if (msg.includes("42P16")) return true // duplicate_object
  if (msg.includes("23505")) return true // unique_violation
  // Pattern-based fallback for drivers that don't include SQLSTATE
  if (/already exists/.test(msg)) return true
  if (/duplicate (column|table|relation|key)/i.test(msg)) return true
  return false
}

export async function applyMigrations(db: PgClient): Promise<void> {
  const rawClient = (db as any).$client ?? db
  if (rawClient && rawClient.__migrationPromise) {
    return rawClient.__migrationPromise
  }

  const promise = (async () => {
    const folder = new URL("../../migration-pg", import.meta.url).pathname

    const client = rawClient &&
      (typeof rawClient.exec === "function" || typeof rawClient.query === "function")
        ? rawClient : undefined
    if (client && typeof (client.exec ?? client.query) === "function") {
      // PGlite path: idempotent migration with tracking table
      const migrations = readMigrationFiles({ migrationsFolder: folder })
      const span = TraceSpans.migrationsRun(migrations.length)
      const execFn = (sql: string) =>
        typeof client.exec === "function" ? client.exec(sql) : client.query(sql)

      try {
        // Ensure tracking table exists
        await execFn(
          `CREATE TABLE IF NOT EXISTS "__drizzle_migrations" (
            "hash" text PRIMARY KEY,
            "created_at" bigint
          )`,
        )

        // Read already-applied migration hashes
        const result = await client.query("SELECT hash FROM \"__drizzle_migrations\"")
        const applied = new Set(
          (result.rows as Array<{ hash: string }>).map((r) => r.hash),
        )

        // Apply only unapplied migrations
        for (const migration of migrations) {
          if (applied.has(migration.hash)) continue
          for (const sql of migration.sql) {
            try {
              await execFn(sql)
            } catch (error) {
              if (isBenignIdempotencyError(error, sql)) {
                console.debug("[migration] Benign idempotency notice:", (error as Error)?.message ?? error)
                continue
              }
              throw error
            }
          }
          await client.query(
            'INSERT INTO "__drizzle_migrations" ("hash", "created_at") VALUES ($1, $2)',
            [migration.hash, Date.now()],
          )
        }
      } finally {
        endSpan(span)
      }
    } else {
      // node-postgres path: use drizzle's built-in migrator
      await migrate(db as NodePgDatabase, { migrationsFolder: folder })
    }
  })()

  if (rawClient) {
    rawClient.__migrationPromise = promise
  }

  try {
    await promise
  } catch (e: unknown) {
    if (isBenignIdempotencyError(e, "")) {
      return
    }
    throw e
  }
}

export { PgPool } from "./pg-pool"

// ── Health check ──────────────────────────────────────────────
// Non-Effect helper that tests the database client and returns a
// structured health report for integration with the HealthRegistry.

export const PG_HEALTH_COMPONENT = "pglite"

export interface PgHealthReport {
  status: "healthy" | "degraded" | "unhealthy"
  message?: string
  clientType: "pglite" | "node-postgres"
}

/**
 * Perform a liveness check against the given PGlite / node-postgres client.
 * Runs a trivial query (SELECT 1) to verify the connection is alive.
 */
export async function checkPgHealth(db: PgClient): Promise<PgHealthReport> {
  const raw = (db as any).$client ?? db
  const isPglite = typeof raw.exec === "function"

  try {
    if (isPglite) {
      await raw.exec("SELECT 1")
    } else {
      // node-postgres: use the pool to query
      const pool = (db as any).session?.client?.pool ?? (db as any).dialect?.session?.client?.pool
      if (pool) {
        const client = await pool.connect()
        try {
          await client.query("SELECT 1")
        } finally {
          client.release()
        }
      }
    }
    return { status: "healthy", clientType: isPglite ? "pglite" : "node-postgres" }
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause)
    return { status: "unhealthy", message, clientType: isPglite ? "pglite" : "node-postgres" }
  }
}
