import { describe, test, expect, beforeAll } from "bun:test"
import { mkdtempSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

const tmpDir = mkdtempSync(join(tmpdir(), "tribunus-projections-test-"))
process.env.TRIBUNUS_STATE_HOME = tmpDir

import {
  ensureProjectionMeta,
  getProjectionHealth,
  markProjectionCurrent,
  markProjectionStale,
} from "../../src/storage/projections"
import { Database } from "../../src/storage/db"

function getRaw() {
  const db = Database.Client() as unknown as { $client?: { exec(sql: string): Promise<void>; query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> } }
  return db.$client ?? (db as unknown as { exec(sql: string): Promise<void>; query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> })
}

describe("projection metadata", () => {
  beforeAll(async () => {
    Database.Client()
  })

  test("ensureProjectionMeta creates the metadata table", async () => {
    await ensureProjectionMeta()
    const raw = getRaw()
    const result = await raw.query(`SELECT name FROM _projection_meta LIMIT 0`)
    expect(result.rows).toBeDefined()
  })

  test("getProjectionHealth returns missing for an unknown name", async () => {
    const health = await getProjectionHealth("nonexistent-projection")
    expect(health).toHaveLength(1)
    expect(health[0].name).toBe("nonexistent-projection")
    expect(health[0].status).toBe("missing")
  })

  test("markProjectionCurrent creates a row on first call", async () => {
    await markProjectionCurrent("test-proj", 2)
    const raw = getRaw()
    const result = await raw.query(
      `SELECT name, version, is_stale FROM _projection_meta WHERE name = $1`,
      ["test-proj"]
    )
    expect(result.rows).toHaveLength(1)
    expect(result.rows[0].name).toBe("test-proj")
    expect(result.rows[0].version).toBe(2)
    expect(result.rows[0].is_stale).toBe(0)
  })

  test("markProjectionCurrent updates the version on subsequent calls", async () => {
    await markProjectionCurrent("test-proj", 3)
    const raw = getRaw()
    const result = await raw.query(
      `SELECT version FROM _projection_meta WHERE name = $1`,
      ["test-proj"]
    )
    expect(result.rows[0].version).toBe(3)
  })

  test("getProjectionHealth reports current for an up-to-date projection", async () => {
    const health = await getProjectionHealth("test-proj")
    expect(health).toHaveLength(1)
    expect(health[0].status).toBe("current")
    expect(health[0].version).toBe(3)
  })

  test("markProjectionStale marks a projection as stale", async () => {
    await markProjectionStale("test-proj")
    const raw = getRaw()
    const result = await raw.query(
      `SELECT is_stale FROM _projection_meta WHERE name = $1`,
      ["test-proj"]
    )
    expect(result.rows[0].is_stale).toBe(1)
  })

  test("getProjectionHealth reports stale for a stale projection", async () => {
    const health = await getProjectionHealth("test-proj")
    expect(health).toHaveLength(1)
    expect(health[0].status).toBe("stale")
  })
})
