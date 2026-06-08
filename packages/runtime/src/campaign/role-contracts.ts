import { Wildcard } from "@/util/wildcard"
import type { AuthorityContract, AuthorityMode, StopCondition } from "@/agent/authority"
import type { LaneState as CanonicalLaneState } from "./types"

// ─── Role Types ─────────────────────────────────────────────────────────────

export type RoleType =
  | "scout"
  | "architect"
  | "critic"
  | "executor"
  | "validator"
  | "redteam"
  | "repair"
  | "historian"
  | "auditor"
  | "integrator"

// ─── Role Contract interface ────────────────────────────────────────────────

export interface RoleContract {
  readonly roleType: RoleType
  readonly allowedTools: readonly string[]
  readonly forbiddenTools: readonly string[]
  readonly allowedFileScopes: readonly string[]
  readonly inputSchema: Readonly<Record<string, unknown>>
  readonly outputSchema: Readonly<Record<string, unknown>>
  readonly maxToolCalls?: number
  readonly maxDurationMs?: number
  readonly stopConditions: readonly string[]
  readonly terminalStatuses: readonly string[]
  readonly mustNot: readonly string[]
}

// ─── Lane State (from canonical types) ──────────────────────────────────────

export type LaneState = CanonicalLaneState

// ─── Role Contracts Map ─────────────────────────────────────────────────────

const SCOPE_ALL = ["**/*"] as const
const SCOPE_SRC = ["packages/opencode/src/**/*.ts", "packages/opencode/src/**/*.tsx"] as const
const SCOPE_TEST = ["packages/opencode/test/**/*.ts"] as const
const SCOPE_SRC_TEST = [...SCOPE_SRC, ...SCOPE_TEST] as const

export const ROLE_CONTRACTS: Record<RoleType, RoleContract> = {
  scout: {
    roleType: "scout",
    allowedTools: [
      "read_source",
      "smart_grep",
      "smart_find",
      "smart_git",
      "read_artifact",
      "read_messages",
      "discover_findings",
      "task_board",
      "curate_context",
      "json_query",
    ],
    forbiddenTools: [
      "smart_write",
      "smart_batch",
      "smart_sd",
      "replace_symbol",
      "prepare_checkpoint",
      "publish_checkpoint",
      "propose_plan",
      "revise_plan",
      "comment_plan",
      "produce_fragment",
      "preflight_check",
      "verify_handoff",
      "log_activity",
      "send_message",
    ],
    allowedFileScopes: SCOPE_ALL,
    inputSchema: {
      target: "string — file, directory, or symbol to explore",
      depth: "number — optional, depth of exploration",
    },
    outputSchema: {
      findings: "Array<{ file: string; summary: string }>",
      map: "object — dependency or surface map discovered",
    },
    maxToolCalls: 100,
    maxDurationMs: 300_000,
    stopConditions: ["external_change_detected", "scope_too_large"],
    terminalStatuses: ["completed", "failed", "cancelled"],
    mustNot: ["edit", "modify", "write"],
  },

  architect: {
    roleType: "architect",
    allowedTools: [
      "read_source",
      "smart_grep",
      "smart_find",
      "read_artifact",
      "read_messages",
      "discover_findings",
      "propose_plan",
      "revise_plan",
      "comment_plan",
      "review_criticism",
      "curate_context",
      "json_query",
      "task_board",
      "prepublication_admitted",
      "prepublication_blocked",
      "prepublication_inconclusive",
    ],
    forbiddenTools: [
      "smart_write",
      "smart_batch",
      "smart_sd",
      "replace_symbol",
      "prepare_checkpoint",
      "publish_checkpoint",
      "smart_bun",
      "smart_bash",
      "preflight_check",
      "produce_fragment",
      "verify_handoff",
      "log_activity",
      "send_message",
    ],
    allowedFileScopes: SCOPE_ALL,
    inputSchema: {
      findings: "Array<{ file: string; summary: string }>",
      constraints: "string[] — design constraints the plan must respect",
    },
    outputSchema: {
      plan_id: "string — canonical plan ID",
      boundary: "string — narrow boundary name",
      claim_atoms: "string[] — verifiable claim atoms",
      estimated_effort: "string — effort estimate (lines, files, risk)",
    },
    maxToolCalls: 80,
    maxDurationMs: 600_000,
    stopConditions: ["ambiguity_detected", "missing_constraint"],
    terminalStatuses: ["completed", "failed"],
    mustNot: ["edit"],
  },

  critic: {
    roleType: "critic",
    allowedTools: [
      "read_source",
      "smart_grep",
      "smart_find",
      "read_artifact",
      "read_messages",
      "discover_findings",
      "review_criticism",
      "comment_plan",
      "json_query",
      "task_board",
    ],
    forbiddenTools: [
      "smart_write",
      "smart_batch",
      "smart_sd",
      "replace_symbol",
      "prepare_checkpoint",
      "publish_checkpoint",
      "propose_plan",
      "revise_plan",
      "smart_bun",
      "smart_bash",
      "preflight_check",
      "produce_fragment",
      "verify_handoff",
      "log_activity",
      "send_message",
    ],
    allowedFileScopes: SCOPE_ALL,
    inputSchema: {
      plan_id: "string — plan to review",
      target_boundary: "string — boundary being reviewed",
    },
    outputSchema: {
      verdict: '"approved" | "approved_with_conditions" | "rejected_revise" | "blocked_needs_orchestrator"',
      findings: "Array<{ axis: string; finding: string }>",
    },
    maxToolCalls: 60,
    maxDurationMs: 300_000,
    stopConditions: ["incomplete_plan"],
    terminalStatuses: ["completed", "failed"],
    mustNot: ["edit"],
  },

  executor: {
    roleType: "executor",
    allowedTools: [
      "read_source",
      "smart_grep",
      "smart_find",
      "smart_write",
      "smart_batch",
      "smart_sd",
      "replace_symbol",
      "produce_fragment",
      "preflight_check",
      "prepare_checkpoint",
      "smart_bun",
      "smart_bash",
      "smart_git",
      "curate_context",
      "record_execution_wave",
      "read_artifact",
      "read_messages",
      "verify_handoff",
      "log_activity",
      "out_of_scope_finding",
    ],
    forbiddenTools: [
      "publish_checkpoint",
      "propose_plan",
      "revise_plan",
      "review_criticism",
      "comment_plan",
      "prepublication_admitted",
      "prepublication_blocked",
      "prepublication_inconclusive",
      "send_message",
      "generate_report",
      "generate_published_checkpoint_report",
      "session_diff",
      "roadmap_progress",
      "lesson_register",
    ],
    allowedFileScopes: SCOPE_SRC_TEST,
    inputSchema: {
      plan_id: "string — approved plan ID",
      claim_atoms: "string[] — claim atoms to implement",
    },
    outputSchema: {
      changes: "Array<{ file: string; diff: string }>",
      checkpoints: "string[] — checkpoint IDs created",
    },
    maxToolCalls: 200,
    maxDurationMs: 600_000,
    stopConditions: ["typecheck_failure", "test_failure", "unexpected_impact", "diff_must_be_shown"],
    terminalStatuses: ["completed", "failed", "blocked"],
    mustNot: ["expand_scope", "redesign"],
  },

  validator: {
    roleType: "validator",
    allowedTools: [
      "read_source",
      "smart_grep",
      "smart_find",
      "read_artifact",
      "read_messages",
      "smart_bun",
      "smart_bash",
      "json_query",
      "qa_observed_clean",
      "task_board",
      "discover_findings",
    ],
    forbiddenTools: [
      "smart_write",
      "smart_batch",
      "smart_sd",
      "replace_symbol",
      "prepare_checkpoint",
      "publish_checkpoint",
      "propose_plan",
      "revise_plan",
      "comment_plan",
      "preflight_check",
      "produce_fragment",
      "verify_handoff",
      "log_activity",
      "send_message",
      "record_execution_wave",
      "out_of_scope_finding",
    ],
    allowedFileScopes: SCOPE_ALL,
    inputSchema: {
      claim_atoms: "string[] — claim atoms to verify",
      candidate_files: "string[] — files to inspect",
    },
    outputSchema: {
      results: "Array<{ test: string; passed: boolean }>",
      coverage_gaps: "string[] — untested or under-tested boundaries",
    },
    maxToolCalls: 100,
    maxDurationMs: 600_000,
    stopConditions: ["blocking_failure"],
    terminalStatuses: ["completed", "failed", "blocked"],
    mustNot: ["edit", "ignore_failures"],
  },

  redteam: {
    roleType: "redteam",
    allowedTools: [
      "read_source",
      "smart_grep",
      "smart_find",
      "read_artifact",
      "read_messages",
      "smart_bun",
      "smart_bash",
      "json_query",
      "record_stress_wave",
      "discover_findings",
      "publish_finding",
      "task_board",
    ],
    forbiddenTools: [
      "smart_write",
      "smart_batch",
      "smart_sd",
      "replace_symbol",
      "prepare_checkpoint",
      "publish_checkpoint",
      "propose_plan",
      "revise_plan",
      "comment_plan",
      "preflight_check",
      "produce_fragment",
      "verify_handoff",
      "log_activity",
      "send_message",
      "record_execution_wave",
      "qa_observed_clean",
      "out_of_scope_finding",
    ],
    allowedFileScopes: SCOPE_ALL,
    inputSchema: {
      target_boundary: "string — boundary to stress test",
      consumer_purpose: "string — what consumer expects",
    },
    outputSchema: {
      findings: "Array<{ severity: string; description: string; file: string }>",
    },
    maxToolCalls: 150,
    maxDurationMs: 600_000,
    stopConditions: ["edge_case_flood"],
    terminalStatuses: ["completed", "failed"],
    mustNot: ["edit"],
  },

  repair: {
    roleType: "repair",
    allowedTools: [
      "read_source",
      "smart_grep",
      "smart_find",
      "smart_write",
      "smart_sd",
      "replace_symbol",
      "smart_batch",
      "smart_bun",
      "smart_bash",
      "preflight_check",
      "produce_fragment",
      "prepare_checkpoint",
      "curate_context",
      "record_execution_wave",
      "read_artifact",
      "read_messages",
      "verify_handoff",
      "log_activity",
      "out_of_scope_finding",
    ],
    forbiddenTools: [
      "propose_plan",
      "revise_plan",
      "review_criticism",
      "comment_plan",
      "publish_checkpoint",
      "prepublication_admitted",
      "prepublication_blocked",
      "prepublication_inconclusive",
      "send_message",
      "generate_report",
      "generate_published_checkpoint_report",
      "session_diff",
      "roadmap_progress",
      "lesson_register",
      "qa_observed_clean",
      "record_stress_wave",
    ],
    allowedFileScopes: SCOPE_SRC_TEST,
    inputSchema: {
      failure: "string — description of the failure mode",
      failing_tests: "string[] — test names or paths that fail",
      affected_files: "string[] — files in the repair scope",
    },
    outputSchema: {
      fix: "string — summary of the applied repair",
      verification: "{ typecheck: string; tests: string }",
    },
    maxToolCalls: 100,
    maxDurationMs: 600_000,
    stopConditions: ["repair_cycle_exhausted"],
    terminalStatuses: ["completed", "failed", "blocked"],
    mustNot: ["expand_scope"],
  },

  historian: {
    roleType: "historian",
    allowedTools: [
      "read_source",
      "smart_grep",
      "smart_find",
      "smart_git",
      "read_artifact",
      "read_messages",
      "prepare_checkpoint",
      "publish_checkpoint",
      "session_diff",
      "generate_report",
      "generate_published_checkpoint_report",
      "roadmap_progress",
      "lesson_register",
      "tool_feedback",
      "task_board",
    ],
    forbiddenTools: [
      "smart_write",
      "smart_batch",
      "smart_sd",
      "replace_symbol",
      "propose_plan",
      "revise_plan",
      "comment_plan",
      "preflight_check",
      "produce_fragment",
      "verify_handoff",
      "log_activity",
      "send_message",
      "smart_bun",
      "smart_bash",
      "curate_context",
      "record_execution_wave",
      "out_of_scope_finding",
    ],
    allowedFileScopes: SCOPE_ALL,
    inputSchema: {
      session_id: "string — session to report on",
      artifacts: "string[] — artifact paths to include",
    },
    outputSchema: {
      report: "string — session report content",
      checkpoints: "string[] — checkpoint IDs processed",
    },
    maxToolCalls: 80,
    maxDurationMs: 300_000,
    stopConditions: ["missing_data"],
    terminalStatuses: ["completed", "failed"],
    mustNot: ["edit"],
  },

  auditor: {
    roleType: "auditor",
    allowedTools: [
      "read_source",
      "smart_grep",
      "smart_find",
      "read_artifact",
      "read_messages",
      "discover_findings",
      "json_query",
      "task_board",
      "analytics",
      "inspect_failure",
      "rig_schema_validate",
    ],
    forbiddenTools: [
      "smart_write",
      "smart_batch",
      "smart_sd",
      "replace_symbol",
      "prepare_checkpoint",
      "publish_checkpoint",
      "propose_plan",
      "revise_plan",
      "comment_plan",
      "smart_bun",
      "smart_bash",
      "preflight_check",
      "produce_fragment",
      "verify_handoff",
      "log_activity",
      "send_message",
      "curate_context",
      "record_execution_wave",
      "out_of_scope_finding",
      "qa_observed_clean",
    ],
    allowedFileScopes: SCOPE_ALL,
    inputSchema: {
      scope: "string — audit scope description",
      criteria: "string[] — audit criteria to evaluate",
    },
    outputSchema: {
      findings: "Array<{ file: string; issue: string; severity: string }>",
      verdict: "string — overall audit verdict",
    },
    maxToolCalls: 120,
    maxDurationMs: 600_000,
    stopConditions: ["irregularity_detected"],
    terminalStatuses: ["completed", "failed"],
    mustNot: ["edit"],
  },

  integrator: {
    roleType: "integrator",
    allowedTools: [
      "read_source",
      "smart_grep",
      "smart_find",
      "smart_git",
      "read_artifact",
      "read_messages",
      "discover_findings",
      "prepare_checkpoint",
      "publish_checkpoint",
      "session_diff",
      "generate_report",
      "generate_published_checkpoint_report",
      "roadmap_progress",
      "lesson_register",
      "tool_feedback",
      "produce_fragment",
      "verify_handoff",
      "task_board",
      "json_query",
    ],
    forbiddenTools: [
      "smart_write",
      "smart_batch",
      "smart_sd",
      "replace_symbol",
      "propose_plan",
      "revise_plan",
      "comment_plan",
      "preflight_check",
      "log_activity",
      "send_message",
      "smart_bun",
      "smart_bash",
      "curate_context",
      "record_execution_wave",
      "out_of_scope_finding",
      "qa_observed_clean",
      "record_stress_wave",
    ],
    allowedFileScopes: SCOPE_ALL,
    inputSchema: {
      lanes: "string[] — lane IDs to integrate",
      integration_point: "string — where to merge",
    },
    outputSchema: {
      merged_boundary: "string — description of integrated boundary",
      conflicts: "string[] — unresolved collisions",
    },
    maxToolCalls: 100,
    maxDurationMs: 600_000,
    stopConditions: ["merge_conflict"],
    terminalStatuses: ["completed", "failed", "blocked"],
    mustNot: ["edit_unchecked"],
  },
}

// ─── Accessor Functions ─────────────────────────────────────────────────────

export function getContract(roleType: RoleType): RoleContract {
  return ROLE_CONTRACTS[roleType]
}

export function validateToolAllowed(roleType: RoleType, toolName: string): boolean {
  const contract = ROLE_CONTRACTS[roleType]
  return contract.allowedTools.includes(toolName) && !contract.forbiddenTools.includes(toolName)
}

export function validateFileScope(roleType: RoleType, filePath: string): boolean {
  const contract = ROLE_CONTRACTS[roleType]
  return contract.allowedFileScopes.some((glob) => Wildcard.match(filePath, glob))
}

// ─── Authorized Scope (maps to AW-005 AuthorityContract) ────────────────────

const ROLE_TO_MODE: Record<RoleType, AuthorityMode> = {
  scout: "investigate",
  architect: "investigate",
  critic: "review",
  executor: "patch",
  validator: "review",
  redteam: "review",
  repair: "patch",
  historian: "investigate",
  auditor: "review",
  integrator: "patch",
}

export function getAuthorizedScope(roleType: RoleType): AuthorityContract {
  const contract = ROLE_CONTRACTS[roleType]
  const mode = ROLE_TO_MODE[roleType]
  const hasWriteAccess = contract.allowedTools.some(
    (t) =>
      t === "smart_write" ||
      t === "smart_batch" ||
      t === "smart_sd" ||
      t === "replace_symbol" ||
      t === "produce_fragment",
  )

  return {
    mode,
    mayRead: [...contract.allowedFileScopes] as AuthorityContract["mayRead"],
    mayWrite: hasWriteAccess
      ? ([...contract.allowedFileScopes] as AuthorityContract["mayWrite"])
      : [],
    mustNotWrite: hasWriteAccess
      ? ["**/node_modules/**", "**/.git/**"]
      : (["**/*"] as AuthorityContract["mustNotWrite"]),
    mayRun: [...contract.allowedTools] as AuthorityContract["mayRun"],
    mustAskBefore: [],
    stopConditions: contract.stopConditions.filter(
      (s): s is StopCondition =>
        s === "ambiguity_detected" ||
        s === "typecheck_failure" ||
        s === "test_failure" ||
        s === "blocking_question_needed" ||
        s === "diff_must_be_shown" ||
        s === "no_checkpoint_without_passing_tests",
    ),
  }
}

// ─── State → Tool Derivation ────────────────────────────────────────────────

export function deriveAllowedTools(state: LaneState): string[] {
  switch (state) {
    case "created":
      return ["read_messages", "task_board", "discover_findings", "read_artifact"]

    case "scouting":
      return [
        "read_source",
        "smart_grep",
        "smart_find",
        "smart_git",
        "read_artifact",
        "read_messages",
        "task_board",
        "discover_findings",
        "curate_context",
      ]

    case "scoped":
      return [
        "read_source",
        "smart_grep",
        "smart_find",
        "read_artifact",
        "read_messages",
        "discover_findings",
        "curate_context",
        "json_query",
      ]

    case "planning":
      return [
        "read_source",
        "smart_grep",
        "smart_find",
        "read_artifact",
        "read_messages",
        "discover_findings",
        "curate_context",
        "propose_plan",
        "revise_plan",
        "comment_plan",
        "json_query",
      ]

    case "critic_review":
      return [
        "read_source",
        "smart_grep",
        "smart_find",
        "read_artifact",
        "read_messages",
        "review_criticism",
        "discover_findings",
        "json_query",
      ]

    case "approved":
      return [
        "read_artifact",
        "read_messages",
        "task_board",
        "discover_findings",
        "read_source",
        "smart_grep",
        "smart_find",
        "json_query",
      ]

    case "executing":
      return [
        "read_source",
        "smart_grep",
        "smart_find",
        "smart_write",
        "smart_batch",
        "smart_sd",
        "replace_symbol",
        "preflight_check",
        "prepare_checkpoint",
        "smart_bun",
        "smart_bash",
        "smart_git",
        "curate_context",
        "record_execution_wave",
        "produce_fragment",
        "verify_handoff",
        "read_artifact",
        "read_messages",
        "log_activity",
        "out_of_scope_finding",
      ]

    case "validating":
      return [
        "read_source",
        "smart_grep",
        "smart_find",
        "read_artifact",
        "read_messages",
        "smart_bun",
        "smart_bash",
        "json_query",
        "qa_observed_clean",
        "discover_findings",
        "task_board",
      ]

    case "red_team":
      return [
        "read_source",
        "smart_grep",
        "smart_find",
        "smart_bun",
        "smart_bash",
        "read_artifact",
        "read_messages",
        "discover_findings",
        "task_board",
        "json_query",
      ]

    case "repairing":
      return [
        "read_source",
        "smart_grep",
        "smart_find",
        "smart_write",
        "smart_sd",
        "replace_symbol",
        "smart_batch",
        "smart_bun",
        "smart_bash",
        "preflight_check",
        "prepare_checkpoint",
        "curate_context",
        "produce_fragment",
        "read_artifact",
        "read_messages",
        "verify_handoff",
        "log_activity",
        "record_execution_wave",
        "out_of_scope_finding",
      ]

    case "checkpointed":
      return ["read_messages", "send_message", "read_artifact", "task_board"]

    case "historian":
      return [
        "read_artifact",
        "read_messages",
        "session_diff",
        "generate_report",
        "roadmap_progress",
        "tool_feedback",
        "lesson_register",
        "send_message",
        "task_board",
      ]

    case "returned":
    case "failed":
    case "blocked":
      return ["read_messages", "send_message"]

    default:
      return []
  }
}
