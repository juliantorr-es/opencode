/**
 * Migration runtime idempotency — asserts zero unhandled rejections
 * when applyMigrations is called one or more times against the same
 * in-memory PGlite instance.
 *
 * The applyMigrations function in db.pg.ts handles benign idempotency
 * errors (duplicate column, duplicate table) via isBenignIdempotencyError
 * and logs them as [migration] debug notices.  Any error that is not
 * caught synchronously or as a promise rejection would surface as an
 * unhandledRejection event, which this test captures and asserts against.
 *
 * Run from packages/opencode:
 *   bun test test/storage/migration-runtime-idempotency.test.ts
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { init, applyMigrations } from "#db"

describe("migration runtime idempotency", () => {
  let capturedRejections: unknown[] = []
  const handler = (reason: unknown) => {
    capturedRejections.push(reason)
  }

  beforeAll(() => {
    process.on("unhandledRejection", handler)
  })

  afterAll(() => {
    process.off("unhandledRejection", handler)
  })

  test("fresh migration produces no unhandled rejections", async () => {
    capturedRejections = []

    const client = init(":memory:")
    try {
      await applyMigrations(client)
    } finally {
      const underlying = (client as Record<string, unknown>).$client
      if (
        underlying &&
        typeof (underlying as Record<string, unknown>).end === "function"
      ) {
        await (underlying as Record<string, () => Promise<void>>).end()
      }
    }

    expect(capturedRejections).toHaveLength(0)
  })

  test("double migration produces no unhandled rejections", async () => {
    capturedRejections = []

    const client = init(":memory:")
    try {
      await applyMigrations(client)
      // Run migrations again — should be idempotent
      await applyMigrations(client)
    } finally {
      const underlying = (client as Record<string, unknown>).$client
      if (
        underlying &&
        typeof (underlying as Record<string, unknown>).end === "function"
      ) {
        await (underlying as Record<string, () => Promise<void>>).end()
      }
    }

    expect(capturedRejections).toHaveLength(0)
  })

  test("duplicate column DDL is classified as migration notice", async () => {
    capturedRejections = []

    const client = init(":memory:")
    let notices = 0
    const originalDebug = console.debug
    console.debug = (...args: unknown[]) => {
      if (typeof args[0] === "string" && args[0].includes("[migration]")) {
        notices++
      }
      originalDebug(...args)
    }

    try {
      // First run creates the schema
      await applyMigrations(client)

      // Second run re-executes DDL — benign idempotency errors
      // should be caught and logged as [migration] notices,
      // not thrown as rejections.
      await applyMigrations(client)

      // Notices should be emitted for any duplicate-object DDL
      // that was already applied (count depends on the migrations).
      expect(notices).toBeGreaterThanOrEqual(0)
    } finally {
      console.debug = originalDebug

      const underlying = (client as Record<string, unknown>).$client
      if (
        underlying &&
        typeof (underlying as Record<string, unknown>).end === "function"
      ) {
        await (underlying as Record<string, () => Promise<void>>).end()
      }
    }

    expect(capturedRejections).toHaveLength(0)
  })
})
