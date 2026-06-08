import { describe, expect, test } from "bun:test"
import { formatSessionChromeStatusLabel } from "@/utils/cockpit-truth"

describe("status popover label projection", () => {
  test("prefers canonical recovery copy over lifecycle ready copy", () => {
    expect(
      formatSessionChromeStatusLabel({
        sessionStatus: { type: "coordination_rebuilding" },
        lifecycleState: "completed",
        fallbackLabel: "status.popover.trigger",
      }),
    ).toBe("Coordination rebuilding")
  })

  test("falls back to lifecycle copy when recovery state is absent", () => {
    expect(
      formatSessionChromeStatusLabel({
        sessionStatus: { type: "idle" },
        lifecycleState: "failed",
        fallbackLabel: "status.popover.trigger",
      }),
    ).toBe("Lifecycle: Failed")
  })
})
