import { Context, Effect, Layer, Option, Ref } from "effect"

export interface InstanceHealth {
  status: "booting" | "ready" | "degraded" | "failed"
  message?: string
  failedServices?: Array<string>
  updatedAt: number
}

export interface Interface {
  readonly set: (id: string, health: InstanceHealth) => Effect.Effect<void>
  readonly get: (id: string) => Effect.Effect<Option.Option<InstanceHealth>>
  readonly getAll: () => Effect.Effect<Map<string, InstanceHealth>>
  readonly remove: (id: string) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/InstanceHealthStore") {}

export const layer: Layer.Layer<Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const state = yield* Ref.make<Map<string, InstanceHealth>>(new Map())
    return Service.of({
      set: (id, health) =>
        Ref.update(state, (m) => {
          const next = new Map(m)
          next.set(id, health)
          return next
        }),
      get: (id) =>
        Ref.get(state).pipe(
          Effect.map((m) => { const val = m.get(id); return val !== undefined ? Option.some(val) : Option.none() }),
        ),
      getAll: () => Ref.get(state),
      remove: (id) =>
        Ref.update(state, (m) => {
          const next = new Map(m)
          next.delete(id)
          return next
        }),
    })
  }),
)

