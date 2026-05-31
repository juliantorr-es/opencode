// ── Typed Transition Predicate Engine ────────────────────────
//
// Checks PredicateSpecs against runtime state (event ledger,
// file memory, claims, DuckDB views) and returns whether the
// predicate is satisfied, with evidence.
// ──────────────────────────────────────────────────────────────

import { Effect } from "effect"
import type { FileContext } from "../context/file-memory"
import type { RuntimeEvent } from "../event/runtime-event"
import { EventName } from "../event/event-names"

// ── Core Types ───────────────────────────────────────────────

export interface EvidenceRef {
  readonly id: string
  readonly type: "event" | "claim" | "file" | "state"
  readonly detail?: string
}

export interface PredicateResult {
  readonly satisfied: boolean
  readonly evidence?: EvidenceRef
  readonly reason?: string
}

export interface PredicateContext {
  readonly events: readonly RuntimeEvent[]
  readonly fileMemory: Map<string, FileContext>
  readonly claims: readonly string[]
  readonly sessionId: string
  readonly duckDbRanked?: readonly string[]
}

export type PredicateSpec =
  | { readonly kind: "event_exists"; readonly eventType: string; readonly after?: string }
  | { readonly kind: "latest_validation_passed"; readonly afterLastEdit?: boolean }
  | { readonly kind: "claims_acquired"; readonly paths: readonly string[] }
  | { readonly kind: "has_claim_conflict" }
  | { readonly kind: "permission_denied"; readonly tool: string }
  | { readonly kind: "retry_budget_remaining"; readonly key: string; readonly limit: number }
  | { readonly kind: "user_approval_granted"; readonly approvalType: string }
  | { readonly kind: "context_sufficient" }
  | { readonly kind: "scope_unsafe" }
  | { readonly kind: "edit_applied" }
  | { readonly kind: "new_validation_failure" }
  | { readonly kind: "failures_existed_before_edit" }
  | { readonly kind: "no_blocking_findings" }
  | { readonly kind: "finding_confirmed" }
  | { readonly kind: "plan_produced" }
  | { readonly kind: "plan_approved" }
  | { readonly kind: "plan_rejected" }
  | { readonly kind: "scout_completed" }
  | { readonly kind: "scope_synthesized" }
  | { readonly kind: "all_children_complete"; readonly children?: readonly string[] }
  | { readonly kind: "child_blocked" }

export type PredicateResolver = (
  spec: PredicateSpec,
  ctx: PredicateContext,
) => PredicateResult

export interface TransitionSpec {
  readonly from: string
  readonly to: string
  readonly predicate: PredicateSpec
  readonly priority?: number
}

export interface AgentStateMachineSpec {
  readonly initial: string
  readonly states: readonly string[]
  readonly transitions: readonly TransitionSpec[]
}

// ── Helpers ──────────────────────────────────────────────────

/** Return the event with the latest `ts` from a list. */
function latestByTs(events: readonly RuntimeEvent[]): RuntimeEvent | undefined {
  return [...events].sort((a, b) => b.ts.localeCompare(a.ts))[0]
}

/** True when the status indicates success. */
function succeeded(s: RuntimeEvent["status"]): boolean {
  return s === "succeeded"
}

/** True when the status indicates failure or denial. */
function failed(s: RuntimeEvent["status"]): boolean {
  return s === "failed" || s === "denied"
}

/** Safely read `payloadJson` as a record. */
function payload(
  e: RuntimeEvent,
): Readonly<Record<string, unknown>> | undefined {
  if (e.payloadJson === undefined || e.payloadJson === null) return undefined
  if (typeof e.payloadJson !== "object") return undefined
  return e.payloadJson as Readonly<Record<string, unknown>>
}

// ── Resolvers (one per kind) ─────────────────────────────────

function resolveEventExists(
  spec: PredicateSpec,
  ctx: PredicateContext,
): PredicateResult {
  const { eventType, after } = spec as PredicateSpec & {
    kind: "event_exists"
  }

  let matching = ctx.events.filter((e) => e.eventType === eventType)

  if (after !== undefined) {
    const refEvent = ctx.events.find((e) => e.id === after)
    if (!refEvent) {
      return {
        satisfied: false,
        reason: `Reference event "${after}" not found in ledger`,
      }
    }
    matching = matching.filter((e) => e.ts > refEvent.ts)
  }

  if (matching.length === 0) {
    return {
      satisfied: false,
      reason: `No "${eventType}" event found${after !== undefined ? ` after "${after}"` : ""}`,
    }
  }

  return { satisfied: true, evidence: { id: matching.at(0)?.id ?? "ev-missing", type: "event" } }
}

function resolveLatestValidationPassed(
  spec: PredicateSpec,
  ctx: PredicateContext,
): PredicateResult {
  const { afterLastEdit } = spec as PredicateSpec & {
    kind: "latest_validation_passed"
  }

  const validations = [...ctx.events]
    .filter((e) => e.eventType === EventName.ValidationCompleted)
    .sort((a, b) => b.ts.localeCompare(a.ts))

  const latest = validations[0]
  if (!latest) {
    return { satisfied: false, reason: "No validation.completed events found" }
  }

  const passed = succeeded(latest.status)

  if (afterLastEdit && passed) {
    const editEvents = ctx.events.filter((e) => e.eventType === EventName.FileEdited)
    const latestEdit = latestByTs(editEvents)
    if (latestEdit && latest.ts <= latestEdit.ts) {
      return {
        satisfied: false,
        reason: "Latest validation predates the latest edit",
        evidence: {
          id: latest.id,
          type: "event",
          detail: `validation=${latest.ts}, edit=${latestEdit.ts}`,
        },
      }
    }
  }

  return {
    satisfied: passed,
    evidence: passed
      ? { id: latest.id, type: "event", detail: `status=${latest.status ?? "unknown"}` }
      : undefined,
    reason: passed ? undefined : `Latest validation status: "${latest.status ?? "unknown"}"`,
  }
}

function resolveClaimsAcquired(
  spec: PredicateSpec,
  ctx: PredicateContext,
): PredicateResult {
  const { paths } = spec as PredicateSpec & { kind: "claims_acquired" }

  const missing = paths.filter((p) => !ctx.claims.includes(p))
  if (missing.length > 0) {
    return {
      satisfied: false,
      reason: `Claims not acquired: [${missing.join(", ")}]`,
    }
  }

  return { satisfied: true }
}

function resolveHasClaimConflict(
  _spec: PredicateSpec,
  ctx: PredicateContext,
): PredicateResult {
  const conflictEvents = ctx.events.filter(
    (e) =>
      e.eventType === EventName.FileConflict ||
      e.eventType === EventName.ClaimConflict ||
      (e.eventType === EventName.FileEdited && e.actor === "system"),
  )

  if (conflictEvents.length === 0) {
    return { satisfied: false, reason: "No claim conflicts detected" }
  }

  return {
    satisfied: true,
    evidence: {
      id: conflictEvents.at(0)?.id ?? "ev-missing",
      type: "event",
      detail: `${conflictEvents.length} conflict(s)`,
    },
  }
}

function resolvePermissionDenied(
  spec: PredicateSpec,
  ctx: PredicateContext,
): PredicateResult {
  const { tool } = spec as PredicateSpec & { kind: "permission_denied" }

  const toolEvents = ctx.events.filter((e) => e.toolName === tool)
  const latest = latestByTs(toolEvents)

  if (!latest) {
    return { satisfied: false, reason: `No events for tool "${tool}"` }
  }

  const denied = latest.status === "denied"
  return {
    satisfied: denied,
    evidence: denied
      ? { id: latest.id, type: "event", detail: `tool=${tool}, status=denied` }
      : undefined,
    reason: denied
      ? undefined
      : `Latest "${tool}" event has status "${latest.status ?? "unknown"}"`,
  }
}

function resolveRetryBudgetRemaining(
  spec: PredicateSpec,
  ctx: PredicateContext,
): PredicateResult {
  const { key, limit } = spec as PredicateSpec & {
    kind: "retry_budget_remaining"
  }

  const failedCount = ctx.events.filter(
    (e) =>
      e.eventType === EventName.ToolFailed &&
      (e.errorCode === key || e.toolName === key),
  ).length

  const remaining = limit - failedCount
  if (remaining <= 0) {
    return {
      satisfied: false,
      reason: `Retry budget exhausted: ${failedCount}/${limit} for "${key}"`,
    }
  }

  return {
    satisfied: true,
    evidence: {
      id: "retry-state",
      type: "state",
      detail: `${remaining} remaining for "${key}"`,
    },
  }
}

function resolveUserApprovalGranted(
  spec: PredicateSpec,
  ctx: PredicateContext,
): PredicateResult {
  const { approvalType } = spec as PredicateSpec & {
    kind: "user_approval_granted"
  }

  const approvals = ctx.events.filter(
    (e) =>
      (e.eventType === EventName.UserApproval && e.phase === approvalType) ||
      e.eventType === `user.approval.${approvalType}`,
  )

  if (approvals.length === 0) {
    return {
      satisfied: false,
      reason: `No user.approval event for "${approvalType}"`,
    }
  }

  return {
    satisfied: true,
    evidence: {
      id: approvals.at(0)?.id ?? "ev-missing",
      type: "event",
      detail: `approvalType=${approvalType}`,
    },
  }
}

function resolveContextSufficient(
  _spec: PredicateSpec,
  ctx: PredicateContext,
): PredicateResult {
  const minEvents = 5
  const hasEnoughEvents = ctx.events.length >= minEvents
  const hasFileMemory = ctx.fileMemory.size > 0
  const hasClaims = ctx.claims.length > 0
  const hasSessionId = ctx.sessionId.length > 0

  const issues: string[] = []
  if (!hasEnoughEvents) issues.push(`only ${ctx.events.length}/${minEvents} events`)
  if (!hasFileMemory) issues.push("file memory not populated")
  if (!hasClaims) issues.push("no claims acquired")
  if (!hasSessionId) issues.push("no session ID")

  if (issues.length > 0) {
    return { satisfied: false, reason: `Context insufficient: ${issues.join(", ")}` }
  }

  return {
    satisfied: true,
    evidence: {
      id: ctx.sessionId,
      type: "state",
      detail: `${ctx.events.length} events, ${ctx.fileMemory.size} files, ${ctx.claims.length} claims`,
    },
  }
}

function resolveScopeUnsafe(
  _spec: PredicateSpec,
  ctx: PredicateContext,
): PredicateResult {
  const denials = ctx.events.filter((e) => e.status === "denied")
  const protectedAccesses = ctx.events.filter(
    (e) =>
      e.eventType === EventName.FileRead &&
      e.filePath !== undefined &&
      (e.filePath.includes("node_modules") ||
        e.filePath.includes(".git/") ||
        e.filePath.includes(".env")),
  )

  const totalIssues = denials.length + protectedAccesses.length
  if (totalIssues === 0) {
    return { satisfied: false, reason: "No scope safety issues detected" }
  }

  return {
    satisfied: true,
    evidence:
      denials.length > 0
        ? { id: denials.at(0)?.id ?? "ev-missing", type: "event", detail: `${denials.length} denial(s)` }
        : { id: protectedAccesses.at(0)?.id ?? "ev-missing", type: "event", detail: "protected path access" },
    reason: `${denials.length} denial(s), ${protectedAccesses.length} protected path access(es)`,
  }
}

function resolveEditApplied(
  _spec: PredicateSpec,
  ctx: PredicateContext,
): PredicateResult {
  const edits = ctx.events.filter((e) => e.eventType === EventName.FileEdited)
  if (edits.length === 0) {
    return { satisfied: false, reason: "No file.edited events found" }
  }
  return {
    satisfied: true,
    evidence: { id: edits.at(0)?.id ?? "ev-missing", type: "event", detail: `${edits.length} edit(s)` },
  }
}

function resolveNewValidationFailure(
  _spec: PredicateSpec,
  ctx: PredicateContext,
): PredicateResult {
  const validations = ctx.events.filter(
    (e) => e.eventType === EventName.ValidationCompleted,
  )
  const edits = ctx.events.filter((e) => e.eventType === EventName.FileEdited)

  const lastSuccess = [...validations]
    .filter((e) => succeeded(e.status))
    .sort((a, b) => b.ts.localeCompare(a.ts))[0]

  const afterTs = lastSuccess?.ts ?? "0"
  const latestEdit = latestByTs(edits)

  if (!latestEdit) {
    return {
      satisfied: false,
      reason: "No file.edited events to check against",
    }
  }

  // A new failure means a validation failed *after* the latest edit
  // and *after* the last successful validation.
  const newFailure = validations.find(
    (e) => failed(e.status) && e.ts > afterTs && e.ts > latestEdit.ts,
  )

  if (!newFailure) {
    return {
      satisfied: false,
      reason: "No new validation failure after edits",
    }
  }

  return {
    satisfied: true,
    evidence: {
      id: newFailure.id,
      type: "event",
      detail: "validation failed after edit",
    },
  }
}

function resolveFailuresExistedBeforeEdit(
  _spec: PredicateSpec,
  ctx: PredicateContext,
): PredicateResult {
  const edits = ctx.events.filter((e) => e.eventType === EventName.FileEdited)
  const latestEdit = latestByTs(edits)

  if (!latestEdit) {
    return { satisfied: false, reason: "No file.edited events" }
  }

  const preEditFailure = ctx.events.find(
    (e) =>
      e.eventType === EventName.ValidationCompleted &&
      failed(e.status) &&
      e.ts < latestEdit.ts,
  )

  if (!preEditFailure) {
    return {
      satisfied: false,
      reason: "No validation failures existed before the latest edit",
    }
  }

  return {
    satisfied: true,
    evidence: {
      id: preEditFailure.id,
      type: "event",
      detail: `failure before edit at ${latestEdit.ts}`,
    },
  }
}

function resolveNoBlockingFindings(
  _spec: PredicateSpec,
  ctx: PredicateContext,
): PredicateResult {
  const blocking = ctx.events.filter(
    (e) =>
      e.eventType === EventName.RedteamFinding &&
      payload(e)?.severity === "blocking",
  )

  if (blocking.length > 0) {
    return {
      satisfied: false,
      evidence: { id: blocking.at(0)?.id ?? "ev-missing", type: "event" },
      reason: `${blocking.length} blocking redteam finding(s)`,
    }
  }

  return { satisfied: true }
}

function resolveFindingConfirmed(
  _spec: PredicateSpec,
  ctx: PredicateContext,
): PredicateResult {
  const findings = ctx.events.filter((e) => e.eventType === EventName.RedteamFinding)
  if (findings.length === 0) {
    return { satisfied: false, reason: "No redteam.finding events" }
  }
  return {
    satisfied: true,
    evidence: { id: findings.at(0)?.id ?? "ev-missing", type: "event" },
  }
}

function resolvePlanProduced(
  _spec: PredicateSpec,
  ctx: PredicateContext,
): PredicateResult {
  const planEvents = ctx.events.filter(
    (e) =>
      e.eventType === EventName.PlanProduced ||
      e.eventType === EventName.PlanCreated ||
      e.eventType === EventName.ArtifactPlan,
  )
  if (planEvents.length === 0) {
    return { satisfied: false, reason: "No plan artifact events" }
  }
  return {
    satisfied: true,
    evidence: { id: planEvents.at(0)?.id ?? "ev-missing", type: "event" },
  }
}

function resolvePlanApproved(
  _spec: PredicateSpec,
  ctx: PredicateContext,
): PredicateResult {
  const approved = ctx.events.filter(
    (e) =>
      e.eventType === EventName.CriticReview &&
      (payload(e)?.verdict === "approved" ||
        e.status === "succeeded"),
  )
  if (approved.length === 0) {
    return {
      satisfied: false,
      reason: "No critic.review event with approved verdict",
    }
  }
  return {
    satisfied: true,
    evidence: { id: approved.at(0)?.id ?? "ev-missing", type: "event", detail: "verdict=approved" },
  }
}

function resolvePlanRejected(
  _spec: PredicateSpec,
  ctx: PredicateContext,
): PredicateResult {
  const rejected = ctx.events.filter(
    (e) =>
      e.eventType === EventName.CriticReview &&
      (payload(e)?.verdict === "rejected" ||
        e.status === "failed"),
  )
  if (rejected.length === 0) {
    return {
      satisfied: false,
      reason: "No critic.review event with rejected verdict",
    }
  }
  return {
    satisfied: true,
    evidence: { id: rejected.at(0)?.id ?? "ev-missing", type: "event", detail: "verdict=rejected" },
  }
}

function resolveAllChildrenComplete(
  spec: PredicateSpec,
  ctx: PredicateContext,
): PredicateResult {
  const { children } = spec as PredicateSpec & {
    kind: "all_children_complete"
  }

  if (children !== undefined && children.length > 0) {
    const missingChildren = children.filter(
      (childId) =>
        !ctx.events.some(
          (e) =>
            (e.eventType === EventName.LaneCompleted ||
              e.eventType === EventName.ChildCompleted) &&
            (e.runId === childId || e.correlationId === childId),
        ),
    )
    if (missingChildren.length > 0) {
      return {
        satisfied: false,
        reason: `Children not complete: [${missingChildren.join(", ")}]`,
      }
    }
    return {
      satisfied: true,
      evidence: {
        id: "all-children",
        type: "state",
        detail: `${children.length} child(ren) complete`,
      },
    }
  }

  // Without an explicit list, check if any completion events exist at all.
  const completeEvents = ctx.events.filter(
    (e) => e.eventType === EventName.LaneCompleted || e.eventType === EventName.ChildCompleted,
  )
  if (completeEvents.length === 0) {
    return { satisfied: false, reason: "No child completion events" }
  }
  return {
    satisfied: true,
    evidence: { id: completeEvents.at(0)?.id ?? "ev-missing", type: "event" },
  }
}

function resolveChildBlocked(
  _spec: PredicateSpec,
  ctx: PredicateContext,
): PredicateResult {
  const blocked = ctx.events.filter(
    (e) => e.eventType === EventName.LaneBlocked || e.eventType === EventName.ChildBlocked,
  )
  if (blocked.length === 0) {
    return {
      satisfied: false,
      reason: "No lane.blocked or child.blocked events",
    }
  }
  return {
    satisfied: true,
    evidence: { id: blocked.at(0)?.id ?? "ev-missing", type: "event" },
  }
}

function resolveScoutCompleted(
  _spec: PredicateSpec,
  ctx: PredicateContext,
): PredicateResult {
  const scoutEvents = ctx.events.filter((e) => e.eventType === EventName.ScoutCompleted)
  if (scoutEvents.length === 0) {
    return { satisfied: false, reason: "No scout.completed events" }
  }
  return { satisfied: true, evidence: { id: scoutEvents.at(0)?.id ?? "ev-missing", type: "event" } }
}

function resolveScopeSynthesized(
  _spec: PredicateSpec,
  ctx: PredicateContext,
): PredicateResult {
  const scopeEvents = ctx.events.filter((e) => e.eventType === EventName.ScopeSynthesized)
  if (scopeEvents.length === 0) {
    return { satisfied: false, reason: "No scope.synthesized events" }
  }
  return { satisfied: true, evidence: { id: scopeEvents.at(0)?.id ?? "ev-missing", type: "event" } }
}

// ── Resolver Map ─────────────────────────────────────────────

export const predicateResolvers: Record<
  PredicateSpec["kind"],
  PredicateResolver
> = {
  event_exists: resolveEventExists,
  latest_validation_passed: resolveLatestValidationPassed,
  claims_acquired: resolveClaimsAcquired,
  has_claim_conflict: resolveHasClaimConflict,
  permission_denied: resolvePermissionDenied,
  retry_budget_remaining: resolveRetryBudgetRemaining,
  user_approval_granted: resolveUserApprovalGranted,
  context_sufficient: resolveContextSufficient,
  scope_unsafe: resolveScopeUnsafe,
  edit_applied: resolveEditApplied,
  new_validation_failure: resolveNewValidationFailure,
  failures_existed_before_edit: resolveFailuresExistedBeforeEdit,
  no_blocking_findings: resolveNoBlockingFindings,
  finding_confirmed: resolveFindingConfirmed,
  plan_produced: resolvePlanProduced,
  plan_approved: resolvePlanApproved,
  plan_rejected: resolvePlanRejected,
  scout_completed: resolveScoutCompleted,
  scope_synthesized: resolveScopeSynthesized,
  all_children_complete: resolveAllChildrenComplete,
  child_blocked: resolveChildBlocked,
}

// ── Public API ───────────────────────────────────────────────

/**
 * Check a single predicate spec against runtime context.
 * Dispatches to the correct resolver by `spec.kind`.
 */
export function checkPredicate(
  spec: PredicateSpec,
  ctx: PredicateContext,
): PredicateResult {
  return predicateResolvers[spec.kind](spec, ctx)
}

/**
 * Given a state machine spec and a current state, evaluate all
 * outgoing transitions in priority order. Returns the first
 * transition whose predicate is satisfied, or `null` if none match.
 */
export function checkTransitions(
  machineSpec: AgentStateMachineSpec,
  currentState: string,
  ctx: PredicateContext,
): TransitionSpec | null {
  const candidates = machineSpec.transitions
    .filter((t) => t.from === currentState)
    .sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100))

  for (const transition of candidates) {
    if (checkPredicate(transition.predicate, ctx).satisfied) {
      return transition
    }
  }

  return null
}

/**
 * Async variant that reads events from an Effect-based event store
 * before checking predicates. Use this when the event store, not
 * an in-memory list, is the source of truth.
 *
 * ```ts
 * const result = yield* checkPredicateEffect(spec, ctx, EventStore.Service)
 * ```
 */
export function checkPredicateEffect(
  spec: PredicateSpec,
  ctx: Omit<PredicateContext, "events">,
  queryEvents: (
    sessionId: string,
  ) => Effect.Effect<readonly RuntimeEvent[]>,
): Effect.Effect<PredicateResult> {
  return Effect.map(queryEvents(ctx.sessionId), (events) =>
    checkPredicate(spec, { ...ctx, events }),
  )
}

/**
 * Async variant of `checkTransitions` that reads events from an
 * Effect-based event store.
 */
export function checkTransitionsEffect(
  machineSpec: AgentStateMachineSpec,
  currentState: string,
  ctx: Omit<PredicateContext, "events">,
  queryEvents: (
    sessionId: string,
  ) => Effect.Effect<readonly RuntimeEvent[]>,
): Effect.Effect<TransitionSpec | null> {
  return Effect.map(queryEvents(ctx.sessionId), (events) =>
    checkTransitions(machineSpec, currentState, { ...ctx, events }),
  )
}
