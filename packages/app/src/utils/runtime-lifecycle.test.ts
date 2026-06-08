import { describe, expect, test } from "bun:test"
import {
  formatSessionRouteStateLabel,
  isBackendUnavailableError,
  isHighSignalSessionRouteState,
  isNotFoundError,
} from "./runtime-lifecycle"

describe("runtime lifecycle helpers", () => {
  test("labels route states", () => {
    expect(formatSessionRouteStateLabel({ state: "hydrating" })).toBe("Session hydrating")
    expect(formatSessionRouteStateLabel({ state: "ready", sessionID: "ses_1", scopeKey: "dir" })).toBe(
      "Session ready",
    )
    expect(formatSessionRouteStateLabel({ state: "missing" })).toBe("Session missing")
  })

  test("flags high-signal route states", () => {
    expect(isHighSignalSessionRouteState({ state: "hydrating" })).toBe(false)
    expect(isHighSignalSessionRouteState({ state: "missing" })).toBe(true)
  })

  test("detects not found and backend unavailable errors", () => {
    expect(isNotFoundError(new Error("nope"))).toBe(false)
    expect(isBackendUnavailableError(new Error("failed to fetch"))).toBe(true)
    expect(
      isNotFoundError(
        Object.assign(new Error("missing"), {
          cause: { status: 404 },
        }),
      ),
    ).toBe(true)
  })
})
