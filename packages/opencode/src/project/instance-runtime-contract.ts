import { Effect, Fiber, Context } from "effect"

export interface InstanceRuntimeInterface {
  readonly fork: <A, E>(
    label: string,
    effect: Effect.Effect<A, E, never>,
  ) => Effect.Effect<Fiber.RuntimeFiber<A, E>>
}

export class InstanceRuntimeTag extends Context.Service<
  InstanceRuntimeTag,
  InstanceRuntimeInterface
>()("@opencode/InstanceRuntime") {}
