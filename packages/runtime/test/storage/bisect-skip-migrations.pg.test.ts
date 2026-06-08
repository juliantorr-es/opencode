/**
 * Bisect script: prove skipMigrations prevents auto-migration.
 *
 * Usage:  bun test test/storage/bisect-skip-migrations.pg.test.ts
 * Exit 0: skipMigrations flag is wired and works.
 * Exit 1: fix absent or broken.
 *
 * Gate logic (test "skipMigrations leaves PGlite empty"):
 *   - Create adapter with skipMigrations:true
 *   - Wait 500ms (generous for in-memory PGlite migration)
 *   - Query information_schema → expect zero user tables
 *
 *   Before fix: migrations fire-and-forget → tables appear → FAIL.
 *   After fix:  migrations skipped → zero tables → PASS.
 */
import { describe, test, expect } from "bun:test"
import { init, applyMigrations } from "#db"
import { makePgAdapter } from "../../src/storage/adapter"

/** List public user tables via underlying PGlite client. */
async function getTables(client: any): Promise<string[]> {
  const raw = (client as any).$client ?? client
  const result = raw.query
    ? await raw.query(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name",
      )
    : await raw.exec(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name",
      )
  const rows = Array.isArray(result) ? result : result.rows ?? []
  return rows.map((r: any) => r.table_name)
}

async function closeClient(client: any) {
  const raw = (client as any).$client
  if (raw && typeof raw.end === "function") await raw.end()
}

describe("bisect: skipMigrations", () => {
  // CONTROL: migrations work when explicitly called
  test("applyMigrations creates tables", async () => {
    const client = init(":memory:")
    try {
      await applyMigrations(client)
      const tables = await getTables(client)
      expect(tables).toContain("session")
      expect(tables.length).toBeGreaterThan(5)
    } finally {
      await closeClient(client)
    }
  })

  // BASELINE: raw PGlite starts empty
  test("raw PGlite has no tables", async () => {
    const client = init(":memory:")
    try {
      const tables = await getTables(client)
      expect(tables.length).toBe(0)
    } finally {
      await closeClient(client)
    }
  })

  // THE GATE: skipMigrations:true → zero tables after settling time
  test("skipMigrations:true leaves PGlite empty", async () => {
    // Use type-cast to pass skipMigrations before the option exists in the type.
    const adapter = makePgAdapter({
      connectionString: ":memory:",
      skipMigrations: true,
    } as any)

    // Wait for any fire-and-forget migration to finish (500ms is generous).
    await new Promise((r) => setTimeout(r, 500))

    // Access the underlying PGlite client through the adapter closure.
    // makePgAdapter stores `client` in its closure; we reach it via query().
    let tables: string[] = []
    const { Effect } = await import("effect")

    await Effect.runPromise(
      adapter.query((db: any) => {
        const raw = db.$client ?? db
        const result = raw.query
          ? raw.query(
              "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name",
            )
          : Promise.resolve({ rows: [] })
        return result
      }),
    ).then((result: any) => {
      const rows = Array.isArray(result) ? result : result.rows ?? []
      tables = rows.map((r: any) => r.table_name)
    })

    expect(tables.length).toBe(0)
  })
})
