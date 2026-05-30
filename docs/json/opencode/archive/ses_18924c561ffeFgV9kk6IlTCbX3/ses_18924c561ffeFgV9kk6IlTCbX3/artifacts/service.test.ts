import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { GitHubApiError, GitHubAuthError, defaultLayer, layer, Service } from "../../src/github/service"

describe("GitHubService", () => {
  test("GitHubApiError is constructable", () => {
    const err = new GitHubApiError({ message: "test error", status: 404 })
    expect(err.message).toBe("test error")
    expect(err.status).toBe(404)
    expect(err._tag).toBe("GitHubApiError")
  })

  test("GitHubAuthError is constructable", () => {
    const err = new GitHubAuthError({ message: "auth failed" })
    expect(err.message).toBe("auth failed")
    expect(err._tag).toBe("GitHubAuthError")
  })

  test("layer factory produces a Layer", () => {
    const l = layer("test-token")
    expect(Layer.isLayer(l)).toBe(true)
  })

  test("defaultLayer composes without errors", async () => {
    const result = await Effect.runPromise(
      Effect.scoped(
        Layer.build(defaultLayer).pipe(Effect.flatMap(() => Effect.succeed(true))),
      ),
    )
    expect(result).toBe(true)
  })
})
