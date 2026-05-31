/**
 * Postgres test harness -- PGlite-based or full Postgres via connection string.
 *
 * ## Schema-per-test isolation
 *
 * - **PGlite mode** (default): Each call to `pgTestLayer` or `makePGLayer`
 *   creates a fresh **in-memory** PGlite instance. Instances are fully
 *   independent -- no Postgres schema management needed.
 * - **Real Postgres mode** (CI, `OPENCODE_DATABASE_URL` set): Each call creates
 *   a unique schema (`pg_adapter_test_${counter}`), sets `search_path`, and
 *   vends a `DatabaseAdapter.Service` that routes all queries through that
 *   schema.
 *
 * ## Usage
 *
 * ```typescript
 * import { pgTestLayer } from "../fixture/pg"
 * import { testEffect } from "../lib/effect"
 *
 * const it = testEffect(pgTestLayer)
 *
 * it.live("query succeeds", () =>
 *   Effect.gen(function* () {
 *     const adapter = yield* DatabaseAdapter.Service
 *     const result = yield* adapter.query((db: any) => db.run("SELECT 1 as val"))
 *     // ...
 *   }),
 * )
 * ```
 */

import { Effect, Layer, Schedule } from "effect"
import { DatabaseAdapter } from "@/storage/adapter"
import { Flag } from "@opencode-ai/core/flag/flag"
import { readMigrationFiles } from "drizzle-orm/migrator"

// ── Counter for unique schema / instance IDs ──────────────────

let testCounter = 0

// ── In-memory PGlite provider ─────────────────────────────────

async function createPGliteAdapter(): Promise<DatabaseAdapter.Interface> {
  const { PGlite } = await import("@electric-sql/pglite")
  const { drizzle } = await import("drizzle-orm/pglite")
  const client = new PGlite()
  const db = drizzle({ client })

  // Apply all migrations so runtime_events and other tables exist
  const folder = new URL("../../migration-pg", import.meta.url).pathname
  const migrations = readMigrationFiles({ migrationsFolder: folder })
  await client.exec(
    `CREATE TABLE IF NOT EXISTS "__drizzle_migrations" (
      "hash" text PRIMARY KEY,
      "created_at" bigint
    )`,
  )
  const result = await client.query("SELECT hash FROM \"__drizzle_migrations\"")
  const applied = new Set(
    (result.rows as Array<{ hash: string }>).map((r) => r.hash),
  )
  for (const migration of migrations) {
    if (applied.has(migration.hash)) continue
    for (const sql of migration.sql) {
      await client.exec(sql)
    }
    await client.query(
      'INSERT INTO "__drizzle_migrations" ("hash", "created_at") VALUES ($1, $2)',
      [migration.hash, Date.now()],
    )
  }

  return makeAdapterFromClient(db as any)
}

// ── Real Postgres provider with schema isolation ──────────────

async function createRealPgAdapter(
  connectionString: string,
  ssl: boolean,
  schemaName: string,
): Promise<DatabaseAdapter.Interface> {
  const { Pool } = await import("pg")
  const { drizzle } = await import("drizzle-orm/node-postgres")
  const pool = new Pool({
    connectionString,
    ssl: ssl ? { rejectUnauthorized: true } : false,
  })
  // Create the isolated schema and set search_path
  await pool.query(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`)
  await pool.query(`SET search_path TO "${schemaName}", public`)
  const db = drizzle({ client: pool })
  return makeAdapterFromClient(db as any)
}

// ── Adapter builder from any Drizzle-like client ──────────────

function makeAdapterFromClient(client: {
  transaction: Function
  run: Function
  all: Function
  get: Function
}): DatabaseAdapter.Interface {
  let pendingAfterCommitHooks: Array<() => void> = []
  let txDepth = 0

  const fireHooks = () => {
    const hooks = pendingAfterCommitHooks
    pendingAfterCommitHooks = []
    for (const fn of hooks) {
      try {
        fn()
      } catch {
        // Isolate callback errors per adapter contract
      }
    }
  }

  const query = <T>(fn: (db: any) => T | Promise<T>) =>
    Effect.tryPromise({
      try: () => {
        if (txDepth === 0) pendingAfterCommitHooks = []
        const result = fn(client as any)
        return result instanceof Promise ? result : Promise.resolve(result)
      },
      catch: (cause) =>
        new DatabaseAdapter.DatabaseError({
          message: "Query failed",
          cause,
          isRetryable: false,
        }),
    })

  const transaction = <T>(
    fn: (db: any) => T | Promise<T>,
    _options?: any,
  ): Effect.Effect<T, DatabaseAdapter.DatabaseError> => {
    pendingAfterCommitHooks = []

    const txFn = async (tx: any) => {
      txDepth++
      try {
        return await fn(tx as any)
      } finally {
        txDepth--
        if (txDepth === 0) fireHooks()
      }
    }

    const base = Effect.tryPromise({
      try: () => (client.transaction as any)(txFn),
      catch: (cause) => {
        pendingAfterCommitHooks = []
        const isRetryable =
          cause !== null &&
          typeof cause === "object" &&
          (cause as any)?.code === "40001"
        return new DatabaseAdapter.DatabaseError({
          message: "Transaction failed",
          cause,
          isRetryable,
        })
      },
    })

    return base.pipe(
      Effect.retry({
        times: 3,
        schedule: Schedule.exponential("100 millis"),
        while: (error) =>
          error instanceof DatabaseAdapter.DatabaseError && error.isRetryable,
      }),
    ) as Effect.Effect<T, DatabaseAdapter.DatabaseError>
  }

  const afterCommit = (fn: () => void) =>
    Effect.sync(() => {
      if (txDepth > 0) {
        pendingAfterCommitHooks.push(fn)
      } else {
        fn()
      }
    })

  return DatabaseAdapter.Service.of({ query, transaction, afterCommit })
}

// ── Public API ────────────────────────────────────────────────

/**
 * Create a `DatabaseAdapter.Service` layer backed by a fresh **in-memory**
 * PGlite instance. Completely isolated -- no files or state shared between
 * calls.
 */
export function makePGLayer(): Layer.Layer<DatabaseAdapter.Service> {
  testCounter++
  return Layer.effect(
    DatabaseAdapter.Service,
    Effect.promise(() => createPGliteAdapter()),
  )
}

/**
 * Create a `DatabaseAdapter.Service` layer backed by a real Postgres
 * connection with **schema-per-test isolation**.
 *
 * Creates schema `pg_adapter_test_${counter}` and sets `search_path` so all
 * queries in this layer are scoped to that schema.
 */
export function makeRealPgLayer(
  connectionString: string,
  ssl = false,
): Layer.Layer<DatabaseAdapter.Service> {
  testCounter++
  const schemaName = `pg_adapter_test_${testCounter}`
  return Layer.effect(
    DatabaseAdapter.Service,
    Effect.promise(() => createRealPgAdapter(connectionString, ssl, schemaName)),
  )
}

/**
 * Convenience layer -- returns a `DatabaseAdapter.Service` backed by:
 *
 * 1. **Real Postgres** when `OPENCODE_DATABASE_URL` env var is set (CI),
 *    with schema-per-test isolation.
 * 2. **In-memory PGlite** otherwise (local dev), with full instance isolation.
 *
 * This is the recommended entry-point for Postgres-dependent tests.
 */
export const pgTestLayer: Layer.Layer<DatabaseAdapter.Service> = Layer.unwrap(
  Effect.sync(() => {
    const pgUrl = Flag.OPENCODE_DATABASE_URL
    if (pgUrl) {
      return makeRealPgLayer(pgUrl, false)
    }
    return makePGLayer()
  }),
)
