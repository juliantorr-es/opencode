import { describe, expect, test } from "bun:test"
import { eq } from "drizzle-orm"
import { Effect } from "effect"
import { Database } from "@/storage/db"
import { ProjectID } from "@/project/schema"
import { SessionID } from "@/session/schema"
import {
  planCoordinationRecovery,
  persistCoordinationRecoveryReceipt,
} from "../../src/coordination/recovery"
import { CoordinationRecoveryTable } from "../../src/coordination/recovery.pg.sql"

const sessionID = "ses_01J5Y5H0AH4Q4NXJ6P4C3P5V2K" as SessionID
const projectID = ProjectID.make("proj-alpha")

describe("planCoordinationRecovery", () => {
  test("returns rebuilding then recovered after a wipe with no unsafe work", () => {
    const plan = planCoordinationRecovery({
      sessionID,
      projectID,
      valkeyAvailable: true,
      statePresent: false,
      durableGeneration: 7,
      currentGeneration: 8,
      unsafeWork: false,
      durableReceipt: false,
      timestamp: 123,
    })

    expect(plan.state).toBe("coordination_rebuilding")
    expect(plan.finalState).toBe("coordination_recovered")
    expect(plan.receipt).toMatchObject({
      sessionID,
      projectID,
      oldGeneration: 7,
      newGeneration: 8,
      outcome: "coordination_recovered",
      reasons: expect.arrayContaining(["generation_mismatch"]),
      unsafeWork: false,
      durableReceipt: false,
      timestamp: 123,
    })
  })

  test("returns refused when unsafe work cannot be resumed", () => {
    const plan = planCoordinationRecovery({
      sessionID,
      projectID,
      valkeyAvailable: true,
      statePresent: false,
      durableGeneration: 7,
      currentGeneration: 8,
      unsafeWork: true,
      durableReceipt: false,
      timestamp: 456,
    })

    expect(plan.state).toBe("coordination_rebuilding")
    expect(plan.finalState).toBe("coordination_refused")
    expect(plan.receipt?.reasons).toEqual(
      expect.arrayContaining(["generation_mismatch", "unsafe_in_flight_work", "missing_durable_receipt"]),
    )
  })

  test("returns degraded when unsafe work has a durable receipt", () => {
    const plan = planCoordinationRecovery({
      sessionID,
      projectID,
      valkeyAvailable: true,
      statePresent: false,
      durableGeneration: 7,
      currentGeneration: 8,
      unsafeWork: true,
      durableReceipt: true,
      timestamp: 457,
    })

    expect(plan.state).toBe("coordination_rebuilding")
    expect(plan.finalState).toBe("coordination_degraded")
    expect(plan.receipt?.reasons).toEqual(expect.arrayContaining(["generation_mismatch", "unsafe_in_flight_work"]))
  })

  test("returns unavailable when valkey cannot be reached", () => {
    const plan = planCoordinationRecovery({
      sessionID,
      projectID,
      valkeyAvailable: false,
      statePresent: false,
      durableGeneration: 7,
      currentGeneration: undefined,
      unsafeWork: false,
      durableReceipt: false,
      timestamp: 789,
    })

    expect(plan.state).toBe("coordination_unavailable")
    expect(plan.finalState).toBeUndefined()
    expect(plan.receipt).toBeUndefined()
  })

  test("persists the recovery receipt", async () => {
    const plan = planCoordinationRecovery({
      sessionID,
      projectID,
      valkeyAvailable: true,
      statePresent: false,
      durableGeneration: 7,
      currentGeneration: 8,
      unsafeWork: false,
      durableReceipt: false,
      timestamp: 999,
    })

    expect(plan.receipt).toBeDefined()
    await Effect.runPromise(persistCoordinationRecoveryReceipt(plan.receipt!))

    const rows = await Database.use((db) => db.select().from(CoordinationRecoveryTable).where(eq(CoordinationRecoveryTable.id, plan.receipt!.id)).execute())
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      session_id: sessionID,
      project_id: projectID,
      old_generation: 7,
      new_generation: 8,
      outcome: "coordination_recovered",
      unsafe_work: false,
      durable_receipt: false,
    })
  })
})
