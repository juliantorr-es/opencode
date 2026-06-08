import { Context, Effect, Layer, Option, Ref, Schema } from "effect"
import { EventStore, EventName } from "../event"
import type { RuntimeEvent as StoreRuntimeEvent } from "../event/runtime-event"
import { Identifier } from "../id/id"
import {
  reduceCampaignState,
  LANE_STATE_MACHINE,
  type CampaignState as SMCampaignState,
  type RuntimeEvent as SMRuntimeEvent,
} from "./state-machine"
import { Service as BinderService, type Binder as CanonicalBinder, layer as BinderLayer, BinderError, type LaneState as BinderLaneState } from "./binder"
import type { LaneState as LaneStateName } from "./types"
import { deriveAllowedTools } from "./role-contracts"

// ── State Tags (canonical LaneState from types.ts) ───────────

export type StateTag = LaneStateName | "failed" | "blocked"

// ── Runtime Events ───────────────────────────────────────────

export type RuntimeEvent =
  | { readonly _tag: "LaneCreated" }
  | { readonly _tag: "StartLearning" }
  | { readonly _tag: "LearningComplete"; readonly artifacts: readonly string[] }
  | { readonly _tag: "PlanReady" }
  | { readonly _tag: "ReviewApproved" }
  | { readonly _tag: "ReviewRejected"; readonly reason: string }
  | { readonly _tag: "ExecutionComplete" }
  | { readonly _tag: "ValidationPassed" }
  | { readonly _tag: "ValidationFailed"; readonly issues: readonly string[] }
  | { readonly _tag: "RepairComplete" }
  | { readonly _tag: "RepairFailed"; readonly error: string }
  | { readonly _tag: "Blocked"; readonly reason: string; readonly laneId?: string; readonly campaignId?: string; readonly ts?: string }
  | { readonly _tag: "Unblocked" }
  | { readonly _tag: "ScoutComplete"; readonly artifacts: readonly string[] }
  | { readonly _tag: "ArchitectComplete" }
  | { readonly _tag: "CriticComplete"; readonly verdict: "approved" | "rejected"; readonly reason?: string }
  | { readonly _tag: "ExecutorComplete"; readonly files: readonly string[] }
  | { readonly _tag: "ValidatorComplete"; readonly passed: boolean; readonly issues: readonly string[] }
  | { readonly _tag: "RedTeamFindingRecorded"; readonly severity: "blocking" | "high" | "medium" | "low" | "info"; readonly summary: string }
  | { readonly _tag: "RedTeamCompleted"; readonly blockingFindings: number; readonly totalFindings: number }
  | { readonly _tag: "ScopeSynthesized"; readonly summary: string }
  | { readonly _tag: "ClaimsAcquired"; readonly files: readonly string[]; readonly claimIds: readonly string[] }
  | { readonly _tag: "CheckpointCreated"; readonly sha: string; readonly message: string }
  | { readonly _tag: "LaneReturned"; readonly binderDigest: string }
  | { readonly _tag: "Failed"; readonly error: string; readonly laneId?: string; readonly campaignId?: string; readonly ts?: string; readonly reason?: string }

// ── Transition Record ────────────────────────────────────────

export interface TransitionRecord {
  readonly from: StateTag
  readonly to: StateTag
  readonly event: string
  readonly evidence: string
  readonly timestamp: number
}

// ── Role Output ──────────────────────────────────────────────

export type RoleOutput =
  | { readonly role: "cartographer" | "scout"; readonly status: "success" | "failure" | "blocked"; readonly artifacts: readonly string[]; readonly message: string }
  | { readonly role: "architect"; readonly status: "success" | "failure" | "blocked"; readonly planRef?: string; readonly message: string }
  | { readonly role: "critic"; readonly status: "success" | "failure" | "blocked"; readonly verdict: "approved" | "rejected"; readonly reviewRef?: string; readonly reviewId?: string; readonly reason?: string; readonly artifacts?: readonly string[]; readonly findings?: readonly { readonly id: string; readonly severity: string; readonly description: string; readonly file?: string }[]; readonly message: string }
  | { readonly role: "executor"; readonly status: "success" | "failure" | "blocked"; readonly changedFiles: readonly string[]; readonly diffSummary?: string; readonly message: string }
  | { readonly role: "validator"; readonly status: "success" | "failure" | "blocked"; readonly passed: boolean; readonly failedTests: readonly string[]; readonly message: string }
  | { readonly role: "redteam"; readonly status: "success" | "failure" | "blocked"; readonly findings: readonly { readonly severity: "blocking" | "high" | "medium" | "low" | "info"; readonly summary: string; readonly description?: string }[]; readonly message: string }
  | { readonly role: "historian"; readonly status: "success" | "failure" | "blocked"; readonly checkpointSha?: string; readonly commitMessage?: string; readonly message: string }
  | { readonly role: "repairer" | "repair"; readonly status: "success" | "failure" | "blocked"; readonly changedFiles: readonly string[]; readonly message: string }

export function roleOutputToEvent(output: RoleOutput): RuntimeEvent {
  if (output.status === "success") {
    switch (output.role) {
      case "cartographer":
      case "scout":
        return { _tag: "ScoutComplete", artifacts: output.artifacts }
      case "architect":
        return { _tag: "ArchitectComplete" }
      case "critic":
        return { _tag: "CriticComplete", verdict: output.verdict, reason: output.reason }
      case "executor":
        return { _tag: "ExecutorComplete", files: output.changedFiles }
      case "validator":
        return { _tag: "ValidatorComplete", passed: output.passed, issues: output.failedTests }
      case "redteam": {
        const blockingFindings = output.findings.filter((f) => f.severity === "blocking").length
        return { _tag: "RedTeamCompleted", blockingFindings, totalFindings: output.findings.length }
      }
      case "historian":
        return { _tag: "CheckpointCreated", sha: output.checkpointSha ?? "", message: output.commitMessage ?? "" }
      default: {
        const role = (output as { role: string }).role
        return { _tag: "Failed", error: `unknown role: ${role}` }
      }
    }
  }
  if (output.status === "blocked") {
    if (output.role === "critic") {
      return { _tag: "CriticComplete", verdict: "rejected", reason: output.message }
    }
    return { _tag: "Blocked", reason: output.message }
  }
  if (output.role === "critic") {
    return { _tag: "CriticComplete", verdict: "rejected", reason: output.message }
  }
  return { _tag: "Failed", error: output.message }
}

// ── Lane Binder (SM-006) — re-exported from canonical binder.ts ───

export type Binder = CanonicalBinder

// ── Active Lane State ────────────────────────────────────────

export interface LaneState {
  readonly id: string
  readonly campaignId: string
  readonly scope: string
  readonly dependencies: readonly string[]
  readonly currentState: StateTag
  readonly previousState: StateTag | null
  readonly smState: SMCampaignState
  readonly eventStream: readonly RuntimeEvent[]
  readonly transitions: readonly TransitionRecord[]
  readonly allowedTools: readonly string[]
  readonly activeRole: string | null
  readonly binder: CanonicalBinder | null
  readonly error: string | null
}

// ── Read-Projected State (for consumers) ─────────────────────

export interface LaneReadState {
  readonly id: string
  readonly campaignId: string
  readonly scope: string
  readonly currentState: StateTag
  readonly transitionCount: number
  readonly eventsProcessed: number
  readonly activeRole: string | null
  readonly allowedTools: readonly string[]
  readonly error: string | null
}

// ── Errors ───────────────────────────────────────────────────

export class LaneNotFoundError extends Schema.TaggedErrorClass<LaneNotFoundError>()("LaneNotFoundError", {
  laneId: Schema.String,
  message: Schema.String,
}) {}

export class InvalidEventError extends Schema.TaggedErrorClass<InvalidEventError>()("InvalidEventError", {
  laneId: Schema.String,
  state: Schema.String,
  event: Schema.String,
  message: Schema.String,
}) {}

export class LaneNotTerminalError extends Schema.TaggedErrorClass<LaneNotTerminalError>()("LaneNotTerminalError", {
  laneId: Schema.String,
  state: Schema.String,
  message: Schema.String,
}) {}

export type Error = LaneNotFoundError | InvalidEventError | LaneNotTerminalError | BinderError

// ── Event Mapping ────────────────────────────────────────────

/**
 * Map a secretary RuntimeEvent (tagged union) to the state machine
 * RuntimeEvent format (type + payload). This bridges the secretary's
 * event model to the canonical predicate-based state machine.
 */
export function toSMEvent(event: RuntimeEvent): SMRuntimeEvent {
  const ts = new Date().toISOString()
  switch (event._tag) {
    case "LaneCreated":
      return { type: EventName.CampaignLaneCreated, timestamp: ts, payload: {} }
    case "StartLearning":
      return { type: "context.sufficient", timestamp: ts, payload: {} }
    case "LearningComplete":
      return { type: "scout.completed", timestamp: ts, payload: { artifacts: [...event.artifacts] } }
    case "PlanReady":
      return { type: "plan.produced", timestamp: ts, payload: {} }
    case "ReviewApproved":
      return { type: "plan.approved", timestamp: ts, payload: {} }
    case "ReviewRejected":
      return { type: "plan.rejected", timestamp: ts, payload: { reason: event.reason } }
    case "ExecutionComplete":
      return { type: "edit.applied", timestamp: ts, payload: {} }
    case "ValidationPassed":
      return { type: "validation.completed", timestamp: ts, payload: { status: "pass" } }
    case "ValidationFailed":
      return { type: "validation.failure", timestamp: ts, payload: { isNew: true, issues: [...event.issues] } }
    case "RepairComplete":
      return { type: "edit.applied", timestamp: ts, payload: {} }
    case "RepairFailed":
      return { type: "validation.failure", timestamp: ts, payload: { isNew: true } }
    case "Blocked":
      return { type: "child.blocked", timestamp: ts, payload: { reason: event.reason } }
    case "Unblocked":
      return { type: "context.sufficient", timestamp: ts, payload: {} }
    case "ScoutComplete":
      return { type: "scout.completed", timestamp: ts, payload: { artifacts: [...event.artifacts] } }
    case "ArchitectComplete":
      return { type: "plan.produced", timestamp: ts, payload: {} }
    case "CriticComplete":
      return event.verdict === "approved"
        ? { type: "plan.approved", timestamp: ts, payload: {} }
        : { type: "plan.rejected", timestamp: ts, payload: { reason: event.reason } }
    case "ExecutorComplete":
      return event.files.length > 0
        ? { type: "edit.applied", timestamp: ts, payload: { files: [...event.files] } }
        : { type: "edit.applied", timestamp: ts, payload: {} }
    case "ValidatorComplete":
      return event.passed
        ? { type: "validation.completed", timestamp: ts, payload: { status: "pass" } }
        : { type: "validation.failure", timestamp: ts, payload: { isNew: true, issues: [...event.issues] } }
    case "RedTeamFindingRecorded":
      return { type: EventName.RedteamFindingRecorded, timestamp: ts, payload: { severity: event.severity, summary: event.summary } }
    case "RedTeamCompleted":
      return { type: EventName.RedteamCompleted, timestamp: ts, payload: { blockingFindings: event.blockingFindings, totalFindings: event.totalFindings } }

    case "ScopeSynthesized":
      return { type: "scope.synthesized", timestamp: ts, payload: { summary: event.summary } }
    case "ClaimsAcquired":
      return { type: "claims.acquired", timestamp: ts, payload: { files: [...event.files], claimIds: [...event.claimIds] } }
    case "CheckpointCreated":
      return { type: EventName.SessionCheckpoint, timestamp: ts, payload: { sha: event.sha, message: event.message } }
    case "LaneReturned":
      return { type: EventName.LaneReturned, timestamp: ts, payload: { binderDigest: event.binderDigest } }
    case "Failed":
      return { type: "permission.denied", timestamp: ts, payload: { error: event.error } }
    default: {
      const _exhaustive: never = event
      return _exhaustive
    }
  }
}

/**
 * Map a secretary RuntimeEvent to an EventStore RuntimeEvent for
 * write-through durability.
 */
const EVENT_NAME_MAP: Record<string, string> = {
  LaneCreated: EventName.CampaignLaneCreated,
  StartLearning: EventName.ContextSufficient,
  LearningComplete: EventName.ScoutCompleted,
  PlanReady: EventName.PlanProduced,
  ReviewApproved: EventName.PlanApproved,
  ReviewRejected: EventName.PlanRejected,
  ExecutionComplete: EventName.EditApplied,
  ValidationPassed: EventName.ValidationCompleted,
  ValidationFailed: EventName.ValidationFailure,
  RepairComplete: EventName.EditApplied,
  RepairFailed: EventName.ValidationFailure,
  Blocked: EventName.ChildBlocked,
  Unblocked: EventName.ContextSufficient,
  ScoutComplete: EventName.ScoutCompleted,
  ArchitectComplete: EventName.PlanProduced,
  ExecutorComplete: EventName.EditApplied,
  ValidatorComplete: EventName.ValidationCompleted,
  RedTeamFindingRecorded: EventName.RedteamFindingRecorded,
  ScopeSynthesized: EventName.ScopeSynthesized,
  ClaimsAcquired: EventName.ClaimsAcquired,
  CheckpointCreated: EventName.SessionCheckpoint,
  LaneReturned: EventName.LaneReturned,
  RedTeamCompleted: EventName.RedteamCompleted,
  Failed: EventName.PermissionDenied,
}

export function toStoreEvent(
  laneId: string,
  campaignId: string,
  event: RuntimeEvent,
): StoreRuntimeEvent {
  const status = resolveStatus(event)
  return {
    id: Effect.runSync(Identifier.ascending("event")),
    sessionId: campaignId,
    runId: laneId,
    parentEventId: undefined,
    correlationId: undefined,
    ts: new Date().toISOString(),
    actor: "lifecycle",
    eventType: (event._tag === "CriticComplete"
      ? (event.verdict === "approved" ? EventName.PlanApproved : EventName.PlanRejected)
      : (EVENT_NAME_MAP[event._tag] ?? event._tag)) as EventName,
    phase: "campaign",
    status,
    toolName: undefined,
    filePath: undefined,
    model: undefined,
    durationMs: undefined,
    tokenInput: undefined,
    tokenOutput: undefined,
    errorCode: undefined,
    errorMessage: undefined,
    recoverable: undefined,
    payloadJson: event satisfies Record<string, unknown>,
    campaignId,
    laneId,
    role: undefined,
  }
}

function resolveStatus(event: RuntimeEvent) {
  switch (event._tag) {
    case "StartLearning":
      return "started"
    case "LaneCreated":
    case "LearningComplete":
    case "PlanReady":
    case "ReviewApproved":
    case "ExecutionComplete":
    case "RepairComplete":
    case "Unblocked":
    case "ScoutComplete":
    case "ArchitectComplete":
    case "ExecutorComplete":
    case "RedTeamFindingRecorded":
    case "RedTeamCompleted":
    case "CheckpointCreated":
    case "ClaimsAcquired":
    case "ScopeSynthesized":
    case "LaneReturned":
    case "ValidationPassed":
      return "succeeded"
    case "ValidationFailed":
    case "ReviewRejected":
    case "RepairFailed":
    case "Failed":
    case "Blocked":
      return "failed"
    case "CriticComplete":
      return event.verdict === "approved" ? "succeeded" : "failed"
    case "ValidatorComplete":
      return event.passed ? "succeeded" : "failed"
    default:
      return undefined
  }
}

// ── Interface ────────────────────────────────────────────────

export interface Interface {
  readonly createLane: (campaignId: string, scope: string, dependencies: string[]) => Effect.Effect<string>
  readonly processEvent: (laneId: string, event: RuntimeEvent) => Effect.Effect<void, Error>
  readonly getLaneState: (laneId: string) => Effect.Effect<LaneReadState, LaneNotFoundError>
  readonly getLaneBinder: (laneId: string) => Effect.Effect<Binder, LaneNotFoundError | LaneNotTerminalError>
  readonly launchRole: (laneId: string, roleType: string) => Effect.Effect<void, Error>
  readonly handleRoleOutput: (laneId: string, output: RoleOutput) => Effect.Effect<void, Error>
  readonly returnLane: (laneId: string) => Effect.Effect<Binder, Error>
  readonly loadLane: (laneId: string) => Effect.Effect<LaneState, LaneNotFoundError>
  readonly init: (laneId: string) => Effect.Effect<void, LaneNotFoundError>
}

// ── Service ──────────────────────────────────────────────────

export class Service extends Context.Service<Service, Interface>()("@opencode/Secretary") {}

// ── Helpers ──────────────────────────────────────────────────

function isTerminal(state: StateTag): boolean {
  return state === "returned" || state === "failed" || state === "blocked"
}

export const STATE_ROLE: Record<string, string | null> = {
  scouting: "cartographer",
  scoped: "cartographer",
  planning: "architect",
  critic_review: "critic",
  approved: "executor",
  executing: "executor",
  validating: "validator",
  red_team: "redteam",
  repairing: "repair",
  historian: "historian",
  created: null,
  checkpointed: null,
  returned: null,
  blocked: null,
  failed: null,
}

export function getRoleForState(state: StateTag): string | null {
  return STATE_ROLE[state] ?? null
}

function now(): number {
  return Date.now()
}

function makeInitialSMState(): SMCampaignState {
  return {
    currentState: "created",
    events: [],
    transitionCount: 0,
    stateHistory: [],
    metadata: {},
    retryBudgets: {},
  }
}

// ── Implementation ───────────────────────────────────────────

const make = Effect.gen(function* () {
  const activeLanes = yield* Ref.make(new Map<string, LaneState>())
  const eventStore = yield* EventStore.Service
  const binderService = yield* BinderService

  function ensureLane(laneId: string): Effect.Effect<LaneState, LaneNotFoundError> {
    return Ref.get(activeLanes).pipe(
      Effect.map((map) => map.get(laneId)),
      Effect.flatMap((lane) =>
        lane
          ? Effect.succeed(lane)
          : Effect.fail(new LaneNotFoundError({ laneId, message: `Lane ${laneId} not found` })),
      ),
    )
  }

  /** Reconstruct a lane from EventStore without requiring it in activeLanes. */
  const loadLane: Interface["loadLane"] = (laneId) =>
    Effect.gen(function* () {
      const existing = yield* Ref.get(activeLanes)
      const existingLane = existing.get(laneId)
      if (existingLane) return existingLane

      const stored = yield* eventStore.query({
        runId: laneId,
        order: "asc",
        limit: 10_000,
      }).pipe(
        Effect.catchTag("DatabaseError", () => Effect.succeed([])),
      )

      if (stored.length === 0) {
        return yield* Effect.fail(new LaneNotFoundError({ laneId, message: `Lane ${laneId} not found in EventStore` }))
      }

      const campaignId = stored.find((e) => e.campaignId)?.campaignId ?? ""

      const binderOpt = yield* binderService.getBinder(laneId)
      const binder = Option.isSome(binderOpt) ? binderOpt.value : null

      const initialSM = makeInitialSMState()
      const events: RuntimeEvent[] = []
      const smEvents: SMRuntimeEvent[] = []

      for (const se of stored) {
        if (se.payloadJson && typeof se.payloadJson === "object" && "_tag" in (se.payloadJson as Record<string, unknown>)) {
          events.push(se.payloadJson as RuntimeEvent)
          smEvents.push(toSMEvent(se.payloadJson as RuntimeEvent))
        }
      }

      const nextSM = smEvents.length > 0
        ? reduceCampaignState(initialSM, smEvents, LANE_STATE_MACHINE)
        : initialSM

      const transitions: TransitionRecord[] = nextSM.stateHistory.map((st) => ({
        from: st.from as StateTag,
        to: st.to as StateTag,
        event: st.eventType,
        evidence: `replayed: ${st.eventType}`,
        timestamp: st.timestamp ? new Date(st.timestamp).getTime() : now(),
      }))

      const errorEvents = events.filter((e) => e._tag === "Failed" || e._tag === "RepairFailed")
      const error: string | null = errorEvents.length > 0 ? (errorEvents[errorEvents.length - 1]!.error ?? null) : null

      const state = nextSM.currentState as StateTag
      const activeRole = getRoleForState(state)
      const allowedTools: readonly string[] = deriveAllowedTools(state)

      const lane: LaneState = {
        id: laneId,
        campaignId,
        scope: "",
        dependencies: [],
        currentState: state,
        previousState: null,
        smState: nextSM,
        eventStream: events as readonly RuntimeEvent[],
        transitions,
        allowedTools,
        activeRole,
        binder,
        error,
      }

      yield* Ref.update(activeLanes, (map) => {
        const next = new Map(map)
        next.set(laneId, lane)
        return next
      })

      return lane
    })

  const createLane: Interface["createLane"] = (campaignId, scope, dependencies) =>
    Effect.gen(function* () {
      const id = `lane-${campaignId}-${now()}-${Math.random().toString(36).slice(2, 8)}`
      const lane: LaneState = {
        id,
        campaignId,
        scope,
        dependencies: [...dependencies],
        currentState: "created",
        previousState: null,
        smState: makeInitialSMState(),
        eventStream: [],
        transitions: [],
        allowedTools: [],
        activeRole: null,
        binder: null,
        error: null,
      }
      yield* Ref.update(activeLanes, (map) => {
        const next = new Map(map)
        next.set(id, lane)
        return next
      })
      yield* binderService.createBinder(id, campaignId, scope, scope)
      const freshBinder = yield* binderService.getBinder(id)
      if (Option.isSome(freshBinder)) {
        yield* Ref.update(activeLanes, (map) => {
          const next = new Map(map)
          const existing = next.get(id)
          if (existing) next.set(id, { ...existing, binder: freshBinder.value })
          return next
        })
      }
      return id
    })

  /** Replay lane events from EventStore to reconstruct state. */
  const init: (laneId: string) => Effect.Effect<void, LaneNotFoundError> = (laneId) =>
    Effect.gen(function* () {
      const existing = yield* Ref.get(activeLanes)
      const lane = existing.get(laneId)
      if (!lane) {
        yield* loadLane(laneId)
        return
      }

      // Load events from store for this lane
      const stored = yield* eventStore.query({
        runId: laneId,
        order: "asc",
        limit: 10_000,
      }).pipe(
        Effect.catchTag("DatabaseError", () => Effect.succeed([])),
      )

      if (stored.length === 0) return

      // Convert to secretary events and SM events
      const events: RuntimeEvent[] = []
      const smEvents: SMRuntimeEvent[] = []

      for (const se of stored) {
        // Reconstitute secretary event from stored eventType
        if (se.payloadJson && typeof se.payloadJson === "object" && "_tag" in (se.payloadJson as Record<string, unknown>)) {
          events.push(se.payloadJson as RuntimeEvent)
          smEvents.push(toSMEvent(se.payloadJson as RuntimeEvent))
        }
      }

      if (smEvents.length === 0) return

      // Apply SM reducer
      const nextSM = reduceCampaignState(lane.smState, smEvents, LANE_STATE_MACHINE)

      // Reconstruct transitions from SM state history
      const transitions: TransitionRecord[] = nextSM.stateHistory.map((st) => ({
        from: st.from as StateTag,
        to: st.to as StateTag,
        event: st.eventType,
        evidence: `replayed: ${st.eventType}`,
        timestamp: st.timestamp ? new Date(st.timestamp).getTime() : now(),
      }))

      // Reconstruct binder from binder service
      const binderOpt = yield* binderService.getBinder(laneId)
      const binder = Option.isSome(binderOpt) ? binderOpt.value : null

      // Restore error state from replayed events
      const errorEvents = events.filter(e => e._tag === "Failed" || e._tag === "RepairFailed")
      const error: string | null = errorEvents.length > 0 ? (errorEvents[errorEvents.length - 1]!.error ?? null) : null

      const state = nextSM.currentState as StateTag
      const activeRole = getRoleForState(state)
      const allowedTools: readonly string[] = deriveAllowedTools(state)

      const updated: LaneState = {
        ...lane,
        currentState: state,
        previousState: lane.currentState === nextSM.currentState ? lane.previousState : lane.currentState,
        eventStream: events as readonly RuntimeEvent[],
        smState: nextSM,
        transitions,
        activeRole,
        allowedTools,
        binder,
        error,
      }

      yield* Ref.update(activeLanes, (map) => {
        const next = new Map(map)
        next.set(laneId, updated)
        return next
      })
    })

  const launchRole: Interface["launchRole"] = (laneId, roleType) =>
    Effect.gen(function* () {
      const lane = yield* ensureLane(laneId)
      const updated: LaneState = { ...lane, activeRole: roleType }
      yield* Ref.update(activeLanes, (map) => {
        const next = new Map(map)
        next.set(laneId, updated)
        return next
      })
    })

  const processEvent: Interface["processEvent"] = (laneId, event) =>
    Effect.gen(function* () {
      const lane = yield* ensureLane(laneId)

      if (isTerminal(lane.currentState)) {
        return yield* Effect.fail(
          new InvalidEventError({
            laneId,
            state: lane.currentState,
            event: event._tag,
            message: `Cannot process event on terminal lane ${laneId} (state: ${lane.currentState})`,
          }),
        )
      }

      // Write-through: persist to EventStore before mutating state
      const storeEvent = toStoreEvent(laneId, lane.campaignId, event)
      yield* eventStore.record(storeEvent)

      const updatedStream = [...lane.eventStream, event] as readonly RuntimeEvent[]

      // Delegate to canonical state machine
      const smEvent = toSMEvent(event)
      const nextSM = reduceCampaignState(lane.smState, [smEvent], LANE_STATE_MACHINE)

      // SM is the primary authority for state transitions
      let newState: StateTag
      let freshPrevious: StateTag | null

      if (nextSM.currentState !== lane.currentState) {
        // SM transitioned — use its result
        const smTarget = nextSM.stateHistory.length > 0
          ? nextSM.stateHistory[nextSM.stateHistory.length - 1]!.to
          : nextSM.currentState
        newState = smTarget as StateTag
        freshPrevious = lane.currentState
      } else {
        // SM didn't transition — handle events the SM doesn't directly cover
        switch (event._tag) {
          case "Blocked":
            newState = "blocked"
            freshPrevious = lane.currentState
            break
          case "Failed":
            newState = "failed"
            freshPrevious = lane.currentState
            break
          case "Unblocked":
            // Unblocked — restore previous state or default
            newState = lane.previousState ?? "created"
            freshPrevious = null
            break
          default:
            // No state change — just update event stream and return
            yield* Ref.update(activeLanes, (map) => {
              const next = new Map(map)
              const existing = next.get(laneId)
              if (existing) {
                next.set(laneId, {
                  ...existing,
                  eventStream: updatedStream,
                  smState: nextSM,
                })
              }
              return next
            })
            return
        }
      }

      const transition: TransitionRecord = {
        from: lane.currentState,
        to: newState,
        event: event._tag,
        evidence: `transition via ${event._tag} at ${now()}`,
        timestamp: now(),
      }

      const updatedTransitions = [...lane.transitions, transition] as readonly TransitionRecord[]
      const allowedTools: readonly string[] = deriveAllowedTools(newState)
      const role = getRoleForState(newState)

      // Collect artifacts from events if transitioning
      const artifacts: string[] = []
      for (const e of updatedStream) {
        if ("artifacts" in e && Array.isArray((e as Record<string, unknown>).artifacts)) {
          artifacts.push(...(e as { artifacts: readonly string[] }).artifacts)
        }
      }

      // Build binder if terminal — using canonical BinderService
      let binder: Binder | null = null
      if (isTerminal(newState)) {
        binder = yield* binderService.ensureBinder(laneId, lane.campaignId, lane.scope, lane.scope)
        for (const t of updatedTransitions) {
          yield* binderService.addTransitionEvidence(
            laneId,
            {
              eventId: `${laneId}:${t.event}:${t.timestamp}`,
              eventType: t.event,
              ts: new Date(t.timestamp).toISOString(),
              summary: `Transition: ${t.from} → ${t.to}`,
            },
          )
        }
        yield* binderService.addExecutionEvent(
          laneId,
          {
            eventId: `${laneId}:${event._tag}:${now()}`,
            eventType: event._tag,
            ts: new Date().toISOString(),
            summary: `Event: ${event._tag}`,
          },
        )
        yield* binderService.updateStatus(laneId, newState as BinderLaneState)
      }

      const updated: LaneState = {
        ...lane,
        currentState: newState,
        previousState: freshPrevious,
        smState: nextSM,
        eventStream: updatedStream,
        transitions: updatedTransitions,
        allowedTools,
        activeRole: role,
        binder,
      }

      yield* Ref.update(activeLanes, (map) => {
        const next = new Map(map)
        next.set(laneId, updated)
        return next
      })
    })


  function addRoleEvidence(laneId: string, output: RoleOutput): Effect.Effect<void, BinderError | LaneNotFoundError> {
    return Effect.gen(function* () {
      const lane = yield* ensureLane(laneId)
      const existingBinder = yield* binderService.getBinder(laneId)
      if (Option.isNone(existingBinder)) {
        yield* binderService.createBinder(laneId, lane.campaignId, lane.scope, lane.scope)
      }
      // Only add evidence for success outputs
      if (output.status === "failure" || output.status === "blocked") return

      // Use typed evidence methods directly instead of section string dispatch
      const ts = new Date().toISOString()

      // Build correct payload type per section category
      switch (output.role) {
        case "scout":
        case "cartographer":
          yield* binderService.addScoutReport(laneId, {
            type: output.role,
            path: `lane:${laneId}:${output.role.toLowerCase()}:${ts}`,
            summary: output.message,
            contentDigest: "",
          })
          break
        case "architect":
          yield* binderService.setArchitecturePlan(laneId, {
            type: "architect",
            path: `lane:${laneId}:architect:${ts}`,
            summary: output.message,
            contentDigest: "",
          })
          break
        case "critic":
          yield* binderService.addCriticReview(laneId, {
            type: "critic",
            path: `lane:${laneId}:critic:${ts}`,
            summary: output.message,
            contentDigest: "",
          })
          if (output.verdict === "approved") {
            yield* binderService.setApprovedPlan(laneId, {
              type: "critic:approved",
              path: `lane:${laneId}:critic:approved:${ts}`,
              summary: "Plan approved by critic review",
              contentDigest: "",
            })
          }
          break
        case "executor":
          yield* binderService.addExecutionEvent(laneId, {
            eventId: `${laneId}:executor:${ts}`,
            eventType: "executor",
            ts: ts,
            summary: output.message,
          })
          break
        case "validator":
          yield* binderService.addValidationResult(laneId, {
            tool: "validator",
            status: output.passed ? "pass" : "fail",
            failures: output.failedTests.map((t) => ({ name: t, message: t })),
            durationMs: 0,
            afterLastEdit: false,
          })
          break
        case "redteam":
          for (const finding of output.findings) {
            yield* binderService.addRedTeamFinding(laneId, {
              severity: finding.severity as "blocking" | "high" | "medium" | "low" | "info",
              summary: finding.summary,
              evidence: {
                eventId: `${laneId}:redteam:${ts}`,
                eventType: "redteam",
                ts: ts,
                summary: finding.summary,
              },
              resolved: false,
            })
          }
          break
        case "historian":
          yield* binderService.setHandoffSummary(laneId, output.checkpointSha ?? output.message)
          break
      }      // Evidence is now added directly via typed methods in the switch above
    })
  }


  function finalizeLaneClosure(laneId: string, output: RoleOutput): Effect.Effect<void, Error> {
    return Effect.gen(function* () {
      const lane = yield* ensureLane(laneId)
      if (lane.currentState !== "checkpointed") return

      const sha = (output as { checkpointSha?: string }).checkpointSha ?? ""
      yield* processEvent(laneId, { _tag: "LaneReturned", binderDigest: sha } satisfies RuntimeEvent)
      const finalized = yield* binderService.finalizeBinder(laneId)

      yield* Ref.update(activeLanes, (map) => {
        const next = new Map(map)
        const existing = next.get(laneId)
        if (existing) next.set(laneId, { ...existing, binder: finalized })
        return next
      })
    })
  }

  const handleRoleOutput: Interface["handleRoleOutput"] = (laneId, output) =>
    Effect.gen(function* () {
      const lane = yield* ensureLane(laneId)

      // Redteam: emit individual findings before completion event
      if (output.role === "redteam") {
        const blockingFindings = output.findings.filter((f) => f.severity === "blocking")
        for (const finding of output.findings) {
          yield* processEvent(laneId, { _tag: "RedTeamFindingRecorded", severity: finding.severity, summary: finding.summary })
        }
        yield* processEvent(laneId, {
          _tag: "RedTeamCompleted",
          blockingFindings: blockingFindings.length,
          totalFindings: output.findings.length,
        })
      } else if (output.status === "failure" || output.status === "blocked") {
        const event = roleOutputToEvent(output)
        yield* processEvent(laneId, event)
      } else {
        const event = roleOutputToEvent(output)
        yield* processEvent(laneId, event)
      }

      // Historian: centralized closure sequence via finalizeLaneClosure
      yield* addRoleEvidence(laneId, output)
      if (output.role === "historian") {
        yield* finalizeLaneClosure(laneId, output)
      }
    })

  const getLaneState: Interface["getLaneState"] = (laneId) =>
    Effect.gen(function* () {
      const lane = yield* ensureLane(laneId)
      return {
        id: lane.id,
        campaignId: lane.campaignId,
        scope: lane.scope,
        currentState: lane.currentState,
        transitionCount: lane.transitions.length,
        eventsProcessed: lane.eventStream.length,
        activeRole: lane.activeRole,
        allowedTools: lane.allowedTools,
        error: lane.error,
      } satisfies LaneReadState
    })

  const getLaneBinder: Interface["getLaneBinder"] = (laneId) =>
    Effect.gen(function* () {
      const lane = yield* ensureLane(laneId)
      const binderOpt = yield* binderService.getBinder(laneId)
      if (Option.isSome(binderOpt)) return binderOpt.value
      if (!lane.binder) {
        return yield* Effect.fail(
          new LaneNotTerminalError({
            laneId,
            state: lane.currentState,
            message: `Lane ${laneId} is not terminal (state: ${lane.currentState})`,
          }),
        )
      }
      return lane.binder
    })

  const returnLane: Interface["returnLane"] = (laneId) =>
    Effect.gen(function* () {
      const lane = yield* ensureLane(laneId)
      const binderOpt = yield* binderService.getBinder(laneId)
      if (Option.isSome(binderOpt)) return binderOpt.value
      if (lane.binder) return lane.binder
      return yield* Effect.fail(
        new LaneNotTerminalError({
          laneId,
          state: lane.currentState,
          message: `Cannot return non-terminal lane ${laneId} (state: ${lane.currentState})`,
        }),
      )
    })

  return Service.of({
    createLane,
    processEvent,
    getLaneState,
    getLaneBinder,
    launchRole,
    handleRoleOutput,
    returnLane,
    loadLane,
    init,
  })
})

export const layer: Layer.Layer<Service, never, EventStore.Service> = Layer.effect(Service, make).pipe(
  Layer.provide(BinderLayer),
)
export const defaultLayer = layer

export const Secretary = { Service, layer, defaultLayer } as const
