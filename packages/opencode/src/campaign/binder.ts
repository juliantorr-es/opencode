import { Context, Effect, Layer, Option, Ref } from "effect"
import { createHash } from "node:crypto"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { EventStore } from "@/event"
import { Identifier } from "@/id/id"
import * as Log from "@opencode-ai/core/util/log"

const log = Log.create({ service: "binder" })

// ── Schema Version ────────────────────────────────────────

const SCHEMA_VERSION = "v1"
const BINDER_VERSION = 1

// ── Types (extending SM-001 types) ────────────────────────

export type LaneState =
  | "created"
  | "scouting"
  | "scoped"
  | "planning"
  | "critic_review"
  | "approved"
  | "executing"
  | "validating"
  | "red_team"
  | "repairing"
  | "historian"
  | "checkpointed"
  | "returned"

export type TerminalStatus =
  | "success"
  | "failure"
  | "blocked"
  | "cancelled"
  | "frozen"

export interface ArtifactRef {
  type: string
  path: string
  summary: string
  contentDigest: string
}

export interface EventRef {
  eventId: string
  eventType: string
  ts: string
  summary: string
}

export interface DiffSummary {
  filesCreated: string[]
  filesModified: string[]
  filesDeleted: string[]
  netLines: number
  perPackage: Record<string, { added: number; removed: number }>
}

export interface ValidationResult {
  tool: string
  status: string
  failures: { name: string; file?: string; line?: number; message: string }[]
  durationMs: number
  afterLastEdit: boolean
}

export interface RedTeamFinding {
  severity: "blocking" | "high" | "medium" | "low" | "info"
  summary: string
  evidence: EventRef
  resolved: boolean
  resolution?: string
}

export interface RepairCycle {
  attempt: number
  finding: string
  appliedFix: string
  result: "success" | "failure"
}

export interface Binder {
  schemaVersion: string
  binderVersion: number
  laneId: string
  campaignId: string
  status: LaneState

  // Mission
  missionObjective: string
  laneScope: string
  claimedFiles: string[]
  dependencyLaneIds: string[]

  // Evidence chain
  scoutReports: ArtifactRef[]
  architecturePlan?: ArtifactRef
  criticReviews: ArtifactRef[]
  approvedPlan?: ArtifactRef

  // Execution
  executionEvents: EventRef[]
  diffSummary?: DiffSummary

  // Validation
  validationResults: ValidationResult[]
  redTeamFindings: RedTeamFinding[]
  repairHistory: RepairCycle[]

  // Closure
  checkpointCommit?: string
  residualRisks: string[]
  handoffSummary?: string
  terminalStatus?: TerminalStatus

  // Metadata
  createdAt: string
  completedAt?: string
  artifactDigest: string
}

// ── Error ─────────────────────────────────────────────────

export class BinderError extends Error {
  readonly _tag = "BinderError"
  constructor(message: string) {
    super(message)
    this.name = "BinderError"
  }
}

// ── Service Interface ─────────────────────────────────────

export interface Interface {
  readonly createBinder: (
    laneId: string,
    campaignId: string,
    mission: string,
    scope: string,
  ) => Effect.Effect<string>

  readonly getBinder: (laneId: string) => Effect.Effect<Option.Option<Binder>>

  readonly getBindersByCampaignId: (campaignId: string) => Effect.Effect<Binder[]>

  readonly addEvidence: (
    laneId: string,
    section: string,
    artifact: ArtifactRef | EventRef,
  ) => Effect.Effect<void, BinderError>

  readonly updateStatus: (
    laneId: string,
    status: LaneState,
    terminalStatus?: TerminalStatus,
  ) => Effect.Effect<void, BinderError>

  readonly finalizeBinder: (laneId: string) => Effect.Effect<Binder, BinderError>

  readonly getBinderDigest: (laneId: string) => Effect.Effect<string, BinderError>
}

// ── Service Tag ───────────────────────────────────────────

export class Service extends Context.Service<Service, Interface>()("@opencode/BinderService") {}

export const use = serviceUse(Service)

// ── Helpers ───────────────────────────────────────────────

function computeDigest(binder: Binder): string {
  const hash = createHash("sha256")
  const evidencePayload = {
    scoutReports: binder.scoutReports,
    architecturePlan: binder.architecturePlan,
    criticReviews: binder.criticReviews,
    approvedPlan: binder.approvedPlan,
    executionEvents: binder.executionEvents,
    diffSummary: binder.diffSummary,
    validationResults: binder.validationResults,
    redTeamFindings: binder.redTeamFindings,
    repairHistory: binder.repairHistory,
    checkpointCommit: binder.checkpointCommit,
    residualRisks: binder.residualRisks,
    handoffSummary: binder.handoffSummary,
    terminalStatus: binder.terminalStatus,
    status: binder.status,
  }
  hash.update(JSON.stringify(evidencePayload))
  return hash.digest("hex")
}

function createInitialBinder(
  laneId: string,
  campaignId: string,
  mission: string,
  scope: string,
): Binder {
  const now = new Date().toISOString()
  const binder: Binder = {
    schemaVersion: SCHEMA_VERSION,
    binderVersion: BINDER_VERSION,
    laneId,
    campaignId,
    status: "created",

    missionObjective: mission,
    laneScope: scope,
    claimedFiles: [],
    dependencyLaneIds: [],

    scoutReports: [],
    criticReviews: [],
    executionEvents: [],
    validationResults: [],
    redTeamFindings: [],
    repairHistory: [],
    residualRisks: [],

    createdAt: now,
    artifactDigest: "",
  }
  binder.artifactDigest = computeDigest(binder)
  return binder
}

function recordBinderEvent(
  eventStore: EventStore.Interface,
  eventType: string,
  laneId: string,
  payload: Record<string, unknown>,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    yield* eventStore.record({
      id: Effect.runSync(Identifier.ascending("event")),
      sessionId: laneId,
      runId: laneId,
      ts: new Date().toISOString(),
      actor: "system" as const,
      eventType,
      phase: "campaign",
      toolName: "binder",
      filePath: undefined,
      model: undefined,
      durationMs: undefined,
      tokenInput: undefined,
      tokenOutput: undefined,
      errorCode: undefined,
      errorMessage: undefined,
      recoverable: undefined,
      parentEventId: undefined,
      correlationId: undefined,
      status: undefined,
      payloadJson: payload,
    })
  })
}

// ── Implementation ────────────────────────────────────────

const make = Effect.gen(function* () {
  const store = yield* Ref.make<Map<string, Binder>>(new Map())
  const eventStore = yield* EventStore.Service

  const createBinder = Effect.fn("Binder.createBinder")(function* (
    laneId: string,
    campaignId: string,
    mission: string,
    scope: string,
  ) {
    const existing = yield* Ref.get(store)
    if (existing.has(laneId)) {
      log.warn("binder already exists", { laneId })
      return laneId
    }

    const binder = createInitialBinder(laneId, campaignId, mission, scope)
    yield* Ref.update(store, (map) => {
      map.set(laneId, binder)
      return map
    })
    yield* recordBinderEvent(eventStore, "binder.created", laneId, {
      laneId,
      campaignId,
    })
    log.info("created binder", { laneId })
    return laneId
  })

  const getBinder = Effect.fn("Binder.getBinder")(function* (laneId: string) {
    const map = yield* Ref.get(store)
    const binder = map.get(laneId)
    if (binder) return Option.some(binder)
    return Option.none<Binder>()
  })

  const getBindersByCampaignId = Effect.fn("Binder.getBindersByCampaignId")(function* (campaignId: string) {
    const map = yield* Ref.get(store)
    const all = Array.from(map.values())
    return all.filter((b) => b.campaignId === campaignId)
  })

  const addEvidence = Effect.fn("Binder.addEvidence")(function* (
    laneId: string,
    section: string,
    artifact: ArtifactRef | EventRef,
  ) {
    const map = yield* Ref.get(store)
    const binder = map.get(laneId)
    if (!binder) {
      return yield* Effect.fail(new BinderError(`Binder not found for lane: ${laneId}`))
    }

    const updated: Binder = { ...binder }

    switch (section) {
      case "scoutReports":
        updated.scoutReports = [...binder.scoutReports, artifact as ArtifactRef]
        break
      case "architecturePlan":
        updated.architecturePlan = artifact as ArtifactRef
        break
      case "criticReviews":
        updated.criticReviews = [...binder.criticReviews, artifact as ArtifactRef]
        break
      case "approvedPlan":
        updated.approvedPlan = artifact as ArtifactRef
        break
      case "executionEvents":
        updated.executionEvents = [...binder.executionEvents, artifact as EventRef]
        break
      case "diffSummary":
        updated.diffSummary = artifact as unknown as DiffSummary
        break
      case "validationResults":
        updated.validationResults = [
          ...binder.validationResults,
          artifact as unknown as ValidationResult,
        ]
        break
      case "redTeamFindings":
        updated.redTeamFindings = [
          ...binder.redTeamFindings,
          artifact as unknown as RedTeamFinding,
        ]
        break
      case "repairHistory":
        updated.repairHistory = [...binder.repairHistory, artifact as unknown as RepairCycle]
        break
      case "residualRisks": {
        const riskSummary = "summary" in artifact ? artifact.summary : JSON.stringify(artifact)
        updated.residualRisks = [...binder.residualRisks, riskSummary]
        break
      }
      case "handoffSummary":
        updated.handoffSummary = "summary" in artifact ? artifact.summary : JSON.stringify(artifact)
        break
      default:
        return yield* Effect.fail(new BinderError(`Unknown evidence section: ${section}`))
    }

    updated.artifactDigest = computeDigest(updated)

    yield* Ref.update(store, (map) => {
      map.set(laneId, updated)
      return map
    })
    yield* recordBinderEvent(eventStore, "binder.evidence_added", laneId, { laneId, section })
  })

  const updateStatus = Effect.fn("Binder.updateStatus")(function* (
    laneId: string,
    status: LaneState,
    terminalStatus?: TerminalStatus,
  ) {
    const map = yield* Ref.get(store)
    const binder = map.get(laneId)
    if (!binder) {
      return yield* Effect.fail(new BinderError(`Binder not found for lane: ${laneId}`))
    }

    const now = new Date().toISOString()
    const updated: Binder = {
      ...binder,
      status,
      ...(terminalStatus !== undefined ? { terminalStatus } : {}),
      ...(status === "checkpointed" || status === "returned"
        ? { completedAt: now }
        : {}),
    }
    updated.artifactDigest = computeDigest(updated)

    yield* Ref.update(store, (map) => {
      map.set(laneId, updated)
      return map
    })
    yield* recordBinderEvent(eventStore, "binder.status_changed", laneId, {
      laneId,
      status,
      terminalStatus,
    })
  })

  const finalizeBinder = Effect.fn("Binder.finalizeBinder")(function* (laneId: string) {
    const map = yield* Ref.get(store)
    const binder = map.get(laneId)
    if (!binder) {
      return yield* Effect.fail(new BinderError(`Binder not found for lane: ${laneId}`))
    }

    const now = new Date().toISOString()
    const updated: Binder = {
      ...binder,
      completedAt: now,
    }
    updated.artifactDigest = computeDigest(updated)

    yield* Ref.update(store, (map) => {
      map.set(laneId, updated)
      return map
    })
    yield* recordBinderEvent(eventStore, "binder.finalized", laneId, {
      laneId,
      digest: updated.artifactDigest,
    })
    log.info("finalized binder", { laneId, digest: updated.artifactDigest })
    return updated
  })

  const getBinderDigest = Effect.fn("Binder.getBinderDigest")(function* (laneId: string) {
    const map = yield* Ref.get(store)
    const binder = map.get(laneId)
    if (!binder) {
      return yield* Effect.fail(new BinderError(`Binder not found for lane: ${laneId}`))
    }
    return binder.artifactDigest
  })

  const service: Interface = {
    createBinder,
    getBinder,
    getBindersByCampaignId,
    addEvidence,
    updateStatus,
    finalizeBinder,
    getBinderDigest,
  }
  return service
})

// ── Layer ─────────────────────────────────────────────────

export const layer: Layer.Layer<Service, never, EventStore.Service> = Layer.effect(Service, make)

export const defaultLayer: Layer.Layer<Service> = layer.pipe(
  Layer.provide(EventStore.layer),
)
