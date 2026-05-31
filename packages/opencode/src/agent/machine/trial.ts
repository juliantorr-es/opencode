import { Duration, Effect } from "effect"
import {
  type MachineDef,
  type MachineHandler,
  MachineDependenciesService,
  Phase,
} from "./types"

export interface TrialData {
  readonly mission: string
  readonly qaResult: unknown
  readonly redTeamResult: unknown
  readonly emsResult: unknown
  readonly passed: boolean
  readonly failures: ReadonlyArray<string>
}

const handle: MachineHandler<TrialData> = (state, event) =>
  Effect.gen(function* () {
    const deps = yield* MachineDependenciesService

    switch (event._tag) {
      case "Start": {
        yield* deps.log("info", `Trial: Validating changes for "${event.mission}"`)
        const data: TrialData = {
          mission: event.mission,
          qaResult: null,
          redTeamResult: null,
          emsResult: null,
          passed: true,
          failures: [],
        }
        return state.transition("validation", data as any)
      }

      case "PhaseComplete": {
        const result = event.result as any
        const data = state.data as TrialData
        const updated = { ...data, ...result } as TrialData

        if (updated.qaResult && updated.redTeamResult && updated.emsResult) {
          const passed = updated.failures.length === 0
          yield* deps.log("info", `Trial: ${passed ? "ALL PASSED" : `${updated.failures.length} FAILURES`}`)
          return state.transition("completed", { ...updated, passed } as any)
        }
        return state.transition("validation", updated as any)
      }

      case "Directive": {
        const data = state.data as TrialData
        switch (event.action) {
          case "add_failure":
            return state.transition(state.phase, {
              ...data,
              failures: [...data.failures, event.payload],
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

export const trialDef: MachineDef<TrialData> = {
  id: "trial",
  description: "Trial — QA + red team + edge-case stress testing.",
  subMachines: ["qa-observer", "red-team", "ems"],
  handle,
  timeout: Duration.minutes(10),
}
