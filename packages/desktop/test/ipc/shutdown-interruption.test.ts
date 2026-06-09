import { describe, it, expect } from "bun:test"
import { Effect, Deferred } from "effect"
import { makeDesktopRuntime } from "../../src/main/effect/desktop-runtime"

describe("Shutdown interruption", () => {
  it("dispose is idempotent", async () => {
    const runtime = makeDesktopRuntime()
    await runtime.dispose()
    await runtime.dispose() // should not throw
  })

  it("runPromise rejects after dispose", async () => {
    const runtime = makeDesktopRuntime()
    await runtime.dispose()

    let error: Error | null = null
    try {
      await runtime.runPromise(Effect.void)
    } catch (e: unknown) {
      error = e instanceof Error ? e : new Error(String(e))
    }
    expect(error).not.toBeNull()
    expect(error?.message).toContain("disposed")
  })

  it("a forked fiber is interrupted by dispose", async () => {
    const runtime = makeDesktopRuntime()
    const deferred = await runtime.runPromise(Deferred.make<void>())

    // Fork a fiber that blocks on the Deferred and sets a flag when done
    let completed = false
    runtime.runFork(
      Effect.gen(function* () {
        yield* Deferred.await(deferred)
        completed = true
      }),
    )

    // Dispose the runtime while the fiber is pending
    await runtime.dispose()

    // Complete the Deferred AFTER disposal
    const { promise, resolve } = Promise.withResolvers<void>()
    setTimeout(resolve, 100)
    await promise

    // The fiber should have been interrupted BEFORE the Deferred completed
    expect(completed).toBe(false)
  })
})
