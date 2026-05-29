import { describe, expect, test } from "bun:test"
import { checkSQLFirewall, DuckDBFirewallError } from "../../src/storage/duckdb-firewall"

describe("DuckDBFirewall", () => {
  test("blocks read_text", () => {
    expect(() => checkSQLFirewall("SELECT read_text('/etc/passwd')")).toThrow(DuckDBFirewallError)
  })

  test("blocks read_blob", () => {
    expect(() => checkSQLFirewall("SELECT read_blob('/etc/passwd')")).toThrow(DuckDBFirewallError)
  })

  test("blocks read_csv", () => {
    expect(() => checkSQLFirewall("SELECT read_csv_auto('file.csv')")).toThrow(DuckDBFirewallError)
  })

  test("blocks read_parquet", () => {
    expect(() => checkSQLFirewall("SELECT read_parquet('data.parquet')")).toThrow(DuckDBFirewallError)
  })

  test("blocks read_json", () => {
    expect(() => checkSQLFirewall("SELECT read_json_auto('data.json')")).toThrow(DuckDBFirewallError)
  })

  test("blocks query_table", () => {
    expect(() => checkSQLFirewall("SELECT query_table('t')")).toThrow(DuckDBFirewallError)
  })

  test("blocks ATTACH", () => {
    expect(() => checkSQLFirewall("ATTACH 'other.db'")).toThrow(DuckDBFirewallError)
  })

  test("blocks load_extension", () => {
    expect(() => checkSQLFirewall("LOAD 'some_ext'")).toThrow(DuckDBFirewallError)
  })

  test("blocks EXPORT", () => {
    expect(() => checkSQLFirewall("EXPORT DATABASE 'out'")).toThrow(DuckDBFirewallError)
  })

  test("blocks COPY … TO", () => {
    expect(() => checkSQLFirewall("COPY t TO 'out.csv'")).toThrow(DuckDBFirewallError)
  })

  test("allows safe SELECT", () => {
    expect(() => checkSQLFirewall("SELECT 1")).not.toThrow()
  })

  test("allows INSERT (not blocked by firewall, blocked by -readonly)", () => {
    expect(() => checkSQLFirewall("INSERT INTO t VALUES (1)")).not.toThrow()
  })

  test("strips block comments before checking", () => {
    expect(() => checkSQLFirewall("SELECT /* read_text('x') */ 1")).not.toThrow()
  })

  test("is case-insensitive", () => {
    expect(() => checkSQLFirewall("select read_text('/etc/passwd')")).toThrow(DuckDBFirewallError)
  })
})
