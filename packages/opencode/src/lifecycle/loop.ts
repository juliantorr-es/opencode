import { Context, Effect } from "effect"
import * as Log from "@opencode-ai/core/util/log"
import type { SessionID } from "../session/schema"
import type { SessionPrompt } from "../session/prompt"
import type { Agent } from "../agent/agent"
import type { LifecycleDefinition, PhaseResult } from "./definition"
import { parseLifecycle, PhaseFailureError } from "./definition"
import { execute } from "./engine"
import { BUILTIN_LIFECYCLES } from "./builtins"
import { PhaseGate } from "./gate"

const log = Log.create({ service: "lifecycle.loop" })

export interface LifecycleLoopInterface {
  readonly run: (input: {
    promptSvc: SessionPrompt.Interface
    sessionID: SessionID
    lifecycle?: LifecycleDefinition
    agent: Agent.Info
    signal?: AbortSignal
    onPhaseResult?: (result: PhaseResult) => Effect.Effect<void>
  }) => Effect.Effect<PhaseResult[]>
}

export class LifecycleLoop extends Context.Service<LifecycleLoop, LifecycleLoopInterface>()(
  "@opencode/LifecycleLoop",
) {}

export const LifecycleLoopTag = LifecycleLoop

/**
 * Run a lifecycled prompt session.
 *
 * Wraps SessionPrompt.loop with lifecycle phase management.
 * For agents with lifecycle definitions, this function drives phase
 * execution through the lifecycle engine, calling promptSvc.loop() for
 * each phase and managing retry/escalation transitions.
 *
 * The compositor does NOT modify prompt.ts or processor.ts.
 *
 * Lifecycle resolution order:
 * 1. Explicit `lifecycle` in the input
 * 2. `agent.lifecycle` (parsed via the LifecycleDefinition schema)
 * 3. BUILTIN_LIFECYCLES[agent.name]
 * 4. No lifecycle → passthrough (runs promptSvc.loop directly)
 */
export const runLifecycledPrompt = Effect.fn("LifecycleLoop.run")(function* (
  input: {
    readonly promptSvc: SessionPrompt.Interface
    readonly sessionID: SessionID
    readonly lifecycle?: LifecycleDefinition
    readonly agent: Agent.Info
    readonly signal?: AbortSignal
    readonly onPhaseResult?: (result: PhaseResult) => Effect.Effect<void>
  },
) {
  const lifecycle = input.lifecycle
    ?? parseLifecycle(input.agent.lifecycle)
    ?? BUILTIN_LIFECYCLES[input.agent.name]

  if (!lifecycle) {
    log.info(`agent ${input.agent.name} has no lifecycle — running normal loop`)
    yield* input.promptSvc.loop({ sessionID: input.sessionID })
    return []
  }

  const phaseGate = yield* PhaseGate.Service

  log.info(`running lifecycled prompt for agent ${input.agent.name} — ${lifecycle.phases.length} phases (${lifecycle.type})`)

  const results: PhaseResult[] = yield* execute({
    lifecycle,
    signal: input.signal,
    onPhaseEnter: (phase) =>
      Effect.gen(function* () {
        yield* Effect.annotateCurrentSpan({ "lifecycle.phase": phase.id })
        log.info(`entering phase: ${phase.id} (${phase.name})`)
        yield* phaseGate.enterPhase(lifecycle.type, phase)
      }) as any,

    onPhaseExit: (phase, result) =>
      Effect.gen(function* () {
        yield* Effect.annotateCurrentSpan({ "lifecycle.phaseResult": result.status })
        log.info(`exiting phase: ${phase.id} — ${result.status} (${result.retriesUsed} retries)`)
        if (input.onPhaseResult) {
          yield* input.onPhaseResult(result)
        }
      }) as any,

    onProcessorRun: (phase) =>
      Effect.gen(function* () {
        if (input.signal?.aborted) {
          return { phase: phase.id, status: "escalated" as const, error: "aborted", retriesUsed: 0 }
        }

        yield* Effect.annotateCurrentSpan({ "lifecycle.processorRun": phase.id })
        log.info(`running loop for phase ${phase.id}`)

        const assistant = yield* input.promptSvc.loop({ sessionID: input.sessionID })

        if (!assistant) {
          log.warn(`phase ${phase.id}: no assistant message returned`)
          return { phase: phase.id, status: "failed" as const, error: "No assistant message returned", retriesUsed: 0 }
        }

        // Treat any normal finish or tool-calls as phase completion.
        // The agent used tools or produced output — phase work is done.
        const finish = (assistant.info as any).finish
        if (finish == null || finish === "end_turn" || finish === "stop" || finish === "tool-calls") {
          return { phase: phase.id, status: "completed" as const, retriesUsed: 0 }
        }

        // Unknown finish — treat as completion (agent stopped naturally)
        log.warn(`phase ${phase.id}: unhandled finish reason ${finish} — treating as completed`)
        return { phase: phase.id, status: "completed" as const, retriesUsed: 0 }
      }) as any,

    onRepair: (phase, attempt, error) =>
      Effect.gen(function* () {
        log.info(`repairing phase ${phase.id}, attempt ${attempt}: ${error}`)
        yield* Effect.annotateCurrentSpan({ "lifecycle.repair": String(attempt) })

        const assistant = yield* input.promptSvc.loop({ sessionID: input.sessionID })
        const finish = (assistant?.info as any)?.finish
        if (finish == null || finish === "end_turn" || finish === "stop" || finish === "tool-calls") {
          return { phase: phase.id, status: "completed" as const, retriesUsed: attempt + 1 }
        }
        return {
          phase: phase.id,
          status: "failed" as const,
          error: `Repair attempt ${attempt + 1} failed for phase ${phase.id}`,
          retriesUsed: attempt + 1,
        }
      }) as any,
  }).pipe(
    Effect.ensuring(phaseGate.exitPhase()),
  )

  log.info(`lifecycled prompt complete — ${results.length} phases executed`)
  return results
})

export const LifecycleLoopService = {
  run: runLifecycledPrompt,
}
