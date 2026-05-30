import { describe, it, expect } from "bun:test"
import {
  isValidAgentDef,
  validateAndFilterAgents,
  isValidMcpEntry,
  validateAndFilterMcpServers,
  isValidPluginConfigEntry,
  validateAndFilterPluginConfigs,
} from "../src/main/ipc-validation"

describe("isValidAgentDef", () => {
  it("returns true for valid agent def", () => {
    expect(isValidAgentDef({ id: "a1", name: "test", prompt: "you are test" })).toBe(true)
  })

  it("returns true with optional temperature and top_p", () => {
    expect(isValidAgentDef({ id: "a1", name: "test", prompt: "you are test", temperature: 0.5, top_p: 0.9 })).toBe(true)
  })

  it("returns false for null", () => {
    expect(isValidAgentDef(null)).toBe(false)
  })

  it("returns false for non-object", () => {
    expect(isValidAgentDef("string")).toBe(false)
  })

  it("returns false for missing id", () => {
    expect(isValidAgentDef({ name: "test", prompt: "you are test" })).toBe(false)
  })

  it("returns false for non-string id", () => {
    expect(isValidAgentDef({ id: 123, name: "test", prompt: "you are test" })).toBe(false)
  })

  it("returns false for invalid temperature (NaN)", () => {
    expect(isValidAgentDef({ id: "a1", name: "test", prompt: "you are test", temperature: NaN })).toBe(false)
  })

  it("returns false for non-number temperature", () => {
    expect(isValidAgentDef({ id: "a1", name: "test", prompt: "you are test", temperature: "high" })).toBe(false)
  })

  it("returns false for invalid top_p (NaN)", () => {
    expect(isValidAgentDef({ id: "a1", name: "test", prompt: "you are test", top_p: NaN })).toBe(false)
  })
})

describe("validateAndFilterAgents", () => {
  it("returns empty array for non-array input", () => {
    expect(validateAndFilterAgents(null)).toEqual([])
  })

  it("returns empty array for empty array", () => {
    expect(validateAndFilterAgents([])).toEqual([])
  })

  it("filters out invalid entries", () => {
    const valid = { id: "a1", name: "test", prompt: "you are test" }
    const invalid = { name: "bad" } // missing id and prompt
    const result = validateAndFilterAgents([valid, invalid, valid])
    expect(result).toHaveLength(2)
  })
})

describe("isValidMcpEntry", () => {
  it("returns true for valid local entry", () => {
    expect(isValidMcpEntry({ name: "srv", config: { type: "local", command: ["cmd"] } })).toBe(true)
  })

  it("returns true for valid remote entry", () => {
    expect(isValidMcpEntry({ name: "srv", config: { type: "remote", url: "http://localhost" } })).toBe(true)
  })

  it("returns false for null", () => {
    expect(isValidMcpEntry(null)).toBe(false)
  })

  it("returns false for missing name", () => {
    expect(isValidMcpEntry({ config: { type: "local", command: ["cmd"] } })).toBe(false)
  })

  it("returns false for missing config", () => {
    expect(isValidMcpEntry({ name: "srv" })).toBe(false)
  })

  it("returns false for local entry with empty command array", () => {
    expect(isValidMcpEntry({ name: "srv", config: { type: "local", command: [] } })).toBe(false)
  })

  it("returns false for remote entry without url string", () => {
    expect(isValidMcpEntry({ name: "srv", config: { type: "remote", url: 123 } })).toBe(false)
  })
})

describe("validateAndFilterMcpServers", () => {
  it("returns { servers: [], dropped: 0 } for non-array input", () => {
    expect(validateAndFilterMcpServers(null)).toEqual({ servers: [], dropped: 0 })
  })

  it("filters out invalid entries and reports dropped count", () => {
    const valid = { name: "srv", config: { type: "local", command: ["cmd"] } }
    const invalid = { name: "bad" } // missing config
    const result = validateAndFilterMcpServers([valid, invalid, valid])
    expect(result.servers).toHaveLength(2)
    expect(result.dropped).toBe(1)
  })
})

describe("isValidPluginConfigEntry", () => {
  it("returns true for valid entry with name, path, enabled", () => {
    expect(isValidPluginConfigEntry({ name: "p", path: "/p", enabled: true })).toBe(true)
  })

  it("returns false for null", () => {
    expect(isValidPluginConfigEntry(null)).toBe(false)
  })

  it("returns false for missing name", () => {
    expect(isValidPluginConfigEntry({ path: "/p", enabled: true })).toBe(false)
  })
})

describe("validateAndFilterPluginConfigs", () => {
  it("returns { configs: [], dropped: 0 } for non-array input", () => {
    expect(validateAndFilterPluginConfigs(null)).toEqual({ configs: [], dropped: 0 })
  })

  it("filters out invalid entries and reports dropped count", () => {
    const valid = { name: "p", path: "/p", enabled: true }
    const invalid = { name: "bad" } // missing path and enabled
    const result = validateAndFilterPluginConfigs([valid, invalid, valid])
    expect(result.configs).toHaveLength(2)
    expect(result.dropped).toBe(1)
  })
})
