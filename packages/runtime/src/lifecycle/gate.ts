import { Context, Effect, Layer, Option, Ref } from "effect"
import type { PhaseDefinition } from "./definition"
import { Tool } from "../tool/tool"

export interface Interface {
  readonly enterPhase: (lifecycleName: string, phase: PhaseDefinition) => Effect.Effect<void>
  readonly exitPhase: () => Effect.Effect<void>
  readonly checkAllowed: (toolId: string) => Effect.Effect<void, Tool.ToolError>
}

interface State {
  readonly lifecycleName: string
  readonly phase: string
  readonly allowedTools: ReadonlySet<string>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/PhaseGate") {}

const make = Effect.gen(function* () {
  const state = yield* Ref.make<State | undefined>(undefined)

  return {
    enterPhase: (lifecycleName: string, phase: PhaseDefinition): Effect.Effect<void> =>
      Ref.set(state, {
        lifecycleName,
        phase: phase.id,
        allowedTools: new Set(phase.allowedTools ?? []),
      }),
    exitPhase: (): Effect.Effect<void> => Ref.set(state, undefined),
    checkAllowed: (toolId: string): Effect.Effect<void, Tool.ToolError> =>
      Effect.gen(function* () {
        const current = yield* Ref.get(state)
        if (!current) return
        if (current.allowedTools.size === 0) return
        if (current.allowedTools.has(toolId)) return
        return yield* Effect.fail(
          new Tool.ToolError({
            tool: toolId,
            detail: `Tool "${toolId}" is not allowed in phase "${current.phase}" of lifecycle "${current.lifecycleName}". Allowed: ${[...current.allowedTools].join(", ")}`,
            recoverable: true,
          }),
        )
      }),
  } satisfies Interface
})

export const layer: Layer.Layer<Service> = Layer.effect(Service, make)

export const PhaseGate = { Service, layer }
