import { Duration, Effect } from "effect"
import {
  type MachineDef,
  type MachineHandler,
  MachineDependenciesService,
} from "./types"

// ─── Data Shape ───────────────────────────────────────────────────────────────

export interface GeneralManData {
  readonly mission: string
  readonly lanes: ReadonlyArray<{
    readonly id: string
    readonly mission: string
    readonly status: "pending" | "running" | "completed" | "failed"
  }>
  readonly handoffs: ReadonlyArray<unknown>
  readonly currentPhase: "scoping" | "delegating" | "monitoring" | "consolidating" | "done"
}

// ─── Handler ──────────────────────────────────────────────────────────────────

const handle: MachineHandler<GeneralManData> = (state, event) =>
  Effect.gen(function* () {
    const deps = yield* MachineDependenciesService

    switch (event._tag) {
      case "Start": {
        yield* deps.log("info", `GeneralMan: Starting mission "${event.mission}"`)
        const data: GeneralManData = {
          mission: event.mission,
          lanes: [],
          handoffs: [],
          currentPhase: "scoping",
        }
        return state.transition("learning", data as any)
      }

      case "PhaseComplete": {
        switch (event.result as string) {
          case "scoping_done": {
            const data = state.data as GeneralManData
            yield* deps.log("info", `GeneralMan: Scoping complete, delegating ${data.lanes.length} lanes`)
            for (const lane of data.lanes) {
              yield* deps.spawn("secretary", lane.id, lane.mission)
            }
            return state.transition("planning", { ...data, currentPhase: "delegating" } as any)
          }
          case "all_handoffs_received": {
            const data = state.data as GeneralManData
            return state.transition("completed", { ...data, currentPhase: "done" } as any)
          }
          default:
            return state
        }
      }

      case "Directive": {
        const data = state.data as GeneralManData
        switch (event.action) {
          case "add_lane": {
            const lane = event.payload as { id: string; mission: string }
            const lanes = [...data.lanes, { id: lane.id, mission: lane.mission, status: "pending" as const }]
            return state.transition(state.phase, { ...data, lanes } as any)
          }
          case "handoff_received": {
            const handoff = event.payload as { lane_id: string; status: string }
            const handoffs = [...data.handoffs, handoff]
            const lanes = data.lanes.map((l) =>
              l.id === handoff.lane_id
                ? { ...l, status: (handoff.status === "completed" ? "completed" : "failed") as "completed" | "failed" }
                : l,
            )
            const allDone = lanes.every((l) => l.status === "completed" || l.status === "failed")
            return state.transition(
              allDone ? "completed" : state.phase,
              { ...data, handoffs, lanes, currentPhase: allDone ? "consolidating" : "monitoring" } as any,
            )
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

// ─── Definition ───────────────────────────────────────────────────────────────

export const generalManDef: MachineDef<GeneralManData> = {
  id: "general-man",
  description: "General Man-agent — spawns cartographers to scope, secretaries to execute. Never reads, never edits.",
  subMachines: ["cartographer", "secretary", "journalist"],
  handle,
  timeout: Duration.minutes(30),
}
