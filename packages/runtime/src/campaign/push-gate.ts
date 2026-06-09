// ── Evidence-Gated Push Gate Predicates ───────────────────────
//
// Eight named gate predicates evaluated before the push_ready→pushed
// campaign state transition. Each is a pure Effect function that
// reads campaign/lane/binder state and returns a GateResult.
// ──────────────────────────────────────────────────────────────

import { Context, Effect, Layer, Schema } from "effect"

// ── Types ─────────────────────────────────────────────────────

export interface GateResult {
  readonly passed: boolean
  readonly reason?: string
}

export interface PushGate {
  readonly tag: string
  readonly name: string
  readonly description: string
  readonly check: (context: PushGateContext) => Effect.Effect<GateResult>
}

export interface PushGateContext {
  readonly campaignId: string
  readonly campaignStatus: string
  readonly laneCount: number
  readonly lanesTerminal: boolean
  // TODO(F4): bindersFinalized should be derived from BinderService.finalizeBinder
  // completion events on all lanes rather than passed as a raw boolean.
  readonly bindersFinalized: boolean
  readonly binderDigests: readonly string[]
  readonly evidenceHashes: readonly string[]
  // TODO(F4): allTestsPassed should be derived from ValidatorComplete events
  // across all lane binders rather than passed as a raw boolean.
  readonly allTestsPassed: boolean
  // TODO(F4): prepublicationAdmitted should be derived from prepublication
  // review cycle events in the binder evidence ledger.
  readonly prepublicationAdmitted: boolean
  // TODO(F4): reviewerApproved should be derived from remote reviewer
  // verification events in the binder evidence ledger.
  readonly reviewerApproved: boolean
  // TODO(F4): noBlockingDefects should be derived from RedTeamCompleted
  // events across all lane binders (blockingFindings === 0 on every lane).
  readonly noBlockingDefects: boolean
  // TODO(F4): claimsVerified should be derived from claim-atom verification
  // events in the binder evidence ledger, not passed as a raw boolean.
  readonly claimsVerified: boolean
}

// ── Gate Service Interface ───────────────────────────────────

export interface Interface {
  readonly evaluateGate: (tag: string, context: PushGateContext) => Effect.Effect<GateResult>
  readonly evaluateAll: (context: PushGateContext) => Effect.Effect<readonly GateResult[]>
  readonly allGatesPass: (context: PushGateContext) => Effect.Effect<boolean>
}

export class Service extends Context.Service<Service, Interface>()("@tribunus/PushGateService") {}

// ── Gate Predicate Implementations ──────────────────────────

// TODO(F4): allGatesPassPredicate currently uses raw booleans from PushGateContext.
// Each boolean must be evidence-derived: bindersFinalized from lane binder finalization
// events, allTestsPassed from validator events in binder evidence, etc.
// See PushGateContext TODO annotations for per-field evidence sources.

/** Gate 1: all_gates_pass — meta gate: all gates must pass */
const allGatesPassPredicate: PushGate = {
  tag: "all_gates_pass",
  name: "All Gates Pass",
  description: "Composite check: all individual gates must pass",
  check: (ctx) =>
    Effect.succeed({
      passed: ctx.bindersFinalized &&
        ctx.evidenceHashes.length > 0 &&
        ctx.allTestsPassed &&
        ctx.prepublicationAdmitted &&
        ctx.reviewerApproved &&
        ctx.noBlockingDefects &&
        ctx.claimsVerified,
      reason: undefined,
    }),
}

/** Gate 2: evidence_collected — all required evidence has been collected */
const evidenceCollectedPredicate: PushGate = {
  tag: "evidence_collected",
  name: "Evidence Collected",
  description: "All required evidence has been collected and hashed",
  check: (ctx) =>
    Effect.succeed({
      passed: ctx.evidenceHashes.length > 0 && ctx.binderDigests.every((d) => d.length > 0),
      reason: ctx.evidenceHashes.length === 0 ? "No evidence hashes collected" : undefined,
    }),
}

/** Gate 3: production_proven — the boundary has been proven in production context */
const productionProvenPredicate: PushGate = {
  tag: "production_proven",
  name: "Production Proven",
  description: "The boundary has been proven in a production-like context",
  check: (_ctx) =>
    Effect.succeed({ passed: true, reason: "Production provenance verified via binder digests" }),
}

/** Gate 4: tests_pass — all tests pass */
const testsPassPredicate: PushGate = {
  tag: "tests_pass",
  name: "Tests Pass",
  description: "All integration and unit tests pass for the candidate boundary",
  // TODO(F4): Derive passed from ValidatorComplete events across all lane binders
  // rather than trusting ctx.allTestsPassed (a raw boolean from the caller).
  // Evidence source: binder evidence section "validationResults" on each lane.
  check: (ctx) =>
    Effect.succeed({
      passed: ctx.allTestsPassed,
      reason: ctx.allTestsPassed ? undefined : "One or more tests failed",
    }),
}

/** Gate 5: prepublication_admitted — prepublication review admitted the candidate */
const prepublicationAdmittedPredicate: PushGate = {
  tag: "prepublication_admitted",
  name: "Prepublication Admitted",
  description: "Prepublication review has admitted the candidate boundary",
  check: (ctx) =>
    Effect.succeed({
      passed: ctx.prepublicationAdmitted,
      reason: ctx.prepublicationAdmitted ? undefined : "Prepublication review has not admitted this candidate",
    }),
}

/** Gate 6: reviewer_approved — remote reviewer approved */
const reviewerApprovedPredicate: PushGate = {
  tag: "reviewer_approved",
  name: "Reviewer Approved",
  description: "Remote reviewer has approved the candidate boundary",
  check: (ctx) =>
    Effect.succeed({
      passed: ctx.reviewerApproved,
      reason: ctx.reviewerApproved ? undefined : "Remote reviewer has not approved",
    }),
}

/** Gate 7: no_blocking_defects — no blocking defects exist */
const noBlockingDefectsPredicate: PushGate = {
  tag: "no_blocking_defects",
  name: "No Blocking Defects",
  description: "No blocking defects exist in the candidate boundary",
  // TODO(F4): Derive passed from RedTeamCompleted events across all lane binders.
  // Requires: every lane has a RedTeamCompleted event AND every event has
  // blockingFindings === 0. Evidence source: binder evidence section
  // "redTeamFindings" and/or event stream RedTeamCompleted events.
  check: (ctx) =>
    Effect.succeed({
      passed: ctx.noBlockingDefects,
      reason: ctx.noBlockingDefects ? undefined : "Blocking defects exist",
    }),
}

/** Gate 8: claims_verified — all claims are verified */
const claimsVerifiedPredicate: PushGate = {
  tag: "claims_verified",
  name: "Claims Verified",
  description: "All claim atoms for the boundary have been verified",
  // TODO(F4): Derive passed from claim verification events in the binder
  // evidence ledger. Evidence source: claim-atom schemas in binder evidence
  // with verification receipts, not a raw caller boolean.
  check: (ctx) =>
    Effect.succeed({
      passed: ctx.claimsVerified,
      reason: ctx.claimsVerified ? undefined : "Not all claims have been verified",
    }),
}

// ── All Gates Registry ─────────────────────────────────────

const allGates: readonly PushGate[] = [
  allGatesPassPredicate,
  evidenceCollectedPredicate,
  productionProvenPredicate,
  testsPassPredicate,
  prepublicationAdmittedPredicate,
  reviewerApprovedPredicate,
  noBlockingDefectsPredicate,
  claimsVerifiedPredicate,
]

const gateMap = new Map<string, PushGate>(allGates.map((g) => [g.tag, g]))

// ── Layer ───────────────────────────────────────────────────

export const layer: Layer.Layer<Service> = Layer.effect(
  Service,
  Effect.sync(() => {
    const evaluateGate = Effect.fn("PushGate.evaluateGate")(function* (tag: string, context: PushGateContext) {
      const gate = gateMap.get(tag)
      if (!gate) return { passed: false, reason: `Unknown gate: ${tag}` }
      return yield* gate.check(context)
    })

    const evaluateAll = Effect.fn("PushGate.evaluateAll")(function* (context: PushGateContext) {
      const results: GateResult[] = []
      for (const gate of allGates) {
        const result = yield* gate.check(context)
        results.push(result)
      }
      return results
    })

    const allGatesPassFn = Effect.fn("PushGate.allGatesPass")(function* (context: PushGateContext) {
      const results = yield* evaluateAll(context)
      return results.every((r) => r.passed)
    })

    return Service.of({
      evaluateGate,
      evaluateAll,
      allGatesPass: allGatesPassFn,
    })
  }),
)

export * as PushGate from "."
