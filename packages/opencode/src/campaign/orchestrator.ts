// ── Campaign Orchestrator ───────────────────────────────────
//
// Owns the campaign lifecycle: creates campaigns, decomposes
// lane dependency graphs, dispatches lanes via the Secretary,
// processes events through the campaign state machine, and
// determines push-readiness.
//
// Dependencies:
//   Secretary.Service  — per-lane lifecycle management
//   CAMPAIGN_STATE_MACHINE + reduceCampaignState  — SM-002
//
// The orchestrator maintains an in-memory store of all active
// campaign run states keyed by campaign ID.

import { Context, Effect, Layer, SynchronizedRef } from "effect"
import * as Log from "@opencode-ai/core/util/log"
import { Secretary } from "./secretary"
import {
  reduceCampaignState,
  CAMPAIGN_STATE_MACHINE,
  type CampaignState as SMState,
  type RuntimeEvent as SMRuntimeEvent,
} from "./state-machine"

const log = Log.create({ service: "campaign.orchestrator" })

// ── Lane Dependency Graph ─────────────────────────────────

/** Describes the dependency relationships between lanes. */
export interface LaneDependencyGraph {
  readonly nodes: readonly string[]
  readonly edges: readonly { readonly from: string; readonly to: string }[]
  readonly parallelGroups: readonly (readonly string[])[]
}

/** Input shape for defining a lane. */
export interface LaneInput {
  readonly id: string
  readonly scope: string
  readonly dependencies: readonly string[]
}

// ── Campaign Run State ────────────────────────────────────

/** Lightweight lane metadata tracked by the orchestrator. */
export interface LaneMeta {
  readonly id: string
  readonly scope: string
  readonly dependencies: readonly string[]
  /** Secretary-assigned lane ID after createLane. */
  readonly secretaryLaneId?: string
}

/** The orchestrator's per-campaign state extends the SM state. */
export interface OrchestratorCampaignState {
  readonly campaignId: string
  readonly goal: string
  readonly scope: string
  /** The campaign state machine state (from SM-002). */
  readonly smState: SMState
  /** Lane dependency graph. */
  readonly dependencyGraph: LaneDependencyGraph
  /** Lane metadata indexed by lane ID. */
  readonly lanes: Record<string, LaneMeta>
  /** Whether integration review has passed. */
  readonly integrationReviewPassed: boolean
  /** Whether final validation has passed. */
  readonly finalValidationPassed: boolean
  /** Human-readable blockers encountered. */
  readonly blockers: readonly string[]
  /** When the campaign was created (epoch ms). */
  readonly createdAt: number
}

// ── Errors ─────────────────────────────────────────────────

export class CampaignNotFound {
  readonly _tag = "CampaignNotFound" as const
  constructor(readonly campaignId: string) {}
}

// ── Orchestrator Interface ────────────────────────────────

export interface OrchestratorInterface {
  /** Create a new campaign and return its ID. */
  readonly createCampaign: (goal: string, scope: string) => Effect.Effect<string>

  /**
   * Decompose lanes into a dependency graph with parallel groups.
   * Pure computation — does not mutate state. Use setLanes to store.
   */
  readonly decompose: (
    lanes: readonly LaneInput[],
  ) => Effect.Effect<LaneDependencyGraph>

  /**
   * Store lane definitions and dependency graph in the campaign state.
   * Must be called between decompose and dispatchLanes.
   */
  readonly setLanes: (
    campaignId: string,
    lanes: readonly LaneInput[],
    graph: LaneDependencyGraph,
  ) => Effect.Effect<void, CampaignNotFound>

  /** Find all ready lanes (deps met, not yet dispatched) and start them via Secretary. */
  readonly dispatchLanes: (campaignId: string) => Effect.Effect<void, CampaignNotFound>

  /** Feed an event into the campaign state machine. */
  readonly processEvent: (
    campaignId: string,
    event: SMRuntimeEvent,
  ) => Effect.Effect<void, CampaignNotFound>

  /** Get the full orchestrator campaign state. */
  readonly getCampaignState: (
    campaignId: string,
  ) => Effect.Effect<OrchestratorCampaignState, CampaignNotFound>

  /** Get IDs of lanes whose dependencies are all satisfied. */
  readonly getReadyLanes: (
    campaignId: string,
  ) => Effect.Effect<readonly string[], CampaignNotFound>

  /** True when every lane has returned, no blockers exist, and all validations passed. */
  readonly isPushReady: (campaignId: string) => Effect.Effect<boolean, CampaignNotFound>
}

export class OrchestratorService extends Context.Service<OrchestratorService, OrchestratorInterface>()(
  "@opencode/CampaignOrchestrator",
) {}

// ── Pure Helpers ──────────────────────────────────────────

/**
 * Compute parallel groups from lane dependency declarations.
 *
 * Lanes with no dependencies → group 0.
 * Lanes whose deps are entirely in earlier groups → next group.
 * Circular dependencies are placed in individual groups.
 */
function computeParallelGroups(
  lanes: readonly LaneInput[],
): LaneDependencyGraph {
  const nodes = lanes.map((l) => l.id)
  const edges: { from: string; to: string }[] = []
  for (const lane of lanes) {
    for (const dep of lane.dependencies) {
      edges.push({ from: lane.id, to: dep })
    }
  }

  const depsMap = new Map<string, Set<string>>()
  for (const lane of lanes) {
    depsMap.set(lane.id, new Set(lane.dependencies))
  }

  const assigned = new Set<string>()
  const parallelGroups: string[][] = []
  const remaining = new Set(nodes)

  while (remaining.size > 0) {
    const ready: string[] = []
    for (const id of remaining) {
      const deps = depsMap.get(id)!
      if (deps.size === 0 || [...deps].every((d) => assigned.has(d))) {
        ready.push(id)
      }
    }

    if (ready.length === 0) {
      // Circular or unresolvable — place each remaining in its own group
      for (const id of remaining) ready.push(id)
    }

    parallelGroups.push(ready)
    for (const id of ready) {
      assigned.add(id)
      remaining.delete(id)
    }
  }

  return { nodes, edges, parallelGroups }
}

/** Return the set of lane IDs whose dependencies are all satisfied and not yet dispatched. */
function satisfiedDeps(
  lanes: Record<string, LaneMeta>,
): Set<string> {
  const dispatched = new Set<string>()
  for (const [id, meta] of Object.entries(lanes)) {
    if (meta.secretaryLaneId) dispatched.add(id)
  }

  const ready = new Set<string>()
  for (const [id, meta] of Object.entries(lanes)) {
    if (!meta.secretaryLaneId && meta.dependencies.every((d) => dispatched.has(d))) {
      ready.add(id)
    }
  }
  return ready
}

/** Generate a simple unique ID. */
let idCounter = 0
function nextId(): string {
  return `oc-${++idCounter}-${Date.now()}`
}

// ── Layer ─────────────────────────────────────────────────

export const layer = Layer.effect(
  OrchestratorService,
  Effect.gen(function* () {
    const secretary = yield* Secretary.Service

    // ── In-memory campaign store ────────────────────────────
    const store = yield* SynchronizedRef.make<Map<string, OrchestratorCampaignState>>(new Map())

    function getState(campaignId: string): Effect.Effect<OrchestratorCampaignState, CampaignNotFound> {
      return Effect.fnUntraced(function* () {
        const map = yield* SynchronizedRef.get(store)
        const state = map.get(campaignId)
        if (!state) return yield* Effect.fail(new CampaignNotFound(campaignId))
        return state
      })()
    }

    function updateState(
      campaignId: string,
      fn: (s: OrchestratorCampaignState) => OrchestratorCampaignState,
    ): Effect.Effect<void> {
      return Effect.fnUntraced(function* () {
        yield* SynchronizedRef.update(store, (map) => {
          const existing = map.get(campaignId)
          if (!existing) return map
          const next = new Map(map)
          next.set(campaignId, fn(existing))
          return next
        })
      })()
    }

    // ── Service methods ─────────────────────────────────────

    const createCampaign = Effect.fn("Orchestrator.createCampaign")(function* (goal: string, scope: string) {
      const id = nextId()
      const now = Date.now()
      const initialState: OrchestratorCampaignState = {
        campaignId: id,
        goal,
        scope,
        smState: {
          currentState: "created",
          events: [],
          transitionCount: 0,
          stateHistory: [],
          metadata: {},
          retryBudgets: {},
        },
        dependencyGraph: { nodes: [], edges: [], parallelGroups: [] },
        lanes: {},
        integrationReviewPassed: false,
        finalValidationPassed: false,
        blockers: [],
        createdAt: now,
      }
      yield* SynchronizedRef.update(store, (map) => {
        const next = new Map(map)
        next.set(id, initialState)
        return next
      })
      log.info("campaign created", { id, goal })
      return id
    })

    const decompose = Effect.fn("Orchestrator.decompose")(function* (
      lanes: readonly LaneInput[],
    ) {
      return computeParallelGroups(lanes)
    })

    const setLanes = Effect.fn("Orchestrator.setLanes")(function* (
      campaignId: string,
      lanes: readonly LaneInput[],
      graph: LaneDependencyGraph,
    ) {
      yield* getState(campaignId) // assert exists
      const laneMap: Record<string, LaneMeta> = {}
      for (const lane of lanes) {
        laneMap[lane.id] = {
          id: lane.id,
          scope: lane.scope,
          dependencies: lane.dependencies,
        }
      }
      yield* updateState(campaignId, (s) => ({
        ...s,
        dependencyGraph: graph,
        lanes: laneMap,
      }))
    })

    const dispatchLanes = Effect.fn("Orchestrator.dispatchLanes")(function* (campaignId: string) {
      const state = yield* getState(campaignId)
      const ready = satisfiedDeps(state.lanes)
      if (ready.size === 0) return

      for (const laneId of ready) {
        const meta = state.lanes[laneId]
        if (!meta) continue
        const depsCopy = [...meta.dependencies]
        const secretaryLaneId = yield* secretary.createLane(campaignId, meta.scope, depsCopy)

        yield* updateState(campaignId, (s) => ({
          ...s,
          lanes: {
            ...s.lanes,
            [laneId]: { ...meta, secretaryLaneId },
          },
        }))
        log.info("lane dispatched", { campaignId, laneId, secretaryLaneId })
      }

      // If all nodes are dispatched after this batch, emit SM event
      const updated = yield* getState(campaignId)
      const allDispatched = updated.dependencyGraph.nodes.every(
        (nid) => updated.lanes[nid]?.secretaryLaneId,
      )
      if (allDispatched) {
        const smEvent: SMRuntimeEvent = {
          type: "all_lanes_dispatched",
          timestamp: new Date().toISOString(),
          payload: { campaignId },
        }
        yield* processEventInternal(campaignId, smEvent)
      }
    })

    // Internal helper that processes events without re-triggering dispatch
    const processEventInternal = Effect.fn("Orchestrator.processEventInternal")(
      function* (campaignId: string, event: SMRuntimeEvent) {
        const state = yield* getState(campaignId)
        const nextSM = reduceCampaignState(state.smState, [event], CAMPAIGN_STATE_MACHINE)
        yield* updateState(campaignId, (s) => ({
          ...s,
          smState: nextSM,
        }))
      },
    )

    const processEvent = Effect.fn("Orchestrator.processEvent")(
      function* (campaignId: string, event: SMRuntimeEvent) {
        const state = yield* getState(campaignId)
        const nextSM = reduceCampaignState(state.smState, [event], CAMPAIGN_STATE_MACHINE)
        yield* updateState(campaignId, (s) => ({
          ...s,
          smState: nextSM,
          // When a lane returns or fails, there are no blockers if nothing is blocked
          blockers: event.type === "lane_completed"
            ? s.blockers
            : s.blockers,
        }))

        // If we just transitioned to lane_dispatch, dispatch ready lanes
        if (
          nextSM.currentState === "lane_dispatch" &&
          state.smState.currentState !== "lane_dispatch"
        ) {
          yield* dispatchLanes(campaignId)
        }
      },
    )

    const getCampaignState = Effect.fn("Orchestrator.getCampaignState")(function* (campaignId: string) {
      return yield* getState(campaignId)
    })

    const getReadyLanes = Effect.fn("Orchestrator.getReadyLanes")(function* (campaignId: string) {
      const state = yield* getState(campaignId)
      return [...satisfiedDeps(state.lanes)]
    })

    const isPushReady = Effect.fn("Orchestrator.isPushReady")(function* (campaignId: string) {
      const state = yield* getState(campaignId)

      const allReturned = state.dependencyGraph.nodes.every(
        (nid) => state.lanes[nid]?.secretaryLaneId,
      )

      const smTerminal =
        state.smState.currentState === "push_ready" ||
        state.smState.currentState === "pushed"

      const noBlockers = state.blockers.length === 0
      const allValidations = state.integrationReviewPassed && state.finalValidationPassed

      return allReturned && smTerminal && noBlockers && allValidations
    })

    return OrchestratorService.of({
      createCampaign,
      decompose,
      setLanes,
      dispatchLanes,
      processEvent,
      getCampaignState,
      getReadyLanes,
      isPushReady,
    })
  }),
)
