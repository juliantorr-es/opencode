import { describe, expect, test } from "bun:test"

// These validation functions are pure logic — no Electron imports — so we import them directly.
// They live in a separate module specifically to be testable without Electron.
import {
  validateAndFilterAgents,
  validateAndFilterMcpServers,
  validateAndFilterPluginConfigs,
} from "../src/main/ipc-validation"

describe("validateAndFilterAgents", () => {
  // Tests the agent validation: requires { id: string, name: string, prompt: string }

  test("filters valid agents from an array", () => {
    const input = [
      { id: "agent-1", name: "Builder", prompt: "You are a builder" },
      { id: "agent-2", name: "Planner", prompt: "You are a planner" },
    ]
    const result = validateAndFilterAgents(input)
    expect(result).toHaveLength(2)
    expect(result[0].id).toBe("agent-1")
    expect(result[1].name).toBe("Planner")
  })

  test("preserves AgentDef optional fields", () => {
    const input = [
      { id: "agent-full", name: "Full Agent", prompt: "Prompt", description: "A full agent", model: "gpt-4", temperature: 0.7, color: "#ff0", steps: 5 },
    ]
    const result = validateAndFilterAgents(input)
    expect(result).toHaveLength(1)
    expect(result[0].description).toBe("A full agent")
    expect(result[0].model).toBe("gpt-4")
    expect(result[0].temperature).toBe(0.7)
    expect(result[0].color).toBe("#ff0")
    expect(result[0].steps).toBe(5)
  })

  test("filters out items missing id", () => {
    const input = [
      { name: "No ID", prompt: "Prompt" },
      { id: "valid", name: "Valid", prompt: "Prompt" },
    ]
    const result = validateAndFilterAgents(input)
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe("valid")
  })

  test("filters out items missing name", () => {
    const input = [
      { id: "no-name", prompt: "Prompt" },
      { id: "valid", name: "Valid", prompt: "Prompt" },
    ]
    const result = validateAndFilterAgents(input)
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe("valid")
  })

  test("filters out items missing prompt", () => {
    const input = [
      { id: "no-prompt", name: "No Prompt" },
      { id: "valid", name: "Valid", prompt: "Prompt" },
    ]
    const result = validateAndFilterAgents(input)
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe("valid")
  })

  test("filters out non-object items", () => {
    const input = [
      "string",
      42,
      null,
      undefined,
      true,
      { id: "valid", name: "Valid", prompt: "Prompt" },
    ]
    const result = validateAndFilterAgents(input)
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe("valid")
  })

  test("filters out items with non-string fields", () => {
    const input = [
      { id: 123, name: "Num ID", prompt: "Prompt" },
      { id: "valid", name: true, prompt: "Prompt" },
      { id: "valid2", name: "Valid2", prompt: 456 },
      { id: "valid3", name: "Valid3", prompt: "Real prompt" },
    ]
    const result = validateAndFilterAgents(input)
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe("valid3")
  })

  test("filters out arrays (not a record)", () => {
    const input = [
      { id: "valid", name: "Valid", prompt: "Prompt" },
      [],
      [1, 2, 3],
    ]
    const result = validateAndFilterAgents(input)
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe("valid")
  })

  test("returns empty array for non-array input", () => {
    expect(validateAndFilterAgents(null)).toEqual([])
    expect(validateAndFilterAgents(undefined)).toEqual([])
    expect(validateAndFilterAgents("string")).toEqual([])
    expect(validateAndFilterAgents({})).toEqual([])
    expect(validateAndFilterAgents(42)).toEqual([])
  })

  test("returns empty array for empty array", () => {
    expect(validateAndFilterAgents([])).toEqual([])
  })

  test("filters out duplicate entries (they pass individually but are all valid)", () => {
    const input = [
      { id: "dup", name: "Dup", prompt: "P" },
      { id: "dup", name: "Dup", prompt: "P" },
      { id: "unique", name: "Unique", prompt: "P" },
    ]
    const result = validateAndFilterAgents(input)
    // Both pass — dedup is not the function's job
    expect(result).toHaveLength(3)
  })
})

describe("validateAndFilterMcpServers", () => {
  // Tests MCP server validation: requires { name: string, config: Record<string, unknown> }

  test("filters valid MCP servers", () => {
    const input = [
      { name: "Server A", config: { command: ["node", "server.js"] } },
      { name: "Server B", config: { url: "https://example.com/sse" } },
    ]
    const result = validateAndFilterMcpServers(input)
    expect(result.servers).toHaveLength(2)
    expect(result.dropped).toBe(0)
    expect(result.servers[0]).toEqual({ name: "Server A", config: { command: ["node", "server.js"] } })
  })

  test("counts dropped entries with missing name", () => {
    const input = [
      { config: { command: ["node"] } },
      { name: "Valid", config: { command: ["node"] } },
    ]
    const result = validateAndFilterMcpServers(input)
    expect(result.servers).toHaveLength(1)
    expect(result.dropped).toBe(1)
    expect(result.servers[0].name).toBe("Valid")
  })

  test("counts dropped entries with missing config", () => {
    const input = [
      { name: "No Config" },
      { name: "Valid", config: { command: ["node"] } },
    ]
    const result = validateAndFilterMcpServers(input)
    expect(result.servers).toHaveLength(1)
    expect(result.dropped).toBe(1)
  })

  test("counts dropped entries where config is not a record", () => {
    const input = [
      { name: "Bad Config", config: "string-config" },
      { name: "Config Array", config: [] },
      { name: "Config Null", config: null },
      { name: "Valid", config: { command: ["node"] } },
    ]
    const result = validateAndFilterMcpServers(input)
    expect(result.servers).toHaveLength(1)
    expect(result.dropped).toBe(3)
  })

  test("counts dropped non-object entries", () => {
    const input = [
      "string",
      42,
      null,
      undefined,
      { name: "Valid", config: { command: ["node"] } },
    ]
    const result = validateAndFilterMcpServers(input)
    expect(result.servers).toHaveLength(1)
    expect(result.dropped).toBe(4)
    expect(result.servers[0].name).toBe("Valid")
  })

  test("returns empty result for non-array input", () => {
    const result = validateAndFilterMcpServers(null)
    expect(result.servers).toEqual([])
    expect(result.dropped).toBe(0)
  })

  test("returns empty result for empty array", () => {
    const result = validateAndFilterMcpServers([])
    expect(result.servers).toEqual([])
    expect(result.dropped).toBe(0)
  })

  test("includes servers with additional properties", () => {
    const input = [
      { name: "Extra Props", config: { command: ["node"] }, extraField: "value" },
    ]
    const result = validateAndFilterMcpServers(input)
    expect(result.servers).toHaveLength(1)
    expect(result.dropped).toBe(0)
  })
})

describe("validateAndFilterPluginConfigs", () => {
  // Tests plugin config validation: requires { name: string, path: string, enabled: boolean }

  test("filters valid plugin configs", () => {
    const input = [
      { name: "Plugin A", path: "/path/to/a", enabled: true },
      { name: "Plugin B", path: "/path/to/b", enabled: false },
    ]
    const result = validateAndFilterPluginConfigs(input)
    expect(result.configs).toHaveLength(2)
    expect(result.dropped).toBe(0)
    expect(result.configs[0].name).toBe("Plugin A")
    expect(result.configs[0].path).toBe("/path/to/a")
    expect(result.configs[0].enabled).toBe(true)
  })

  test("includes optional config field when present", () => {
    const input = [
      {
        name: "Plugin With Config",
        path: "/path",
        enabled: true,
        config: { apiKey: "abc123", endpoint: "https://example.com" },
      },
    ]
    const result = validateAndFilterPluginConfigs(input)
    expect(result.configs).toHaveLength(1)
    expect(result.configs[0].config).toEqual({ apiKey: "abc123", endpoint: "https://example.com" })
  })

  test("omits config field when not present", () => {
    const input = [
      { name: "Plugin No Config", path: "/path", enabled: true },
    ]
    const result = validateAndFilterPluginConfigs(input)
    expect(result.configs).toHaveLength(1)
    expect(result.configs[0].config).toBeUndefined()
  })

  test("counts dropped entries with missing name", () => {
    const input = [
      { path: "/path", enabled: true },
      { name: "Valid", path: "/path", enabled: true },
    ]
    const result = validateAndFilterPluginConfigs(input)
    expect(result.configs).toHaveLength(1)
    expect(result.dropped).toBe(1)
  })

  test("counts dropped entries with missing path", () => {
    const input = [
      { name: "No Path", enabled: true },
      { name: "Valid", path: "/path", enabled: true },
    ]
    const result = validateAndFilterPluginConfigs(input)
    expect(result.configs).toHaveLength(1)
    expect(result.dropped).toBe(1)
  })

  test("counts dropped entries with missing enabled", () => {
    const input = [
      { name: "No Enabled", path: "/path" },
      { name: "Valid", path: "/path", enabled: true },
    ]
    const result = validateAndFilterPluginConfigs(input)
    expect(result.configs).toHaveLength(1)
    expect(result.dropped).toBe(1)
  })

  test("counts dropped entries with wrong types for required fields", () => {
    const input = [
      { name: 123, path: "/path", enabled: true },
      { name: "Name", path: 456, enabled: true },
      { name: "Name", path: "/path", enabled: "yes" },
      { name: "Name", path: null, enabled: true },
      { name: "Valid", path: "/path", enabled: true },
    ]
    const result = validateAndFilterPluginConfigs(input)
    expect(result.configs).toHaveLength(1)
    expect(result.dropped).toBe(4)
  })

  test("counts dropped non-object entries", () => {
    const input = [
      "string",
      null,
      undefined,
      42,
      { name: "Valid", path: "/path", enabled: true },
    ]
    const result = validateAndFilterPluginConfigs(input)
    expect(result.configs).toHaveLength(1)
    expect(result.dropped).toBe(4)
  })

  test("filters out array entries (not a record)", () => {
    const input = [
      { name: "Valid", path: "/path", enabled: true },
      ["some", "array"],
    ]
    const result = validateAndFilterPluginConfigs(input)
    expect(result.configs).toHaveLength(1)
    expect(result.dropped).toBe(1)
  })

  test("returns empty result for non-array input", () => {
    expect(validateAndFilterPluginConfigs(null)).toEqual({ configs: [], dropped: 0 })
    expect(validateAndFilterPluginConfigs(undefined)).toEqual({ configs: [], dropped: 0 })
    expect(validateAndFilterPluginConfigs("string")).toEqual({ configs: [], dropped: 0 })
    expect(validateAndFilterPluginConfigs({})).toEqual({ configs: [], dropped: 0 })
  })

  test("returns empty result for empty array", () => {
    expect(validateAndFilterPluginConfigs([])).toEqual({ configs: [], dropped: 0 })
  })

  test("handles large arrays correctly", () => {
    const valid = { name: "Valid", path: "/path", enabled: true }
    const invalid = { name: "Invalid" } // missing path and enabled

    const input = [
      ...Array.from({ length: 50 }, (_, i) => ({ ...valid, name: `Plugin ${i}` })),
      invalid,
    ]
    const result = validateAndFilterPluginConfigs(input)
    expect(result.configs).toHaveLength(50)
    expect(result.dropped).toBe(1)
  })
})
