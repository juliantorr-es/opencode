import { Duration, Effect } from "effect"
import {
  type MachineDef,
  type MachineHandler,
  MachineDependenciesService,
  Phase,
} from "./types"

export interface CartographerData {
  readonly mission: string
  readonly surveyorResult: unknown
  readonly compassResult: unknown
  readonly soundingsResult: unknown
  readonly logbookResult: unknown
  readonly smokingGuns: ReadonlyArray<string>
}

const handle: MachineHandler<CartographerData> = (state, event) =>
  Effect.gen(function* () {
    const deps = yield* MachineDependenciesService

    switch (event._tag) {
      case "Start": {
        yield* deps.log("info", `Cartographer: Mapping terrain for "${event.mission}"`)
        const data: CartographerData = {
          mission: event.mission,
          surveyorResult: null,
          compassResult: null,
          soundingsResult: null,
          logbookResult: null,
          smokingGuns: [],
        }
        return state.transition("learning", data as any)
      }

      case "PhaseComplete": {
        const result = event.result as any
        const data = state.data as CartographerData
        const updated = { ...data, ...result } as CartographerData

        // Check if all sub-findings are collected
        if (updated.surveyorResult && updated.compassResult && updated.soundingsResult && updated.logbookResult) {
          yield* deps.log("info", "Cartographer: All findings collected, reporting")
          yield* deps.recordActivity("discovered", `lane/${state.laneId}/map`, {
            smokingGuns: updated.smokingGuns,
          })
          return state.transition("completed", updated as any)
        }

        return state.transition("learning", updated as any)
      }

      case "Directive": {
        const data = state.data as CartographerData
        switch (event.action) {
          case "add_finding": {
            const finding = event.payload as any
            return state.transition(state.phase, {
              ...data,
              [finding.key]: finding.value,
              smokingGuns: finding.smokingGun
                ? [...data.smokingGuns, finding.smokingGun]
                : data.smokingGuns,
            } as any)
          }
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

export const cartographerDef: MachineDef<CartographerData> = {
  id: "cartographer",
  description: "Cartographer — maps entry points, dependency graphs, conventions, and git history.",
  subMachines: ["surveyor", "compass", "soundings", "logbook"],
  handle,
  timeout: Duration.minutes(5),
}
