import { describe, test, expect } from "bun:test"
import { executeMigrationStatement, executeMigrations } from "../../src/storage/migration-executor"

describe("migration executor", () => {
  test("applied statement returns applied status", async () => {
    const exec = async (_: string) => {}
    const result = await executeMigrationStatement(exec, "CREATE TABLE test (id int)")
    expect(result.status).toBe("applied")
  })

  test("duplicate column with ADD COLUMN returns notice", async () => {
    let calls = 0
    const exec = async (_: string) => {
      calls++
      const err = new Error("column already exists") as Error & { code: string }
      err.code = "42701"
      throw err
    }
    const result = await executeMigrationStatement(exec, "ALTER TABLE test ADD COLUMN name text")
    expect(result.status).toBe("notice")
    expect(calls).toBe(1)
  })

  test("unknown error still throws", async () => {
    const exec = async (_: string) => {
      throw new Error("connection lost")
    }
    await expect(executeMigrationStatement(exec, "SELECT 1")).rejects.toThrow("connection lost")
  })

  test("duplicate SQLSTATE without ADD COLUMN still throws", async () => {
    const exec = async (_: string) => {
      const err = new Error("bad") as Error & { code: string }
      err.code = "42701"
      throw err
    }
    await expect(executeMigrationStatement(exec, "DROP TABLE test")).rejects.toThrow("bad")
  })

  test("executeMigrations processes all statements", async () => {
    const exec = async (_: string) => {}
    const notices = await executeMigrations(["stmt1", "stmt2", "stmt3"], exec)
    expect(notices).toHaveLength(0)
  })

  test("no unhandled rejections from migration loop", async () => {
    const unhandled: unknown[] = []
    const listener = (reason: unknown) => unhandled.push(reason)
    process.on("unhandledRejection", listener)
    try {
      const exec = async (stmt: string) => {
        if (stmt.includes("already")) {
          const err = new Error("already exists") as Error & { code: string }
          err.code = "42701"
          throw err
        }
      }
      await executeMigrations(["CREATE TABLE t (id int)", "ALTER TABLE t ADD COLUMN already int"], exec)
      expect(unhandled).toHaveLength(0)
    } finally {
      process.off("unhandledRejection", listener)
    }
  })
})
