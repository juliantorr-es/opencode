// ── Workflow Schema ────────────────────────────────────
// Declarative agent workflow definition.
// Presets map to this structure; execution engine consumes it.

export type WorkflowMode = "quick_fix" | "prototype" | "polish" | "refactor" | "research" | "security_review" | "enterprise" | "custom"
export type RigorLevel = "fast" | "balanced" | "rigorous" | "enterprise"
export type RiskLevel = "low" | "medium" | "high"

export interface WorkflowRole {
  id: string
  agentProfile: string
  purpose: string
  canMutate: boolean
  allowedTools: string[]
  requiredInputs: string[]
  expectedOutputs: string[]
  dependsOn?: string[]
}

export interface WorkflowGate {
  id: string
  kind: "typecheck" | "test" | "lint" | "secret_scan" | "review" | "approval" | "binder"
  required: boolean
  appliesAfter: string[]
}

export interface WorkflowBudget {
  maxTimeMs?: number
  maxToolCalls?: number
  maxParallelLanes?: number
  stopOnFirstFailure?: boolean
}

export interface ToolPolicy {
  allow: string[]
  deny: string[]
  requireApproval: string[]
}

export interface WorkflowOutput {
  kind: "patch" | "report" | "binder" | "pr" | "release_notes" | "diagnostics"
  required: boolean
}

export interface AgentWorkflow {
  id: string
  name: string
  description: string
  mode: WorkflowMode
  rigorLevel: RigorLevel
  riskLevel: RiskLevel
  roles: WorkflowRole[]
  gates: WorkflowGate[]
  budgets: WorkflowBudget
  tools: ToolPolicy
  outputs: WorkflowOutput[]
  scope?: {
    files?: string[]
    directories?: string[]
    subsystems?: string[]
  }
  dynamicRules?: DynamicRule[]
}

export interface DynamicRule {
  condition: string // e.g. "migration_touched" | "ipc_touched" | "electron_config_touched"
  addRoles?: WorkflowRole[]
  addGates?: WorkflowGate[]
}

export interface WorkflowPreset {
  id: string
  name: string
  description: string
  mode: WorkflowMode
  rigorLevel: RigorLevel
  defaultRisk: RiskLevel
  template: AgentWorkflow
}
