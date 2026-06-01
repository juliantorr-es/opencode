import { PGlite } from "@electric-sql/pglite"
import { Pool } from "pg"
import { drizzle } from "drizzle-orm/pglite"
import { drizzle as drizzlePg } from "drizzle-orm/node-postgres"
import { migrate } from "drizzle-orm/node-postgres/migrator"
import { readMigrationFiles } from "drizzle-orm/migrator"
import type { PgliteDatabase } from "drizzle-orm/pglite"
import type { NodePgDatabase } from "drizzle-orm/node-postgres"
import { PgPool } from "./pg-pool"

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
    try {
      client = new PGlite(dataDir)
    } catch (cause) {
      throw new DatabaseInitError("PGlite initialization failed", {
        cause: cause instanceof Error ? cause : new Error(String(cause)),
        dataDir: typeof dataDir === "string" ? dataDir : ":memory:",
      })
    }
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

export async function applyMigrations(db: PgClient): Promise<void> {
  const folder = new URL("../../migration-pg", import.meta.url).pathname

  // Duck-type check: PGlite exposes exec() on its raw client
  const client = (db as any).$client
  if (typeof client.exec === "function") {
    // PGlite path: idempotent migration with tracking table
    const migrations = readMigrationFiles({ migrationsFolder: folder })

    // Ensure tracking table exists
    await client.exec(
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
          await client.exec(sql)
        } catch (e: any) {
          const msg = e?.message ?? ""
          // Skip idempotent DDL: relation/column/constraint/index already exists
          if (/already exists/.test(msg)) continue
          // Skip idempotent DDL: does not exist (drop if not exists)
          if (/does not exist/.test(msg)) continue
          throw e
        }
      }
      await client.query(
        'INSERT INTO "__drizzle_migrations" ("hash", "created_at") VALUES ($1, $2)',
        [migration.hash, Date.now()],
      )
    }
  } else {
    // node-postgres path: use drizzle's built-in migrator
    await migrate(db as NodePgDatabase, { migrationsFolder: folder })
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
