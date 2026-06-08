import { Schema } from "effect"

// ── Literal Union Types ─────────────────────────────────────
// These define the legal states for lanes, campaigns, roles,
// transitions, and terminal dispositions.

export const LaneState = Schema.Literals([
  "created",
  "scouting",
  "scoping",
  "scoped",
  "planning",
  "critic_review",
  "approved",
  "executing",
  "validating",
  "red_team",
  "repairing",
  "historian",
  "checkpointed",
  "returned",
  "blocked",
  "failed",
])
export type LaneState = typeof LaneState.Type

export const CampaignState = Schema.Literals([
  "created",
  "scouting",
  "scope_synthesis",
  "lane_decomposition",
  "lane_dispatch",
  "waiting_for_lanes",
  "integration_review",
  "final_validation",
  "push_ready",
  "pushed",
  "blocked",
  "failed",
])
export type CampaignState = typeof CampaignState.Type

export const TerminalStatus = Schema.Literals([
  "completed_validated",
  "completed_unvalidated",
  "completed_with_warnings",
  "blocked_needs_user",
  "blocked_scope_conflict",
  "blocked_tool_unavailable",
  "failed_internal_error",
  "stopped_by_user",
  "superseded",
])
export type TerminalStatus = typeof TerminalStatus.Type

export const RoleType = Schema.Literals([
  "scout",
  "architect",
  "critic",
  "executor",
  "validator",
  "redteam",
  "repair",
  "historian",
  "auditor",
  "integrator",
])
export type RoleType = typeof RoleType.Type

export const ProposedBy = Schema.Literals([
  "agent",
  "secretary",
  "orchestrator",
  "predicate",
])
export type ProposedBy = typeof ProposedBy.Type

// ── Supporting Value Objects ────────────────────────────────

export const EvidenceRef = Schema.Struct({
  eventType: Schema.String,
  eventId: Schema.String,
  description: Schema.String,
  digest: Schema.optional(Schema.String),
}).annotate({ identifier: "EvidenceRef" })
export type EvidenceRef = typeof EvidenceRef.Type

export const RuntimeEvent = Schema.Struct({
  type: Schema.String,
  timestamp: Schema.Number,
  data: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
}).annotate({ identifier: "RuntimeEvent" })
export type RuntimeEvent = typeof RuntimeEvent.Type

// ── Transition ──────────────────────────────────────────────

export const Transition = Schema.Struct({
  from: LaneState,
  to: LaneState,
  reason: Schema.String,
  evidence: Schema.Array(EvidenceRef),
  proposedBy: ProposedBy,
  decidedAt: Schema.Number,
}).annotate({ identifier: "Transition" })
export type Transition = typeof Transition.Type

// ── Role ────────────────────────────────────────────────────

export const Role = Schema.Struct({
  type: RoleType,
  instanceId: Schema.String,
  contractId: Schema.String,
  input: Schema.String,
  output: Schema.String,
  status: Schema.String,
  startedAt: Schema.Number,
  completedAt: Schema.optional(Schema.Number),
}).annotate({ identifier: "Role" })
export type Role = typeof Role.Type

// ── Binder ──────────────────────────────────────────────────
// The Binder is the lane's persistent state record — it carries
// every artifact produced across the lane lifecycle.

export const Binder = Schema.Struct({
  missionObjective: Schema.String,
  laneScope: Schema.String,
  claims: Schema.Array(Schema.String),
  scoutReports: Schema.Array(Schema.String),
  architecturePlan: Schema.String,
  criticReviews: Schema.Array(Schema.String),
  approvedPlan: Schema.String,
  executionEvents: Schema.Array(RuntimeEvent),
  diffSummary: Schema.String,
  validationResults: Schema.Array(Schema.String),
  redTeamFindings: Schema.Array(Schema.String),
  repairHistory: Schema.Array(Schema.String),
  checkpointCommit: Schema.optional(Schema.String),
  residualRisks: Schema.Array(Schema.String),
  handoffSummary: Schema.String,
  binderVersion: Schema.Number,
  schemaVersion: Schema.String,
}).annotate({ identifier: "Binder" })
export type Binder = typeof Binder.Type

// ── Lane ────────────────────────────────────────────────────
// A lane is a single unit of work within a campaign.

export const Lane = Schema.Struct({
  id: Schema.String,
  campaignId: Schema.String,
  scope: Schema.String,
  claimedFiles: Schema.Array(Schema.String),
  dependencyIds: Schema.Array(Schema.String),
  stateMachineSpec: Schema.String,
  currentState: LaneState,
  secretaryId: Schema.String,
  roleInstances: Schema.Array(Role),
  binder: Binder,
  status: LaneState,
  createdAt: Schema.Number,
  completedAt: Schema.optional(Schema.Number),
}).annotate({ identifier: "Lane" })
export type Lane = typeof Lane.Type

// ── Campaign ────────────────────────────────────────────────
// A campaign orchestrates multiple lanes toward a unified goal.

export const Campaign = Schema.Struct({
  id: Schema.String,
  goal: Schema.String,
  phase: CampaignState,
  lanes: Schema.Array(Lane),
  authorityContract: Schema.String,
  contextPacketBuilder: Schema.String,
  budgets: Schema.Record(Schema.String, Schema.Number),
  checkpoints: Schema.Array(Schema.String),
  terminalStatus: Schema.optional(TerminalStatus),
}).annotate({ identifier: "Campaign" })
export type Campaign = typeof Campaign.Type
