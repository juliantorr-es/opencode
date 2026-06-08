import { describe, expect, test } from "bun:test"
import { formatSessionRecoveryStatusLabel, isSessionRecoveryMutationBlocked } from "./cockpit-truth"

describe("cockpit truth recovery labels", () => {
  test("labels coordination recovery states canonically", () => {
    expect(formatSessionRecoveryStatusLabel("coordination_unavailable")).toBe("Coordination unavailable")
    expect(formatSessionRecoveryStatusLabel("coordination_rebuilding")).toBe("Coordination rebuilding")
    expect(formatSessionRecoveryStatusLabel("coordination_recovered")).toBe("Coordination recovered")
    expect(formatSessionRecoveryStatusLabel("coordination_degraded")).toBe("Coordination degraded")
    expect(formatSessionRecoveryStatusLabel("coordination_refused")).toBe("Coordination refused")
  })

  test("blocks mutating actions until recovery is complete", () => {
    expect(isSessionRecoveryMutationBlocked({ type: "coordination_unavailable" })).toBe(true)
    expect(isSessionRecoveryMutationBlocked({ type: "coordination_rebuilding" })).toBe(true)
    expect(isSessionRecoveryMutationBlocked({ type: "coordination_degraded" })).toBe(true)
    expect(isSessionRecoveryMutationBlocked({ type: "coordination_refused" })).toBe(true)
    expect(isSessionRecoveryMutationBlocked({ type: "coordination_recovered" })).toBe(false)
    expect(isSessionRecoveryMutationBlocked({ type: "busy" })).toBe(false)
    expect(isSessionRecoveryMutationBlocked(undefined)).toBe(false)
  })
})
