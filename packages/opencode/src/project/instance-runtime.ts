import { AppRuntime } from "@/effect/app-runtime"
import { type InstanceContext } from "./instance-context"
import { InstanceStore, type LoadInput } from "./instance-store"

// Bridge for Promise/ALS callers that cannot yet yield InstanceStore.Service.
// Delete these functions once those callers are migrated to Effect boundaries
// that provide InstanceStore directly.

export const load = (input: LoadInput) => AppRuntime.runPromise(InstanceStore.Service.use((store) => store.load(input)))
export const disposeInstance = (ctx: InstanceContext) =>
  AppRuntime.runPromise(InstanceStore.Service.use((store) => store.dispose(ctx)))
export const disposeAllInstances = () => AppRuntime.runPromise(InstanceStore.Service.use((store) => store.disposeAll()))
export const reloadInstance = (input: LoadInput) =>
  AppRuntime.runPromise(InstanceStore.Service.use((store) => store.reload(input)))

import { Effect, Fiber, Layer, Scope, Context } from "effect"
import { EventStore } from "@/event"
import { DatabaseAdapter } from "@/storage/adapter"

export interface Interface {
  /** Fork instance work that has all its dependencies already provided.
   * Only accepts Effect<A, E, never> — never an effect with unresolved R. */
  readonly fork: <A, E>(
    label: string,
    effect: Effect.Effect<A, E, never>,
  ) => Effect.Effect<Fiber.RuntimeFiber<A, E>>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/InstanceRuntime") {}

export const layer: Layer.Layer<
  Service,
  never,
  EventStore.Service | DatabaseAdapter.Service | Scope.Scope
> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const eventStore = yield* EventStore.Service
    const databaseAdapter = yield* DatabaseAdapter.Service
    const scope = yield* Scope.Scope

    const fork = <A, E>(label: string, effect: Effect.Effect<A, E, never>): Effect.Effect<Fiber.RuntimeFiber<A, E>> =>
      Effect.gen(function* () {
        // Provide captured services into the forked work context so that
        // any further forks inside svc.init() can still resolve them.
        const provided = effect.pipe(
          Effect.provideService(EventStore.Service, eventStore),
          Effect.provideService(DatabaseAdapter.Service, databaseAdapter),
        )
        yield* Effect.logDebug(`forking instance work`).pipe(
          Effect.annotateLogs("label", label),
        )
        const fiber = yield* provided.pipe(
          Effect.forkIn(scope),
        )
        return fiber
      })

    return Service.of({ fork })
  }),
)
export * as InstanceRuntime from "./instance-runtime"

