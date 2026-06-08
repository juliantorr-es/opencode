import { afterEach, expect, test } from "bun:test"
import { eq } from "drizzle-orm"
import path from "node:path"
import { Effect, Layer } from "effect"
import { HttpClient } from "effect/unstable/http"
import { CrossSpawnSpawner } from "@tribunus/core/cross-spawn-spawner"
import { AccessToken, AccountID, OrgID, RefreshToken } from "../../src/account/schema"
import { Account } from "../../src/account/account"
import { AccountStateTable, AccountTable } from "../../src/account/account.pg.sql"
import { Bus } from "../../src/bus"
import { Config } from "../../src/config/config"
import { planCoordinationRecovery, persistCoordinationRecoveryReceipt, setRecoveryStatus } from "../../src/coordination/recovery"
import { CoordinationRecoveryTable } from "../../src/coordination/recovery.pg.sql"
import { AppRuntime } from "../../src/effect/app-runtime"
import { InstanceRef } from "../../src/effect/instance-ref"
import { Database } from "@/storage/db"
import { applyMigrations } from "../../src/storage/db.pg.ts"
import { DatabaseAdapter } from "@/storage/adapter"
import { ProjectID } from "../../src/project/schema"
import { InstanceStore } from "../../src/project/instance-store"
import { Provider } from "../../src/provider/provider"
import { ShareNext } from "@/share/share-next"
import { Session } from "../../src/session/session"
import { SessionID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { disposeAllInstances, provideInstance, tmpdir } from "../fixture/fixture"
import { resetDatabase } from "../fixture/db"

type SessionRecoveryState =
  | "coordination_unavailable"
  | "coordination_rebuilding"
  | "coordination_recovered"
  | "coordination_degraded"
  | "coordination_refused"

type SessionRecoveryStatus = { type: SessionRecoveryState }

const recoveryLabels: Record<SessionRecoveryState, string> = {
  coordination_unavailable: "Coordination unavailable",
  coordination_rebuilding: "Coordination rebuilding",
  coordination_recovered: "Coordination recovered",
  coordination_degraded: "Coordination degraded",
  coordination_refused: "Coordination refused",
}

function formatRecoveryLabel(value: SessionRecoveryStatus | undefined) {
  if (!value) return "status.popover.trigger"
  return recoveryLabels[value.type]
}

function isRecoveryMutationBlocked(value: SessionRecoveryStatus | undefined) {
  return value?.type !== "coordination_recovered"
}

const none = HttpClient.make(() => Effect.die("unexpected http call"))

const runtime = Layer.mergeAll(
  ShareNext.layer.pipe(
    Layer.provide(Bus.layer),
    Layer.provide(Account.defaultLayer),
    Layer.provide(Config.defaultLayer),
    Layer.provide(Provider.defaultLayer),
    Layer.provide(Session.defaultLayer),
    Layer.provide(Layer.succeed(HttpClient.HttpClient, none)),
  ),
  SessionStatus.defaultLayer,
  CrossSpawnSpawner.defaultLayer,
  DatabaseAdapter.defaultLayer,
)

const runProvided = (effect: any): Promise<any> => Effect.runPromise(effect as never) as Promise<any>

afterEach(async () => {
  await disposeAllInstances()
  await AppRuntime.runPromise(InstanceStore.Service.use((store) => store.disposeAll())).catch(() => undefined)
  await resetDatabase().catch(() => undefined)
})

const seedAccount = (input: { accountID: string; url: string; orgID?: string }) =>
  Effect.promise(() =>
    Database.use(async (db) => {
      const now = Date.now()
      await db.delete(AccountStateTable).execute()
      await db.delete(AccountTable).execute()
      await db.insert(AccountTable).values({
        id: AccountID.make(input.accountID),
        email: `${input.accountID}@example.com`,
        url: input.url,
        access_token: AccessToken.make(`access-${input.accountID}`),
        refresh_token: RefreshToken.make(`refresh-${input.accountID}`),
        token_expiry: now + 60 * 60_000,
        time_created: now,
        time_updated: now,
      }).execute()
      await db.insert(AccountStateTable).values({
        id: 1,
        active_account_id: AccountID.make(input.accountID),
        active_org_id: input.orgID ? OrgID.make(input.orgID) : null,
      }).execute()
    }),
  )

const seedEnterpriseConfig = (directory: string, url: string) =>
  Bun.write(
    path.join(directory, "opencode.json"),
    JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      enterprise: { url },
    }),
  )

const recoveryStates = [
  "coordination_rebuilding",
  "coordination_degraded",
  "coordination_refused",
] as const satisfies readonly SessionRecoveryStatus["type"][]

function createProjectionStore() {
  return {
    session_status: {} as Record<string, SessionRecoveryStatus | undefined>,
  }
}

function makeProjectionSDK(directory: string): {
  session: {
    status: () => Promise<{ data?: Record<string, SessionRecoveryStatus> }>
  }
} {
  const fetchStatus = async () => {
    const request = new Request("http://localhost/session/status", {
      headers: {
        "x-opencode-directory": directory,
      },
    })
    const response = await AppRuntime.runPromise(
      Effect.promise(() => HttpApiApp.webHandler().handler(request, HttpApiApp.context)),
    )
    return { data: await response.json() }
  }

  return {
    session: {
      status: fetchStatus,
    },
  } as never
}

test("isolates account, session, and share state across two concurrent runtimes", async () => {
  const leftTmp = await tmpdir()
  const rightTmp = await tmpdir()
  try {
    await seedEnterpriseConfig(leftTmp.path, "https://legacy-left.example.com")
    await seedEnterpriseConfig(rightTmp.path, "https://control-right.example.com")

    const sharedSession = SessionID.make("ses_shared_runtime")

    const [a, b] = await runProvided(
      Effect.all(
        [
          Effect.gen(function* () {
            yield* seedAccount({ accountID: "account-left", url: "https://legacy-left.example.com" })
            const status = yield* SessionStatus.Service
            yield* setRecoveryStatus(sharedSession, "coordination_rebuilding")
            const request = yield* ShareNext.use.request()
            return { request, status: yield* status.get(sharedSession) }
          }).pipe(provideInstance(leftTmp.path)),
          Effect.gen(function* () {
            yield* seedAccount({
              accountID: "account-right",
              url: "https://control-right.example.com",
              orgID: "org-right",
            })
            const status = yield* SessionStatus.Service
            yield* setRecoveryStatus(sharedSession, "coordination_refused")
            const request = yield* ShareNext.use.request()
            return { request, status: yield* status.get(sharedSession) }
          }).pipe(provideInstance(rightTmp.path)),
        ],
        { concurrency: "unbounded" },
      ).pipe(Effect.scoped, Effect.provide(runtime)),
    )

    expect(a.request.api.create).toBe("/api/share")
    expect(a.request.baseUrl).toBe("https://legacy-left.example.com")
    expect(a.request.headers).toEqual({})
    expect(a.status).toEqual({ type: "coordination_rebuilding" })

    expect(b.request.api.create).toBe("/api/shares")
    expect(b.request.baseUrl).toBe("https://control-right.example.com")
    expect(b.request.headers).toEqual({
      authorization: "Bearer access-account-right",
      "x-org-id": "org-right",
    })
    expect(b.status).toEqual({ type: "coordination_refused" })
  } finally {
    await leftTmp[Symbol.asyncDispose]()
    await rightTmp[Symbol.asyncDispose]()
  }
})

test("scopes session lifecycle status updates to the intended instance and session", async () => {
  const leftTmp = await tmpdir()
  const rightTmp = await tmpdir()
  try {
    const sharedSession = SessionID.make("ses_shared_status")
    const leftOnlySession = SessionID.make("ses_left_only")
    const rightOnlySession = SessionID.make("ses_right_only")

    const [a, b] = await runProvided(
      Effect.all(
        [
          Effect.gen(function* () {
            const status = yield* SessionStatus.Service
            yield* setRecoveryStatus(sharedSession, "coordination_rebuilding")
            yield* status.set(leftOnlySession, { type: "busy" })
            return {
              shared: yield* status.get(sharedSession),
              leftOnly: yield* status.get(leftOnlySession),
              rightOnly: yield* status.get(rightOnlySession),
            }
          }).pipe(provideInstance(leftTmp.path)),
          Effect.gen(function* () {
            const status = yield* SessionStatus.Service
            yield* setRecoveryStatus(sharedSession, "coordination_degraded")
            return {
              shared: yield* status.get(sharedSession),
              leftOnly: yield* status.get(leftOnlySession),
              rightOnly: yield* status.get(rightOnlySession),
            }
          }).pipe(provideInstance(rightTmp.path)),
        ],
        { concurrency: "unbounded" },
      ).pipe(Effect.scoped, Effect.provide(runtime)),
    )

    expect(a.shared).toEqual({ type: "coordination_rebuilding" })
    expect(a.leftOnly).toEqual({ type: "busy" })
    expect(a.rightOnly).toEqual({ type: "idle" })
    expect(b.shared).toEqual({ type: "coordination_degraded" })
    expect(b.leftOnly).toEqual({ type: "idle" })
    expect(b.rightOnly).toEqual({ type: "idle" })
  } finally {
    await leftTmp[Symbol.asyncDispose]()
    await rightTmp[Symbol.asyncDispose]()
  }
})

test("drops in-memory session state on teardown and keeps durable recovery receipts queryable", async () => {
  const dirTmp = await tmpdir()
  try {
    await seedEnterpriseConfig(dirTmp.path, "https://teardown.example.com")

    const sessionID = SessionID.make("ses_teardown_runtime")
    const projectID = ProjectID.make("proj-teardown")
    const plan = planCoordinationRecovery({
      sessionID,
      projectID,
      valkeyAvailable: true,
      statePresent: false,
      durableGeneration: 2,
      currentGeneration: 3,
      unsafeWork: true,
      durableReceipt: true,
      timestamp: 123456,
    })

    expect(plan.receipt).toBeDefined()
    if (!plan.receipt) throw new Error("expected coordination recovery receipt")
    const receipt = plan.receipt

    await runProvided(
      Effect.gen(function* () {
        yield* seedAccount({ accountID: "account-teardown", url: "https://teardown.example.com" })
        const status = yield* SessionStatus.Service
        yield* setRecoveryStatus(sessionID, "coordination_degraded")
        yield* persistCoordinationRecoveryReceipt(receipt)
        expect(yield* status.get(sessionID)).toEqual({ type: "coordination_degraded" })
      }).pipe(provideInstance(dirTmp.path), Effect.scoped, Effect.provide(runtime)),
    )

    await disposeAllInstances()

    const after = await runProvided(
      Effect.gen(function* () {
        const status = yield* SessionStatus.Service
        const request = yield* ShareNext.use.request()
        const row = yield* Effect.promise(() =>
          Database.use((db) =>
            db
              .select()
              .from(CoordinationRecoveryTable)
              .where(eq(CoordinationRecoveryTable.id, receipt.id))
              .execute()
              .then((rows: any[]) => rows[0]),
          ),
        )
        return { status: yield* status.get(sessionID), request, row }
      }).pipe(provideInstance(dirTmp.path), Effect.scoped, Effect.provide(runtime)),
    )

    expect(after.status).toEqual({ type: "idle" })
    expect(after.request.baseUrl).toBe("https://teardown.example.com")
    expect(after.row).toMatchObject({
      session_id: sessionID,
      outcome: "coordination_degraded",
      durable_receipt: true,
    })
  } finally {
    await dirTmp[Symbol.asyncDispose]()
  }
})

test("projects recovery truth through the instance api into app bootstrap state", async () => {
  const dirTmp = await tmpdir({ git: true })
  try {
    await Database.use((db) => applyMigrations(db as never))
    const ctx = await AppRuntime.runPromise(InstanceStore.Service.use((store) => store.load({ directory: dirTmp.path })))
    const sessionID = SessionID.make("ses_projection_runtime")
    const sdk = makeProjectionSDK(dirTmp.path)

    for (const state of recoveryStates) {
      await AppRuntime.runPromise(
        Effect.gen(function* () {
          const status = yield* SessionStatus.Service
          yield* setRecoveryStatus(sessionID, state)
          expect(yield* status.get(sessionID)).toEqual({ type: state })
        }).pipe(Effect.provideService(InstanceRef, ctx)),
      )

      const store = createProjectionStore()
      store.session_status = {
        ...((await sdk.session.status()).data ?? {}),
      }

      const projected = store.session_status[sessionID] as SessionRecoveryStatus | undefined
      expect(projected).toEqual({ type: state })
      expect(formatRecoveryLabel(projected)).toBe(recoveryLabels[state])
      expect(isRecoveryMutationBlocked(projected)).toBe(true)
    }
  } finally {
    await AppRuntime.runPromise(InstanceStore.Service.use((store) => store.disposeAll())).catch(() => undefined)
    await dirTmp[Symbol.asyncDispose]()
  }
})
