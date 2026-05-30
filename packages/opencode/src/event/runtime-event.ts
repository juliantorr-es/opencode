import { Schema } from "effect"

export const ActorType = Schema.Literals(["user", "assistant", "tool", "system", "lifecycle"])
export type ActorType = Schema.Schema.Type<typeof ActorType>

export const EventStatus = Schema.Literals(["started", "succeeded", "failed", "denied", "cancelled", "recovered"])
export type EventStatus = Schema.Schema.Type<typeof EventStatus>

export const RuntimeEvent = Schema.Struct({
  id: Schema.String,
  sessionId: Schema.String,
  runId: Schema.String,
  parentEventId: Schema.optional(Schema.String),
  correlationId: Schema.optional(Schema.String),
  ts: Schema.String,
  actor: ActorType,
  eventType: Schema.String,
  phase: Schema.optional(Schema.String),
  status: Schema.optional(EventStatus),
  toolName: Schema.optional(Schema.String),
  filePath: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  durationMs: Schema.optional(Schema.Number),
  tokenInput: Schema.optional(Schema.Number),
  tokenOutput: Schema.optional(Schema.Number),
  errorCode: Schema.optional(Schema.String),
  errorMessage: Schema.optional(Schema.String),
  recoverable: Schema.optional(Schema.Boolean),
  payloadJson: Schema.optional(Schema.Unknown),
  campaignId: Schema.optional(Schema.String),
  laneId: Schema.optional(Schema.String),
  role: Schema.optional(Schema.String),
})
export type RuntimeEvent = Schema.Schema.Type<typeof RuntimeEvent>
