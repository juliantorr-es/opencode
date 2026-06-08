// ── CampaignEvent Schema Bridge ──────────────────────────────
//
// Maps between campaign-specific event types and the RuntimeEvent
// schema. toRuntimeEvent converts a CampaignEvent into the flat
// RuntimeEvent for EventStore durability. fromRuntimeEvent
// reconstructs a CampaignEvent from a stored RuntimeEvent row.
//
// The CampaignEvent union is the canonical set of typed campaign
// events, mirrored by the event name strings in EventName.
// ──────────────────────────────────────────────────────────────

import { Effect, Schema } from "effect"
import type { RuntimeEvent } from "../event/runtime-event"
import { Identifier } from "../id/id"

// ── Campaign Event Tagged Union ────────────────────────────

export const CampaignEventType = Schema.Literals([
  "campaign.created",
  "campaign.lane.assigned",
  "campaign.lane.completed",
  "campaign.gate.activated",
  "campaign.gate.passed",
  "campaign.gate.failed",
  "campaign.artifact.produced",
  "campaign.review.initiated",
  "campaign.review.completed",
  "campaign.push.initiated",
  "campaign.push.completed",
  "campaign.push.failed",
  "campaign.push.evidence.collected",
  "campaign.push.evidence.missing",
  "campaign.publication.submitted",
  "campaign.publication.admitted",
  "campaign.publication.blocked",
  "campaign.checkpoint.created",
])
export type CampaignEventType = typeof CampaignEventType.Type

export const CampaignEventPayload = Schema.Struct({
  eventType: CampaignEventType,
  campaignId: Schema.String,
  laneId: Schema.optional(Schema.String),
  role: Schema.optional(Schema.String),
  data: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  ts: Schema.String,
})
export type CampaignEventPayload = typeof CampaignEventPayload.Type

// ── Converters ─────────────────────────────────────────────

/**
 * Convert a CampaignEventPayload into a full RuntimeEvent for
 * EventStore persistence. Generates a new event ID.
 */
export function toRuntimeEvent(
  campaignId: string,
  event: Omit<CampaignEventPayload, "campaignId" | "ts">,
): RuntimeEvent {
  return {
    id: Effect.runSync(Identifier.ascending("event")),
    sessionId: campaignId,
    runId: event.laneId ?? campaignId,
    parentEventId: undefined,
    correlationId: undefined,
    ts: new Date().toISOString(),
    actor: "lifecycle",
    eventType: event.eventType,
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
    payloadJson: event.data,
    campaignId,
    laneId: event.laneId,
    role: event.role,
  }
}

/**
 * Attempt to reconstruct a CampaignEventPayload from a stored
 * RuntimeEvent. Returns null if the event is not a campaign event.
 */
export function fromRuntimeEvent(event: RuntimeEvent): CampaignEventPayload | null {
  if (!event.campaignId || !event.eventType.startsWith("campaign.")) return null

  return {
    eventType: event.eventType as CampaignEventType,
    campaignId: event.campaignId,
    laneId: event.laneId,
    role: event.role,
    data: event.payloadJson as Record<string, unknown> | undefined,
    ts: event.ts,
  }
}

export * as CampaignEvent from "."
