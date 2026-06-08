import { Duration, Effect } from "effect"
import {
  type MachineDef,
  type MachineHandler,
  MachineDependenciesService,
  Phase,
} from "./types"

export interface JournalistData {
  readonly mission: string
  readonly scoopResult: unknown
  readonly editorResult: unknown
  readonly bylineResult: unknown
  readonly pressResult: unknown
  readonly retortResult: unknown
  readonly headlineResult: unknown
  readonly commitMessages: ReadonlyArray<string>
  readonly filesCreated: ReadonlyArray<string>
  readonly filesModified: ReadonlyArray<string>
  readonly prDescription: string
}

const handle: MachineHandler<JournalistData> = (state, event) =>
  Effect.gen(function* () {
    const deps = yield* MachineDependenciesService

    switch (event._tag) {
      case "Start": {
        yield* deps.log("info", `Journalist: Preparing publication for "${event.mission}"`)
        const data: JournalistData = {
          mission: event.mission,
          scoopResult: null,
          editorResult: null,
          bylineResult: null,
          pressResult: null,
          retortResult: null,
          headlineResult: null,
          commitMessages: [],
          filesCreated: [],
          filesModified: [],
          prDescription: "",
        }
        return state.transition("publication", data as any)
      }

      case "PhaseComplete": {
        const result = event.result as any
        const data = state.data as JournalistData
        const updated = { ...data, ...result } as JournalistData

        if (updated.bylineResult && updated.pressResult) {
          const handoff = {
            filesCreated: updated.filesCreated,
            filesModified: updated.filesModified,
            commitMessages: updated.commitMessages,
            prDescription: updated.prDescription,
          }
          yield* deps.log("info", "Journalist: Publication ready")
          return state.transition("completed", handoff as any)
        }
        return state.transition("publication", updated as any)
      }

      case "Directive": {
        const data = state.data as JournalistData
        switch (event.action) {
          case "add_commit_message":
            return state.transition(state.phase, {
              ...data,
              commitMessages: [...data.commitMessages, event.payload],
            } as any)
          case "set_pr_description":
            return state.transition(state.phase, {
              ...data,
              prDescription: String(event.payload),
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

export const journalistDef: MachineDef<JournalistData> = {
  id: "journalist",
  description: "Journalist — git history, commit composition, PR crafting, and release notes.",
  subMachines: ["scoop", "editor", "byline", "press", "retort", "headline"],
  handle,
  timeout: Duration.minutes(5),
}
