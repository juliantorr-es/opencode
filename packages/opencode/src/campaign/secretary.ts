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
  | { readonly _tag: "Blocked"; readonly reason: string }
  | { readonly _tag: "Unblocked" }
  | { readonly _tag: "RoleComplete"; readonly role: string; readonly output: string }
  | { readonly _tag: "Failed"; readonly error: string }

// ── Transition Record ────────────────────────────────────────

export interface TransitionRecord {
  readonly from: StateTag
  readonly to: StateTag
  readonly event: string
  readonly evidence: string
  readonly timestamp: number
}

// ── Role Output ──────────────────────────────────────────────

export interface RoleOutput {
  readonly role: string
  readonly status: "success" | "failure" | "blocked"
  readonly artifacts: readonly string[]
  readonly message: string
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
function toSMEvent(event: RuntimeEvent): SMRuntimeEvent {
  const ts = new Date().toISOString()
  switch (event._tag) {
    case "LaneCreated":
      return { type: "lane.created", timestamp: ts, payload: {} }
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
    case "RoleComplete":
      return { type: "edit.applied", timestamp: ts, payload: { role: event.role, output: event.output } }
    case "Failed":
      return { type: "permission.denied", timestamp: ts, payload: { error: event.error } }
  }
}

/**
 * Map a secretary RuntimeEvent to an EventStore RuntimeEvent for
 * write-through durability.
 */
const EVENT_NAME_MAP: Record<string, string> = {
  LaneCreated: EventName.CampaignLaneCreated,
  StartLearning: EventName.ContextSufficient,
  LearningComplete: EventName.PlanProduced,
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
  RoleComplete: EventName.EditApplied,
  Failed: EventName.PermissionDenied,
}

function toStoreEvent(
  laneId: string,
  campaignId: string,
  event: RuntimeEvent,
): StoreRuntimeEvent {
  return {
    id: Identifier.ascending("event"),
    sessionId: campaignId,
    runId: laneId,
    parentEventId: undefined,
    correlationId: undefined,
    ts: new Date().toISOString(),
    actor: "lifecycle",
    eventType: EVENT_NAME_MAP[event._tag] ?? event._tag,
    phase: "campaign",
    status: undefined,
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

// ── Interface ────────────────────────────────────────────────

export interface Interface {
  readonly createLane: (campaignId: string, scope: string, dependencies: string[]) => Effect.Effect<string>
  readonly processEvent: (laneId: string, event: RuntimeEvent) => Effect.Effect<void, Error>
  readonly getLaneState: (laneId: string) => Effect.Effect<LaneReadState, LaneNotFoundError>
  readonly getLaneBinder: (laneId: string) => Effect.Effect<Binder, LaneNotFoundError | LaneNotTerminalError>
  readonly launchRole: (laneId: string, roleType: string) => Effect.Effect<void, Error>
  readonly handleRoleOutput: (laneId: string, output: RoleOutput) => Effect.Effect<void, Error>
  readonly returnLane: (laneId: string) => Effect.Effect<Binder, Error>
  readonly init: (laneId: string) => Effect.Effect<void>
}

// ── Service ──────────────────────────────────────────────────

export class Service extends Context.Service<Service, Interface>()("@opencode/Secretary") {}

// ── Helpers ──────────────────────────────────────────────────

function isTerminal(state: StateTag): boolean {
  return state === "checkpointed" || state === "failed" || state === "blocked" || state === "returned"
}

const STATE_ROLE: Record<string, string> = {
  learning: "cartographer",
  planning: "architect",
  reviewing: "critic",
  executing: "executor",
  validating: "validator",
  repairing: "repairer",
}

function getRoleForState(state: StateTag): string | null {
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
      return id
    })

  /** Replay lane events from EventStore to reconstruct state. */
  const init: (laneId: string) => Effect.Effect<void> = (laneId) =>
    Effect.gen(function* () {
      const existing = yield* Ref.get(activeLanes)
      const lane = existing.get(laneId)
      if (!lane) return

      // Load events from store for this lane
      const stored = yield* eventStore.query({
        runId: laneId,
        order: "asc",
        limit: 10_000,
      })

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

      const updated: LaneState = {
        ...lane,
        currentState: nextSM.currentState as StateTag,
        previousState: lane.currentState === nextSM.currentState ? lane.previousState : lane.currentState,
        eventStream: events as readonly RuntimeEvent[],
        smState: nextSM,
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
      const allowedTools: readonly string[] = []
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
        yield* binderService.createBinder(laneId, lane.campaignId, lane.scope, lane.scope)
        for (const t of lane.transitions) {
          yield* binderService.addEvidence(
            laneId,
            "transition",
            {
              eventId: `${laneId}:${t.event}:${t.timestamp}`,
              eventType: t.event,
              ts: new Date(t.timestamp).toISOString(),
              summary: `Transition: ${t.from} → ${t.to}`,
            },
          )
        }
        yield* binderService.addEvidence(
          laneId,
          "event",
          {
            eventId: `${laneId}:${event._tag}:${now()}`,
            eventType: event._tag,
            ts: new Date().toISOString(),
            summary: `Event: ${event._tag}`,
          },
        )
        yield* binderService.updateStatus(laneId, newState as BinderLaneState)
        binder = yield* binderService.finalizeBinder(laneId)
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

  const handleRoleOutput: Interface["handleRoleOutput"] = (laneId, output) =>
    Effect.gen(function* () {
      const lane = yield* ensureLane(laneId)

      const event: RuntimeEvent = output.status === "success"
        ? { _tag: "RoleComplete", role: output.role, output: output.message }
        : output.status === "blocked"
          ? { _tag: "Blocked", reason: output.message }
          : { _tag: "Failed", error: output.message }

      yield* processEvent(laneId, event)
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
      const binder = lane.binder
      if (binder) return binder
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
    init,
  })
})

export const layer: Layer.Layer<Service, never, EventStore.Service> = Layer.effect(Service, make).pipe(
  Layer.provide(BinderLayer),
)
export const defaultLayer = layer

export const Secretary = { Service, layer, defaultLayer } as const
