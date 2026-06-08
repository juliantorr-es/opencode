# Session/Instance Runtime Seam Verification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove that instance-scoped runtime state stays isolated across two concurrent runtimes and across teardown/recreate boundaries, including account state, session status, and durable recovery receipts.

**Architecture:** Keep the change in the test layer. Reuse the fixture-backed instance loader, seed two tmpdir-backed runtimes with different account state, and exercise `ShareNext`, `SessionStatus`, and coordination recovery through the same runtime seam the app uses. The regression harness should prove both positive isolation and negative leakage cases without widening production code.

**Tech Stack:** Bun test, Effect, existing `provideInstance`/`tmpdirScoped` fixture helpers, Drizzle-backed PGlite storage, `ShareNext`, `SessionStatus`, `CoordinationRecovery`.

---

### Task 1: Add the seam regression harness

**Files:**
- Modify: `packages/opencode/test/fixture/fixture.ts:1-220`
- Create: `packages/opencode/test/project/instance-runtime-seam.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { afterEach, expect, test } from "bun:test"
import { eq } from "drizzle-orm"
import { Effect, Exit, Layer } from "effect"
import { HttpClient } from "effect/unstable/http"
import { CrossSpawnSpawner } from "@tribunus/core/cross-spawn-spawner"
import { AccessToken, AccountID, OrgID, RefreshToken } from "../../src/account/schema"
import { Account } from "../../src/account/account"
import { AccountStateTable, AccountTable } from "../../src/account/account.pg.sql"
import { Bus } from "../../src/bus"
import { Config } from "../../src/config/config"
import { Database } from "@/storage/db"
import { DatabaseAdapter } from "@/storage/adapter"
import { Provider } from "../../src/provider/provider"
import { Session } from "../../src/session/session"
import { SessionID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { ShareNext } from "@/share/share-next"
import { CoordinationRecoveryTable } from "../../src/coordination/recovery.pg.sql"
import {
  planCoordinationRecovery,
  persistCoordinationRecoveryReceipt,
  setRecoveryStatus,
} from "../../src/coordination/recovery"
import { disposeAllInstances, provideInstance, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

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
  Bus.layer,
  Session.defaultLayer,
)

const it = testEffect(runtime)

afterEach(async () => {
  await disposeAllInstances()
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

test("isolates account, session, and share state across two concurrent runtimes", async () => {
  const left = await tmpdirScoped({ git: true })
  const right = await tmpdirScoped({ git: true })
  const sharedSession = SessionID.make("ses_shared_runtime")

  const [a, b] = await Effect.runPromise(
    Effect.all(
      [
        Effect.gen(function* () {
          yield* seedAccount({ accountID: "account-left", url: "https://legacy-left.example.com" })
          const status = yield* SessionStatus.Service
          yield* setRecoveryStatus(sharedSession, "coordination_rebuilding")
          const request = yield* ShareNext.use.request()
          return { request, status: yield* status.get(sharedSession) }
        }).pipe(provideInstance(left)),
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
        }).pipe(provideInstance(right)),
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
})

test("scopes session lifecycle status updates to the intended instance and session", async () => {
  const left = await tmpdirScoped({ git: true })
  const right = await tmpdirScoped({ git: true })
  const sharedSession = SessionID.make("ses_shared_status")
  const leftOnlySession = SessionID.make("ses_left_only")

  const [a, b] = await Effect.runPromise(
    Effect.all(
      [
        Effect.gen(function* () {
          const status = yield* SessionStatus.Service
          yield* setRecoveryStatus(sharedSession, "coordination_rebuilding")
          yield* status.set(leftOnlySession, { type: "busy" })
          return {
            shared: yield* status.get(sharedSession),
            leftOnly: yield* status.get(leftOnlySession),
            other: yield* status.get(SessionID.make("ses_right_only")),
          }
        }).pipe(provideInstance(left)),
        Effect.gen(function* () {
          const status = yield* SessionStatus.Service
          yield* setRecoveryStatus(sharedSession, "coordination_degraded")
          return {
            shared: yield* status.get(sharedSession),
            leftOnly: yield* status.get(leftOnlySession),
            other: yield* status.get(SessionID.make("ses_right_only")),
          }
        }).pipe(provideInstance(right)),
      ],
      { concurrency: "unbounded" },
    ).pipe(Effect.scoped, Effect.provide(runtime)),
  )

  expect(a.shared).toEqual({ type: "coordination_rebuilding" })
  expect(a.leftOnly).toEqual({ type: "busy" })
  expect(a.other).toEqual({ type: "idle" })
  expect(b.shared).toEqual({ type: "coordination_degraded" })
  expect(b.leftOnly).toEqual({ type: "idle" })
  expect(b.other).toEqual({ type: "idle" })
})

test("drops in-memory session state on teardown and keeps durable recovery receipts queryable", async () => {
  const dir = await tmpdirScoped({ git: true })
  const sessionID = SessionID.make("ses_teardown_runtime")
  const plan = planCoordinationRecovery({
    sessionID,
    projectID: "proj-teardown" as never,
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

  await Effect.runPromise(
    Effect.gen(function* () {
      yield* seedAccount({ accountID: "account-teardown", url: "https://teardown.example.com" })
      const status = yield* SessionStatus.Service
      yield* setRecoveryStatus(sessionID, "coordination_degraded")
      yield* persistCoordinationRecoveryReceipt(plan.receipt)
      expect(yield* status.get(sessionID)).toEqual({ type: "coordination_degraded" })
    }).pipe(provideInstance(dir), Effect.scoped, Effect.provide(runtime)),
  )

  await disposeAllInstances()

  const after = await Effect.runPromise(
    Effect.gen(function* () {
      const status = yield* SessionStatus.Service
      const request = yield* ShareNext.use.request()
      const row = yield* Effect.promise(() =>
        Database.use((db) =>
          db
            .select()
            .from(CoordinationRecoveryTable)
            .where(eq(CoordinationRecoveryTable.id, plan.receipt!.id))
            .execute()
            .then((rows) => rows[0]),
        ),
      )
      return { status: yield* status.get(sessionID), request, row }
    }).pipe(provideInstance(dir), Effect.scoped, Effect.provide(runtime)),
  )

  expect(after.status).toEqual({ type: "idle" })
  expect(after.request.baseUrl).toBe("https://teardown.example.com")
  expect(after.row).toMatchObject({
    session_id: sessionID,
    outcome: "coordination_degraded",
    durable_receipt: true,
  })
})
```

- [ ] **Step 2: Run the focused test file**

Run: `cd packages/opencode && bun test --timeout 30000 test/project/instance-runtime-seam.test.ts`
Expected: three passing tests and no unexpected cross-instance reads.

- [ ] **Step 3: Verify the broader package still typechecks for the touched surface**

Run: `cd packages/opencode && bun typecheck`
Expected: pass, or a clearly unrelated pre-existing failure if one remains outside this seam.

- [ ] **Step 4: Commit the regression harness**

```bash
git add docs/superpowers/plans/2026-06-04-instance-runtime-seam-verification.md packages/opencode/test/project/instance-runtime-seam.test.ts packages/opencode/test/fixture/fixture.ts
git commit -m "test(project): add runtime seam verification"
```
