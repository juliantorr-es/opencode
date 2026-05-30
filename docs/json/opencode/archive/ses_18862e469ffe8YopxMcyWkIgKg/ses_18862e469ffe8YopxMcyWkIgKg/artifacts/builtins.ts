import type { LifecycleDefinition } from "./definition"

// ── Cartographer lifecycle ───────────────────────────────────────────────
// 5 sub-subagents fanned out in parallel

export const CARTOGRAPHER_LIFECYCLE: LifecycleDefinition = {
  type: "linear",
  phases: [
    {
      name: "discover",
      description: "Discover entry points, file patterns, and directory structure",
      allowedTools: ["grep", "glob", "list", "read"],
      fanOut: false,
      maxRetries: 1,
      escalation: "blocker",
    },
    {
      name: "map",
      description: "Fan out to surface-mapper, module-grapher, convention-scout, test-reader, and diff-historian",
      fanOut: true,
      subagents: ["surface-mapper", "module-grapher", "convention-scout", "test-reader", "diff-historian"],
      requiresAll: true,
      maxRetries: 0,
      escalation: "skip",
    },
    {
      name: "synthesize",
      description: "Synthesize findings from all subagents into a unified map",
      allowedTools: ["read", "write"],
      maxRetries: 1,
      escalation: "blocker",
    },
  ],
  transitions: [
    { from: "discover", to: "map", condition: "success" },
    { from: "map", to: "synthesize", condition: "success" },
    { from: "discover", to: "synthesize", condition: "failure" },
  ],
}

// ── Executor lifecycle ───────────────────────────────────────────────────
// Edit → verify cycle with retry

export const EXECUTOR_LIFECYCLE: LifecycleDefinition = {
  type: "linear",
  phases: [
    {
      name: "edit",
      description: "Apply planned edits to source files",
      allowedTools: ["edit", "write", "bash", "grep", "read"],
      maxRetries: 2,
      escalation: "blocker",
    },
    {
      name: "verify",
      description: "Run typecheck, tests, and bisect to verify the edit",
      allowedTools: ["bash", "grep", "read"],
      maxRetries: 1,
      escalation: "skip",
    },
    {
      name: "report",
      description: "Report handoff with verification results",
      allowedTools: ["write", "read"],
      maxRetries: 0,
      escalation: "skip",
    },
  ],
  transitions: [
    { from: "edit", to: "verify", condition: "success" },
    { from: "verify", to: "edit", condition: "failure" },
    { from: "verify", to: "report", condition: "success" },
  ],
}

// ── Critic lifecycle ─────────────────────────────────────────────────────
// 7 axes scoring — each axis is a sequential evaluation step

export const CRITIC_LIFECYCLE: LifecycleDefinition = {
  type: "linear",
  phases: [
    {
      name: "coupling",
      description: "Evaluate coupling: dependency count, cohesion, abstraction leak",
      allowedTools: ["grep", "read"],
      maxRetries: 0,
      escalation: "skip",
    },
    {
      name: "debuggability",
      description: "Evaluate debuggability: error messages, logging, traceability",
      allowedTools: ["grep", "read"],
      maxRetries: 0,
      escalation: "skip",
    },
    {
      name: "convergence",
      description: "Evaluate convergence: how close to agreed design",
      allowedTools: ["grep", "read", "bash"],
      maxRetries: 0,
      escalation: "skip",
    },
    {
      name: "surfaceArea",
      description: "Evaluate surface area: API surface, config surface, exposed types",
      allowedTools: ["grep", "read"],
      maxRetries: 0,
      escalation: "skip",
    },
    {
      name: "testability",
      description: "Evaluate testability: modularity, dependency injection, mocks needed",
      allowedTools: ["grep", "read"],
      maxRetries: 0,
      escalation: "skip",
    },
    {
      name: "errorClarity",
      description: "Evaluate error clarity: error types, messages, recovery guidance",
      allowedTools: ["grep", "read"],
      maxRetries: 0,
      escalation: "skip",
    },
    {
      name: "reversibility",
      description: "Evaluate reversibility: rollback plan, migration safety, commit granularity",
      allowedTools: ["grep", "read", "bash"],
      maxRetries: 0,
      escalation: "skip",
    },
    {
      name: "synthesize",
      description: "Synthesize all axis scores into a final critic report",
      allowedTools: ["write"],
      maxRetries: 0,
      escalation: "skip",
    },
  ],
  transitions: [
    { from: "coupling", to: "debuggability", condition: "always" },
    { from: "debuggability", to: "convergence", condition: "always" },
    { from: "convergence", to: "surfaceArea", condition: "always" },
    { from: "surfaceArea", to: "testability", condition: "always" },
    { from: "testability", to: "errorClarity", condition: "always" },
    { from: "errorClarity", to: "reversibility", condition: "always" },
    { from: "reversibility", to: "synthesize", condition: "always" },
  ],
}

// ── Lane owner lifecycle ─────────────────────────────────────────────────
// Full wave lifecycle with repair cycles

export const LANE_OWNER_LIFECYCLE: LifecycleDefinition = {
  type: "linear",
  phases: [
    {
      name: "explore",
      description: "Explore the codebase terrain for this lane",
      allowedTools: ["grep", "glob", "list", "read", "bash"],
      fanOut: true,
      subagents: ["cartographer", "historian"],
      requiresAll: true,
      maxRetries: 1,
      escalation: "blocker",
    },
    {
      name: "plan",
      description: "Design the smallest change that eliminates the root cause",
      allowedTools: ["grep", "read", "write"],
      maxRetries: 2,
      escalation: "blocker",
    },
    {
      name: "review",
      description: "Internal review against plan criticism axes",
      fanOut: true,
      subagents: ["critic"],
      requiresAll: true,
      maxRetries: 3,
      escalation: "skip",
    },
    {
      name: "execute",
      description: "Apply the planned edits",
      fanOut: true,
      subagents: ["executor"],
      requiresAll: true,
      maxRetries: 3,
      escalation: "blocker",
    },
    {
      name: "validate",
      description: "QA validation against boundary claims",
      fanOut: true,
      subagents: ["validator"],
      requiresAll: true,
      maxRetries: 2,
      escalation: "skip",
    },
    {
      name: "stress",
      description: "Adversarial stress testing",
      fanOut: true,
      subagents: ["stress"],
      requiresAll: false,
      maxRetries: 1,
      escalation: "skip",
    },
    {
      name: "repair",
      description: "Repair any issues found in validation or stress",
      allowedTools: ["edit", "write", "bash", "grep", "read"],
      maxRetries: 3,
      escalation: "blocker",
    },
    {
      name: "publish",
      description: "Publish the candidate checkpoint",
      allowedTools: ["bash", "read"],
      maxRetries: 0,
      escalation: "blocker",
    },
  ],
  transitions: [
    { from: "explore", to: "plan", condition: "success" },
    { from: "plan", to: "review", condition: "success" },
    { from: "review", to: "execute", condition: "success" },
    { from: "review", to: "plan", condition: "failure" },
    { from: "execute", to: "validate", condition: "success" },
    { from: "validate", to: "stress", condition: "success" },
    { from: "validate", to: "repair", condition: "failure" },
    { from: "stress", to: "repair", condition: "failure" },
    { from: "stress", to: "publish", condition: "success" },
    { from: "repair", to: "execute", condition: "success" },
    { from: "repair", to: "publish", condition: "success" },
  ],
}

// ── Default lifecycle registry ───────────────────────────────────────────

/**
 * Map of agent type names to their lifecycle definitions.
 * Used by the LifecycleEngine to resolve a lifecycle for any agent.
 */
export const BUILTIN_LIFECYCLES: Record<string, LifecycleDefinition> = {
  cartographer: CARTOGRAPHER_LIFECYCLE,
  executor: EXECUTOR_LIFECYCLE,
  critic: CRITIC_LIFECYCLE,
  "lane-owner": LANE_OWNER_LIFECYCLE,
}
