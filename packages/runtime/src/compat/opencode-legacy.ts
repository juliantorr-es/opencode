import { join } from "node:path"
import { homedir } from "node:os"

/**
 * OpenCode Legacy Compatibility
 * 
 * ALL opencode-branded aliases, env vars, IPC channels, config fallbacks,
 * and directory migrations are centralized here. Nothing else should emit
 * or depend on opencode-branded runtime behavior.
 * 
 * Deprecation horizon: removeAfter version specified below.
 */

export const OPENCODE_LEGACY_COMPAT = {
  introduced: "0.1.0",
  removeAfter: "0.3.0",
  envAliases: true,
  ipcAliases: true,
  configFallback: true,
  dirMigration: true,
} as const

export const ENV_ALIASES: Record<string, string> = {
  // Path/env aliases
  STATE_HOME: "TRIBUNUS_STATE_HOME",
  CONFIG_HOME: "TRIBUNUS_CONFIG_HOME",
  CACHE_HOME: "TRIBUNUS_CACHE_HOME",
  DATA_HOME: "TRIBUNUS_DATA_HOME",
  LOG_HOME: "TRIBUNUS_LOG_HOME",
  // Runtime config
  CLIENT: "TRIBUNUS_CLIENT",
  COORDINATION_BACKEND: "TRIBUNUS_COORDINATION_BACKEND",
  DB: "TRIBUNUS_DB",
  VALKEY_URL: "TRIBUNUS_VALKEY_URL",
  // User-facing config
  GITHUB_CLIENT_ID: "TRIBUNUS_GITHUB_CLIENT_ID",
  FORCE_UPDATER: "TRIBUNUS_FORCE_UPDATER",
  SAFE_MODE: "TRIBUNUS_SAFE_MODE",
  PORT: "TRIBUNUS_PORT",
  WEBSEARCH_PROVIDER: "TRIBUNUS_WEBSEARCH_PROVIDER",
  REPO_CLONE_GITHUB_BASE_URL: "TRIBUNUS_REPO_CLONE_GITHUB_BASE_URL",
  CONFIG_CONTENT: "TRIBUNUS_CONFIG_CONTENT",
  AUTH_CONTENT: "TRIBUNUS_AUTH_CONTENT",
  CONFIG_DIR: "TRIBUNUS_CONFIG_DIR",
  DISABLE_PROJECT_CONFIG: "TRIBUNUS_DISABLE_PROJECT_CONFIG",
}

const warnedEnvKeys = new Set<string>()

export function getEnv(suffix: keyof typeof ENV_ALIASES): string | undefined {
  const canonical = process.env[ENV_ALIASES[suffix]]
  if (canonical !== undefined) return canonical
  
  const legacyKey = `OPENCODE_${suffix}`
  const legacy = process.env[legacyKey]
  if (legacy !== undefined && !warnedEnvKeys.has(legacyKey)) {
    console.warn(`[legacy] ${legacyKey} is deprecated — use ${ENV_ALIASES[suffix]} instead`)
    warnedEnvKeys.add(legacyKey)
  }
  return legacy
}

const IPC_ALIASES: Record<string, string> = {}

export function registerLegacyIpcAlias(legacyChannel: string, canonicalChannel: string): void {
  IPC_ALIASES[legacyChannel] = canonicalChannel
}

export function isLegacyIpcAlias(channel: string): boolean {
  return channel in IPC_ALIASES
}

export function legacyConfigDir(): string {
  return join(homedir(), ".opencode")
}

export function tribunusConfigDir(): string {
  return join(homedir(), ".tribunus")
}

export function validateNoLegacyLeaks(): string[] {
  const issues: string[] = []
  return issues
}


