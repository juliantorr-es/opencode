export const CapabilityId = {
  FilesystemRead: "filesystem.read",
  FilesystemWrite: "filesystem.write",
  NetworkRequest: "network.request",
  NetworkWebsocket: "network.websocket",
  SecretsAccess: "secrets.access",
  ToolRegister: "tool.register",
  ToolExecute: "tool.execute",
  EventSubscribe: "event.subscribe",
  EventEmit: "event.emit",
  HooksTransformMessage: "hooks.transform_message",
  HooksTransformSystem: "hooks.transform_system",
  HooksCompaction: "hooks.compaction",
  ConfigRead: "config.read",
  ConfigWrite: "config.write",
} as const
export type CapabilityId = (typeof CapabilityId)[keyof typeof CapabilityId]

export interface CapabilityManifest {
  opencode_version?: string
  capabilities: CapabilityId[]
  filesystem_read_scope?: string[]
  filesystem_write_scope?: string[]
  network_origins?: string[]
  tool_namespace?: string
  desktop_slots?: string[]
}

export type TrustLevel = "built-in" | "verified" | "external"

export interface PluginSecurityState {
  trustLevel: TrustLevel
  manifest: CapabilityManifest
  crashCount: number
  quarantined: boolean
}
