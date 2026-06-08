/**
 * Layered Config Loader
 *
 * Precedence (lowest to highest):
 * 1. Built-in defaults (hardcoded)
 * 2. User global config (appData)
 * 3. Repo .tribunus declarative config (JSON, validated)
 * 4. Repo .tribunus executable config (TypeScript, trust-gated)
 * 5. Session/workflow overrides
 *
 * Safety invariants CANNOT be disabled by any layer.
 */

export interface ProjectConfig {
  version: number
  project: {
    name: string
  }
  workflows: {
    default: string
    allowed: string[]
  }
  policy: {
    protectedPaths: string[]
    runtimeArtifactsForbidden: boolean
    forcePushForbidden: boolean
  }
  coordination: {
    backend: "auto" | "local" | "local-valkey" | "remote-valkey"
  }
  gates: {
    required: string[]
    optional: string[]
  }
}

export interface UserConfig {
  theme?: string
  recentProjects?: string[]
  preferredModel?: string
  notificationPreferences?: Record<string, boolean>
  capacityMode?: "conservative" | "balanced" | "aggressive"
  coordinationBackend?: string
}

export interface SessionOverrides {
  workflowId?: string
  maxAgents?: number
  scope?: string[]
}

// ── Safety Invariants (cannot be overridden) ────────────

export const SAFETY_INVARIANTS = {
  secretRedaction: true,
  pathScopeRestrictions: true,
  unsafeGitProhibitions: true,
  auditEventRecording: true,
  toolPermissionEnforcement: true,
  runtimeArtifactHygiene: true,
} as const

export type SafetyInvariant = keyof typeof SAFETY_INVARIANTS

// ── Built-in defaults ───────────────────────────────────

const BUILTIN_DEFAULTS: ProjectConfig = {
  version: 1,
  project: { name: "unknown" },
  workflows: { default: "quick-fix", allowed: ["quick-fix"] },
  policy: {
    protectedPaths: [".env", ".env.*"],
    runtimeArtifactsForbidden: true,
    forcePushForbidden: true,
  },
  coordination: { backend: "auto" },
  gates: { required: [], optional: [] },
}

// ── Loader ──────────────────────────────────────────────

export interface ConfigLayer {
  source: "builtin" | "user" | "repo" | "repo-plugin" | "session"
  config: Partial<ProjectConfig>
}

export function resolveConfig(layers: ConfigLayer[]): ProjectConfig {
  const sorted = [...layers].sort((a, b) => layerPriority(a.source) - layerPriority(b.source))

  let config = { ...BUILTIN_DEFAULTS }

  for (const layer of sorted) {
    config = deepMerge(config, layer.config as ProjectConfig)
  }

  // Enforce safety invariants — these cannot be overridden
  config.policy.runtimeArtifactsForbidden = true
  config.policy.forcePushForbidden = true

  return config
}

function layerPriority(source: ConfigLayer["source"]): number {
  switch (source) {
    case "builtin": return 0
    case "user": return 1
    case "repo": return 2
    case "repo-plugin": return 3
    case "session": return 4
  }
}

function deepMerge<T extends Record<string, unknown>>(base: T, override: Partial<T>): T {
  const result = { ...base }
  for (const key of Object.keys(override) as (keyof T)[]) {
    const baseVal = base[key]
    const overrideVal = override[key]
    if (overrideVal === undefined) continue
    if (isObject(baseVal) && isObject(overrideVal)) {
      (result as Record<string, unknown>)[key as string] = deepMerge(
        baseVal as Record<string, unknown>,
        overrideVal as Record<string, unknown>,
      )
    } else if (Array.isArray(baseVal) && Array.isArray(overrideVal)) {
      // Arrays: repo overrides replace, not merge
      (result as Record<string, unknown>)[key as string] = overrideVal
    } else {
      (result as Record<string, unknown>)[key as string] = overrideVal
    }
  }
  return result
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

// ── Validation ──────────────────────────────────────────

export type ConfigValidationError = {
  path: string
  message: string
}

export function validateProjectConfig(config: unknown): config is ProjectConfig {
  if (!isObject(config)) return false
  if (typeof config.version !== "number") return false
  if (config.version !== 1) return false
  if (!isObject(config.project)) return false
  if (typeof (config.project as Record<string, unknown>).name !== "string") return false
  return true
}

export function validateWithErrors(config: unknown): ConfigValidationError[] {
  const errors: ConfigValidationError[] = []
  if (!isObject(config)) {
    errors.push({ path: "", message: "config must be an object" })
    return errors
  }
  if (typeof config.version !== "number") {
    errors.push({ path: "version", message: "version must be a number" })
  }
  if (config.version !== 1) {
    errors.push({ path: "version", message: `unsupported config version: ${config.version}` })
  }
  return errors
}
