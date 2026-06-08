import { describe, test, expect } from "bun:test"
import { Effect } from "effect"
import { initTablesSql, initViewsSql } from "../../src/storage/schema.duckdb"
import { runPipeline } from "../../src/storage/pipeline"
import { makeLocalPgAdapter } from "../../src/storage/adapter"

describe("DuckDB migration", () => {
  test("initTablesSql contains expected CREATE TABLE statements", () => {
    const sql = initTablesSql()

    expect(sql).toBeTruthy()
    expect(typeof sql).toBe("string")
    expect(sql.length).toBeGreaterThan(0)

    expect(sql).toContain("CREATE TABLE")
    expect(sql).toContain("_analytics_waves")
    expect(sql).toContain("_analytics_findings")
    expect(sql).toContain("_pipeline_runtime_event")
  })

  test("initViewsSql contains expected CREATE VIEW statements", () => {
    const sql = initViewsSql()

    expect(sql).toBeTruthy()
    expect(typeof sql).toBe("string")
    expect(sql.length).toBeGreaterThan(0)

    expect(sql).toContain("CREATE VIEW")
    expect(sql).toContain("_analytics_session_clustering")
    expect(sql).toContain("_analytics_tool_usage")
  })

  test("initTablesSql and initViewsSql produce valid combined SQL", () => {
    const tables = initTablesSql()
    const views = initViewsSql()

    const combined = [tables, views].join(";\n")
    expect(combined).toContain("CREATE TABLE")
    expect(combined).toContain("CREATE VIEW")

    const statements = combined.split(";").filter(s => s.trim().length > 0)
    expect(statements.length).toBeGreaterThan(0)
  })

  test("runPipeline completes on :memory: with SQLite adapter", async () => {
    const { spawnSync } = await import("child_process")
    const result = spawnSync("which", ["duckdb"])
    if (result.status !== 0) {
      console.log("Skipping: duckdb binary not found")
      return
    }

    const adapter = makeLocalPgAdapter()

    await expect(
      Effect.runPromise(runPipeline(":memory:", adapter)),
    ).resolves.toBeUndefined()
  }, { timeout: 15000 })
})
