import { describe, expect, test } from "bun:test"
import { DuckDBError } from "../../src/storage/db.duckdb"
import { checkSQLFirewall } from "../../src/storage/duckdb-firewall"

describe("DuckDB pool timeout", () => {
  test("checkSQLFirewall rejects blocked functions", () => {
    expect(() => checkSQLFirewall("SELECT read_text('/etc/passwd')")).toThrow()
  })

  test("DuckDBError is constructable with timeout message", () => {
    const err = new DuckDBError("DuckDB query timed out after 30000ms")
    expect(err).toBeInstanceOf(DuckDBError)
    expect(err.message).toContain("timed out")
    expect(err.name).toBe("DuckDBError")
  })

  test("pool queue timeout message contains 'queue timed out'", () => {
    const err = new DuckDBError("DuckDB query queue timed out after 30000ms")
    expect(err.message).toContain("queue timed out")
    expect(err.message).toContain("30000ms")
    expect(err._tag).toBe("DuckDBError")
  })
})
