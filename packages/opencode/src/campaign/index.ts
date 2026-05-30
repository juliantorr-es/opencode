// ── Campaign Module ──────────────────────────────────────────
//
// State machine predicates, transition checking, and campaign
// orchestration primitives.
// ──────────────────────────────────────────────────────────────

export * as Campaign from "./types"
export * from "./state-machine"
export * from "./orchestrator"
export * from "./role-contracts"

export type {
  EvidenceRef,
  PredicateResult,
  PredicateContext,
  PredicateSpec,
  PredicateResolver,
  TransitionSpec,
  AgentStateMachineSpec,
} from "./predicates"

export {
  checkPredicate,
  checkTransitions,
  checkPredicateEffect,
  checkTransitionsEffect,
  predicateResolvers,
} from "./predicates"

// ── Auditor ──────────────────────────────────────────────────

export type {
  AuditCheck,
  AuditFinding,
  AuditReport,
  EventRef as AuditorEventRef,
  LaneAuditData,
  CampaignAuditData,
} from "./auditor"
export {
  CampaignNotFoundError,
  Service as AuditorService,
  type Interface as AuditorInterface,
  type CampaignLoader,
} from "./auditor"
export { layer as auditorLayer } from "./auditor"

// ── Push Gate ────────────────────────────────────────────────

export type {
  GateResult,
  PushGate,
  PushGateContext,
} from "./push-gate"
export {
  Service as PushGateService,
  type Interface as PushGateInterface,
  layer as pushGateLayer,
} from "./push-gate"

// ── Process Auditor ─────────────────────────────────────────

export type {
  AuditFinding as ProcessAuditFinding,
  AuditResult as ProcessAuditResult,
} from "./process-auditor"
export {
  ProcessAuditorService,
  type ProcessAuditorInterface,
  layer as processAuditorLayer,
} from "./process-auditor"

// ── Push Record ─────────────────────────────────────────────

export type {
  GateEval,
  PushRecord,
  PushStatus,
  CreatePushRecordInput,
} from "./push-record"
export {
  PushRecordError,
  Service as PushRecordService,
  type Interface as PushRecordInterface,
  layer as pushRecordLayer,
} from "./push-record"
