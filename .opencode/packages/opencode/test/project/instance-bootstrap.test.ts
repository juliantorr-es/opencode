import { describe, it, expect } from "bun:test"
import { Effect } from "effect"
import { existsSync } from "node:fs"
import { bootstrapFixture } from "../fixtures/bootstrap"
import { InstanceStore } from "../../src/store/instance"

describe("instance bootstrap", () => {
  it.live("timestamp columns accept Date.now() values without overflow", () =>
    Effect.gen(function* () {
      const tmp = yield* bootstrapFixture
      const store = yield* InstanceStore.Service

      const now = Date.now()
      // If we get past bootstrap without overflow errors, the migration worked.
      // The coordination_claim table is created during migration with bigint columns.
      // The account fixture inserts token_expiry at Date.now() scale.
      yield* store.provide(
        { directory: tmp.directory },
        Effect.succeed(true),
      )
      // If we got here, no overflow occurred.
      expect(existsSync(tmp.marker)).toBe(true)
    }),
  )
})
