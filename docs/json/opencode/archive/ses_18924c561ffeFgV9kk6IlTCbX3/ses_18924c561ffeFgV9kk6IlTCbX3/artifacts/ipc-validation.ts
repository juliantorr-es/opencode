// Validation helpers for IPC store handlers.
// Extracted from ipc.ts for testability. All functions are pure
// — they transform/validate data without side effects.

export function isValidAgentDef(val: unknown): val is Record<string, unknown> {
  if (typeof val !== "object" || val === null) return false
  const obj = val as Record<string, unknown>
  if (typeof obj.id !== "string" || typeof obj.name !== "string" || typeof obj.prompt !== "string") return false
  if (obj.temperature !== undefined && (typeof obj.temperature !== "number" || Number.isNaN(obj.temperature))) return false
  if (obj.top_p !== undefined && (typeof obj.top_p !== "number" || Number.isNaN(obj.top_p))) return false
  return true
}

export function validateAndFilterAgents(raw: unknown): unknown[] {
  if (!Array.isArray(raw)) return []
  return raw.filter((item): item is Record<string, unknown> => {
    if (isValidAgentDef(item)) return true
    console.warn("Dropping invalid agent entry:", item)
    return false
  })
}

export function isValidMcpEntry(val: unknown): val is Record<string, unknown> {
  if (typeof val !== "object" || val === null) return false
  const obj = val as Record<string, unknown>
  if (typeof obj.name !== "string") return false
  const config = obj.config as Record<string, unknown> | undefined
  if (!config || typeof config !== "object") return false
  if (config.type === "local" && !Array.isArray(config.command)) return false
  if (config.type === "remote" && typeof config.url !== "string") return false
  return config.type === "local" || config.type === "remote"
}

export function validateAndFilterMcpServers(raw: unknown): { servers: unknown[]; dropped: number } {
  if (!Array.isArray(raw)) return { servers: [], dropped: 0 }
  const original = raw.length
  const servers = raw.filter((item): item is Record<string, unknown> => {
    if (isValidMcpEntry(item)) return true
    console.warn("Dropping invalid MCP server entry:", item)
    return false
  })
  return { servers, dropped: original - servers.length }
}

export function isValidPluginConfigEntry(val: unknown): val is Record<string, unknown> {
  if (typeof val !== "object" || val === null) return false
  const obj = val as Record<string, unknown>
  return typeof obj.name === "string" && typeof obj.path === "string" && typeof obj.enabled === "boolean"
}

export function validateAndFilterPluginConfigs(raw: unknown): { configs: unknown[]; dropped: number } {
  if (!Array.isArray(raw)) return { configs: [], dropped: 0 }
  const original = raw.length
  const configs = raw.filter((item): item is Record<string, unknown> => {
    if (isValidPluginConfigEntry(item)) return true
    console.warn("Dropping invalid plugin config entry:", item)
    return false
  })
  return { configs, dropped: original - configs.length }
}
