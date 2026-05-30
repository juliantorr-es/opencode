import { describe, it, expect } from "bun:test"

// Validation functions replicated from main/ipc.ts (same logic)
function isValidPluginConfigEntry(val: unknown): val is Record<string, unknown> {
  if (typeof val !== "object" || val === null) return false
  const obj = val as Record<string, unknown>
  return typeof obj.name === "string" && typeof obj.path === "string" && typeof obj.enabled === "boolean"
}

function validateAndFilterPluginConfigs(raw: unknown): { configs: unknown[]; dropped: number } {
  if (!Array.isArray(raw)) return { configs: [], dropped: 0 }
  const original = raw.length
  const configs = raw.filter((item): item is Record<string, unknown> => {
    if (isValidPluginConfigEntry(item)) return true
    return false
  })
  return { configs, dropped: original - configs.length }
}

describe("isValidPluginConfigEntry", () => {
  it("returns true for valid entry with name, path, enabled", () => {
    expect(isValidPluginConfigEntry({ name: "p", path: "/p", enabled: true })).toBe(true)
  })

  it("returns true for entry with optional config", () => {
    expect(isValidPluginConfigEntry({ name: "p", path: "/p", enabled: true, config: { key: "val" } })).toBe(true)
  })

  it("returns false for null", () => {
    expect(isValidPluginConfigEntry(null)).toBe(false)
  })

  it("returns false for non-object", () => {
    expect(isValidPluginConfigEntry("string")).toBe(false)
  })

  it("returns false for missing name", () => {
    expect(isValidPluginConfigEntry({ path: "/p", enabled: true })).toBe(false)
  })

  it("returns false for missing path", () => {
    expect(isValidPluginConfigEntry({ name: "p", enabled: true })).toBe(false)
  })

  it("returns false for non-boolean enabled", () => {
    expect(isValidPluginConfigEntry({ name: "p", path: "/p", enabled: "yes" })).toBe(false)
  })

  it("returns false for non-string name", () => {
    expect(isValidPluginConfigEntry({ name: 123, path: "/p", enabled: true })).toBe(false)
  })
})

describe("validateAndFilterPluginConfigs", () => {
  it("returns { configs: [], dropped: 0 } for non-array input", () => {
    const result = validateAndFilterPluginConfigs(null)
    expect(result).toEqual({ configs: [], dropped: 0 })
  })

  it("returns { configs: [], dropped: 0 } for empty array", () => {
    const result = validateAndFilterPluginConfigs([])
    expect(result).toEqual({ configs: [], dropped: 0 })
  })

  it("filters out invalid entries and reports dropped count", () => {
    const valid = { name: "p", path: "/p", enabled: true }
    const invalid = { name: "bad" } // missing path and enabled
    const result = validateAndFilterPluginConfigs([valid, invalid, valid])
    expect(result.configs).toHaveLength(2)
    expect(result.dropped).toBe(1)
  })

  it("keeps all valid entries unchanged", () => {
    const entries = [
      { name: "a", path: "/a", enabled: true },
      { name: "b", path: "/b", enabled: false },
    ]
    const result = validateAndFilterPluginConfigs(entries)
    expect(result.configs).toHaveLength(2)
    expect(result.dropped).toBe(0)
  })

  it("drops all entries if all invalid", () => {
    const result = validateAndFilterPluginConfigs([null, undefined, 42])
    expect(result.configs).toHaveLength(0)
    expect(result.dropped).toBe(3)
  })
})
