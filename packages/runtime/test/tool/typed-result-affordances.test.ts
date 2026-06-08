import { describe, it, expect } from "bun:test"
import {
  serializeNext,
  toolCategory,
  suggestedToolsAfterSuccess,
  affordancesAfterSuccess,
  makeSuccess,
  makeFailure,
  makeDenied,
  makeCancelled,
  formatOutput,
  parseOutput,
} from "../../src/tool/typed-result"
import type { NextAffordance, TypedToolResult } from "../../src/tool/typed-result"

describe("serializeNext", () => {
  it("merges suggestedTools into affordance objects", () => {
    const result = serializeNext(["grep", "read"], [])
    expect(result).toEqual([
      { action: "use_grep", target: "grep", command: "grep" },
      { action: "use_read", target: "read", command: "read" },
    ])
  })

  it("de-duplicates affordances whose targets already appeared in suggestedTools", () => {
    const result = serializeNext(
      ["grep"],
      [{ action: "search", target: "grep", command: "run grep again" }],
    )
    expect(result).toEqual([
      { action: "use_grep", target: "grep", command: "grep" },
    ])
  })

  it("skips generic continue when there are concrete suggestions", () => {
    const result = serializeNext(
      ["read"],
      [{ action: "continue", command: "proceed" }],
    )
    expect(result).toEqual([
      { action: "use_read", target: "read", command: "read" },
    ])
  })

  it("keeps continue when there are no concrete suggestions", () => {
    const result = serializeNext(
      [],
      [{ action: "continue", command: "proceed" }],
    )
    expect(result).toEqual([{ action: "continue", command: "proceed" }])
  })

  it("preserves non-conflicting affordances", () => {
    const result = serializeNext(
      ["grep"],
      [{ action: "retry", target: "bash", command: "try again" }],
    )
    expect(result).toEqual([
      { action: "use_grep", target: "grep", command: "grep" },
      { action: "retry", target: "bash", command: "try again" },
    ])
  })

  it("returns empty array for empty inputs", () => {
    expect(serializeNext([], [])).toEqual([])
  })
})

describe("NextAffordance extended fields", () => {
  it("accepts when field in affordance", () => {
    const aff: NextAffordance = {
      action: "conditional",
      when: "after_tests_pass",
    }
    expect(aff.when).toBe("after_tests_pass")
  })

  it("accepts args field in affordance", () => {
    const aff: NextAffordance = {
      action: "conditional",
      args: { file_path: "src/index.ts" },
    }
    expect(aff.args).toEqual({ file_path: "src/index.ts" })
  })
})

describe("toolCategory", () => {
  it("classifies read tools", () => {
    expect(toolCategory("read")).toBe("read")
    expect(toolCategory("read_source")).toBe("read")
  })

  it("classifies write tools", () => {
    expect(toolCategory("write")).toBe("write")
    expect(toolCategory("smart_edit")).toBe("write")
  })

  it("classifies search tools", () => {
    expect(toolCategory("grep")).toBe("search")
    expect(toolCategory("smart_find")).toBe("search")
  })

  it("classifies execute tools", () => {
    expect(toolCategory("bash")).toBe("execute")
    expect(toolCategory("task")).toBe("execute")
  })

  it("falls back to diagnose for unknown tools", () => {
    expect(toolCategory("unknown_tool")).toBe("diagnose")
  })
})

describe("TypedToolResult next field", () => {
  it("makeSuccess includes next field", () => {
    const result = makeSuccess("read", { content: "test" }, "read complete")
    expect(result.next).toBeDefined()
    expect(Array.isArray(result.next)).toBe(true)
    expect(result.next.length).toBeGreaterThan(0)
  })

  it("makeFailure includes next field", () => {
    const result = makeFailure("read", null, "validation", "bad input", false)
    expect(result.next).toBeDefined()
    expect(Array.isArray(result.next)).toBe(true)
  })

  it("makeDenied includes next field", () => {
    const result = makeDenied("write", null, "permission required")
    expect(result.next).toBeDefined()
    expect(Array.isArray(result.next)).toBe(true)
  })

  it("makeCancelled includes next field", () => {
    const result = makeCancelled("bash", null, "cancelled by user")
    expect(result.next).toBeDefined()
    expect(Array.isArray(result.next)).toBe(true)
  })

  it("formatOutput includes next in structured JSON", () => {
    const result = makeSuccess("read", { content: "test" }, "read complete")
    const output = formatOutput(result)
    expect(output).toContain('"next":')
    expect(output).toContain("[[typed-result]]")
  })

  it("parseOutput recovers next field", () => {
    const result = makeSuccess("read", { content: "test" }, "read complete")
    const output = formatOutput(result)
    const parsed = parseOutput(output)
    expect(parsed).toBeDefined()
    expect(parsed!.next).toBeDefined()
    expect(Array.isArray(parsed!.next)).toBe(true)
  })
})

describe("suggestedToolsAfterSuccess", () => {
  it("returns non-empty array for known tools", () => {
    const tools = suggestedToolsAfterSuccess("read")
    expect(Array.isArray(tools)).toBe(true)
    expect(tools.length).toBeGreaterThan(0)
  })

  it("does not include the tool itself", () => {
    const tools = suggestedToolsAfterSuccess("read")
    for (const t of tools) {
      expect(t).not.toBe("read")
    }
  })
})

describe("affordancesAfterSuccess", () => {
  it("returns NextAffordance array for read category", () => {
    const affs = affordancesAfterSuccess("read")
    expect(affs.length).toBeGreaterThan(0)
    for (const aff of affs) {
      expect(aff.action).toBeDefined()
      expect(typeof aff.action).toBe("string")
    }
  })
})
