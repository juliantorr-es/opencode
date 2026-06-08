// ── Declarative State Machine Spec + Deterministic Reducer ──
//
// Defines the agent state machine schema and two concrete
// machines: LANE_STATE_MACHINE (per-lane lifecycle) and
// CAMPAIGN_STATE_MACHINE (multi-lane campaign lifecycle).
//
// reduceCampaignState is a pure deterministic function: same
// events + spec always produces the same output state.
// SM-003: predicate evaluation delegates to typed campaign/predicates.ts (checkPredicate).

import { checkPredicate, type PredicateSpec, type PredicateContext } from "./predicates"
import type { RuntimeEvent as PredicateRuntimeEvent } from "../event/runtime-event"
import { EventName } from "../event/event-names"

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

export interface TransitionRule {
  readonly to: string
  readonly predicate: PredicateSpec
  readonly priority?: number
  readonly actions?: readonly ActionSpec[]
}

export interface AgentStateSpec {
  readonly allowedTools: readonly string[]
  readonly entryActions?: readonly ActionSpec[]
  readonly transitions: readonly TransitionRule[]
  readonly exitCriteria?: readonly PredicateSpec[]
  readonly retryPolicy?: RetryPolicy
}

export interface AgentMachineSpec {
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

export const LANE_STATE_MACHINE: AgentMachineSpec = {
  id: "lane",
  initial: "created",
  version: "1.0.0",
  states: {
    created: {
      allowedTools: [],
      transitions: [
        { to: "scouting", predicate: { kind: "context_sufficient" } },
      ],
    },
    scouting: {
      allowedTools: [],
      transitions: [
        { to: "scoped", predicate: { kind: "scout_completed" } },
      ],
    },
    scoped: {
      allowedTools: [],
      transitions: [
        { to: "planning", predicate: { kind: "scope_synthesized" } },
      ],
    },
    planning: {
      allowedTools: [],
      transitions: [
        { to: "critic_review", predicate: { kind: "plan_produced" } },
      ],
    },
    critic_review: {
      allowedTools: [],
      transitions: [
        { to: "planning", predicate: { kind: "plan_rejected" }, priority: 5 },
        { to: "approved", predicate: { kind: "plan_approved" }, priority: 10 },
      ],
    },
    approved: {
      allowedTools: [],
      transitions: [
        { to: "executing", predicate: { kind: "claims_acquired", paths: [] } },
      ],
    },
    executing: {
      allowedTools: [],
      transitions: [
        { to: "validating", predicate: { kind: "edit_applied" } },
      ],
    },
    validating: {
      allowedTools: [],
      transitions: [
        { to: "repairing", predicate: { kind: "new_validation_failure" }, priority: 5 },
        { to: "red_team", predicate: { kind: "latest_validation_passed", afterLastEdit: true }, priority: 10 },
      ],
    },
    red_team: {
      allowedTools: [],
      transitions: [
        { to: "repairing", predicate: { kind: "finding_blocking" }, priority: 5 },
        { to: "historian", predicate: { kind: "redteam_completed" }, priority: 10 },
      ],
    },
    repairing: {
      allowedTools: [],
      entryActions: [{ kind: "decrement_repair_budget" }],
      transitions: [
        { to: "executing", predicate: { kind: "retry_budget_remaining", key: "repair", limit: 3 }, priority: 5 },
        { to: "blocked", predicate: { kind: "repair_budget_exhausted" }, priority: 10 },
      ],
      retryPolicy: { maxRetries: 3, backoffMs: 1000 },
    },
    scoping: {
      allowedTools: [],
      entryActions: [],
      transitions: [
        { to: "scoped", predicate: { kind: "context_sufficient" } },
      ],
    },
    historian: {
      allowedTools: [],
      transitions: [
        { to: "checkpointed", predicate: { kind: "event_exists", eventType: EventName.SessionCheckpoint } },
      ],
    },
    checkpointed: {
      allowedTools: [],
      transitions: [
        { to: "returned", predicate: { kind: "event_exists", eventType: EventName.LaneReturned } },
      ],
    },
    blocked: {
      allowedTools: [],
      transitions: [],
    },
  },
}

// ── Campaign State Machine ────────────────────────────────

function blockedTransitions(): readonly TransitionRule[] {
  return [
    { to: "blocked", predicate: { kind: "has_claim_conflict" }, priority: 0 },
    { to: "blocked", predicate: { kind: "child_blocked" }, priority: 1 },
    { to: "blocked", predicate: { kind: "scope_unsafe" }, priority: 2 },
  ] as const
}

export const CAMPAIGN_STATE_MACHINE: AgentMachineSpec = {
  id: "campaign",
  initial: "created",
  version: "1.0.0",
  states: {
    created: {
      allowedTools: [],
      transitions: [
        ...blockedTransitions(),
        { to: "scouting", predicate: { kind: "context_sufficient" }, priority: 10 },
      ],
    },
    scouting: {
      allowedTools: [],
      transitions: [
        ...blockedTransitions(),
        { to: "scope_synthesis", predicate: { kind: "scout_completed" }, priority: 10 },
      ],
    },
    scope_synthesis: {
      allowedTools: [],
      transitions: [
        ...blockedTransitions(),
        { to: "lane_decomposition", predicate: { kind: "scope_synthesized" }, priority: 10 },
      ],
    },
    lane_decomposition: {
      allowedTools: [],
      transitions: [
        ...blockedTransitions(),
        { to: "lane_dispatch", predicate: { kind: "claims_acquired", paths: [] }, priority: 10 },
      ],
    },
    lane_dispatch: {
      allowedTools: [],
      transitions: [
        ...blockedTransitions(),
        { to: "waiting_for_lanes", predicate: { kind: "all_children_complete" }, priority: 10 },
      ],
    },
    waiting_for_lanes: {
      allowedTools: [],
      transitions: [
        ...blockedTransitions(),
        { to: "integration_review", predicate: { kind: "all_children_complete" }, priority: 10 },
      ],
    },
    integration_review: {
      allowedTools: [],
      transitions: [
        ...blockedTransitions(),
        { to: "final_validation", predicate: { kind: "no_blocking_findings" }, priority: 10 },
      ],
    },
    final_validation: {
      allowedTools: [],
      transitions: [
        ...blockedTransitions(),
        { to: "push_ready", predicate: { kind: "latest_validation_passed", afterLastEdit: false }, priority: 10 },
      ],
    },
    push_ready: {
      allowedTools: [],
      transitions: [
        ...blockedTransitions(),
        { to: "pushed", predicate: { kind: "all_gates_pass" }, priority: 10 },
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

// ── Predicate Evaluator (Adapter) ──────────────────────────

/**
 * Augment a simplified SMRuntimeEvent with fields needed by the
 * typed predicate engine (predicates.ts). SMRuntimeEvent has only
 * `type`, `timestamp`, and `payload`; the typed engine expects
 * `eventType`, `ts`, `payloadJson`, `status`, `toolName`, `id`, etc.
 */
function augmentEvent(e: RuntimeEvent): PredicateRuntimeEvent {
  const payload = e.payload as Record<string, unknown> | undefined
  return {
    type: e.type,
    eventType: e.type,
    timestamp: e.timestamp,
    ts: e.timestamp ?? "",
    id: e.timestamp ?? "",
    sessionId: "",
    runId: "",
    actor: "system",
    payload: e.payload,
    payloadJson: e.payload,
    status: payload?.status,
    toolName: payload?.tool,
  } as unknown as PredicateRuntimeEvent
}

// Adapter: delegates to typed predicate engine (predicates.ts)
function evaluatePredicate(
  predicate: PredicateSpec,
  events: readonly RuntimeEvent[],
  state: CampaignState,
): boolean {
  const ctx: PredicateContext = {
    events: events.map(augmentEvent),
    fileMemory: new Map(),
    claims: [],
    sessionId: "",
    retryBudgets: state.retryBudgets,
  }
  return checkPredicate(predicate, ctx).satisfied
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
  spec: AgentMachineSpec,
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
      if (evaluatePredicate(transition.predicate, allEvents, evalState)) {
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
