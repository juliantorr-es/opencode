/**
 * Postgres integration test -- exercises the DatabaseAdapter layer against
 * Postgres (real or PGlite) using db.execute() which is the correct raw-SQL
 * API for Postgres Drizzle clients (PgliteDatabase / NodePgDatabase).
 *
 * Pg clients expose execute() returning { rows: T[] }, not run()/all()/get().
 * See: drizzle-orm/pglite and drizzle-orm/node-postgres driver docs.
 *
 * ## Mode
 *
 * - PGlite (default): Runs against in-memory PGlite via pgTestLayer.
 * - Real Postgres (CI): When OPENCODE_DATABASE_URL is set, runs against
 *   a real Postgres service with schema-per-test isolation.
 */

import { describe, it, expect } from "bun:test"
import { Effect } from "effect"
import { DatabaseAdapter } from "@/storage/adapter"
import { pgTestLayer } from "../fixture/pg"
import { testEffect } from "../lib/effect"

const itLive = testEffect(pgTestLayer)

/** Execute a raw SQL string via the adapter's query interface. */
function sql(adapter: DatabaseAdapter.Interface, query: string) {
  return adapter.query((db: any) => db.execute(query))
}

/** Extract rows from an execute() result -- normalises PGlite vs node-postgres. */
function rows(result: any): any[] {
  if (Array.isArray(result)) return result
  return result?.rows ?? []
}

describe("Pg adapter integration", () => {
  describe("query", () => {
    itLive.live("INSERT and SELECT round-trip", () =>
      Effect.gen(function* () {
        const adapter = yield* DatabaseAdapter.Service
        const table = `pg_int_test_${Date.now()}`

        // Create table
        yield* sql(adapter, `
          CREATE TABLE IF NOT EXISTS "${table}" (
            id SERIAL PRIMARY KEY,
            name TEXT NOT NULL,
            value INTEGER DEFAULT 0
          )
        `)

        // Insert
        yield* sql(adapter, `INSERT INTO "${table}" (name, value) VALUES ('hello', 42)`)

        // Select
        const selectResult = yield* sql(adapter, `SELECT * FROM "${table}" WHERE name = 'hello'`)
        const selectRows = rows(selectResult)
        expect(selectRows.length).toBe(1)
        expect(selectRows[0].name).toBe("hello")
        expect(selectRows[0].value).toBe(42)
      }),
    )

    itLive.live("UPDATE modifies existing rows", () =>
      Effect.gen(function* () {
        const adapter = yield* DatabaseAdapter.Service
        const table = `pg_int_upd_${Date.now()}`

        yield* sql(adapter, `CREATE TABLE IF NOT EXISTS "${table}" (id SERIAL PRIMARY KEY, name TEXT, value INTEGER DEFAULT 0)`)
        yield* sql(adapter, `INSERT INTO "${table}" (name, value) VALUES ('before', 1)`)

        yield* sql(adapter, `UPDATE "${table}" SET value = 99 WHERE name = 'before'`)

        const result = yield* sql(adapter, `SELECT value FROM "${table}" WHERE name = 'before'`)
        expect(rows(result)[0].value).toBe(99)
      }),
    )

    itLive.live("DELETE removes rows", () =>
      Effect.gen(function* () {
        const adapter = yield* DatabaseAdapter.Service
        const table = `pg_int_del_${Date.now()}`

        yield* sql(adapter, `CREATE TABLE IF NOT EXISTS "${table}" (id SERIAL PRIMARY KEY, name TEXT)`)
        yield* sql(adapter, `INSERT INTO "${table}" (name) VALUES ('a'), ('b')`)

        yield* sql(adapter, `DELETE FROM "${table}" WHERE name = 'a'`)

        const result = yield* sql(adapter, `SELECT name FROM "${table}" ORDER BY name`)
        const remaining = rows(result)
        expect(remaining.length).toBe(1)
        expect(remaining[0].name).toBe("b")
      }),
    )

    itLive.live("COUNT aggregation", () =>
      Effect.gen(function* () {
        const adapter = yield* DatabaseAdapter.Service
        const table = `pg_int_cnt_${Date.now()}`

        yield* sql(adapter, `CREATE TABLE IF NOT EXISTS "${table}" (id SERIAL PRIMARY KEY, name TEXT)`)
        yield* sql(adapter, `INSERT INTO "${table}" (name) VALUES ('a'), ('b'), ('c')`)

        const result = yield* sql(adapter, `SELECT COUNT(*) as count FROM "${table}"`)
        expect(rows(result)[0].count).toBe(3)
      }),
    )

    itLive.live("NULL handling", () =>
      Effect.gen(function* () {
        const adapter = yield* DatabaseAdapter.Service
        const table = `pg_int_null_${Date.now()}`

        yield* sql(adapter, `CREATE TABLE IF NOT EXISTS "${table}" (id SERIAL PRIMARY KEY, label TEXT, score INTEGER)`)
        yield* sql(adapter, `INSERT INTO "${table}" (label, score) VALUES (NULL, NULL)`)

        const result = yield* sql(adapter, `SELECT * FROM "${table}"`)
        const r = rows(result)
        expect(r.length).toBe(1)
        expect(r[0].label).toBeNull()
        expect(r[0].score).toBeNull()
      }),
    )
  })

  describe("transaction", () => {
    itLive.live("commits changes", () =>
      Effect.gen(function* () {
        const adapter = yield* DatabaseAdapter.Service
        const table = `pg_tx_cmt_${Date.now()}`

        yield* sql(adapter, `CREATE TABLE IF NOT EXISTS "${table}" (id SERIAL PRIMARY KEY, name TEXT)`)

        yield* adapter.transaction((db: any) =>
          db.execute(`INSERT INTO "${table}" (name) VALUES ('tx-commit')`),
        )

        const result = yield* sql(adapter, `SELECT * FROM "${table}" WHERE name = 'tx-commit'`)
        expect(rows(result).length).toBe(1)
      }),
    )

    itLive.live("rolls back on error", () =>
      Effect.gen(function* () {
        const adapter = yield* DatabaseAdapter.Service
        const table = `pg_tx_rb_${Date.now()}`

        yield* sql(adapter, `CREATE TABLE IF NOT EXISTS "${table}" (id SERIAL PRIMARY KEY, name TEXT)`)
        yield* sql(adapter, `INSERT INTO "${table}" (name) VALUES ('before')`)

        const error = yield* adapter
          .transaction((db: any) => {
            db.execute(`INSERT INTO "${table}" (name) VALUES ('during')`)
            throw new Error("simulated rollback")
          })
          .pipe(Effect.flip)

        expect(error).toBeInstanceOf(DatabaseAdapter.DatabaseError)

        const result = yield* sql(adapter, `SELECT name FROM "${table}" ORDER BY name`)
        expect(rows(result).length).toBe(1)
        expect(rows(result)[0].name).toBe("before")
      }),
    )

    itLive.live("accepts Postgres transaction options (serializable)", () =>
      Effect.gen(function* () {
        const adapter = yield* DatabaseAdapter.Service
        const table = `pg_tx_op_${Date.now()}`

        yield* sql(adapter, `CREATE TABLE IF NOT EXISTS "${table}" (id SERIAL PRIMARY KEY, name TEXT)`)

        yield* adapter.transaction(
          (db: any) => db.execute(`INSERT INTO "${table}" (name) VALUES ('tx-opts')`),
          { _tag: "postgres", isolationLevel: "serializable" } as any,
        )

        const result = yield* sql(adapter, `SELECT * FROM "${table}" WHERE name = 'tx-opts'`)
        expect(rows(result).length).toBe(1)
      }),
    )
  })

  describe("error handling", () => {
    itLive.live("wraps query errors in DatabaseError", () =>
      Effect.gen(function* () {
        const adapter = yield* DatabaseAdapter.Service

        const error = yield* adapter
          .query((db: any) => db.execute("SELECT * FROM nonexistent_table_xyz"))
          .pipe(Effect.flip)

        expect(error).toBeInstanceOf(DatabaseAdapter.DatabaseError)
        expect(error.message).toBe("Query failed")
      }),
    )

    itLive.live("wraps thrown exceptions in DatabaseError", () =>
      Effect.gen(function* () {
        const adapter = yield* DatabaseAdapter.Service

        const error = yield* adapter
          .query(() => { throw new Error("custom boom") })
          .pipe(Effect.flip)

        expect(error).toBeInstanceOf(DatabaseAdapter.DatabaseError)
        expect(error.message).toBe("Query failed")
      }),
    )

    itLive.live("handles constraint violations", () =>
      Effect.gen(function* () {
        const adapter = yield* DatabaseAdapter.Service
        const table = `pg_int_uniq_${Date.now()}`

        yield* sql(adapter, `CREATE TABLE IF NOT EXISTS "${table}" (id SERIAL PRIMARY KEY, email TEXT UNIQUE NOT NULL)`)
        yield* sql(adapter, `INSERT INTO "${table}" (email) VALUES ('dup@test.com')`)

        const error = yield* adapter
          .query((db: any) =>
            db.execute(`INSERT INTO "${table}" (email) VALUES ('dup@test.com')`),
          )
          .pipe(Effect.flip)

        expect(error).toBeInstanceOf(DatabaseAdapter.DatabaseError)
        expect(error.message).toBe("Query failed")
      }),
    )
  })

  describe("smoke tests", () => {
    itLive.live("SELECT 1 returns a row", () =>
      Effect.gen(function* () {
        const adapter = yield* DatabaseAdapter.Service
        const result = yield* sql(adapter, "SELECT 1 as val")
        expect(rows(result).length).toBe(1)
        expect(rows(result)[0].val).toBe(1)
      }),
    )

    itLive.live("NOW() returns a date", () =>
      Effect.gen(function* () {
        const adapter = yield* DatabaseAdapter.Service
        const result = yield* sql(adapter, "SELECT NOW() as now")
        expect(rows(result)[0].now).toBeDefined()
      }),
    )
  })
})
