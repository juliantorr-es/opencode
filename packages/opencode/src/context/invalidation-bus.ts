import { Effect, Layer, PubSub, Scope, Context, Stream } from "effect"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { type InvalidationScope, getInvalidations } from "./invalidation-registry"

export type InvalidationEvent = {
  scope: InvalidationScope
  sessionId?: string
}

export interface Interface {
  readonly notify: (eventType: string, sessionId?: string) => Effect.Effect<void>
  readonly subscribe: (scope: InvalidationScope) => Effect.Effect<Stream.Stream<void>, never, Scope.Scope>
  readonly subscribeAll: () => Effect.Effect<Stream.Stream<InvalidationEvent>, never, Scope.Scope>
}

export class ContextInvalidationBus extends Context.Service<ContextInvalidationBus, Interface>()("@opencode/ContextInvalidationBus") {}

export const use = serviceUse(ContextInvalidationBus)

export const layer = Layer.effect(
  ContextInvalidationBus,
  Effect.gen(function* () {
    const scopes = new Map<InvalidationScope, PubSub.PubSub<void>>()
    const all = yield* PubSub.unbounded<InvalidationEvent>()

    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        yield* PubSub.shutdown(all)
        for (const ps of scopes.values()) {
          yield* PubSub.shutdown(ps)
        }
      }),
    )

    const getOrCreateScope = (scope: InvalidationScope) =>
      Effect.gen(function* () {
        let ps = scopes.get(scope)
        if (!ps) {
          ps = yield* PubSub.unbounded<void>()
          scopes.set(scope, ps)
        }
        return ps
      })

    const notify = Effect.fn("ContextInvalidationBus.notify")(function* (eventType: string, sessionId?: string) {
      const invalidations = getInvalidations(eventType)
      for (const scope of invalidations) {
        const ps = yield* getOrCreateScope(scope)
        yield* PubSub.publish(ps, void 0)
        yield* PubSub.publish(all, { scope, sessionId })
      }
    })

    const subscribe = Effect.fn("ContextInvalidationBus.subscribe")(function* (scope: InvalidationScope) {
      const ps = yield* getOrCreateScope(scope)
      const subscription = yield* PubSub.subscribe(ps)
      return Stream.fromSubscription(subscription)
    })

    const subscribeAll = Effect.fn("ContextInvalidationBus.subscribeAll")(function* () {
      const subscription = yield* PubSub.subscribe(all)
      return Stream.fromSubscription(subscription)
    })

    return ContextInvalidationBus.of({ notify, subscribe, subscribeAll })
  }),
)

export const defaultLayer = layer
