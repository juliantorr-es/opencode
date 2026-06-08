import { Duration, Effect } from "effect"
import {
  type MachineDef,
  type MachineHandler,
  MachineDependenciesService,
  Phase,
} from "./types"

export interface CriticData {
  readonly mission: string
  readonly plan: unknown
  readonly witnessResult: unknown
  readonly coronerResult: unknown
  readonly precedentResult: unknown
  readonly blastRadiusResult: unknown
  readonly reasonableDoubtResult: unknown
  readonly exhibitAResult: unknown
  readonly appealResult: unknown
  readonly scores: Record<string, number>
  readonly objections: ReadonlyArray<{ axis: string; objection: string }>
  readonly verdict: "approve" | "approve_with_conditions" | "reject"
  readonly conditions: ReadonlyArray<string>
}

const handle: MachineHandler<CriticData> = (state, event) =>
  Effect.gen(function* () {
    const deps = yield* MachineDependenciesService

    switch (event._tag) {
      case "Start": {
        yield* deps.log("info", `Critic: Reviewing plan for "${event.mission}"`)
        const data: CriticData = {
          mission: event.mission,
          plan: null,
          witnessResult: null,
          coronerResult: null,
          precedentResult: null,
          blastRadiusResult: null,
          reasonableDoubtResult: null,
          exhibitAResult: null,
          appealResult: null,
          scores: {},
          objections: [],
          verdict: "approve",
          conditions: [],
        }
        return state.transition("review", data as any)
      }

      case "PhaseComplete": {
        const result = event.result as any
        const data = state.data as CriticData
        const updated = { ...data, ...result } as CriticData

        // Check if all reviews collected
        if (
          updated.witnessResult &&
          updated.coronerResult &&
          updated.precedentResult &&
          updated.blastRadiusResult &&
          updated.reasonableDoubtResult
        ) {
          // Determine verdict
          const lowScores = Object.entries(updated.scores).filter(([, s]) => s <= 2)
          let verdict: "approve" | "approve_with_conditions" | "reject" = "approve"

          if (updated.scores["debuggability"] !== undefined && updated.scores["debuggability"] <= 1) {
            verdict = "approve_with_conditions"
          }
          if (lowScores.length >= 3) {
            verdict = "reject"
          }

          yield* deps.log("info", `Critic: Verdict — ${verdict}`)
          return state.transition("completed", { ...updated, verdict } as any)
        }

        return state.transition("review", updated as any)
      }

      case "Directive": {
        const data = state.data as CriticData
        switch (event.action) {
          case "score_axis": {
            const axisPayload = event.payload as { axis: string; score: number; objection?: string }
            return state.transition(state.phase, {
              ...data,
              scores: { ...data.scores, [axisPayload.axis]: axisPayload.score },
              objections: axisPayload.objection
                ? [...data.objections, { axis: axisPayload.axis, objection: axisPayload.objection }]
                : data.objections,
            } as any)
          }
          case "set_condition":
            return state.transition(state.phase, {
              ...data,
              conditions: [...data.conditions, event.payload],
            } as any)
          default:
            return state
        }
      }

      case "Cancel":
        return state.transition("cancelled")

      default:
        return state
    }
  })

export const criticDef: MachineDef<CriticData> = {
  id: "critic",
  description: "Plan reviewer — judges plans across 7 axes: coupling, debuggability, convergence, surface area, testability, error clarity, reversibility.",
  subMachines: ["witness", "coroner", "precedent", "blast-radius", "reasonable-doubt", "exhibit-a", "appeal"],
  handle,
  timeout: Duration.minutes(5),
}
