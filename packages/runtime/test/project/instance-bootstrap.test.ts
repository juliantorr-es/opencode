import { afterEach, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { CrossSpawnSpawner } from "@tribunus/core/cross-spawn-spawner"
import { init, applyMigrations } from "#db"
import { Cause, Deferred, Effect, Exit, Fiber, Layer } from "effect"
import { Database } from "../../src/storage/db"
import { DatabaseAdapter } from "../../src/storage/adapter"
import { EventStore } from "../../src/event"
import { bootstrap as cliBootstrap } from "../../src/cli/bootstrap"
import { InstanceLayer } from "../../src/project/instance-layer"
import { InstanceStore } from "../../src/project/instance-store"
import { disposeAllInstances, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { waitGlobalBusEvent } from "../server/global-bus"

const it = testEffect(Layer.mergeAll(InstanceLayer.layer, CrossSpawnSpawner.defaultLayer))

// InstanceBootstrap must run before any code touches the instance —
// originally tracked by PRs #25389 and #25449, now a permanent
// invariant. The plugin config hook writes a marker file; the test
// bodies deliberately avoid Plugin/config directly. The marker only
// appears if InstanceBootstrap ran at the instance boundary.
//
// The boundaries below are transport-agnostic and stay.

afterEach(async () => {
  await disposeAllInstances()
})

const ACCOUNT_STATE_ID = 1

const bootstrapFixture = Effect.gen(function* () {
  const dir = yield* tmpdirScoped({ git: true })
  const marker = path.join(dir, "config-hook-fired")
  const pluginFile = path.join(dir, "plugin.ts")
  yield* Effect.promise(() =>
    Bun.write(
      pluginFile,
      [
        `const MARKER = ${JSON.stringify(marker)}`,
        "export default async () => ({",
        "  config: async () => {",
        '    await Bun.write(MARKER, "ran")',
        "  },",
        "})",
        "",
      ].join("\n"),
    ),
  )
  yield* Effect.promise(() =>
    Bun.write(
      path.join(dir, "opencode.json"),
      JSON.stringify({
        $schema: "https://opencode.ai/config.json",
        plugin: [pathToFileURL(pluginFile).href],
      }),
    ),
  )
  // Seed an active account so Config.loadInstanceState can resolve AccountRepo.active.
  // PGlite exec is only available on the raw client; drizzle queries are async.
  yield* Effect.promise(() =>
    Database.use(async (db) => {
      const { AccountTable, AccountStateTable } = await import("../../src/account/account.pg.sql.ts")
      const now = Date.now()
      await db.insert(AccountTable).values({
        id: "test-account",
        email: "test@test.com",
        url: "https://test.opencode.ai",
        access_token: "test-access-token" as any,
        refresh_token: "test-refresh-token" as any,
        token_expiry: now + 3600000,
        time_created: now,
      }).onConflictDoNothing().execute()
      await db.insert(AccountStateTable).values({
        id: ACCOUNT_STATE_ID,
        active_account_id: "test-account",
        active_org_id: null,
      }).onConflictDoUpdate({
        target: AccountStateTable.id,
        set: { active_account_id: "test-account", active_org_id: null },
      }).execute()
    }),
  )
  return { directory: dir, marker }
})

function waitDisposed(directory: string) {
  return waitGlobalBusEvent({
    message: "timed out waiting for CLI bootstrap instance disposal",
    predicate: (event) => event.payload.type === "server.instance.disposed" && event.directory === directory,
  })
}

it.live("InstanceStore.provide runs InstanceBootstrap before effect", () =>
  Effect.gen(function* () {
    const tmp = yield* bootstrapFixture
    const store = yield* InstanceStore.Service

    // This test also proves the fromPlugin tool execution boundary:
    // plugin tools register via fromPlugin() which captures construction-time
    // context (EffectBridge, agent, truncate). If context capture failed,
    // the plugin config hook would trigger a tool invocation that dies with
    // a missing-service error during bootstrap.
    yield* store.provide({ directory: tmp.directory }, Effect.succeed("ok"))

    expect(existsSync(tmp.marker)).toBe(true)
  }),
)

it.live("CLI bootstrap runs InstanceBootstrap before callback", () =>
  Effect.gen(function* () {
    const tmp = yield* bootstrapFixture

    yield* Effect.promise(() => cliBootstrap(tmp.directory, async () => "ok"))

    expect(existsSync(tmp.marker)).toBe(true)
  }),
)

it.live("CLI bootstrap disposes the instance when the callback rejects", () =>
  Effect.gen(function* () {
    const tmp = yield* bootstrapFixture
    const disposed = yield* waitDisposed(tmp.directory).pipe(Effect.forkScoped)

    const exit = yield* Effect.promise(() =>
      cliBootstrap(tmp.directory, async () => Promise.reject(new Error("boom"))),
    ).pipe(Effect.exit)

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toMatchObject({ message: "boom" })
    yield* Fiber.join(disposed)
  }),
)

it.live("InstanceStore.reload runs InstanceBootstrap", () =>
  Effect.gen(function* () {
    const tmp = yield* bootstrapFixture
    const store = yield* InstanceStore.Service

    yield* store.reload({ directory: tmp.directory })

    expect(existsSync(tmp.marker)).toBe(true)
  }),
)

it.live("forked bootstrap fiber resolves InstanceEnvironment services", () =>
  Effect.gen(function* () {
    const tmp = yield* bootstrapFixture
    const store = yield* InstanceStore.Service
    // Use Deferred to observe the child fiber result
    const deferred = yield* Deferred.make<boolean>()
    const scoped = Effect.gen(function* () {
      yield* store.provide(
        { directory: tmp.directory },
        Effect.gen(function* () {
          // Verify core services are accessible
          const db = yield* Effect.serviceOption(DatabaseAdapter.Service)
          const events = yield* Effect.serviceOption(EventStore.Service)
          yield* Deferred.succeed(deferred, db._tag === "Some" && events._tag === "Some")
        }),
      )
    })
    yield* scoped.pipe(Effect.scoped)
    const result = yield* Deferred.await(deferred)
    expect(result).toBe(true)
  }),
)

test("migration double-run produces zero unhandled rejections", async () => {
  const rejections: unknown[] = []
  const onUnhandled = (reason: unknown) => {
    rejections.push(reason)
  }
  process.on("unhandledRejection", onUnhandled)

  const closeClient = async (client: any) => {
    const raw = client?.$client ?? client
    if (raw && typeof raw.close === "function") {
      await raw.close()
    }
  }

  try {
    const db = init(":memory:")
    try {
      // Fresh bootstrap — applies all migrations
      await applyMigrations(db)
      // Re-bootstrap — idempotent, every statement should be a benign duplicate
      await applyMigrations(db)

      // Flush microtasks and timers so any lingering promise rejections surface
      await new Promise((resolve) => setTimeout(resolve, 50))

      expect(rejections).toHaveLength(0)
    } finally {
      await closeClient(db)
    }
  } finally {
    process.off("unhandledRejection", onUnhandled)
  }
})
