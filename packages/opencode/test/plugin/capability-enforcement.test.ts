import { describe, expect, test } from "bun:test"
import { isValidCapabilityId } from "../../src/plugin/capability"

describe("isValidCapabilityId", () => {
  test("returns true for valid capability ID", () => {
    expect(isValidCapabilityId("filesystem.read")).toBe(true)
    expect(isValidCapabilityId("network.request")).toBe(true)
    expect(isValidCapabilityId("secrets.access")).toBe(true)
    expect(isValidCapabilityId("tool.register")).toBe(true)
    expect(isValidCapabilityId("tool.execute")).toBe(true)
    expect(isValidCapabilityId("event.subscribe")).toBe(true)
    expect(isValidCapabilityId("event.emit")).toBe(true)
    expect(isValidCapabilityId("hooks.transform_message")).toBe(true)
    expect(isValidCapabilityId("hooks.transform_system")).toBe(true)
    expect(isValidCapabilityId("hooks.compaction")).toBe(true)
    expect(isValidCapabilityId("filesystem.write")).toBe(true)
    expect(isValidCapabilityId("network.websocket")).toBe(true)
    expect(isValidCapabilityId("config.read")).toBe(true)
    expect(isValidCapabilityId("config.write")).toBe(true)
  })

  test("returns false for invalid capability ID", () => {
    expect(isValidCapabilityId("not.a.capability")).toBe(false)
    expect(isValidCapabilityId("random-string")).toBe(false)
    expect(isValidCapabilityId("")).toBe(false)
    expect(isValidCapabilityId("TOOL.REGISTER")).toBe(false)
    expect(isValidCapabilityId(" tool.register ")).toBe(false)
  })

  test("returns false for empty string", () => {
    expect(isValidCapabilityId("")).toBe(false)
  })

  test("rejects invalid CapabilityId string via type guard", () => {
    const invalidCapability = "nonexistent.capability" as string
    if (isValidCapabilityId(invalidCapability)) {
      expect.unreachable("should not pass guard for invalid ID")
    }
    expect(typeof invalidCapability).toBe("string")
  })
})
