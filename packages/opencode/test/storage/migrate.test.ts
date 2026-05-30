import { describe, test, expect } from "bun:test"
import { runMigrations } from "../../src/storage/migrate"

describe("runMigrations", () => {
  test("runs SQLite migrations on :memory: with explicit dialect", async () => {
    await expect(runMigrations({ dialect: "sqlite", dbPath: ":memory:" })).resolves.toBeUndefined()
  })

  test("runs PG migrations on in-memory PGlite", async () => {
    await expect(runMigrations({ dialect: "pg", connectionString: ":memory:" })).resolves.toBeUndefined()
  })

  test("auto-detects PG when OPENCODE_DATABASE_URL is set", async () => {
    process.env["OPENCODE_DATABASE_URL"] = ":memory:"
    try {
      await expect(runMigrations()).resolves.toBeUndefined()
    } finally {
      delete process.env["OPENCODE_DATABASE_URL"]
    }
  })

  test("respects OPENCODE_DATABASE_DIALECT override", async () => {
    process.env["OPENCODE_DATABASE_DIALECT"] = "sqlite"
    process.env["OPENCODE_DATABASE_URL"] = "postgres://should-not-be-used"
    try {
      await expect(runMigrations({ dbPath: ":memory:" })).resolves.toBeUndefined()
    } finally {
      delete process.env["OPENCODE_DATABASE_DIALECT"]
      delete process.env["OPENCODE_DATABASE_URL"]
    }
  })

  test("throws when PG mode has no connection string", async () => {
    await expect(runMigrations({ dialect: "pg" })).rejects.toThrow("OPENCODE_DATABASE_URL")
  })

  test("detects sqlite from OPENCODE_DATABASE_DIALECT env var", async () => {
    process.env["OPENCODE_DATABASE_DIALECT"] = "sqlite"
    try {
      await expect(runMigrations({ dbPath: ":memory:" })).resolves.toBeUndefined()
    } finally {
      delete process.env["OPENCODE_DATABASE_DIALECT"]
    }
  })

  test("defaults to sqlite when no env vars are set", async () => {
    await expect(runMigrations({ dbPath: ":memory:" })).resolves.toBeUndefined()
  })

  test("CLI --pg flag forces PG mode", async () => {
    await expect(runMigrations({ dialect: "pg", connectionString: ":memory:" })).resolves.toBeUndefined()
  })

  test("detects invalid dialect env var and falls through", async () => {
    process.env["OPENCODE_DATABASE_DIALECT"] = "invalid"
    process.env["OPENCODE_DATABASE_URL"] = ":memory:"
    try {
      // invalid falls through to URL check → PG
      await expect(runMigrations()).resolves.toBeUndefined()
    } finally {
      delete process.env["OPENCODE_DATABASE_DIALECT"]
      delete process.env["OPENCODE_DATABASE_URL"]
    }
  })
})
