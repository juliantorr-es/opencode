/**
 * PgAdapter integration tests.
 *
 * Uses the **actual production** `PgAdapter` from `@/storage/adapter` with
 * a temporary PGlite data directory (see `initPg` in `db.pg.ts`). No fixture
 * reimplementations.
 *
 * Also tests `DuckDBAdapter` — read-only enforcement and SQL firewall —
 * through the production adapter layer.
 *
 * ## Postgres test mode
 *
 * - **PGlite** (default): A temp directory is created for each test suite
 *   invocation. `PgAdapter` is called with the temp path, which triggers
 *   the PGlite code path in the production `initPg`.
 * - **Real Postgres**: Set `OPENCODE_DATABASE_URL` to run against a real
 *   Postgres server.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test"
import { Effect, ManagedRuntime } from "effect"
import { DatabaseAdapter } from "@/storage/adapter"
import { mkdtempSync, rmSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { Flag } from "@opencode-ai/core/flag/flag"

// ── PgAdapter setup (actual production code path) ────────────
// Creates a temp directory and passes it to the real PgAdapter
// constructor.  `initPg` in `db.pg.ts` uses PGlite when the URL
// starts with "/" or "file:".

const pgDir = mkdtempSync(join(tmpdir(), "opencode-pg-test-"))
const pgLayer = DatabaseAdapter.PgAdapter(pgDir, false)
const pgRuntime = ManagedRuntime.make(pgLayer)
const pgAdapter: DatabaseAdapter.Interface = pgRuntime.runSync(
  DatabaseAdapter.Service.use((svc) => Effect.succeed(svc)),
)
const runPg = <A, E>(effect: Effect.Effect<A, E>) => pgRuntime.runPromise(effect)

const TABLE = "adapter_pg_test"

// ── DuckDBAdapter setup (tests read-only + SQL firewall) ─────

let duckRuntime: ManagedRuntime.ManagedRuntime<any, any>
let duckAdapter: DatabaseAdapter.Interface
let runDuck: <A, E>(effect: Effect.Effect<A, E>) => Promise<A>

// ── Helpers ──────────────────────────────────────────────────

function isRealPg(): boolean {
  return Flag.OPENCODE_DATABASE_URL !== undefined
}

// ── Cleanup ──────────────────────────────────────────────────

afterAll(() => {
  try {
    rmSync(pgDir, { recursive: true, force: true })
  } catch {
    // Temp dir cleanup is best-effort
  }
})

// ═══════════════════════════════════════════════════════════════
// PgAdapter tests
// ═══════════════════════════════════════════════════════════════

describe("PgAdapter", () => {
  beforeAll(async () => {
    await runPg(
      pgAdapter.query((db: any) =>
        db.run(
          `create table if not exists ${TABLE} (id serial primary key, name text not null, ts timestamptz default now())`,
        ),
      ),
    )
  })

  describe("query", () => {
    it("executes sync callbacks", async () => {
      const insertResult = await runPg(
        pgAdapter.query((db: any) => db.run(`insert into ${TABLE} (name) values ('sync-test')`)),
      )
      expect(insertResult).toBeDefined()

      const rows = await runPg(
        pgAdapter.query((db: any) => db.all(`select * from ${TABLE} where name = 'sync-test'`)),
      )
      expect(rows.length).toBeGreaterThanOrEqual(1)
      expect(rows[0].name).toBe("sync-test")
    })

    it("executes async callbacks", async () => {
      const result = await runPg(
        pgAdapter.query(async (db: any) => {
          await Promise.resolve()
          return db.run(`insert into ${TABLE} (name) values ('async-test')`)
        }),
      )
      expect(result).toBeDefined()

      const rows = await runPg(
        pgAdapter.query((db: any) => db.all(`select * from ${TABLE} where name = 'async-test'`)),
      )
      expect(rows.length).toBeGreaterThanOrEqual(1)
      expect(rows[0].name).toBe("async-test")
    })

    it("wraps errors in DatabaseError", async () => {
      const error = await runPg(
        pgAdapter.query((db: any) => db.all("select * from nonexistent_table_xyz")).pipe(Effect.flip),
      )
      expect(error).toBeInstanceOf(DatabaseAdapter.DatabaseError)
      expect(error.message).toBe("Query failed")
    })

    it("wraps thrown exceptions in DatabaseError", async () => {
      const error = await runPg(
        pgAdapter.query(() => {
          throw new Error("custom boom")
        }).pipe(Effect.flip),
      )
      expect(error).toBeInstanceOf(DatabaseAdapter.DatabaseError)
      expect(error.message).toBe("Query failed")
    })

    // When running against a real Postgres, the error cause is sanitised
    // (F-006).  PGlite errors don't carry connection strings, but the
    // sanitisation code path is exercised regardless.
    if (isRealPg()) {
      it("sanitises PG error causes (connection string stripped)", async () => {
        // Force a connection error by running an invalid query
        const error = await runPg(
          pgAdapter.query((db: any) => db.all("select pg_sleep(999) /* noop */")).pipe(Effect.flip),
        )
        expect(error).toBeInstanceOf(DatabaseAdapter.DatabaseError)
        // The cause should not contain raw PG error fields beyond safe ones
        const cause = (error as any).cause
        if (cause && typeof cause === "object") {
          expect(typeof cause.message === "string").toBe(true)
          // If a connection string somehow appeared, it must be redacted
          if (typeof cause.message === "string") {
            expect(cause.message).not.toMatch(/postgres(?:ql)?:\/\//i)
          }
        }
      })
    }
  })

  describe("transaction", () => {
    it("accepts Postgres transaction options", async () => {
      await runPg(
        pgAdapter.transaction(
          (db: any) => db.run(`insert into ${TABLE} (name) values ('tx-pg-options')`),
          { _tag: "postgres", isolationLevel: "serializable" },
        ),
      )
    })

    it("retries on failure", async () => {
      let callCount = 0
      const error = await runPg(
        pgAdapter.transaction(() => {
          callCount++
          throw new Error(`simulated attempt ${callCount}`)
        }).pipe(Effect.flip),
      )
      // Retry schedule: times=3, so up to 4 total attempts (initial + 3 retries)
      expect(callCount).toBeGreaterThan(1)
      expect(error).toBeInstanceOf(DatabaseAdapter.DatabaseError)
      expect(error.message).toBe("Transaction failed")
    })

    it("commits successfully and persists changes", async () => {
      const name = `tx-commit-pg-${Date.now()}`
      await runPg(
        pgAdapter.transaction((db: any) => db.run(`insert into ${TABLE} (name) values ('${name}')`)),
      )

      const rows = await runPg(
        pgAdapter.query((db: any) => db.all(`select * from ${TABLE} where name = '${name}'`)),
      )
      expect(rows.length).toBe(1)
    })

    it("wraps transaction errors in DatabaseError", async () => {
      const error = await runPg(
        pgAdapter.transaction(() => {
          throw new Error("tx boom")
        }).pipe(Effect.flip),
      )
      expect(error).toBeInstanceOf(DatabaseAdapter.DatabaseError)
      expect(error.message).toBe("Transaction failed")
    })
  })

  describe("afterCommit", () => {
    it("fires callback after transaction commits", async () => {
      const calls: string[] = []

      await runPg(
        pgAdapter.transaction((db: any) => {
          // Call afterCommit through the adapter Interface directly
          // (inside the transaction callback, it's outside of Effect context,
          //  so we wrap in Effect.runSync)
          Effect.runSync(pgAdapter.afterCommit(() => calls.push("committed")))
          return db.run(`insert into ${TABLE} (name) values ('after-commit-test')`)
        }),
      )

      expect(calls).toEqual(["committed"])
    })

    it("fires multiple callbacks in registration order (FIFO)", async () => {
      const order: number[] = []

      await runPg(
        pgAdapter.transaction((db: any) => {
          Effect.runSync(pgAdapter.afterCommit(() => order.push(1)))
          Effect.runSync(pgAdapter.afterCommit(() => order.push(2)))
          Effect.runSync(pgAdapter.afterCommit(() => order.push(3)))
          return db.run(`insert into ${TABLE} (name) values ('after-commit-order')`)
        }),
      )

      expect(order).toEqual([1, 2, 3])
    })

    it("executes immediately outside a transaction", async () => {
      const calls: string[] = []
      await runPg(pgAdapter.afterCommit(() => calls.push("immediate")))
      expect(calls).toEqual(["immediate"])
    })
  })

  describe("Postgres-specific", () => {
    it("supports jsonb columns", async () => {
      await runPg(
        pgAdapter.query((db: any) =>
          db.run(`create table if not exists ${TABLE}_json (id serial primary key, data jsonb)`),
        ),
      )

      const payload = { hello: "world", nested: { a: 1 } }
      await runPg(
        pgAdapter.query((db: any) =>
          db.run(`insert into ${TABLE}_json (data) values ('${JSON.stringify(payload)}'::jsonb)`),
        ),
      )

      const rows = await runPg(
        pgAdapter.query((db: any) => db.all(`select * from ${TABLE}_json`)),
      )
      expect(rows.length).toBe(1)
      expect(rows[0].data.hello).toBe("world")
    })

    it("supports RETURNING clause", async () => {
      const rows = await runPg(
        pgAdapter.query((db: any) =>
          db.all(`insert into ${TABLE} (name) values ('returning-test') returning id, name`),
        ),
      )
      expect(rows.length).toBe(1)
      expect(rows[0].name).toBe("returning-test")
      expect(rows[0].id).toBeDefined()
    })
  })
})

// ═══════════════════════════════════════════════════════════════
// DuckDBAdapter tests (read-only enforcement + SQL firewall)
// ═══════════════════════════════════════════════════════════════

describe("DuckDBAdapter", () => {
  beforeAll(async () => {
    duckRuntime = ManagedRuntime.make(DatabaseAdapter.DuckDBAdapter)
    duckAdapter = duckRuntime.runSync(
      DatabaseAdapter.Service.use((svc) => Effect.succeed(svc)),
    )
    runDuck = <A, E>(effect: Effect.Effect<A, E>) => duckRuntime.runPromise(effect)
  })

  afterAll(() => {
    // ManagedRuntime from effect does not expose dispose in this version;
    // the runtime will be garbage-collected naturally.
  })

  describe("read-only enforcement", () => {
    it("rejects transactions immediately", async () => {
      const error = await runDuck(
        duckAdapter.transaction((db: any) => db.run("SELECT 1")).pipe(Effect.flip),
      )
      expect(error).toBeInstanceOf(DatabaseAdapter.DatabaseError)
      expect(error.message).toBe("DuckDB is read-only — transactions are not supported")
    })

    it("wraps insert errors from DrizzleLikeClient wrapper", async () => {
      const error = await runDuck(
        duckAdapter.query((db: any) => db.insert("foo")).pipe(Effect.flip),
      )
      expect(error).toBeInstanceOf(DatabaseAdapter.DatabaseError)
      expect(error.message).toBe("DuckDB query failed")
    })

    it("wraps update errors from DrizzleLikeClient wrapper", async () => {
      const error = await runDuck(
        duckAdapter.query((db: any) => db.update("foo")).pipe(Effect.flip),
      )
      expect(error).toBeInstanceOf(DatabaseAdapter.DatabaseError)
      expect(error.message).toBe("DuckDB query failed")
    })

    it("wraps delete errors from DrizzleLikeClient wrapper", async () => {
      const error = await runDuck(
        duckAdapter.query((db: any) => db.delete("foo")).pipe(Effect.flip),
      )
      expect(error).toBeInstanceOf(DatabaseAdapter.DatabaseError)
      expect(error.message).toBe("DuckDB query failed")
    })

    it("rejects Drizzle select builder", async () => {
      const error = await runDuck(
        duckAdapter.query((db: any) => db.select()).pipe(Effect.flip),
      )
      // select() throws a plain Error which gets wrapped in DatabaseError
      expect(error).toBeInstanceOf(DatabaseAdapter.DatabaseError)
    })
  })

  describe("SQL firewall", () => {
    // The firewall check (checkDuckDBSQLFirewall) runs in the
    // DrizzleLikeClient wrapper before any SQL reaches the DuckDB
    // subprocess, so no duckdb binary is needed for these tests.

    it("blocks read_text", async () => {
      const error = await runDuck(
        duckAdapter.query((db: any) =>
          db.run("SELECT read_text('/etc/passwd')"),
        ).pipe(Effect.flip),
      )
      expect(error).toBeInstanceOf(DatabaseAdapter.DatabaseError)
      expect(error.message).toBe("DuckDB query failed")
      // The original firewall error is recorded as the cause
      const cause = (error as any).cause
      expect(cause).toBeDefined()
      expect(typeof cause?.message === "string").toBe(true)
      if (cause?.message) {
        expect(String(cause.message).toLowerCase()).toContain("read_text")
      }
    })

    it("blocks read_blob", async () => {
      const error = await runDuck(
        duckAdapter.query((db: any) =>
          db.run("SELECT read_blob('/etc/passwd')"),
        ).pipe(Effect.flip),
      )
      expect(error).toBeInstanceOf(DatabaseAdapter.DatabaseError)
      // Verify the blocked function name appears in the chain
      const cause = (error as any).cause
      if (cause?.message) {
        expect(String(cause.message).toLowerCase()).toContain("read_blob")
      }
    })

    it("blocks read_csv_auto", async () => {
      const error = await runDuck(
        duckAdapter.query((db: any) =>
          db.get("SELECT * FROM read_csv_auto('data.csv')"),
        ).pipe(Effect.flip),
      )
      expect(error).toBeInstanceOf(DatabaseAdapter.DatabaseError)
      const cause = (error as any).cause
      if (cause?.message) {
        expect(String(cause.message).toLowerCase()).toContain("read_csv")
      }
    })

    it("blocks read_parquet", async () => {
      const error = await runDuck(
        duckAdapter.query((db: any) =>
          db.run("SELECT * FROM read_parquet('data.parquet')"),
        ).pipe(Effect.flip),
      )
      expect(error).toBeInstanceOf(DatabaseAdapter.DatabaseError)
      const cause = (error as any).cause
      if (cause?.message) {
        expect(String(cause.message).toLowerCase()).toContain("read_parquet")
      }
    })

    it("blocks read_json_auto", async () => {
      const error = await runDuck(
        duckAdapter.query((db: any) =>
          db.run("SELECT * FROM read_json_auto('data.json')"),
        ).pipe(Effect.flip),
      )
      expect(error).toBeInstanceOf(DatabaseAdapter.DatabaseError)
      const cause = (error as any).cause
      if (cause?.message) {
        expect(String(cause.message).toLowerCase()).toContain("read_json")
      }
    })

    it("blocks query_table", async () => {
      const error = await runDuck(
        duckAdapter.query((db: any) =>
          db.run("SELECT * FROM query_table('some_table')"),
        ).pipe(Effect.flip),
      )
      expect(error).toBeInstanceOf(DatabaseAdapter.DatabaseError)
      const cause = (error as any).cause
      if (cause?.message) {
        expect(String(cause.message).toLowerCase()).toContain("query_table")
      }
    })

    it("blocks ATTACH", async () => {
      const error = await runDuck(
        duckAdapter.query((db: any) =>
          db.run("ATTACH 'other.db' AS other_db"),
        ).pipe(Effect.flip),
      )
      expect(error).toBeInstanceOf(DatabaseAdapter.DatabaseError)
    })

    it("blocks load_extension", async () => {
      const error = await runDuck(
        duckAdapter.query((db: any) =>
          db.run("LOAD 'some_extension'"),
        ).pipe(Effect.flip),
      )
      expect(error).toBeInstanceOf(DatabaseAdapter.DatabaseError)
      const cause = (error as any).cause
      expect(cause?.message?.toLowerCase?.()).toContain('load')
    })

    it("blocks EXPORT", async () => {
      const error = await runDuck(
        duckAdapter.query((db: any) =>
          db.run("EXPORT DATABASE '/tmp/export'"),
        ).pipe(Effect.flip),
      )
      expect(error).toBeInstanceOf(DatabaseAdapter.DatabaseError)
    })

    it("blocks COPY … TO pattern", async () => {
      const error = await runDuck(
        duckAdapter.query((db: any) =>
          db.run("COPY my_table TO '/tmp/export.csv'"),
        ).pipe(Effect.flip),
      )
      expect(error).toBeInstanceOf(DatabaseAdapter.DatabaseError)
    })
  })
})
