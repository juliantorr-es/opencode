import { Duration, Effect } from "effect"
import {
  type MachineDef,
  type MachineHandler,
  MachineDependenciesService,
  Phase,
} from "./types"

export interface ArchitectData {
  readonly mission: string
  readonly cartographerInput: unknown
  readonly foundationResult: unknown
  readonly loadBearerResult: unknown
  readonly buildingInspectorResult: unknown
  readonly blueprintResult: unknown
  readonly zoningBoardResult: unknown
  readonly plan: unknown
  readonly rootCauses: ReadonlyArray<{ hypothesis: string; confidence: string; evidence: string[] }>
  readonly fixes: ReadonlyArray<{
    id: string
    description: string
    files: string[]
    impact: Record<string, unknown>
    risks: string[]
    validation: string[]
  }>
}

const handle: MachineHandler<ArchitectData> = (state, event) =>
  Effect.gen(function* () {
    const deps = yield* MachineDependenciesService

    switch (event._tag) {
      case "Start": {
        yield* deps.log("info", `Architect: Designing plan for "${event.mission}"`)
        const data: ArchitectData = {
          mission: event.mission,
          cartographerInput: null,
          foundationResult: null,
          loadBearerResult: null,
          buildingInspectorResult: null,
          blueprintResult: null,
          zoningBoardResult: null,
          plan: null,
          rootCauses: [],
          fixes: [],
        }
        return state.transition("planning", data as any)
      }

      case "PhaseComplete": {
        const result = event.result as any
        const data = state.data as ArchitectData

        // Merge sub-findings as they arrive
        const updated = { ...data, ...result } as ArchitectData

        // Check if all sub-plans are collected
        if (
          updated.foundationResult &&
          updated.loadBearerResult &&
          updated.buildingInspectorResult &&
          updated.blueprintResult &&
          updated.zoningBoardResult
        ) {
          const plan = {
            root_causes: updated.rootCauses,
            fixes: updated.fixes,
            apply_order: updated.fixes.map((f) => f.id),
            rollback_plan: "revert each fix in reverse order",
          }
          yield* deps.log("info", "Architect: Plan complete")
          return state.transition("completed", { ...updated, plan } as any)
        }

        return state.transition("planning", updated as any)
      }

      case "Directive": {
        const data = state.data as ArchitectData
        switch (event.action) {
          case "add_root_cause":
            return state.transition(state.phase, {
              ...data,
              rootCauses: [...data.rootCauses, event.payload],
            } as any)
          case "add_fix":
            return state.transition(state.phase, {
              ...data,
              fixes: [...data.fixes, event.payload],
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

export const architectDef: MachineDef<ArchitectData> = {
  id: "architect",
  description: "Plan architect — designs the smallest change that eliminates the root cause.",
  subMachines: ["foundation", "load-bearer", "building-inspector", "blueprint", "zoning-board"],
  handle,
  timeout: Duration.minutes(5),
}
