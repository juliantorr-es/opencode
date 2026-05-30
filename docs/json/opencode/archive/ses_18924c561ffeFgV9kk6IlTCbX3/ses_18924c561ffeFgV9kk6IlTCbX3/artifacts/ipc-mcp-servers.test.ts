import { describe, it, expect } from "bun:test"
import { isValidMcpEntry, validateAndFilterMcpServers } from "../src/main/ipc-validation"

describe("isValidMcpEntry", () => {
  it("returns true for valid local entry with command array", () => {
    expect(isValidMcpEntry({ name: "my-server", config: { type: "local", command: ["node", "index.js"] } })).toBe(true)
  })

  it("returns true for valid local entry with optional fields", () => {
    expect(
      isValidMcpEntry({
        name: "my-server",
        config: { type: "local", command: ["node", "index.js"], timeout: 30, enabled: true },
      }),
    ).toBe(true)
  })

  it("returns true for valid remote entry with url", () => {
    expect(isValidMcpEntry({ name: "my-server", config: { type: "remote", url: "http://localhost:3000" } })).toBe(true)
  })

  it("returns true for valid remote entry with optional fields", () => {
    expect(
      isValidMcpEntry({
        name: "my-server",
        config: { type: "remote", url: "http://localhost:3000", enabled: true },
      }),
    ).toBe(true)
  })

  it("returns false for null", () => {
    expect(isValidMcpEntry(null)).toBe(false)
  })

  it("returns false for non-object", () => {
    expect(isValidMcpEntry("string")).toBe(false)
  })

  it("returns false for missing name", () => {
    expect(isValidMcpEntry({ config: { type: "local", command: ["node"] } })).toBe(false)
  })

  it("returns false for non-string name", () => {
    expect(isValidMcpEntry({ name: 123, config: { type: "local", command: ["node"] } })).toBe(false)
  })

  it("returns false for missing config", () => {
    expect(isValidMcpEntry({ name: "my-server" })).toBe(false)
  })

  it("returns false for null config", () => {
    expect(isValidMcpEntry({ name: "my-server", config: null })).toBe(false)
  })

  it("returns false for invalid config type", () => {
    expect(isValidMcpEntry({ name: "my-server", config: { type: "ssh", command: ["node"] } })).toBe(false)
  })

  it("returns false for local entry without command array", () => {
    expect(isValidMcpEntry({ name: "my-server", config: { type: "local", command: "node" } })).toBe(false)
  })

  it("returns false for empty command array (local)", () => {
    expect(isValidMcpEntry({ name: "my-server", config: { type: "local", command: [] } })).toBe(false)
  })

  it("returns false for remote entry without url string", () => {
    expect(isValidMcpEntry({ name: "my-server", config: { type: "remote", url: 123 } })).toBe(false)
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

  it("keeps all valid entries unchanged", () => {
    const entries = [
      { name: "a", config: { type: "local", command: ["node"] } },
      { name: "b", config: { type: "remote", url: "http://localhost:3000" } },
    ]
    const result = validateAndFilterMcpServers(entries)
    expect(result.servers).toHaveLength(2)
    expect(result.dropped).toBe(0)
  })

  it("filters out invalid entries and reports dropped count", () => {
    const valid = { name: "a", config: { type: "local", command: ["node"] } }
    const invalid = { name: "bad" } // missing config
    const result = validateAndFilterMcpServers([valid, invalid, valid])
    expect(result.servers).toHaveLength(2)
    expect(result.dropped).toBe(1)
  })

  it("drops all entries if all invalid", () => {
    const result = validateAndFilterMcpServers([null, undefined, 42])
    expect(result.servers).toHaveLength(0)
    expect(result.dropped).toBe(3)
  })

  it("drops entries with invalid config type", () => {
    const entries = [
      { name: "a", config: { type: "local", command: ["node"] } },
      { name: "b", config: { type: "ssh", command: ["node"] } },
      { name: "c", config: { type: "remote", url: "http://localhost" } },
    ]
    const result = validateAndFilterMcpServers(entries)
    expect(result.servers).toHaveLength(2)
    expect(result.dropped).toBe(1)
  })

  it("drops entries with non-array command for local type", () => {
    const entries = [
      { name: "a", config: { type: "local", command: "node index.js" } },
      { name: "b", config: { type: "local", command: ["node"] } },
    ]
    const result = validateAndFilterMcpServers(entries)
    expect(result.servers).toHaveLength(1)
    expect(result.dropped).toBe(1)
  })
})
