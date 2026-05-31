import { Duration, Effect } from "effect"
import {
  type MachineDef,
  type MachineHandler,
  type MachineState,
  MachineDependenciesService,
  Phase,
} from "./types"

// ─── Data Shape ───────────────────────────────────────────────────────────────

export interface SecretaryData {
  readonly mission: string
  readonly wave: number
  readonly maxWaves: number
  readonly repairCycles: number
  readonly maxRepairCycles: number
  readonly cartographerResult: unknown
  readonly architectResult: unknown
  readonly planApproved: boolean
  readonly surgeonResult: unknown
  readonly trialResult: unknown
  readonly journalistResult: unknown
  readonly filesCreated: ReadonlyArray<string>
  readonly filesModified: ReadonlyArray<string>
  readonly handoffSent: boolean
  readonly currentSubAgents: ReadonlyArray<{ id: string; machineId: string; status: string }>
}

// ─── Handler ──────────────────────────────────────────────────────────────────

const handle: MachineHandler<SecretaryData> = (state, event) =>
  Effect.gen(function* () {
    const deps = yield* MachineDependenciesService
    const data = state.data as SecretaryData

    switch (event._tag) {
      case "Start": {
        yield* deps.log("info", `Secretary: Starting lane "${event.laneId}" — ${event.mission}`)
        const initial: SecretaryData = {
          mission: event.mission,
          wave: 0,
          maxWaves: 6,
          repairCycles: 0,
          maxRepairCycles: 3,
          cartographerResult: null,
          architectResult: null,
          planApproved: false,
          surgeonResult: null,
          trialResult: null,
          journalistResult: null,
          filesCreated: [],
          filesModified: [],
          handoffSent: false,
          currentSubAgents: [],
        }

        // Wave 1: Fan out cartographer crew
        yield* deps.log("info", "Secretary: Wave 1 — Cartographer crew")
        yield* deps.spawn("cartographer", `${state.laneId}/cartographer`, event.mission)

        return state.transition("learning", { ...initial, wave: 1 } as any)
      }

      case "PhaseComplete": {
        const wave = data.wave

        switch (wave) {
          case 1: {
            yield* deps.log("info", "Secretary: Cartographer complete, spawning architect")
            yield* deps.spawn("architect", `${state.laneId}/architect`, data.mission)
            return state.transition("planning", { ...data, wave: 2, cartographerResult: event.result } as any)
          }
          case 2: {
            yield* deps.log("info", "Secretary: Architect complete, spawning critic")
            yield* deps.spawn("critic", `${state.laneId}/critic`, data.mission)
            return state.transition("review", { ...data, wave: 3, architectResult: event.result } as any)
          }
          case 3: {
            if (data.planApproved) {
              yield* deps.log("info", "Secretary: Plan approved, spawning surgeon")
              yield* deps.spawn("surgeon", `${state.laneId}/surgeon`, data.mission)
              return state.transition("execution", { ...data, wave: 4 } as any)
            } else if (data.repairCycles < data.maxRepairCycles) {
              yield* deps.log("info", `Secretary: Plan rejected, repair cycle ${data.repairCycles + 1}`)
              yield* deps.spawn("architect", `${state.laneId}/architect`, data.mission)
              return state.transition("planning", {
                ...data,
                wave: 2,
                repairCycles: data.repairCycles + 1,
              } as any)
            } else {
              return state.transition("blocked", {
                ...data,
                errors: [...(state as any).errors, "Max repair cycles exceeded for plan review"],
              } as any)
            }
          }
          case 4: {
            yield* deps.log("info", "Secretary: Surgeon complete, spawning trial")
            yield* deps.spawn("trial", `${state.laneId}/trial`, data.mission)
            return state.transition("validation", { ...data, wave: 5, surgeonResult: event.result } as any)
          }
          case 5: {
            if (event.result === "passed") {
              yield* deps.log("info", "Secretary: Validation passed, spawning journalist")
              yield* deps.spawn("journalist", `${state.laneId}/journalist`, data.mission)
              return state.transition("publication", { ...data, wave: 6, trialResult: event.result } as any)
            } else if (data.repairCycles < data.maxRepairCycles) {
              yield* deps.log("info", `Secretary: Validation failed, repair cycle ${data.repairCycles + 1}`)
              yield* deps.spawn("architect", `${state.laneId}/architect`, data.mission)
              return state.transition("planning", {
                ...data,
                wave: 2,
                trialResult: event.result,
                repairCycles: data.repairCycles + 1,
              } as any)
            } else {
              return state.transition("blocked", {
                ...data,
                errors: [...(state as any).errors, "Max repair cycles exceeded for validation"],
              } as any)
            }
          }
          case 6: {
            yield* deps.log("info", "Secretary: Lane complete, sending handoff")
            const journalistData = event.result as Record<string, unknown> | null
            yield* deps.sendDirective("*", "handoff", `Lane ${state.laneId} complete — completed`, JSON.stringify({
              lane_id: state.laneId,
              status: "completed",
              waves_completed: ["learning", "planning", "review", "execution", "validation", "publication"],
              repair_cycles: data.repairCycles,
              files_created: journalistData?.filesCreated ?? data.filesCreated,
              files_modified: journalistData?.filesModified ?? data.filesModified,
            }))
            return state.transition("completed", { ...data, wave: 6, journalistResult: event.result, handoffSent: true } as any)
          }
          default:
            return state
        }
      }

      case "Directive": {
        switch (event.action) {
          case "approve_plan":
            return state.transition(state.phase, { ...data, planApproved: true } as any)
          case "reject_plan":
            return state.transition(state.phase, { ...data, planApproved: false } as any)
          case "cancel":
            return state.transition("cancelled", data as any)
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

export const secretaryDef: MachineDef<SecretaryData> = {
  id: "secretary",
  description: "Secretary — manages one lane through the full wave lifecycle (cartographer → architect → critic → surgeon → trial → journalist).",
  subMachines: ["cartographer", "architect", "critic", "surgeon", "trial", "journalist"],
  handle,
  timeout: Duration.minutes(15),
}
