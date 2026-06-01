/**
 * Config resolution — single source of truth for all plugin configuration.
 *
 * Resolution path:
 *   global config (~/.config/opencode/opencode.json)
 *     ↓
 *   project config (opencode.jsonc)
 *     ↓
 *   plugin defaults
 *     ↓
 *   resolved configuration
 *
 * Every tool reads resolved config through this module.
 * No tool parses config independently.
 */

import { readFileSync, existsSync } from "node:fs"
import { resolve } from "node:path"
import { homedir } from "node:os"

// ═══════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════

export interface PluginDefaults {
  db: {
    retentionDays: number
    journalMode: "wal" | "delete"
    busyTimeout: number
  }
  orchestration: {
    staleTimeoutMinutes: number
    maxRepairRounds: number
    contextBudget: Record<string, { system: number; history: number; artifacts: number }>
    agentProfiles: Record<string, { exploreTemp: number; executeTemp: number }>
    criticalLanes: string[]
  }
  tools: {
    autoApprove: string[]
    emojis: Record<string, string>
  }
  features: {
    liveFileWatcher: boolean
    autoHandoffDetection: boolean
    loopDetection: boolean
    contextDiffing: boolean
    hiveMemory: boolean
    knowledgeGraph: boolean
    fileHashTracking: boolean
  }
}

const DEFAULTS: PluginDefaults = {
  db: {
    retentionDays: 7,
    journalMode: "wal",
    busyTimeout: 5000,
  },
  orchestration: {
    staleTimeoutMinutes: 5,
    maxRepairRounds: 3,
    contextBudget: {
      cartographer: { system: 2000, history: 4000, artifacts: 6000 },
      architect: { system: 1500, history: 3000, artifacts: 4000 },
      critic: { system: 1500, history: 3000, artifacts: 3000 },
      surgeon: { system: 1000, history: 2000, artifacts: 8000 },
      trial: { system: 1000, history: 2000, artifacts: 5000 },
      journalist: { system: 1500, history: 5000, artifacts: 2000 },
      "handy-agent": { system: 1000, history: 1500, artifacts: 4000 },
      "general-man-agent": { system: 2000, history: 6000, artifacts: 3000 },
    },
    agentProfiles: {
      cartographer: { exploreTemp: 0.7, executeTemp: 0.3 },
      architect: { exploreTemp: 0.6, executeTemp: 0.1 },
      critic: { exploreTemp: 0.4, executeTemp: 0.1 },
      surgeon: { exploreTemp: 0.3, executeTemp: 0.0 },
      trial: { exploreTemp: 0.7, executeTemp: 0.1 },
      journalist: { exploreTemp: 0.5, executeTemp: 0.2 },
      "handy-agent": { exploreTemp: 0.4, executeTemp: 0.0 },
      "general-man-agent": { exploreTemp: 0.5, executeTemp: 0.2 },
    },
    criticalLanes: [],
  },
  tools: {
    autoApprove: [
      "read", "grep", "glob", "list",
      "smart_grep", "smart_find", "smart_git", "smart_bun",
      "smart_bash", "smart_edit", "smart_write", "smart_sd", "smart_batch",
      "read_source", 'read(action="artifact")', 'read(action="lib")',
      "feedback", "record", "verify", "discover", "gate",
      "leaf_handoff", "ping", "session_journal", "task_board",
      "task", "announce_leaf", "roadmap", "smart_session",
    ],
    emojis: {
      smart_bun: "🧪", smart_bash: "💻", smart_git: "📦",
      smart_grep: "🔍", smart_find: "📂", smart_edit: "✏️",
      smart_write: "📝", read_source: "📖", read: "👁️",
      leaf_handoff: "📬", ping: "📡", task_board: "📊",
    },
  },
  features: {
    liveFileWatcher: true,
    autoHandoffDetection: true,
    loopDetection: true,
    contextDiffing: true,
    hiveMemory: true,
    knowledgeGraph: true,
    fileHashTracking: true,
  },
}

// ═══════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════

function readJSONC(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {}
  const raw = readFileSync(path, "utf8")
  const clean = raw
    .replace(/\/\/[^\n]*/g, "")
    .replace(/,\s*}/g, "}")
    .replace(/,\s*\]/g, "]")
  try { return JSON.parse(clean) } catch { return {} }
}

function merge<T extends Record<string, unknown>>(base: T, override: Record<string, unknown>): T {
  const result = { ...base } as Record<string, unknown>
  for (const [key, val] of Object.entries(override)) {
    if (val !== null && val !== undefined) {
      if (typeof val === "object" && !Array.isArray(val) && typeof result[key] === "object" && !Array.isArray(result[key])) {
        result[key] = merge(result[key] as Record<string, unknown>, val as Record<string, unknown>)
      } else {
        result[key] = val
      }
    }
  }
  return result as T
}

// ═══════════════════════════════════════════════════════════
// Resolution
// ═══════════════════════════════════════════════════════════

export interface ResolvedConfig {
  global: Record<string, unknown> | null
  project: Record<string, unknown> | null
  defaults: PluginDefaults
  resolved: PluginDefaults & {
    permissions: Record<string, unknown>
    agents: Record<string, unknown>
  }
}

let _cached: ResolvedConfig | null = null

export function resolveConfig(worktree: string, pluginOverrides?: Partial<PluginDefaults>): ResolvedConfig {
  if (_cached) return _cached

  const globalPath = resolve(homedir(), ".config/opencode/opencode.json")
  const projectPath = resolve(worktree, "opencode.jsonc")

  const global = existsSync(globalPath) ? readJSONC(globalPath) : null
  const project = readJSONC(projectPath)

  // Merge: defaults → project → global (global wins for permissions)
  let resolved = { ...DEFAULTS } as PluginDefaults
  if (pluginOverrides) resolved = merge(resolved, pluginOverrides as Record<string, unknown>)

  const permissions = {
    ...(project?.permission ?? {}),
    ...(global?.permission ?? {}),
  }

  const agents = {
    ...(project?.agent ?? {}),
    ...(global?.agent ?? {}),
  }

  _cached = {
    global: global as Record<string, unknown> | null,
    project: project as Record<string, unknown> | null,
    defaults: DEFAULTS,
    resolved: { ...resolved, permissions, agents },
  }

  return _cached
}

export function invalidateCache(): void {
  _cached = null
}

export function getPermissions(config: ResolvedConfig): Record<string, unknown> {
  return config.resolved.permissions
}

export function getAgentConfig(config: ResolvedConfig): Record<string, unknown> {
  return config.resolved.agents
}

/**
 * Check if configs are in sync — used by doctor
 */
export function checkConfigSync(worktree: string): { synced: boolean; diffs: string[] } {
  const globalPath = resolve(homedir(), ".config/opencode/opencode.json")
  const projectPath = resolve(worktree, "opencode.jsonc")

  if (!existsSync(globalPath)) return { synced: true, diffs: ["No global config found (optional)"] }

  const global = readJSONC(globalPath)
  const project = readJSONC(projectPath)
  const diffs: string[] = []

  // Check permissions
  const gPerms = new Set(Object.keys(global.permission ?? {}))
  const lPerms = new Set(Object.keys(project.permission ?? {}))
  for (const p of lPerms) {
    if (!gPerms.has(p)) diffs.push(`Global missing permission: ${p}`)
  }

  // Check agents
  const gAgents = new Set(Object.keys(global.agent ?? {}))
  const lAgents = new Set(Object.keys(project.agent ?? {}))
  for (const a of lAgents) {
    if (!gAgents.has(a)) diffs.push(`Global missing agent: ${a}`)
  }

  return { synced: diffs.length === 0, diffs }
}
