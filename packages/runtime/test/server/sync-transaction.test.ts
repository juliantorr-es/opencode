import { describe, it, expect } from "bun:test"
import { createServerTestCell } from "./test-cell"
import { Database } from "../../src/storage/db"

describe("SyncEvent Async Transaction Regression", () => {
  it("verifies Database.transaction correctly awaits async callback and runs afterCommit hooks", async () => {
    const cell = await createServerTestCell()
    try {
      let commitHookExecuted = false

      // Run an async transaction callback
      const result = await Database.transaction(async (tx) => {
        // Register an afterCommit hook
        Database.effect(() => {
          commitHookExecuted = true
        })

        // Perform some query
        await tx.execute(Database.sql`SELECT 1`)

        expect(commitHookExecuted).toBe(false) // should not have run yet
        return "success-value"
      })

      expect(result).toBe("success-value")
      expect(commitHookExecuted).toBe(true) // should have run after resolve
    } finally {
      await cell.teardown()
    }
  }, 15000)
})
