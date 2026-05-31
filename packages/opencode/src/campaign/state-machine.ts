// ── Declarative State Machine Spec + Deterministic Reducer ──
//
// Defines the agent state machine schema and two concrete
// machines: LANE_STATE_MACHINE (per-lane lifecycle) and
// CAMPAIGN_STATE_MACHINE (multi-lane campaign lifecycle).
//
// reduceCampaignState is a pure deterministic function: same
// events + spec always produces the same output state.
// SM-003: predicate evaluation now uses typed evidence predicates

import { checkPredicate } from "./predicates"

// ── Entry Action Executor ─────────────────────────────────

/**
 * Execute an entry action (e.g. decrement_repair_budget) against
 * the mutable retryBudgets map during a reduction pass.
 * Called by reduceCampaignState after each transition.
 */
function executeEntryAction(
  action: ActionSpec,
  retryBudgets: Record<string, number>,
  stateSpec: AgentStateSpec,
): void {
  switch (action.kind) {
    case "decrement_repair_budget": {
      const current = retryBudgets["repair"]
      const maxRetries = stateSpec.retryPolicy?.maxRetries ?? 3
      retryBudgets["repair"] = current === undefined ? maxRetries - 1 : current - 1
      break
    }
  }
}

// ── Types ─────────────────────────────────────────────────

export interface ActionSpec {
  readonly kind: string
  readonly params?: Readonly<Record<string, unknown>>
}

export interface RetryPolicy {
  readonly maxRetries: number
  readonly backoffMs: number
}

export type PredicateSpec =
  | { readonly kind: "event_exists"; readonly eventType: string; readonly after?: string }
  | { readonly kind: "latest_validation_passed"; readonly afterLastEdit: boolean }
  | { readonly kind: "claims_acquired"; readonly paths: readonly string[] }
  | { readonly kind: "has_claim_conflict" }
  | { readonly kind: "permission_denied"; readonly tool: string }
  | { readonly kind: "retry_budget_remaining"; readonly key: string }
  | { readonly kind: "user_approval_granted"; readonly approvalType: string }
  | { readonly kind: "context_sufficient" }
  | { readonly kind: "scope_unsafe" }
  | { readonly kind: "edit_applied" }
  | { readonly kind: "new_validation_failure" }
  | { readonly kind: "failures_existed_before_edit" }
  | { readonly kind: "repair_budget_exhausted" }
  | { readonly kind: "all_children_complete" }
  | { readonly kind: "child_blocked" }
  | { readonly kind: "no_blocking_findings" }
  | { readonly kind: "finding_confirmed" }
  | { readonly kind: "plan_produced" }
  | { readonly kind: "plan_approved" }
  | { readonly kind: "plan_rejected" }
  | { readonly kind: "scout_completed" }
  | { readonly kind: "scope_synthesized" }
  | { readonly kind: "all_gates_pass" }

export interface TransitionSpec {
  readonly to: string
  readonly when: PredicateSpec
  readonly priority?: number
  readonly actions?: readonly ActionSpec[]
}

export interface AgentStateSpec {
  readonly allowedTools: readonly string[]
  readonly entryActions?: readonly ActionSpec[]
  readonly transitions: readonly TransitionSpec[]
  readonly exitCriteria?: readonly PredicateSpec[]
  readonly retryPolicy?: RetryPolicy
}

export interface AgentStateMachineSpec {
  readonly id: string
  readonly initial: string
  readonly states: Readonly<Record<string, AgentStateSpec>>
  readonly version: string
}

export interface RuntimeEvent {
  readonly type: string
  readonly timestamp?: string
  readonly payload?: Readonly<Record<string, unknown>>
}

export interface StateTransition {
  readonly from: string
  readonly to: string
  readonly eventType: string
  readonly timestamp?: string
}

export interface CampaignState {
  readonly currentState: string
  readonly events: readonly RuntimeEvent[]
  readonly transitionCount: number
  readonly stateHistory: readonly StateTransition[]
  readonly metadata: Readonly<Record<string, unknown>>
  readonly retryBudgets: Readonly<Record<string, number>>
}

// ── Lane State Machine ─────────────────────────────────────

export const LANE_STATE_MACHINE: AgentStateMachineSpec = {
  id: "lane",
  initial: "created",
  version: "1.0.0",
  states: {
    created: {
      allowedTools: [],
      transitions: [
        { to: "scouting", when: { kind: "context_sufficient" } },
      ],
    },
    scouting: {
      allowedTools: [],
      transitions: [
        { to: "scoped", when: { kind: "plan_produced" } },
      ],
    },
    scoped: {
      allowedTools: [],
      transitions: [
        { to: "planning", when: { kind: "plan_produced" } },
      ],
    },
    planning: {
      allowedTools: [],
      transitions: [
        { to: "critic_review", when: { kind: "plan_produced" } },
      ],
    },
    critic_review: {
      allowedTools: [],
      transitions: [
        { to: "planning", when: { kind: "plan_rejected" }, priority: 5 },
        { to: "approved", when: { kind: "plan_approved" }, priority: 10 },
      ],
    },
    approved: {
      allowedTools: [],
      transitions: [
        { to: "executing", when: { kind: "claims_acquired", paths: [] } },
      ],
    },
    executing: {
      allowedTools: [],
      transitions: [
        { to: "validating", when: { kind: "edit_applied" } },
      ],
    },
    validating: {
      allowedTools: [],
      transitions: [
        { to: "repairing", when: { kind: "new_validation_failure" }, priority: 5 },
        { to: "red_team", when: { kind: "latest_validation_passed", afterLastEdit: true }, priority: 10 },
      ],
    },
    red_team: {
      allowedTools: [],
      transitions: [
        { to: "repairing", when: { kind: "finding_confirmed" }, priority: 5 },
        { to: "historian", when: { kind: "no_blocking_findings" }, priority: 10 },
      ],
    },
    repairing: {
      allowedTools: [],
      entryActions: [{ kind: "decrement_repair_budget" }],
      transitions: [
        { to: "scoping", when: { kind: "retry_budget_remaining", key: "repair" }, priority: 5 },
        { to: "blocked", when: { kind: "repair_budget_exhausted" }, priority: 10 },
      ],
      retryPolicy: { maxRetries: 3, backoffMs: 1000 },
    },
    scoping: {
      allowedTools: [],
      entryActions: [],
      transitions: [
        { to: "scoped", when: { kind: "context_sufficient" } },
      ],
    },
    historian: {
      allowedTools: [],
      transitions: [
        { to: "checkpointed", when: { kind: "event_exists", eventType: "session.checkpoint" } },
      ],
    },
    checkpointed: {
      allowedTools: [],
      transitions: [
        { to: "returned", when: { kind: "event_exists", eventType: "lane.returned" } },
      ],
    },
    blocked: {
      allowedTools: [],
      transitions: [],
    },
  },
}

// ── Campaign State Machine ────────────────────────────────

function blockedTransitions(): readonly TransitionSpec[] {
  return [
    { to: "blocked", when: { kind: "has_claim_conflict" }, priority: 0 },
    { to: "blocked", when: { kind: "child_blocked" }, priority: 1 },
    { to: "blocked", when: { kind: "scope_unsafe" }, priority: 2 },
  ] as const
}

export const CAMPAIGN_STATE_MACHINE: AgentStateMachineSpec = {
  id: "campaign",
  initial: "created",
  version: "1.0.0",
  states: {
    created: {
      allowedTools: [],
      transitions: [
        ...blockedTransitions(),
        { to: "scouting", when: { kind: "context_sufficient" }, priority: 10 },
      ],
    },
    scouting: {
      allowedTools: [],
      transitions: [
        ...blockedTransitions(),
        { to: "scope_synthesis", when: { kind: "scout_completed" }, priority: 10 },
      ],
    },
    scope_synthesis: {
      allowedTools: [],
      transitions: [
        ...blockedTransitions(),
        { to: "lane_decomposition", when: { kind: "scope_synthesized" }, priority: 10 },
      ],
    },
    lane_decomposition: {
      allowedTools: [],
      transitions: [
        ...blockedTransitions(),
        { to: "lane_dispatch", when: { kind: "claims_acquired", paths: [] }, priority: 10 },
      ],
    },
    lane_dispatch: {
      allowedTools: [],
      transitions: [
        ...blockedTransitions(),
        { to: "waiting_for_lanes", when: { kind: "all_children_complete" }, priority: 10 },
      ],
    },
    waiting_for_lanes: {
      allowedTools: [],
      transitions: [
        ...blockedTransitions(),
        { to: "integration_review", when: { kind: "all_children_complete" }, priority: 10 },
      ],
    },
    integration_review: {
      allowedTools: [],
      transitions: [
        ...blockedTransitions(),
        { to: "final_validation", when: { kind: "no_blocking_findings" }, priority: 10 },
      ],
    },
    final_validation: {
      allowedTools: [],
      transitions: [
        ...blockedTransitions(),
        { to: "push_ready", when: { kind: "latest_validation_passed", afterLastEdit: false }, priority: 10 },
      ],
    },
    push_ready: {
      allowedTools: [],
      transitions: [
        ...blockedTransitions(),
        { to: "pushed", when: { kind: "all_gates_pass" }, priority: 10 },
      ],
    },
    pushed: {
      allowedTools: [],
      transitions: [
        ...blockedTransitions(),
      ],
    },
    blocked: {
      allowedTools: [],
      transitions: [],
    },
  },
}

// ── Predicate Evaluator (Heuristic) ───────────────────────

function evaluatePredicate(
  predicate: PredicateSpec,
  events: readonly RuntimeEvent[],
  state: CampaignState,
): boolean {
  switch (predicate.kind) {
    case "event_exists": {
      const match = events.some(e => e.type === predicate.eventType)
      if (!match) return false
      if (predicate.after !== undefined) {
        return events.some(
          e => e.type === predicate.eventType && e.timestamp != null && e.timestamp >= predicate.after!,
        )
      }
      return true
    }
    case "latest_validation_passed": {
      if (predicate.afterLastEdit) {
        const editEvents = events.filter(e => e.type === "edit.applied")
        if (editEvents.length > 0) {
          const lastEdit = editEvents[editEvents.length - 1]!
          return events.some(
            e =>
              e.type === "validation.completed" &&
              e.payload?.status === "pass" &&
              (lastEdit.timestamp == null ||
                (e.timestamp != null && e.timestamp >= lastEdit.timestamp)),
          )
        }
      }
      const validationEvents = events.filter(e => e.type === "validation.completed")
      if (validationEvents.length === 0) return false
      return validationEvents[validationEvents.length - 1]!.payload?.status === "pass"
    }
    case "claims_acquired": {
      if (predicate.paths.length === 0) {
        return events.some(e => e.type === "claims.acquired")
      }
      return (predicate.paths as readonly string[]).every(path =>
        events.some(
          e => e.type === "claims.acquired" && (e.payload as Record<string, unknown> | undefined)?.path === path,
        ),
      )
    }
    case "has_claim_conflict":
      return events.some(e => e.type === "claim.conflict")
    case "permission_denied":
      return events.some(
        e =>
          e.type === "permission.denied" &&
          (e.payload as Record<string, unknown> | undefined)?.tool === predicate.tool,
      )
    case "retry_budget_remaining": {
      const budget = state.retryBudgets[predicate.key] as number | undefined
      return (budget ?? 0) > 0
    }
    case "repair_budget_exhausted": {
      const budget = state.retryBudgets["repair"] as number | undefined
      return (budget ?? 0) <= 0
    }
    case "user_approval_granted":
      return events.some(
        e =>
          e.type === "user.approval" &&
          (e.payload as Record<string, unknown> | undefined)?.approvalType === predicate.approvalType,
      )
    case "context_sufficient":
      return events.some(e => e.type === "context.sufficient")
    case "scope_unsafe":
      return events.some(e => e.type === "scope.unsafe")
    case "edit_applied":
      return events.some(e => e.type === "edit.applied")
    case "new_validation_failure":
      return events.some(
        e =>
          e.type === "validation.failure" &&
          (e.payload as Record<string, unknown> | undefined)?.isNew === true,
      )
    case "failures_existed_before_edit":
      return events.some(
        e =>
          e.type === "validation.failure" &&
          (e.payload as Record<string, unknown> | undefined)?.isNew !== true,
      )
    case "all_children_complete":
      return events.some(e => e.type === "children.all_complete")
    case "child_blocked":
      return events.some(e => e.type === "child.blocked")
    case "no_blocking_findings":
      return !events.some(e => e.type === "finding.blocking")
    case "finding_confirmed":
      return events.some(e => e.type === "finding.confirmed")
    case "plan_produced":
      return events.some(e => e.type === "plan.produced")
    case "plan_approved":
      return events.some(e => e.type === "plan.approved")
    case "plan_rejected":
      return events.some(e => e.type === "plan.rejected")
    case "scout_completed":
      return events.some(e => e.type === "scout.completed")
    case "scope_synthesized":
      return events.some(e => e.type === "scope.synthesized")
    case "all_gates_pass":
      return events.some(e => e.type === "gates.all_passed")
  }
  return false
}

// ── Deterministic Reducer ─────────────────────────────────

/**
 * Pure deterministic function that walks events in order,
 * applies each to the current state, and transitions when
 * predicates match.
 *
 * Given the same previous state, events, and spec, it always
 * produces the same result.
 */
export function reduceCampaignState(
  previous: CampaignState,
  events: readonly RuntimeEvent[],
  spec: AgentStateMachineSpec,
): CampaignState {
  if (events.length === 0) return previous

  const allEvents: RuntimeEvent[] = [...previous.events, ...events]
  let currentState = previous.currentState
  let transitionCount = previous.transitionCount
  const stateHistory: StateTransition[] = [...previous.stateHistory]

  // Mutable budget accumulator — entry actions decrement this during the pass
  const workingRetryBudgets: Record<string, number> = { ...previous.retryBudgets }

  for (const event of events) {
    const stateSpec = spec.states[currentState]
    if (stateSpec === undefined) break

    const candidates = [...stateSpec.transitions].sort(
      (a, b) => (a.priority ?? 100) - (b.priority ?? 100),
    )

    for (const transition of candidates) {
      // Pass a snapshot with current (possibly mutated) retryBudgets
      // instead of the frozen previous state — predicates like
      // retry_budget_remaining and repair_budget_exhausted now
      // see budgets mutated by entry actions in earlier transitions.
      const evalState: CampaignState = {
        ...previous,
        currentState,
        retryBudgets: workingRetryBudgets,
      }
      if (evaluatePredicate(transition.when, allEvents, evalState)) {
        stateHistory.push({
          from: currentState,
          to: transition.to,
          eventType: event.type,
          timestamp: event.timestamp,
        })
        currentState = transition.to
        transitionCount++

        // Execute entry actions on the new state (e.g. decrement_repair_budget)
        const targetSpec = spec.states[currentState]
        if (targetSpec?.entryActions) {
          for (const action of targetSpec.entryActions) {
            executeEntryAction(action, workingRetryBudgets, targetSpec)
          }
        }

        break
      }
    }
  }

  return {
    currentState,
    events: allEvents,
    transitionCount,
    stateHistory,
    metadata: previous.metadata,
    retryBudgets: workingRetryBudgets,
  } satisfies CampaignState
}
