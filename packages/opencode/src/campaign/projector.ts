// ── CampaignProjector — Event-Sourced State Projection ───────
//
// Derives a materialized CampaignStateProjection from a stream of
// campaign events by replaying them through the canonical state
// machine reducer.
//
// The projector is an Effect Service — it maintains in-memory
// projections keyed by campaign ID, rebuilt on demand from the
// EventStore.
// ──────────────────────────────────────────────────────────────

import { Context, Effect, Layer, Ref } from "effect"
import { EventStore } from "../event"
import {
  reduceCampaignState,
  CAMPAIGN_STATE_MACHINE,
  type CampaignState,
  type RuntimeEvent as SMRuntimeEvent,
} from "./state-machine"
import type { LaneState, CampaignState as CampaignPhase } from "./types"

// ── Projection Types ──────────────────────────────────────

export interface ProjectedLane {
  readonly laneId: string
  readonly scope: string
  readonly currentState: LaneState
  readonly eventCount: number
  readonly transitionCount: number
}

export interface CampaignStateProjection {
  readonly campaignId: string
  readonly phase: CampaignPhase
  readonly smState: CampaignState
  readonly lanes: readonly ProjectedLane[]
  readonly totalEvents: number
  readonly projectedAt: number
}

// ── Interface ──────────────────────────────────────────────

export interface Interface {
  /** Project campaign events into a materialized state. */
  readonly project: (
    campaignId: string,
    events: readonly SMRuntimeEvent[],
  ) => Effect.Effect<CampaignStateProjection>

  /** Get or build the projection for a campaign from EventStore. */
  readonly getProjection: (campaignId: string) => Effect.Effect<CampaignStateProjection>
}

export class CampaignProjector extends Context.Service<CampaignProjector, Interface>()("CampaignProjector") {}

// ── Implementation ─────────────────────────────────────────

const make = Effect.gen(function* () {
  const eventStore = yield* EventStore.Service
  const cache = yield* Ref.make<Map<string, CampaignStateProjection>>(new Map())

  /** Build a CampaignStateProjection from campaign events. */
  const project = Effect.fn("CampaignProjector.project")(function* (
    campaignId: string,
    events: readonly SMRuntimeEvent[],
  ) {
    const initialState: CampaignState = {
      currentState: "created",
      events: [],
      transitionCount: 0,
      stateHistory: [],
      metadata: {},
      retryBudgets: {},
    }

    const smState = reduceCampaignState(initialState, events, CAMPAIGN_STATE_MACHINE)

    // Collect lane IDs from event metadata
    const laneIds = [
      ...new Set(
        events
          .filter((e) => e.payload?.laneId != null)
          .map((e) => String(e.payload!.laneId)),
      ),
    ]

    const lanes: ProjectedLane[] = laneIds.map((id) => {
      const laneEvents = events.filter((e) => e.payload?.laneId === id)
      return {
        laneId: id,
        scope: String(
          laneEvents[laneEvents.length - 1]?.payload?.scope ?? "",
        ),
        currentState: "created" as LaneState,
        eventCount: laneEvents.length,
        transitionCount: laneEvents.length,
      }
    })

    const projection: CampaignStateProjection = {
      campaignId,
      phase: smState.currentState as CampaignPhase,
      smState,
      lanes,
      totalEvents: events.length,
      projectedAt: Date.now(),
    }

    return projection
  })

  /** Load events from EventStore and build projection. */
  const getProjection = Effect.fn("CampaignProjector.getProjection")(function* (
    campaignId: string,
  ) {
    // Check cache first
    const cached = yield* Ref.get(cache)
    const existing = cached.get(campaignId)
    if (existing) return existing

    // Query events from store
    const stored = yield* eventStore.query({
      sessionId: campaignId,
      order: "asc",
      limit: 10_000,
    })

    // Convert stored events to SM format
    const smEvents: SMRuntimeEvent[] = stored.map((e) => ({
      type: e.eventType,
      timestamp: e.ts,
      payload: {
        ...(e.payloadJson as Record<string, unknown>),
        laneId: e.laneId,
      },
    }))

    const projection = yield* project(campaignId, smEvents)

    // Cache the result
    yield* Ref.update(cache, (m) => {
      const next = new Map(m)
      next.set(campaignId, projection)
      return next
    })

    return projection
  })

  return { project, getProjection } satisfies Interface
})

export const layer: Layer.Layer<CampaignProjector, never, EventStore.Service> = Layer.effect(
  CampaignProjector,
  make,
)

export * as CampaignProjector from "."
