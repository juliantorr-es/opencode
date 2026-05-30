import { describe, it, expect } from "bun:test"
import {
  isValidPluginConfigEntry,
  validateAndFilterPluginConfigs,
  validateAndFilterAgents,
  validateAndFilterMcpServers,
} from "../src/main/ipc-validation"

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

describe("validateAndFilterAgents", () => {
  it("returns [] for non-array input", () => {
    expect(validateAndFilterAgents(null)).toEqual([])
  })

  it("returns [] for empty array", () => {
    expect(validateAndFilterAgents([])).toEqual([])
  })

  it("filters entries with valid id, name, and prompt", () => {
    const valid = { id: "a1", name: "Agent A", prompt: "You are helpful" }
    const invalid = { id: "b2" } // missing name and prompt
    const result = validateAndFilterAgents([valid, invalid, valid])
    expect(result).toHaveLength(2)
  })

  it("drops entries with non-string id", () => {
    const result = validateAndFilterAgents([{ id: 123, name: "A", prompt: "X" }])
    expect(result).toHaveLength(0)
  })

  it("drops entries with non-string name", () => {
    const result = validateAndFilterAgents([{ id: "a1", name: 123, prompt: "X" }])
    expect(result).toHaveLength(0)
  })

  it("drops null/undefined entries", () => {
    const result = validateAndFilterAgents([null, undefined])
    expect(result).toHaveLength(0)
  })
})

describe("validateAndFilterMcpServers", () => {
  it("returns { servers: [], dropped: 0 } for non-array input", () => {
    const result = validateAndFilterMcpServers(null)
    expect(result).toEqual({ servers: [], dropped: 0 })
  })

  it("returns { servers: [], dropped: 0 } for empty array", () => {
    const result = validateAndFilterMcpServers([])
    expect(result).toEqual({ servers: [], dropped: 0 })
  })

  it("filters valid local MCP entries", () => {
    const valid = { name: "server-a", config: { type: "local", command: ["node", "index.js"] } }
    const result = validateAndFilterMcpServers([valid])
    expect(result.servers).toHaveLength(1)
    expect(result.dropped).toBe(0)
  })

  it("filters valid remote MCP entries", () => {
    const valid = { name: "server-b", config: { type: "remote", url: "https://example.com/sse" } }
    const result = validateAndFilterMcpServers([valid])
    expect(result.servers).toHaveLength(1)
    expect(result.dropped).toBe(0)
  })

  it("drops entries without config", () => {
    const result = validateAndFilterMcpServers([{ name: "server-c" }])
    expect(result.servers).toHaveLength(0)
    expect(result.dropped).toBe(1)
  })

  it("drops entries with invalid config type", () => {
    const result = validateAndFilterMcpServers([{ name: "server-d", config: { type: "unknown" } }])
    expect(result.servers).toHaveLength(0)
    expect(result.dropped).toBe(1)
  })

  it("filters mixed valid and invalid entries", () => {
    const valid = { name: "server-a", config: { type: "local", command: ["node", "index.js"] } }
    const invalid = { name: "server-b" }
    const result = validateAndFilterMcpServers([valid, invalid, valid])
    expect(result.servers).toHaveLength(2)
    expect(result.dropped).toBe(1)
  })
})
