export type WorkflowMode = "quick_fix" | "prototype" | "polish" | "refactor" | "research" | "security_review" | "enterprise" | "custom";
export type RigorLevel = "fast" | "balanced" | "rigorous" | "enterprise";
export type RiskLevel = "low" | "medium" | "high";
export interface WorkflowRole {
    id: string;
    agentProfile: string;
    purpose: string;
    canMutate: boolean;
    allowedTools: string[];
    requiredInputs: string[];
    expectedOutputs: string[];
    dependsOn?: string[];
}
export interface WorkflowGate {
    id: string;
    kind: "typecheck" | "test" | "lint" | "secret_scan" | "review" | "approval" | "binder";
    required: boolean;
    appliesAfter: string[];
}
export interface WorkflowBudget {
    maxTimeMs?: number;
    maxToolCalls?: number;
    maxParallelLanes?: number;
    stopOnFirstFailure?: boolean;
}
export interface ToolPolicy {
    allow: string[];
    deny: string[];
    requireApproval: string[];
}
export interface WorkflowOutput {
    kind: "patch" | "report" | "binder" | "pr" | "release_notes" | "diagnostics";
    required: boolean;
}
export interface AgentWorkflow {
    id: string;
    name: string;
    description: string;
    mode: WorkflowMode;
    rigorLevel: RigorLevel;
    riskLevel: RiskLevel;
    roles: WorkflowRole[];
    gates: WorkflowGate[];
    budgets: WorkflowBudget;
    tools: ToolPolicy;
    outputs: WorkflowOutput[];
    scope?: {
        files?: string[];
        directories?: string[];
        subsystems?: string[];
    };
    dynamicRules?: DynamicRule[];
}
export interface DynamicRule {
    condition: string;
    addRoles?: WorkflowRole[];
    addGates?: WorkflowGate[];
}
export interface WorkflowPreset {
    id: string;
    name: string;
    description: string;
    mode: WorkflowMode;
    rigorLevel: RigorLevel;
    defaultRisk: RiskLevel;
    template: AgentWorkflow;
}
/**
 * Workflow Authority — distinguishes what users may customize from what
 * the platform enforces regardless of workflow configuration.
 *
 * Customizable: roles, rigor, parallelism, validation gates, outputs, budget
 * Mandatory (never bypassed): secret redaction, path scope restrictions,
 *   unsafe git prohibitions, audit event recording, tool permission safety,
 *   runtime artifact hygiene
 */
export interface WorkflowAuthority {
    /** User-customizable preferences */
    customizable: {
        roles: boolean;
        rigorLevel: boolean;
        parallelism: boolean;
        validationGates: boolean;
        outputs: boolean;
        budget: boolean;
        toolPolicy: boolean;
    };
    /** Non-negotiable platform invariants — always enforced */
    mandatory: {
        secretRedaction: true;
        pathScopeRestrictions: true;
        unsafeGitProhibitions: true;
        auditEventRecording: true;
        toolPermissionSafety: true;
        runtimeArtifactHygiene: true;
    };
}
/** The canonical authority — what the platform guarantees regardless of workflow */
export declare const WORKFLOW_AUTHORITY: WorkflowAuthority;
/**
 * Validate that a workflow does not attempt to bypass mandatory invariants.
 * Returns the set of violated invariants, or empty if the workflow is valid.
 */
export declare function validateWorkflowAuthority(workflow: AgentWorkflow): string[];
