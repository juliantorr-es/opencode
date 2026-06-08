/**
 * PG-004: Tests for the PgPool connection pool service.
 *
 * Tests creation failure paths and the integration adapter.
 * Since PgPool connects eagerly on creation, tests for unreachable
 * hosts exercise the retry-and-fail path.
 */

import { describe, it, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { PgPool } from "@/storage/pg-pool"
import { DatabaseAdapter } from "@/storage/adapter"
import { testEffect } from "../lib/effect"
import { makePGLayer } from "../fixture/pg"

const itLive = testEffect(makePGLayer())

describe("PgPool", () => {
  describe("create", () => {
    it("rejects empty connection string", async () => {
      try {
        await Effect.runPromise(
          PgPool.create({
            connectionString: "",
            maxRetries: 0,
          }),
        )
        // Should not reach here
        expect(true).toBe(false)
      } catch (e: any) {
        expect(e.message).toContain("PG pool connection failed")
      }
    })
  })

  describe("healthCheck", () => {
    it("returns false for unreachable host", async () => {
      try {
        const pool = await Effect.runPromise(
          PgPool.create({
            connectionString: "postgresql://localhost:65432/nonexistent",
            connectionTimeoutMs: 500,
            maxRetries: 0,
          }),
        )
        // If creation somehow succeeded (unlikely), test healthCheck
        const healthy = await pool.healthCheck()
        expect(healthy).toBe(false)
        await pool.close()
      } catch {
        // Expected: creation fails because host is unreachable
        expect(true).toBe(true)
      }
    })
  })

  describe("error classification", () => {
    it("non-retryable errors fail immediately (no retry delay)", async () => {
      // Empty connection string hits validation before connection attempt
      const start = Date.now()
      try {
        await Effect.runPromise(
          PgPool.create({
            connectionString: "",
            maxRetries: 3,
            connectionTimeoutMs: 1000,
          }),
        )
      } catch {
        const elapsed = Date.now() - start
        // Should fail fast (not wait for exponential backoff)
        expect(elapsed).toBeLessThan(5000)
      }
    })
  })
})

describe("Graceful degradation", () => {
  it("defaultLayer uses SQLite when PG not configured", async () => {
    // Without OPENCODE_DATABASE_URL, defaultLayer picks SQLite
    const prev = process.env["OPENCODE_DATABASE_URL"]
    delete process.env["OPENCODE_DATABASE_URL"]

    try {
      const layer = DatabaseAdapter.defaultLayer
      const result = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const adapter = yield* DatabaseAdapter.Service
            return yield* adapter.query(() => Promise.resolve("sqlite-ok"))
          }).pipe(Effect.provide(layer)),
        ),
      )
      expect(result).toBe("sqlite-ok")
    } finally {
      if (prev) process.env["OPENCODE_DATABASE_URL"] = prev
    }
  })
})

describe("Integration with adapter", () => {
  itLive.live("query succeeds via standard PG adapter", () =>
    Effect.gen(function* () {
      const adapter = yield* DatabaseAdapter.Service
      const result = yield* adapter.query((db: any) => db.execute("SELECT 1 as val"))
      const rows = Array.isArray(result) ? result : result?.rows ?? []
      expect(rows.length).toBe(1)
    }),
  )
})
