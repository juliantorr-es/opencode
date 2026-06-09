import { Context, Effect, Layer, Ref } from "effect"

export enum HealthStatus {
  Healthy = "healthy",
  Degraded = "degraded",
  Down = "down",
  Unknown = "unknown",
}

export interface ComponentHealth {
  status: HealthStatus
  message?: string
  updatedAt: number
}

export interface Interface {
  readonly get: (component: string) => Effect.Effect<ComponentHealth>
  readonly getAll: () => Effect.Effect<Record<string, ComponentHealth>>
  readonly set: (component: string, status: ComponentHealth) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@tribunus/HealthRegistry") {}

export const HealthRegistry = Service

export const layer: Layer.Layer<Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const state = yield* Ref.make<Map<string, ComponentHealth>>(new Map())
    return Service.of({
      get: (component) =>
        Ref.get(state).pipe(
          Effect.map((m) => m.get(component) ?? { status: HealthStatus.Unknown, updatedAt: Date.now() }),
        ),
      getAll: () =>
        Ref.get(state).pipe(
          Effect.map((m) => Object.fromEntries(m)),
        ),
      set: (component, h) =>
        Ref.update(state, (m) => {
          const next = new Map(m)
          next.set(component, h)
          return next
        }),
    })
  }),
)
