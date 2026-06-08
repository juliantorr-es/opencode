import { Effect, Context, Layer, Ref } from "effect"

export interface Scratchpad {
  hypothesis: string
  verifiedFacts: string[]
  uncertainFacts: string[]
  filesInspected: string[]
  candidateFixes: string[]
  risks: string[]
  nextAction: string
  stopCondition: string
}

export interface Interface {
  readonly get: Effect.Effect<Scratchpad>
  readonly update: (fields: Partial<Scratchpad>) => Effect.Effect<void>
  readonly reset: Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Scratchpad") {}

const DEFAULT: Scratchpad = {
  hypothesis: "",
  verifiedFacts: [],
  uncertainFacts: [],
  filesInspected: [],
  candidateFixes: [],
  risks: [],
  nextAction: "",
  stopCondition: "",
}

const make = Effect.gen(function* () {
  const state = yield* Ref.make<Scratchpad>(DEFAULT)

  return {
    get: Ref.get(state),
    update: (fields: Partial<Scratchpad>) => Ref.update(state, (s) => ({ ...s, ...fields })),
    reset: Ref.set(state, { ...DEFAULT }),
  } satisfies Interface
})

export const layer: Layer.Layer<Service> = Layer.effect(Service, make)

export const defaultLayer = layer

export * as Scratchpad from "./scratchpad"
