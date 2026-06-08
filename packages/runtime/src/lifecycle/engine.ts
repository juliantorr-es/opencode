import { Context, Effect } from "effect"
import type { LifecycleDefinition, PhaseDefinition, PhaseResult, PhaseFailureError } from "./definition"
import { getNextPhase } from "./definition"
import * as Log from "@tribunus/core/util/log"

const log = Log.create({ service: "lifecycle.engine" })

/**
 * Hook-based lifecycle engine.
 *
 * The engine does NOT own the session, tools, or subagents — it delegates via
 * hooks so the caller controls tool gating, subagent spawning, and processor
 * invocation. This keeps the engine stateless and composable.
 */
export interface Interface {
  readonly execute: (input: {
    lifecycle: LifecycleDefinition
    onPhaseEnter: (phase: PhaseDefinition) => Effect.Effect<void>
    onPhaseExit: (phase: PhaseDefinition, result: PhaseResult) => Effect.Effect<void>
    onProcessorRun: (phase: PhaseDefinition) => Effect.Effect<PhaseResult>
    onRepair: (phase: PhaseDefinition, attempt: number, error: string) => Effect.Effect<PhaseResult>
    signal?: AbortSignal
  }) => Effect.Effect<PhaseResult[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/LifecycleEngine") {}

export const layer = Context.empty

/**
 * Execute all phases of a lifecycle definition, applying retry/escalation for failures.
 *
 * Algorithm per phase:
 * 1. Call onPhaseEnter hook
 * 2. Enter retry loop (up to maxRetries + 1 attempts):
 *    a. Call onProcessorRun
 *    b. If status is "completed": break retry loop
 *    c. If failed + retries remain: call onRepair hook, re-run
 *    d. If maxRetries exceeded: apply escalation strategy
 * 3. Call onPhaseExit hook
 * 4. Find next phase via transitions (DAG) or index (linear)
 * 5. If no next phase, return all results
 */
export const execute: Interface["execute"] = Effect.fn("LifecycleEngine.execute")(function* (input) {
  const { lifecycle, onPhaseEnter, onPhaseExit, onProcessorRun, onRepair, signal } = input
  const results: PhaseResult[] = []

  let currentIndex = 0
  while (currentIndex < lifecycle.phases.length) {
    if (signal?.aborted) {
      log.info(`lifecycle aborted at phase index ${currentIndex}`)
      break
    }

    const phase = lifecycle.phases[currentIndex]
    const maxRetries = phase.maxRetries ?? 0

    yield* Effect.annotateCurrentSpan({ "lifecycle.phase": phase.id })
    yield* onPhaseEnter(phase)

    let phaseResult: PhaseResult = { phase: phase.id, status: "failed", retriesUsed: 0 }

    // Retry loop: maxRetries + 1 attempts (the initial run counts as attempt 0)
    for (let attempt = 0; attempt <= maxRetries + 1; attempt++) {
      if (signal?.aborted) {
        phaseResult = { phase: phase.id, status: "escalated", error: "aborted", retriesUsed: attempt }
        break
      }

      yield* Effect.annotateCurrentSpan({ "lifecycle.attempt": String(attempt) })

      if (attempt > maxRetries) {
        // Escalation
        const escalation = phase.escalation ?? "skip"
        yield* Effect.annotateCurrentSpan({ "lifecycle.escalation": escalation })
        log.warn(`phase ${phase.id} max retries (${maxRetries}) exceeded, escalating: ${escalation}`)

        if (escalation === "abort") {
          phaseResult = { phase: phase.id, status: "escalated", error: `Max retries (${maxRetries}) exceeded`, retriesUsed: attempt }
          yield* onPhaseExit(phase, phaseResult)
          results.push(phaseResult)
          return results
        }

        if (escalation === "blocker") {
          phaseResult = { phase: phase.id, status: "escalated", error: `Max retries (${maxRetries}) exceeded — needs escalation`, retriesUsed: attempt }
          yield* onPhaseExit(phase, phaseResult)
          results.push(phaseResult)
          return results
        }

        // "skip" — mark as failed and continue to next phase
        phaseResult = { phase: phase.id, status: "failed", error: `Max retries (${maxRetries}) exceeded`, retriesUsed: attempt }
        break
      }

      // Run the phase
      const result = yield* onProcessorRun(phase)
      phaseResult = result

      if (result.status === "completed") break

      if (attempt < maxRetries) {
        log.info(`phase ${phase.id} attempt ${attempt} failed, repairing`)
        const repairResult = yield* onRepair(phase, attempt, result.error ?? "unknown error")
        if (repairResult.status === "completed") {
          phaseResult = repairResult
          break
        }
      }
    }

    yield* Effect.annotateCurrentSpan({ "lifecycle.phaseResult": phaseResult.status })
    yield* onPhaseExit(phase, phaseResult)
    results.push(phaseResult)

    // Find next phase
    if (phaseResult.status === "completed" || phaseResult.status === "failed") {
      const nextPhaseId = getNextPhase(lifecycle, phase.id, phaseResult.status === "completed" ? "completed" : "failed")
      if (!nextPhaseId) break
      currentIndex = lifecycle.phases.findIndex((p) => p.id === nextPhaseId)
      if (currentIndex < 0) {
        log.warn(`next phase ${nextPhaseId} not found in lifecycle`)
        break
      }
    } else {
      // escalated or skipped — stop
      break
    }
  }

  return results
})

export const LifecycleEngine = { Service, layer, execute }
