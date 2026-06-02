/**
 * Workspace Trust — gates executable repo config behind user consent.
 *
 * Declarative JSON config (.tribunus/config.json, workflows/, policies/) is loaded automatically.
 * Executable code (.tribunus/plugin.ts, .tribunus/tools/*.ts) requires trust.
 *
 * Modeled after VS Code's workspace trust.
 */

export type TrustState = "untrusted" | "trusted" | "prompting"

export interface WorkspaceTrust {
  /** Current trust state for this workspace */
  state: TrustState
  /** Path to the workspace root */
  workspacePath: string
  /** When trust was granted or denied */
  decidedAt?: number
  /** Whether the user was prompted */
  wasPrompted: boolean
}

export interface TrustDecision {
  trust: boolean
  remember: boolean
}

// ── Trust Store ─────────────────────────────────────────
// In production, persisted to appData. For now, in-memory.

const trustStore = new Map<string, WorkspaceTrust>()

export function getWorkspaceTrust(workspacePath: string): WorkspaceTrust {
  const existing = trustStore.get(workspacePath)
  if (existing) return existing

  return {
    state: "untrusted",
    workspacePath,
    wasPrompted: false,
  }
}

export function setWorkspaceTrust(workspacePath: string, trust: boolean, remember: boolean): void {
  const entry: WorkspaceTrust = {
    state: trust ? "trusted" : "untrusted",
    workspacePath,
    decidedAt: Date.now(),
    wasPrompted: true,
  }
  if (remember) {
    trustStore.set(workspacePath, entry)
  }
}

export function isExecutableConfigAllowed(workspacePath: string): boolean {
  const trust = getWorkspaceTrust(workspacePath)
  return trust.state === "trusted"
}

// ── What requires trust ─────────────────────────────────

export const TRUST_GATED_PATTERNS = [
  ".tribunus/plugin.ts",
  ".tribunus/plugin.js",
  ".tribunus/tools/*.ts",
  ".tribunus/tools/*.js",
  ".tribunus/agents/*.ts",
  ".tribunus/agents/*.js",
]

export function isTrustGatedPath(relativePath: string): boolean {
  return TRUST_GATED_PATTERNS.some(pattern => {
    if (pattern.includes("*")) {
      const regex = new RegExp("^" + pattern.replace(/\*/g, ".*") + "$")
      return regex.test(relativePath)
    }
    return relativePath === pattern
  })
}

// ── Trust prompt data ───────────────────────────────────

export interface TrustPromptData {
  workspacePath: string
  executableFiles: string[]
  /** What the workspace is requesting */
  capabilities: string[]
}

export function buildTrustPrompt(workspacePath: string, files: string[]): TrustPromptData {
  return {
    workspacePath,
    executableFiles: files,
    capabilities: ["Execute custom tools", "Override agent profiles", "Run workspace plugins"],
  }
}
