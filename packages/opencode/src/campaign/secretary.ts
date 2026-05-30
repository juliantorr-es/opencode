import { Context, Effect, Layer, Ref, Schema } from "effect"
import { EventStore } from "../event"
import type { RuntimeEvent as StoreRuntimeEvent } from "../event/runtime-event"
import { Identifier } from "../id/id"
import {
  reduceCampaignState,
  LANE_STATE_MACHINE,
  type CampaignState as SMCampaignState,
  type RuntimeEvent as SMRuntimeEvent,
} from "./state-machine"
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

// ── Lane Binder (SM-006) ─────────────────────────────────────

export interface Binder {
  readonly laneId: string
  readonly campaignId: string
  readonly scope: string
  readonly finalState: StateTag
  readonly transitionCount: number
  readonly eventsProcessed: number
  readonly toolsUsed: readonly string[]
  readonly artifacts: readonly string[]
}

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
  readonly binder: Binder | null
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

export type Error = LaneNotFoundError | InvalidEventError | LaneNotTerminalError

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
      return { type: "plan.produced", timestamp: ts, payload: { artifacts: [...event.artifacts] } }
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
    eventType: event._tag,
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
  return state === "failed" || state === "blocked"
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

      // Determine new state tag from SM result
      let newState: StateTag
      let freshPrevious: StateTag | null

      if (event._tag === "Blocked") {
        newState = "blocked"
        freshPrevious = lane.currentState
      } else if (event._tag === "Failed" || nextSM.currentState === "failed" as string) {
        newState = "failed"
        freshPrevious = lane.previousState
      } else if (lane.currentState === "blocked" && event._tag === "Unblocked") {
        // Unblocked — restore previous state or default
        newState = lane.previousState ?? "created"
        freshPrevious = null
      } else if (nextSM.currentState === lane.currentState && nextSM.currentState !== "blocked") {
        // SM didn't transition — no state change, just update event stream
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
      } else {
        // Normal SM transition
        const smCurrent = nextSM.stateHistory.length > 0
          ? nextSM.stateHistory[nextSM.stateHistory.length - 1]!.to
          : nextSM.currentState
        newState = smCurrent as StateTag
        freshPrevious = null
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

      // Build binder if terminal
      const binder: Binder | null = isTerminal(newState)
        ? {
            laneId,
            campaignId: lane.campaignId,
            scope: lane.scope,
            finalState: newState,
            transitionCount: updatedTransitions.length,
            eventsProcessed: updatedStream.length,
            toolsUsed: allowedTools,
            artifacts,
          }
        : null

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

export const layer: Layer.Layer<Service, never, EventStore.Service> = Layer.effect(Service, make)
export const defaultLayer = layer

export const Secretary = { Service, layer, defaultLayer } as const
