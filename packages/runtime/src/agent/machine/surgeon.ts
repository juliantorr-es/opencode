import { Duration, Effect } from "effect"
import {
  type MachineDef,
  type MachineHandler,
  MachineDependenciesService,
  Phase,
} from "./types"

export interface SurgeonData {
  readonly mission: string
  readonly plan: unknown
  readonly edits: ReadonlyArray<{
    step: number
    file: string
    applied: boolean
    reason?: string
    verification?: { typecheck: string; test: string; boundaryMoved: boolean }
  }>
  readonly filesCreated: ReadonlyArray<string>
  readonly filesModified: ReadonlyArray<string>
  readonly currentStep: number
  readonly totalSteps: number
}

const handle: MachineHandler<SurgeonData> = (state, event) =>
  Effect.gen(function* () {
    const deps = yield* MachineDependenciesService

    switch (event._tag) {
      case "Start": {
        yield* deps.log("info", `Surgeon: Executing plan for "${event.mission}"`)
        const data: SurgeonData = {
          mission: event.mission,
          plan: null,
          edits: [],
          filesCreated: [],
          filesModified: [],
          currentStep: 0,
          totalSteps: 0,
        }
        return state.transition("execution", data as any)
      }

      case "PhaseComplete": {
        const result = event.result as any
        const data = state.data as SurgeonData

        // Merge sub-agent results
        const updated = { ...data, ...result } as SurgeonData

        if (updated.currentStep >= updated.totalSteps && updated.totalSteps > 0) {
          yield* deps.log("info", "Surgeon: All edits applied")
          return state.transition("completed", updated as any)
        }

        return state.transition("execution", updated as any)
      }

      case "Directive": {
        const data = state.data as SurgeonData
        switch (event.action) {
          case "apply_edit": {
            const edit = event.payload as any
            const edits = [...data.edits, edit]
            return state.transition(state.phase, {
              ...data,
              edits,
              currentStep: data.currentStep + 1,
              filesCreated: edit.newFile ? [...data.filesCreated, edit.file] : data.filesCreated,
              filesModified: !edit.newFile ? [...data.filesModified, edit.file] : data.filesModified,
            } as any)
          }
          case "add_verification": {
            const v = event.payload as any
            const edits = data.edits.map((e, i) =>
              i === data.edits.length - 1 ? { ...e, verification: v } : e,
            )
            return state.transition(state.phase, { ...data, edits } as any)
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

export const surgeonDef: MachineDef<SurgeonData> = {
  id: "surgeon",
  description: "Surgeon — applies planned edits mechanically with verification after every edit batch.",
  subMachines: ["scalpel", "vitals", "stress-test", "second-opinion", "tourniquet", "monitor"],
  handle,
  timeout: Duration.minutes(10),
}
