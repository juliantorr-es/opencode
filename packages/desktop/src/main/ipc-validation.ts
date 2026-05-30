import type { AgentDef, PluginConfigEntry } from "../preload/types"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function validateAndFilterAgents(input: unknown): AgentDef[] {
  if (!Array.isArray(input)) return []
  return input.filter((item): item is AgentDef => {
    if (!isRecord(item)) return false
    return (
      typeof item.id === "string" &&
      typeof item.name === "string" &&
      typeof item.prompt === "string"
    )
  })
}

export function validateAndFilterMcpServers(input: unknown): { servers: unknown[]; dropped: number } {
  if (!Array.isArray(input)) return { servers: [], dropped: 0 }
  const servers: unknown[] = []
  let dropped = 0
  for (const item of input) {
    if (!isRecord(item) || typeof item.name !== "string" || !isRecord(item.config)) {
      dropped++
    } else {
      servers.push(item)
    }
  }
  return { servers, dropped }
}

export function validateAndFilterPluginConfigs(input: unknown): { configs: PluginConfigEntry[]; dropped: number } {
  if (!Array.isArray(input)) return { configs: [], dropped: 0 }
  const configs: PluginConfigEntry[] = []
  let dropped = 0
  for (const item of input) {
    if (!isRecord(item) || typeof item.name !== "string" || typeof item.path !== "string" || typeof item.enabled !== "boolean") {
      dropped++
    } else {
      const entry: PluginConfigEntry = {
        name: item.name,
        path: item.path,
        enabled: item.enabled,
      }
      if (isRecord(item.config)) {
        entry.config = item.config
      }
      configs.push(entry)
    }
  }
  return { configs, dropped }
}
