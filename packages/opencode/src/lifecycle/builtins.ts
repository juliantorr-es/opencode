import type { LifecycleDefinition } from "./definition"

export const CARTOGRAPHER_LIFECYCLE: LifecycleDefinition = {
  type: "dag",
  phases: [
    {
      id: "discover",
      name: "Discover",
      description: "Discover entry points and surface area",
      allowedTools: ["read", "grep", "find"],
      maxRetries: 1,
      escalation: "skip",
    },
    {
      id: "map",
      name: "Map",
      description: "Map conventions, dependencies, and patterns",
      allowedTools: ["read", "grep", "find"],
      maxRetries: 1,
      escalation: "skip",
    },
    {
      id: "synthesize",
      name: "Synthesize",
      description: "Synthesize findings into a structured artifact",
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

export const EXECUTOR_LIFECYCLE: LifecycleDefinition = {
  type: "linear",
  phases: [
    {
      id: "read_plan",
      name: "Read Plan",
      description: "Read the plan artifact to understand what to implement",
      allowedTools: ["read", "grep"],
      maxRetries: 1,
      escalation: "blocker",
    },
    {
      id: "edit",
      name: "Edit",
      description: "Apply changes to source files",
      allowedTools: [
        "read",
        "write",
        "edit",
        "apply_patch",
        "search_replace",
        "smart_edit",
        "smart_write",
        "smart_batch",
        "replace_symbol",
        "batch",
        "grep",
        "find",
      ],
      maxRetries: 2,
      escalation: "blocker",
    },
    {
      id: "verify",
      name: "Verify",
      description: "Verify changes compile and tests pass",
      allowedTools: ["read", "bun", "grep"],
      maxRetries: 2,
      escalation: "blocker",
    },
  ],
}

export const CRITIC_LIFECYCLE: LifecycleDefinition = {
  type: "dag",
  phases: [
    {
      id: "read_plan",
      name: "Read Plan",
      description: "Read the plan artifact to understand the proposal",
      allowedTools: ["read"],
      maxRetries: 0,
      escalation: "blocker",
    },
    {
      id: "analyze",
      name: "Analyze",
      description: "Analyze the plan across 7 evaluation axes",
      allowedTools: ["read", "grep", "find", "diff"],
      maxRetries: 1,
      escalation: "skip",
    },
    {
      id: "verdict",
      name: "Verdict",
      description: "Synthesize review verdict with structured findings",
      allowedTools: ["read", "comment_plan"],
      maxRetries: 1,
      escalation: "blocker",
    },
  ],
  transitions: [
    { from: "read_plan", to: "analyze", condition: "success" },
    { from: "analyze", to: "verdict", condition: "success" },
    { from: "read_plan", to: "verdict", condition: "failure" },
  ],
}

export const LANE_OWNER_LIFECYCLE: LifecycleDefinition = {
  type: "linear",
  phases: [
    {
      id: "cartography",
      name: "Cartography",
      description: "Explore the codebase terrain — entry points, conventions, patterns",
      allowedTools: ["read", "grep", "find", "task", "rg", "fd", "smart_grep", "smart_find"],
      maxRetries: 1,
      escalation: "blocker",
    },
    {
      id: "plan",
      name: "Plan",
      description: "Design the smallest change that eliminates the root cause",
      allowedTools: ["read", "propose_plan", "revise_plan", "task"],
      maxRetries: 1,
      escalation: "blocker",
    },
    {
      id: "review",
      name: "Review",
      description: "Review the plan with a critic subagent",
      allowedTools: ["read", "review_criticism", "comment_plan", "task"],
      maxRetries: 2,
      escalation: "blocker",
    },
    {
      id: "execution",
      name: "Execution",
      description: "Execute the plan — apply edits and run type checks",
      allowedTools: [
        "read",
        "grep",
        "find",
        "write",
        "edit",
        "apply_patch",
        "search_replace",
        "smart_edit",
        "smart_write",
        "smart_batch",
        "replace_symbol",
        "batch",
        "bun",
        "task",
        "rg",
        "sd",
        "fd",
      ],
      maxRetries: 2,
      escalation: "blocker",
    },
    {
      id: "validation",
      name: "Validation",
      description: "Validate all changes — typecheck, tests, stress test",
      allowedTools: ["read", "bun", "smart_grep", "grep", "task"],
      maxRetries: 2,
      escalation: "blocker",
    },
  ],
}

export const BUILTIN_LIFECYCLES: Record<string, LifecycleDefinition> = {
  cartographer: CARTOGRAPHER_LIFECYCLE,
  executor: EXECUTOR_LIFECYCLE,
  critic: CRITIC_LIFECYCLE,
  "lane-owner": LANE_OWNER_LIFECYCLE,
}
