import { Effect, Exit, Fiber, Layer, ManagedRuntime } from "effect"

/**
 * Owns the root Effect scope for the Electron main process.
 *
 * This is the single runtime owner identified as missing in the architectural
 * audit. Every long-lived resource in the main process is supervised by this
 * runtime. Electron process lifetime = root Effect scope lifetime.
 *
 * Construction: build once during bootstrap, before the root program runs.
 * Disposal: call `dispose()` during shutdown to interrupt fibers and run
 * finalizers. Idempotent — safe to call multiple times.
 */
export interface DesktopRuntime {
  readonly runPromise: <A, E>(
    effect: Effect.Effect<A, E, never>,
    options?: Effect.RunOptions,
  ) => Promise<A>
  readonly runPromiseExit: <A, E>(
    effect: Effect.Effect<A, E, never>,
    options?: Effect.RunOptions,
  ) => Promise<Exit.Exit<A, E>>
  readonly runFork: <A, E>(effect: Effect.Effect<A, E, never>) => Fiber.Fiber<A, E>
  readonly runSync: <A, E>(effect: Effect.Effect<A, E, never>) => A
  /** Interrupt the root scope, await all finalizers. Idempotent. */
  readonly dispose: () => Promise<void>
}

const disposedError = (): Error => new Error("DesktopRuntime is disposed")

export function makeDesktopRuntime(): DesktopRuntime {
  const rt = ManagedRuntime.make(Layer.empty)
  let disposed = false

  const check = (): void => {
    if (disposed) throw disposedError()
  }

  return {
    runPromise(effect, options) {
      check()
      return rt.runPromise(effect, options)
    },
    runPromiseExit(effect, options) {
      check()
      return rt.runPromiseExit(effect, options)
    },
    runFork(effect) {
      check()
      return rt.runFork(effect)
    },
    runSync(effect) {
      check()
      return rt.runSync(effect)
    },
    async dispose() {
      if (disposed) return
      disposed = true
      await rt.dispose()
    },
  }
}
