import { Effect, Context, Layer } from "effect"
import type { LifecycleDefinition, Phase } from "./definition"

type PhaseResult = {
  readonly phase: string
  readonly status: "completed" | "failed" | "skipped" | "escalated"
  readonly error?: string
  readonly retriesUsed: number
}

export interface Interface {
  readonly execute: (input: {
    lifecycle: LifecycleDefinition
    /** Called before each phase begins execution */
    onPhaseEnter?: (phase: Phase) => Effect.Effect<void>
    /** Called after each phase completes (or fails/skips/escalates) */
    onPhaseExit?: (phase: Phase, result: PhaseResult) => Effect.Effect<void>
    /** Execute a single phase. Must return the phase result. */
    onProcessorRun: (phase: Phase) => Effect.Effect<PhaseResult>
    /** Called when a retry is needed after a failure. Returns the retry result. */
    onRepair?: (phase: Phase, attempt: number, error: string) => Effect.Effect<PhaseResult>
  }) => Effect.Effect<PhaseResult[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/LifecycleEngine") {}

function runPhase(
  phase: Phase,
  run: Phase,
  onProcessorRun: (phase: Phase) => Effect.Effect<PhaseResult>,
  onRepair: ((phase: Phase, attempt: number, error: string) => Effect.Effect<PhaseResult>) | undefined,
  phaseError: string | undefined,
  attempt: number,
): Effect.Effect<PhaseResult> {
  if (attempt === 0) {
    return onProcessorRun(phase).pipe(
      Effect.catchCause((cause) =>
        Effect.succeed({
          phase: phase.name,
          status: "failed" as const,
          error: String(cause),
          retriesUsed: attempt,
        } as PhaseResult),
      ),
    )
  }
  if (!onRepair) {
    return Effect.succeed({
      phase: phase.name,
      status: "failed" as const,
      error: phaseError ?? "unknown error",
      retriesUsed: attempt,
    } as PhaseResult)
  }
  return onRepair(phase, attempt, phaseError ?? "unknown error").pipe(
    Effect.catchCause((cause) =>
      Effect.succeed({
        phase: phase.name,
        status: "failed" as const,
        error: String(cause),
        retriesUsed: attempt,
      } as PhaseResult),
    ),
  )
}

function resolveTransition(
  lifecycle: LifecycleDefinition,
  fromPhase: string,
  condition: "success" | "failure" | "always",
): { from: string; to: string; condition: "success" | "failure" | "always" } | undefined {
  const exact = lifecycle.transitions.find(
    (t) => t.from === fromPhase && t.condition === condition,
  )
  if (exact) return exact
  if (condition === "always") return undefined
  return lifecycle.transitions.find(
    (t) => t.from === fromPhase && t.condition === "always",
  )
}

const execute: Interface["execute"] = (input) =>
  Effect.gen(function* () {
    const results: PhaseResult[] = []
    const { lifecycle } = input
    let currentPhaseIndex = 0

    while (currentPhaseIndex < lifecycle.phases.length) {
      const phase = lifecycle.phases[currentPhaseIndex]
      let retriesUsed = 0
      let phaseStatus: PhaseResult["status"] = "completed"
      let phaseError: string | undefined
      const maxRetries = phase.maxRetries ?? 0

      // Call onPhaseEnter hook
      if (input.onPhaseEnter) {
        yield* input.onPhaseEnter(phase)
      }

      // Execute the phase with retry loop
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        if (attempt > 0) retriesUsed = attempt

        const result: PhaseResult = yield* runPhase(
          phase,
          phase,
          input.onProcessorRun,
          input.onRepair,
          phaseError,
          attempt,
        )

        if (result.status !== "failed") {
          phaseStatus = "completed"
          phaseError = undefined
          break
        }

        phaseError = result.error
        if (attempt < maxRetries) {
          continue
        }

        // Max retries exceeded — apply escalation
        switch (phase.escalation ?? "abort") {
          case "abort": {
            phaseStatus = "escalated"
            const finalResult: PhaseResult = {
              phase: phase.name,
              status: "escalated",
              error: phaseError,
              retriesUsed,
            }
            results.push(finalResult)
            if (input.onPhaseExit) {
              yield* input.onPhaseExit(phase, finalResult)
            }
            return results
          }
          case "skip":
            phaseStatus = "skipped"
            break
          case "blocker":
          default:
            phaseStatus = "failed"
            break
        }
      }

      const phaseResult: PhaseResult = {
        phase: phase.name,
        status: phaseStatus,
        error: phaseError,
        retriesUsed,
      }
      results.push(phaseResult)

      // Call onPhaseExit hook
      if (input.onPhaseExit) {
        yield* input.onPhaseExit(phase, phaseResult)
      }

      // Handle transitions for non-completed phases
      if (phaseStatus !== "completed") {
        const transition = resolveTransition(lifecycle, phase.name, "failure")
        if (transition) {
          const nextIndex = lifecycle.phases.findIndex((p) => p.name === transition.to)
          if (nextIndex >= 0) {
            currentPhaseIndex = nextIndex
            continue
          }
        }
        break
      }

      // Find next phase via transitions
      const successTransition = resolveTransition(lifecycle, phase.name, "success")
      if (successTransition) {
        const nextIndex = lifecycle.phases.findIndex((p) => p.name === successTransition.to)
        if (nextIndex >= 0) {
          currentPhaseIndex = nextIndex
          continue
        }
      }

      // Check for "always" transitions
      const alwaysTransition = resolveTransition(lifecycle, phase.name, "always")
      if (alwaysTransition) {
        const nextIndex = lifecycle.phases.findIndex((p) => p.name === alwaysTransition.to)
        if (nextIndex >= 0) {
          currentPhaseIndex = nextIndex
          continue
        }
      }

      // Default: go to next phase in order
      currentPhaseIndex++
    }

    return results
  }).pipe(Effect.withSpan("LifecycleEngine.execute"))

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    return Service.of({ execute })
  }),
)

export const defaultLayer = layer
