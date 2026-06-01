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

import { Effect, Fiber, Layer, Scope } from "effect"
import { InstanceRuntimeInterface, InstanceRuntimeTag } from "./instance-runtime-contract"

export type Interface = InstanceRuntimeInterface
export { InstanceRuntimeTag as Service }

export const layer: Layer.Layer<
  InstanceRuntimeTag,
  never,
  Scope.Scope
> = Layer.effect(
  InstanceRuntimeTag,
  Effect.gen(function* () {
    const scope = yield* Scope.Scope

    const fork = <A, E>(label: string, effect: Effect.Effect<A, E, never>): Effect.Effect<Fiber.RuntimeFiber<A, E>> =>
      Effect.gen(function* () {
        yield* Effect.logDebug(`forking instance work`).pipe(
          Effect.annotateLogs("label", label),
        )
        const fiber = yield* effect.pipe(
          Effect.forkIn(scope, { startImmediately: true }),
        )
        return fiber
      })

    return InstanceRuntimeTag.of({ fork })
  }),
)
export * as InstanceRuntime from "./instance-runtime"

