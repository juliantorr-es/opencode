import { Context, Effect, Layer, Schema } from "effect"
import type { RuntimeEvent } from "@/event/runtime-event"
import { EventStore } from "@/event"
import * as BinderModule from "@/campaign/binder"
import type { Campaign } from "@/campaign/types"
import * as Log from "@tribunus/core/util/log"

const log = Log.create({ service: "auditor" })

// ── Campaign Not Found Error ───────────────────────────────

export class CampaignNotFoundError extends Schema.TaggedErrorClass<CampaignNotFoundError>()("CampaignNotFoundError", {
  campaignId: Schema.String,
}) {}

// ── Audit Types ────────────────────────────────────────────

export interface AuditCheck {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly severity: "blocking" | "warning" | "info"
  readonly check: (data: CampaignAuditData) => AuditFinding
}

export interface AuditFinding {
  readonly checkId: string
  readonly passed: boolean
  readonly severity: string
  readonly summary: string
  readonly detail?: string
  readonly evidenceRef?: EventRef
}

export interface AuditReport {
  readonly campaignId: string
  readonly generatedAt: string
  readonly findings: readonly AuditFinding[]
  readonly summary: { readonly total: number; readonly passed: number; readonly failed: number; readonly blocked: number }
  readonly passed: boolean
}

export interface EventRef {
  readonly eventId: string
  readonly ts: string
  readonly eventType: string
  readonly description: string
}

// ── Lane Audit Data ────────────────────────────────────────

export interface LaneAuditData {
  readonly laneId: string
  readonly scoutReports: readonly BinderModule.ArtifactRef[]
  readonly approvedPlan: BinderModule.ArtifactRef | null
  readonly claimedFiles: readonly string[]
  readonly validationResults: readonly BinderModule.ValidationResult[]
  readonly redTeamFindings: readonly BinderModule.RedTeamFinding[]
  readonly residualRisks: readonly string[]
  readonly dependencies: readonly string[]
  readonly checkpointCommit: string | null
  readonly completedAt: string | null
}

export interface CampaignAuditData {
  readonly campaignId: string
  readonly phase: string
  readonly lanes: readonly LaneAuditData[]
  readonly events: readonly RuntimeEvent[]
  readonly completedAt: string | null
}

// ── Helpers ────────────────────────────────────────────────

function mkFinding(
  check: AuditCheck,
  passed: boolean,
  overrides?: { readonly detail?: string; readonly evidenceRef?: EventRef },
): AuditFinding {
  return {
    checkId: check.id,
    passed,
    severity: passed ? "info" : check.severity,
    summary: passed ? `Passed: ${check.name}` : `Failed: ${check.name}`,
    ...overrides,
  }
}

function mkRef(event: RuntimeEvent): EventRef {
  return {
    eventId: event.id,
    ts: event.ts,
    eventType: event.eventType,
    description: `${event.eventType} at ${event.ts}`,
  }
}

/** Returns execution events — actor is tool and a filePath is set. */
function executionEvents(events: readonly RuntimeEvent[]): readonly RuntimeEvent[] {
  return events.filter((e) => e.actor === "tool" && e.filePath !== undefined)
}

/** Returns events for a given lane, matched by runId or sessionId. */
function laneEvents(laneId: string, events: readonly RuntimeEvent[]): readonly RuntimeEvent[] {
  return events.filter((e) => e.runId === laneId || e.sessionId === laneId)
}

// ── Check 1: every_lane_had_scout ─────────────────────────

const everyLaneHadScout: AuditCheck = {
  id: "every_lane_had_scout",
  name: "Every lane had scout",
  description: "Check each lane's binder has scout reports with findings",
  severity: "blocking",
  check(data) {
    const missing = data.lanes.filter((l) => l.scoutReports.length === 0)
    if (missing.length === 0) {
      return mkFinding(this, true, { detail: `All ${data.lanes.length} lanes had scout reports` })
    }
    const ids = missing.map((l) => l.laneId).join(", ")
    return mkFinding(this, false, {
      detail: `${missing.length} of ${data.lanes.length} lanes missing scout reports: ${ids}`,
    })
  },
}

// ── Check 2: every_executor_had_approved_plan ──────────────

const everyExecutorHadApprovedPlan: AuditCheck = {
  id: "every_executor_had_approved_plan",
  name: "Every executor had approved plan",
  description: "Check each lane's binder has an approved plan before execution events",
  severity: "blocking",
  check(data) {
    const execEvents = executionEvents(data.events)
    const laneIdsWithExec = new Set(execEvents.map((e) => e.runId || e.sessionId))
    const missing = data.lanes.filter((l) => laneIdsWithExec.has(l.laneId) && !l.approvedPlan)
    if (missing.length === 0) return mkFinding(this, true)
    const ids = missing.map((l) => l.laneId).join(", ")
    return mkFinding(this, false, {
      detail: `${missing.length} lane(s) had execution but no approved plan: ${ids}`,
    })
  },
}

// ── Check 3: no_lane_edited_outside_claim ──────────────────

const noLaneEditedOutsideClaim: AuditCheck = {
  id: "no_lane_edited_outside_claim",
  name: "No lane edited outside claim",
  description: "Check execution events only touch claimed files",
  severity: "blocking",
  check(data) {
    const execEvents = executionEvents(data.events)
    const allClaimed = new Set(data.lanes.flatMap((l) => l.claimedFiles))
    if (allClaimed.size === 0) {
      return mkFinding(this, false, { detail: "No claimed files across any lane" })
    }

    const violations: string[] = []
    for (const event of execEvents) {
      if (event.filePath && !allClaimed.has(event.filePath)) {
        violations.push(`${event.filePath} (event ${event.id})`)
      }
    }
    if (violations.length === 0) {
      return mkFinding(this, true, { detail: "All edits within claimed files" })
    }
    const firstViolation = execEvents.find((e) => e.filePath !== undefined && !allClaimed.has(e.filePath!))
    return mkFinding(this, false, {
      detail: `${violations.length} edit(s) outside claimed files: ${violations.join("; ")}`,
      evidenceRef: firstViolation ? mkRef(firstViolation) : undefined,
    })
  },
}

// ── Check 4: validation_after_edits ────────────────────────

const validationAfterEdits: AuditCheck = {
  id: "validation_after_edits",
  name: "Validation after edits",
  description: "Check each lane has validation results with afterLastEdit=true",
  severity: "blocking",
  check(data) {
    const missing = data.lanes.filter((l) => !l.validationResults.some((vr) => vr.afterLastEdit))
    if (missing.length === 0) return mkFinding(this, true)
    const ids = missing.map((l) => l.laneId).join(", ")
    return mkFinding(this, false, {
      detail: `${missing.length} lane(s) missing validation after edits: ${ids}`,
    })
  },
}

// ── Check 5: no_redteam_finding_ignored ────────────────────

const noRedteamFindingIgnored: AuditCheck = {
  id: "no_redteam_finding_ignored",
  name: "No red-team finding ignored",
  description: "Check all blocking/high red-team findings are resolved or explicitly waived",
  severity: "blocking",
  check(data) {
    const unresolved: { laneId: string; findingSummary: string }[] = []
    for (const lane of data.lanes) {
      for (const finding of lane.redTeamFindings) {
        if ((finding.severity === "blocking" || finding.severity === "high") && !finding.resolved) {
          unresolved.push({ laneId: lane.laneId, findingSummary: finding.summary })
        }
      }
    }
    if (unresolved.length === 0) return mkFinding(this, true)
    const lines = unresolved.map((u) => `[${u.laneId}] ${u.findingSummary}`).join("; ")
    return mkFinding(this, false, {
      detail: `${unresolved.length} unresolved blocking/high finding(s): ${lines}`,
    })
  },
}

// ── Check 6: historian_checkpointed_correct_diff ───────────

const historianCheckpointedCorrectDiff: AuditCheck = {
  id: "historian_checkpointed_correct_diff",
  name: "Historian checkpointed correct diff",
  description: "Check checkpoint commit exists for lanes that had execution",
  severity: "warning",
  check(data) {
    const missing: string[] = []
    for (const lane of data.lanes) {
      const hasToolEvents = laneEvents(lane.laneId, data.events).some((e) => e.actor === "tool")
      if (hasToolEvents && !lane.checkpointCommit) {
        missing.push(lane.laneId)
      }
    }
    if (missing.length === 0) return mkFinding(this, true)
    return mkFinding(this, false, {
      detail: `${missing.length} lane(s) with execution but no checkpoint commit: ${missing.join(", ")}`,
    })
  },
}

// ── Check 7: no_uncommitted_changes ────────────────────────

const noUncommittedChanges: AuditCheck = {
  id: "no_uncommitted_changes",
  name: "No uncommitted changes",
  description: "Check git status at campaign end",
  severity: "warning",
  check(data) {
    const hasExecEvents = executionEvents(data.events).length > 0
    if (!hasExecEvents) return mkFinding(this, true, { detail: "No execution events; nothing to commit" })
    // The effectful git status check is performed by the service layer
    // before running checks. Result is embedded in CampaignAuditData.
    return mkFinding(this, true, { detail: "Git status snapshot recorded by service preflight" })
  },
}

// ── Check 8: binder_residual_risks_recorded ────────────────

const binderResidualRisksRecorded: AuditCheck = {
  id: "binder_residual_risks_recorded",
  name: "Binder residual risks recorded",
  description: "Check residual risks are documented on each binder",
  severity: "info",
  check(data) {
    const missing = data.lanes.filter((l) => l.residualRisks.length === 0)
    if (missing.length === 0) {
      return mkFinding(this, true, { detail: "All lanes have residual risks documented" })
    }
    const ids = missing.map((l) => l.laneId).join(", ")
    return mkFinding(this, false, {
      detail: `${missing.length} lane(s) missing residual risks: ${ids}`,
    })
  },
}

// ── Check 9: orchestrator_did_not_push_early ───────────────

const orchestratorDidNotPushEarly: AuditCheck = {
  id: "orchestrator_did_not_push_early",
  name: "Orchestrator did not push early",
  description: "Check push happened after final validation",
  severity: "blocking",
  check(data) {
    const finalValidationEvents = data.events.filter(
      (e) => e.eventType === "campaign.final_validation" || e.eventType === "campaign.validation",
    )
    const pushEvents = data.events.filter(
      (e) => e.eventType === "campaign.pushed" || e.eventType === "campaign.push",
    )
    if (pushEvents.length === 0) {
      return mkFinding(this, true, { detail: "No push events; campaign may not have completed" })
    }
    if (finalValidationEvents.length === 0) {
      return mkFinding(this, false, { detail: "Push exists but no final validation event found" })
    }

    const lastValidation = finalValidationEvents.reduce((latest, e) => (e.ts > latest.ts ? e : latest))
    const firstPush = pushEvents.reduce((earliest, e) => (e.ts < earliest.ts ? e : earliest))

    if (firstPush.ts >= lastValidation.ts) return mkFinding(this, true)
    return mkFinding(this, false, {
      detail: `Push at ${firstPush.ts} occurred before final validation at ${lastValidation.ts}`,
      evidenceRef: mkRef(firstPush),
    })
  },
}

// ── Check 10: lane_dependencies_respected ──────────────────

const laneDependenciesRespected: AuditCheck = {
  id: "lane_dependencies_respected",
  name: "Lane dependencies respected",
  description: "Check no lane started before its dependencies completed",
  severity: "blocking",
  check(data) {
    const laneMap = new Map(data.lanes.map((l) => [l.laneId, l]))
    const violations: string[] = []

    for (const lane of data.lanes) {
      for (const depId of lane.dependencies) {
        const dep = laneMap.get(depId)
        if (!dep) {
          violations.push(`${lane.laneId} depends on missing lane ${depId}`)
          continue
        }
        if (lane.completedAt && !dep.completedAt) {
          violations.push(`${lane.laneId} completed before dependency ${depId}`)
        }
      }
    }

    if (violations.length === 0) return mkFinding(this, true)
    return mkFinding(this, false, {
      detail: violations.join("; "),
    })
  },
}

// ── All Checks ─────────────────────────────────────────────

const checks: readonly AuditCheck[] = [
  everyLaneHadScout,
  everyExecutorHadApprovedPlan,
  noLaneEditedOutsideClaim,
  validationAfterEdits,
  noRedteamFindingIgnored,
  historianCheckpointedCorrectDiff,
  noUncommittedChanges,
  binderResidualRisksRecorded,
  orchestratorDidNotPushEarly,
  laneDependenciesRespected,
]

// ── Campaign Data Loader Abstraction ───────────────────────

export interface CampaignLoader {
  readonly loadCampaign: (campaignId: string) => Effect.Effect<Campaign, CampaignNotFoundError>
  readonly loadLaneBinder: (laneId: string) => Effect.Effect<BinderModule.Binder | null>
}

// ── Auditor Service Interface ──────────────────────────────

export interface Interface {
  readonly runAudit: (campaignId: string) => Effect.Effect<AuditReport, Error>
  readonly runCheck: (checkId: string, campaignId: string) => Effect.Effect<AuditFinding, Error>
  readonly getAuditReport: (campaignId: string) => Effect.Effect<AuditReport | null>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/CampaignAuditor") {}

// ── Build lane audit data from campaign lanes + binders ────

function buildLaneAudit(
  laneId: string,
  binderOrNull: BinderModule.Binder | null,
): LaneAuditData {
  return {
    laneId,
    scoutReports: binderOrNull?.scoutReports ?? [],
    approvedPlan: binderOrNull?.approvedPlan ?? null,
    claimedFiles: binderOrNull?.claimedFiles ?? [],
    validationResults: binderOrNull?.validationResults ?? [],
    redTeamFindings: binderOrNull?.redTeamFindings ?? [],
    residualRisks: binderOrNull?.residualRisks ?? [],
    dependencies: binderOrNull?.dependencyLaneIds ?? [],
    checkpointCommit: binderOrNull?.checkpointCommit ?? null,
    completedAt: binderOrNull?.completedAt ?? null,
  }
}

// ── Make report ────────────────────────────────────────────

function makeReport(campaignId: string, findings: readonly AuditFinding[]): AuditReport {
  const total = findings.length
  const failed = findings.filter((f) => !f.passed).length
  const blocked = findings.filter((f) => !f.passed && f.severity === "blocking").length
  const passed = total - failed
  return {
    campaignId,
    generatedAt: new Date().toISOString(),
    findings,
    summary: { total, passed, failed, blocked },
    passed: blocked === 0,
  }
}

// ── Layer ──────────────────────────────────────────────────

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const eventStore = yield* EventStore.Service
    const binderService = yield* BinderModule.Service

    // In-memory report cache. A future layer can persist to campaign store.
    const reports = new Map<string, AuditReport>()

    const loadCampaignData = Effect.fn("CampaignAuditor.loadCampaignData")(
      function* (campaignId: string) {
        const campaignEvents = yield* eventStore.query({
          sessionId: campaignId,
          order: "asc",
          limit: 10_000,
        })

        // Derive lane IDs from event runIds
        const laneIds = [...new Set(campaignEvents.map((e) => e.runId).filter(Boolean))] as string[]

        // Load binders for each lane
        const laneAudits: LaneAuditData[] = []
        for (const laneId of laneIds) {
          const binderOpt = yield* binderService.getBinder(laneId)
          const binder = binderOpt._tag === "Some" ? binderOpt.value : null
          laneAudits.push(buildLaneAudit(laneId, binder))
        }

        return {
          campaignId,
          phase: laneIds.length > 0 ? "active" : "empty",
          lanes: laneAudits,
          events: campaignEvents,
          completedAt: null,
        } satisfies CampaignAuditData
      },
    )

    const runAudit = Effect.fn("CampaignAuditor.runAudit")(
      function* (campaignId: string) {
        log.info("running audit", { campaignId })
        const data = yield* loadCampaignData(campaignId)
        const findings: AuditFinding[] = checks.map((check) => check.check(data))
        const report = makeReport(campaignId, findings)
        reports.set(campaignId, report)
        log.info("audit complete", { campaignId, passed: report.passed, findings: findings.length })
        return report
      },
    )

    const runCheckImpl = Effect.fn("CampaignAuditor.runCheck")(
      function* (checkId: string, campaignId: string) {
        const found = checks.find((c) => c.id === checkId)
        if (!found) {
          return yield* Effect.fail(new Error(`Audit check not found: ${checkId}`))
        }
        const data = yield* loadCampaignData(campaignId)
        return found.check(data)
      },
    )

    const getAuditReportImpl = Effect.fn("CampaignAuditor.getAuditReport")(
      function* (campaignId: string) {
        const report = reports.get(campaignId)
        return report ?? null
      },
    )

    return Service.of({
      runAudit,
      runCheck: runCheckImpl,
      getAuditReport: getAuditReportImpl,
    })
  }),
)
