import { describe, test, expect } from "bun:test"
import { init, applyMigrations } from "#db"
import { runMigrations } from "../../src/storage/migrate"

describe("PG migrations via runMigrations", () => {
  test("runs PG migrations on in-memory PGlite with explicit connection string", async () => {
    await expect(runMigrations(":memory:")).resolves.toBeUndefined()
  })

  test("uses :memory: when no connection string provided", async () => {
    await expect(runMigrations()).resolves.toBeUndefined()
  })

  test("respects OPENCODE_DATABASE_URL env var", async () => {
    process.env["OPENCODE_DATABASE_URL"] = ":memory:"
    try {
      await expect(runMigrations()).resolves.toBeUndefined()
    } finally {
      delete process.env["OPENCODE_DATABASE_URL"]
    }
  })
})

describe("PG migrations via #db (init + applyMigrations)", () => {
  async function getTables(client: any): Promise<string[]> {
    const underlying = (client as any).$client
    const result = await underlying.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name",
    )
    const rows = Array.isArray(result) ? result : result.rows ?? []
    return rows.map((r: any) => r.table_name)
  }

  test("applyMigrations creates expected tables", async () => {
    const client = init(":memory:")
    try {
      await applyMigrations(client)
      const tables = await getTables(client)

      expect(tables).toContain("session")
      expect(tables).toContain("message")
      expect(tables).toContain("account")
      expect(tables).toContain("project")
      expect(tables).toContain("workspace")
      expect(tables).toContain("part")
      expect(tables).toContain("todo")
    } finally {
      const underlying = (client as any).$client
      if (underlying && typeof underlying.end === "function") {
        await underlying.end()
      }
    }
  })

  test("applyMigrations applies all migrations without error", async () => {
    const client = init(":memory:")
    try {
      await expect(applyMigrations(client)).resolves.toBeUndefined()
      const tables = await getTables(client)
      expect(tables.length).toBeGreaterThan(5)
      expect(tables).toContain("session")
    } finally {
      const underlying = (client as any).$client
      if (underlying && typeof underlying.end === "function") {
        await underlying.end()
      }
    }
  })
})
