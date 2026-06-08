import { Context, Effect, Schema, Layer } from "effect"
import * as Option from "effect/Option"
import * as Log from "@tribunus/core/util/log"
import { serviceUse } from "@tribunus/core/effect/service-use"
import { Service as BinderService, defaultLayer as BinderDefaultLayer } from "./binder"
import type { Binder as BinderBinder } from "./binder"

const log = Log.create({ service: "campaign-integrator" })

// ── Supporting Types ──────────────────────────────────────

export interface EventRef {
  eventId: string
  laneId: string
  timestamp: number
  kind: string
  files: string[]
}

export interface DiffSummary {
  filesCreated: string[]
  filesModified: string[]
  filesDeleted: string[]
  netLinesAdded: number
  netLinesRemoved: number
  patches: Record<string, string>
}

export interface ValidationResult {
  passed: boolean
  errors: string[]
  warnings: string[]
  output: string
}

export interface Binder {
  laneId: string
  filesCreated: string[]
  filesModified: string[]
  filesDeleted: string[]
  exportedTypes: Record<string, string>
  executionEvents: EventRef[]
  dependsOn: string[]
  diff?: DiffSummary
}

// ── Main Types ────────────────────────────────────────────

export interface IntegrationPlan {
  campaignId: string
  laneOrder: string[]
  mergeStrategy: "sequential_checkpoints" | "rebase" | "replay"
}

export interface ContractDrift {
  severity: "breaking" | "warning" | "info"
  laneA: string
  laneB: string
  description: string
  evidenceEvents: EventRef[]
}

export interface IntegrationResult {
  campaignId: string
  success: boolean
  mergeStrategy: string
  lanesMerged: string[]
  contractDrifts: ContractDrift[]
  finalDiff: DiffSummary
  validationResult?: ValidationResult
  blockers: string[]
}

// ── Errors ────────────────────────────────────────────────

export class CampaignNotFoundError extends Schema.TaggedErrorClass<CampaignNotFoundError>()(
  "CampaignNotFoundError",
  { campaignId: Schema.String, message: Schema.String },
) {}

export class NoBindersError extends Schema.TaggedErrorClass<NoBindersError>()(
  "NoBindersError",
  { campaignId: Schema.String, message: Schema.String },
) {}

export class CyclicDependencyError extends Schema.TaggedErrorClass<CyclicDependencyError>()(
  "CyclicDependencyError",
  { campaignId: Schema.String, lanes: Schema.mutable(Schema.Array(Schema.String)), message: Schema.String },
) {}

export class MergeConflictError extends Schema.TaggedErrorClass<MergeConflictError>()(
  "MergeConflictError",
  { campaignId: Schema.String, conflictingFiles: Schema.mutable(Schema.Array(Schema.String)), message: Schema.String },
) {}

// ── Service Interface ─────────────────────────────────────

export interface Interface {
  readonly planIntegration: (campaignId: string) => Effect.Effect<IntegrationPlan>
  readonly detectContractDrift: (laneBinders: Binder[]) => Effect.Effect<ContractDrift[]>
  readonly mergeLaneCheckpoints: (plan: IntegrationPlan) => Effect.Effect<IntegrationResult>
  readonly getIntegrationResult: (campaignId: string) => Effect.Effect<Option.Option<IntegrationResult>>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/CampaignIntegrator") {}

export const use = serviceUse(Service)

// ── Helpers ───────────────────────────────────────────────

/**
 * Topological sort based on dependency graph.
 * Throws CyclicDependencyError if a cycle is detected.
 */
function topologicalSort(binders: Binder[]): Binder[] {
  const laneIds = new Set(binders.map((b) => b.laneId))
  const adjacency = new Map<string, string[]>()
  for (const b of binders) {
    const deps = b.dependsOn.filter((d) => laneIds.has(d))
    adjacency.set(b.laneId, deps)
  }

  const visited = new Set<string>()
  const inStack = new Set<string>()
  const order: string[] = []
  const idToBinder = new Map(binders.map((b) => [b.laneId, b]))

  function visit(laneId: string): void {
    if (inStack.has(laneId)) {
      throw new CyclicDependencyError({
        campaignId: "",
        lanes: [...inStack],
        message: `Circular dependency detected involving lane: ${laneId}`,
      })
    }
    if (visited.has(laneId)) return

    inStack.add(laneId)
    visited.add(laneId)
    const deps = adjacency.get(laneId) ?? []
    for (const dep of deps) visit(dep)
    inStack.delete(laneId)
    order.push(laneId)
  }

  for (const laneId of laneIds) {
    if (!visited.has(laneId)) visit(laneId)
  }

  return order.map((id) => idToBinder.get(id)!).reverse()
}

function collectSharedFiles(binders: Binder[]): Map<string, Binder[]> {
  const fileMap = new Map<string, Binder[]>()
  for (const binder of binders) {
    const allFiles = [...binder.filesCreated, ...binder.filesModified]
    for (const file of allFiles) {
      const existing = fileMap.get(file) ?? []
      existing.push(binder)
      fileMap.set(file, existing)
    }
  }
  return fileMap
}

function detectConflicts(binders: Binder[]): string[] {
  const sharedFiles = collectSharedFiles(binders)
  const conflicts: string[] = []
  for (const [file, lanes] of sharedFiles) {
    if (lanes.length > 1) conflicts.push(file)
  }
  return conflicts
}

function assignMergeStrategy(binders: Binder[], laneOrder: string[]): "sequential_checkpoints" | "rebase" | "replay" {
  const sharedFiles = collectSharedFiles(binders)
  let coupledCount = 0
  for (const [, lanes] of sharedFiles) {
    if (lanes.length > 1) coupledCount++
  }

  const hasDeps = binders.some((b) => b.dependsOn.length > 0)
  if (hasDeps) return "rebase"
  if (coupledCount > 0) return "sequential_checkpoints"
  return "replay"
}

function buildEmptyDiff(): DiffSummary {
  return {
    filesCreated: [],
    filesModified: [],
    filesDeleted: [],
    netLinesAdded: 0,
    netLinesRemoved: 0,
    patches: {},
  }
}

function toIntegratorBinder(b: BinderBinder): Binder {
  const allEvents = b.executionEvents.map((e) => ({
    eventId: e.eventId,
    laneId: b.laneId,
    timestamp: new Date(e.ts).getTime(),
    kind: e.eventType,
    files: [],
  }))
  const diff: DiffSummary | undefined = b.diffSummary
    ? {
        filesCreated: b.diffSummary.filesCreated,
        filesModified: b.diffSummary.filesModified,
        filesDeleted: b.diffSummary.filesDeleted,
        netLinesAdded: b.diffSummary.netLines,
        netLinesRemoved: 0,
        patches: {},
      }
    : undefined
  return {
    laneId: b.laneId,
    filesCreated: diff?.filesCreated ?? [],
    filesModified: diff?.filesModified ?? [],
    filesDeleted: diff?.filesDeleted ?? [],
    exportedTypes: {},
    executionEvents: allEvents,
    dependsOn: b.dependencyLaneIds,
    diff,
  }
}

const getBinders = Effect.fn("Integrator.getBinders")(function* (campaignId: string) {
  const binderService = yield* BinderService
  const all = yield* binderService.getBindersByCampaignId(campaignId)
  return all.map(toIntegratorBinder)
})

// ── Layer ─────────────────────────────────────────────────

export const layer: Layer.Layer<Service, never, BinderService> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const results = new Map<string, IntegrationResult>()

    const planIntegration = Effect.fn(function* (campaignId: string) {
      const binders = yield* getBinders(campaignId)
      if (binders.length === 0) {
        return yield* Effect.fail(new NoBindersError({
          campaignId,
          message: `No lane binders found for campaign: ${campaignId}`,
        }))
      }

      const ordered = topologicalSort(binders)
      const laneOrder = ordered.map((b) => b.laneId)
      const mergeStrategy = assignMergeStrategy(binders, laneOrder)

      log.info("planned integration", { campaignId, laneCount: laneOrder.length, mergeStrategy })

      return { campaignId, laneOrder, mergeStrategy }
    })

    const detectContractDrift = Effect.fn(function* (laneBinders: Binder[]) {
      const drifts: ContractDrift[] = []
      const sharedFiles = collectSharedFiles(laneBinders)

      for (const [file, lanes] of sharedFiles) {
        if (lanes.length < 2) continue

        for (let i = 0; i < lanes.length; i++) {
          for (let j = i + 1; j < lanes.length; j++) {
            const a = lanes[i]!
            const b = lanes[j]!

            const evidenceEvents = [
              ...a.executionEvents.filter((e) => e.files.includes(file)),
              ...b.executionEvents.filter((e) => e.files.includes(file)),
            ]

            const aExports = Object.keys(a.exportedTypes)
            const bExports = Object.keys(b.exportedTypes)

            // Check if one lane exports a type that the other modifies the file of
            const aExportsFile = aExports.filter((t) => a.exportedTypes[t] === file)
            const bExportsFile = bExports.filter((t) => b.exportedTypes[t] === file)

            if (aExportsFile.length > 0 && b.filesModified.includes(file)) {
              drifts.push({
                severity: "warning",
                laneA: a.laneId,
                laneB: b.laneId,
                description: `Lane ${b.laneId} modified file "${file}" where Lane ${a.laneId} exports types: ${aExportsFile.join(", ")}`,
                evidenceEvents,
              })
            }
            if (bExportsFile.length > 0 && a.filesModified.includes(file)) {
              drifts.push({
                severity: "warning",
                laneA: b.laneId,
                laneB: a.laneId,
                description: `Lane ${a.laneId} modified file "${file}" where Lane ${b.laneId} exports types: ${bExportsFile.join(", ")}`,
                evidenceEvents,
              })
            }

            // Check for full renames — one lane creates, another deletes the same file
            if (a.filesCreated.includes(file) && b.filesModified.includes(file)) {
              drifts.push({
                severity: "info",
                laneA: a.laneId,
                laneB: b.laneId,
                description: `Lane ${a.laneId} created "${file}" but Lane ${b.laneId} also modified it — potential integration concern`,
                evidenceEvents,
              })
            }
          }
        }
      }

      // Check dependency contract: if Lane A depends on Lane B, Lane B's deleted
      // files that Lane A references are breaking changes
      const binderMap = new Map(laneBinders.map((b) => [b.laneId, b]))
      for (const binder of laneBinders) {
        for (const depId of binder.dependsOn) {
          const dep = binderMap.get(depId)
          if (!dep) continue

          const evidenceEvents = dep.executionEvents
          for (const depFile of dep.filesDeleted) {
            if (binder.filesCreated.includes(depFile) || binder.filesModified.includes(depFile)) {
              drifts.push({
                severity: "breaking",
                laneA: dep.laneId,
                laneB: binder.laneId,
                description: `Lane ${dep.laneId} deleted "${depFile}" that Lane ${binder.laneId} references (via dependency)`,
                evidenceEvents,
              })
            }
          }
        }
      }

      log.info("contract drift detection complete", { driftsFound: drifts.length })
      return drifts
    })

    const mergeLaneCheckpoints = Effect.fn(function* (plan: IntegrationPlan) {
      const allLanesMerged: string[] = []
      const allDrifts: ContractDrift[] = []
      const blockers: string[] = []

      // Retrieve binders for the ordered lanes
      const allBinders = yield* getBinders(plan.campaignId)
      if (allBinders.length === 0) {
        return yield* Effect.fail(new NoBindersError({
          campaignId: plan.campaignId,
          message: `Cannot merge — no binders for campaign: ${plan.campaignId}`,
        }))
      }

      const binderMap = new Map(allBinders.map((b) => [b.laneId, b]))
      const orderedBinders = plan.laneOrder.map((id) => binderMap.get(id)).filter((b): b is Binder => b !== undefined)

      // Detect contract drift
      const drifts = yield* detectContractDrift(orderedBinders)
      allDrifts.push(...drifts)

      // Detect conflicts
      const conflicts = detectConflicts(orderedBinders)
      if (conflicts.length > 0) {
        blockers.push(`Merge conflict detected in files: ${conflicts.join(", ")}`)
      }

      // Check for breaking drifts
      const breakingDrifts = drifts.filter((d) => d.severity === "breaking")

      if (breakingDrifts.length > 0) {
        blockers.push(
          `Breaking contract drifts prevent safe merge: ${breakingDrifts.map((d) => d.description).join("; ")}`,
        )
      }

      // Build final diff summary by composing lane diffs in order
      const finalDiff: DiffSummary = buildEmptyDiff()
      for (const binder of orderedBinders) {
        allLanesMerged.push(binder.laneId)
        const laneDiff = binder.diff
        if (!laneDiff) continue

        for (const file of laneDiff.filesCreated) {
          if (!finalDiff.filesCreated.includes(file)) finalDiff.filesCreated.push(file)
        }
        for (const file of laneDiff.filesModified) {
          if (!finalDiff.filesModified.includes(file)) finalDiff.filesModified.push(file)
        }
        for (const file of laneDiff.filesDeleted) {
          if (!finalDiff.filesDeleted.includes(file)) finalDiff.filesDeleted.push(file)
        }
        finalDiff.netLinesAdded += laneDiff.netLinesAdded
        finalDiff.netLinesRemoved += laneDiff.netLinesRemoved

        for (const [file, patch] of Object.entries(laneDiff.patches)) {
          finalDiff.patches[file] = patch
        }
      }

      const result: IntegrationResult = {
        campaignId: plan.campaignId,
        success: blockers.length === 0,
        mergeStrategy: plan.mergeStrategy,
        lanesMerged: allLanesMerged,
        contractDrifts: allDrifts,
        finalDiff,
        blockers,
      }

      results.set(plan.campaignId, result)

      log.info("merge complete", {
        campaignId: plan.campaignId,
        success: result.success,
        lanesMerged: allLanesMerged.length,
        blockers: blockers.length,
      })

      return result
    })

    const getIntegrationResult = Effect.fn(function* (campaignId: string) {
      const existing = results.get(campaignId)
      return existing ? Option.some(existing) : Option.none<IntegrationResult>()
    })

    return Service.of({
      planIntegration,
      detectContractDrift,
      mergeLaneCheckpoints,
      getIntegrationResult,
    } as Interface)
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(BinderDefaultLayer),
)

export * as Integrator from "."
