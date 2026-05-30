import type { McpRemoteConfig } from "@opencode-ai/sdk/v2/client"

type McpLocalConfig = {
  type: "local"
  command: string[]
  environment?: Record<string, string>
  timeout?: number
  enabled?: boolean
}

export type McpServerConfig = McpLocalConfig | McpRemoteConfig

export type McpServerEntry = {
  name: string
  config: McpServerConfig
}
