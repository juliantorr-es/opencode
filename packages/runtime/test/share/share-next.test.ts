import { describe, expect, test } from "bun:test"
import { Effect, Exit, Layer } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { CrossSpawnSpawner } from "@tribunus/core/cross-spawn-spawner"
import { AccessToken, AccountID, OrgID, RefreshToken } from "../../src/account/schema"
import { Bus } from "../../src/bus"
import { Account } from "../../src/account/account"
import { DatabaseAdapter } from "@/storage/adapter"
import { Config } from "../../src/config/config"
import { Session } from "../../src/session/session"
import type { SessionID } from "../../src/session/schema"
import { ShareNext } from "@/share/share-next"
import { SessionShareTable } from "../../src/share/share.pg.sql"
import { Database } from "@/storage/db"
import { AccountStateTable, AccountTable } from "../../src/account/account.pg.sql"
import { eq } from "drizzle-orm"
import { Provider } from "../../src/provider/provider"
import { provideTmpdirInstance } from "../fixture/fixture"
import { CapabilityContext } from "../../src/capability/metadata"

const json = (req: Parameters<typeof HttpClientResponse.fromWeb>[0], body: unknown, status = 200) =>
  HttpClientResponse.fromWeb(
    req,
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  )

const none = HttpClient.make(() => Effect.die("unexpected http call"))

const runtime = (client: HttpClient.HttpClient) =>
  Layer.mergeAll(
    ShareNext.layer.pipe(
      Layer.provide(Bus.layer),
      Layer.provide(Account.defaultLayer),
      Layer.provide(Config.defaultLayer),
      Layer.provide(Provider.defaultLayer),
      Layer.provide(Session.defaultLayer),
      Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
    ),
    CrossSpawnSpawner.defaultLayer,
    DatabaseAdapter.defaultLayer,
    Bus.layer,
    Session.defaultLayer,
  )

const run = <A, E, R>(client: HttpClient.HttpClient, effect: Effect.Effect<A, E, R>) =>
  // The test runtime is set up to provide the environment, so we cast to bypass Effect typecheck mismatch
  Effect.runPromise(
    effect.pipe(
      Effect.scoped,
      Effect.provide(runtime(client)),
      Effect.provideService(CapabilityContext, {
        grantedBoundaries: ["filesystem", "network", "secrets", "shell"],
        approvalLevelGranted: "human",
      }),
    ) as any,
  )

const share = (id: SessionID) =>
  Effect.promise(() =>
    Database.use((db: any) =>
      db.select().from(SessionShareTable).where(eq(SessionShareTable.session_id, id)).execute().then((rows: any[]) => rows[0] as any),
    ),
  )

const seed = (url: string, org?: string) =>
  Effect.promise(() =>
    Database.use(async (db) => {
      const now = Date.now()
      await db.delete(AccountStateTable).execute()
      await db.delete(AccountTable).execute()
      await db.insert(AccountTable).values({
        id: AccountID.make("account-1"),
        email: "user@example.com",
        url,
        access_token: AccessToken.make("st_test_token"),
        refresh_token: RefreshToken.make("rt_test_token"),
        token_expiry: now + 10 * 60_000,
        time_created: now,
        time_updated: now,
      }).execute()
      await db.insert(AccountStateTable).values({
        id: 1,
        active_account_id: AccountID.make("account-1"),
        active_org_id: org ? OrgID.make(org) : null,
      }).execute()
    }),
  )

describe("ShareNext", () => {
  test("request uses legacy share API without active org account", async () => {
    await run(
      none,
      provideTmpdirInstance(
        () =>
          Effect.gen(function* () {
            yield* seed("https://legacy-share.example.com")

            const req = yield* ShareNext.Service.use((svc) => svc.request()).pipe(
              Effect.provideService(HttpClient.HttpClient, none),
            )

            expect(req.api.create).toBe("/api/share")
            expect(req.api.sync("shr_123")).toBe("/api/share/shr_123/sync")
            expect(req.api.remove("shr_123")).toBe("/api/share/shr_123")
            expect(req.api.data("shr_123")).toBe("/api/share/shr_123/data")
            expect(req.baseUrl).toBe("https://legacy-share.example.com")
            expect(req.headers).toEqual({})
          }),
        { config: { enterprise: { url: "https://legacy-share.example.com" } } },
      ),
    )
  })

  test("request uses default URL when no enterprise config", async () => {
    await run(
      none,
      provideTmpdirInstance(() =>
        Effect.gen(function* () {
          const req = yield* ShareNext.Service.use((svc) => svc.request()).pipe(
            Effect.provideService(HttpClient.HttpClient, none),
          )

          expect(req.baseUrl).toBe("https://opncd.ai")
          expect(req.api.create).toBe("/api/share")
          expect(req.headers).toEqual({})
        }),
      ),
    )
  })

  test("request uses org share API with auth headers when account is active", async () => {
    await run(
      none,
      provideTmpdirInstance(
        () =>
          Effect.gen(function* () {
            yield* seed("https://control.example.com", "org-1")

            const req = yield* ShareNext.use.request()

            expect(req.api.create).toBe("/api/shares")
            expect(req.api.sync("shr_123")).toBe("/api/shares/shr_123/sync")
            expect(req.api.remove("shr_123")).toBe("/api/shares/shr_123")
            expect(req.api.data("shr_123")).toBe("/api/shares/shr_123/data")
            expect(req.baseUrl).toBe("https://control.example.com")
            expect(req.headers).toEqual({
              authorization: "Bearer st_test_token",
              "x-org-id": "org-1",
            })
          }),
        { config: { enterprise: { url: "https://control.example.com" } } },
      ),
    )
  })

  test("create posts share, persists it, and returns the result", async () => {
    const seen: HttpClientRequest.HttpClientRequest[] = []
    const client = HttpClient.make((req) => {
      seen.push(req)
      if (req.url.endsWith("/api/share")) {
        return Effect.succeed(
          json(req, {
            id: "shr_abc",
            url: "https://legacy-share.example.com/share/abc",
            secret: "sec_123",
          }),
        )
      }
      return Effect.succeed(json(req, { ok: true }))
    })

    await run(
      client,
      provideTmpdirInstance(
        () =>
          Effect.gen(function* () {
            yield* seed("https://legacy-share.example.com")
            const session = yield* Session.use.create({ title: "test" })

            const result = yield* ShareNext.use.create(session.id)

            expect(result.id).toBe("shr_abc")
            expect(result.url).toBe("https://legacy-share.example.com/share/abc")
            expect(result.secret).toBe("sec_123")

            const row = (yield* share(session.id)) as any
            expect(row?.id).toBe("shr_abc")
            expect(row?.url).toBe("https://legacy-share.example.com/share/abc")
            expect(row?.secret).toBe("sec_123")

            expect(seen).toHaveLength(1)
            expect(seen[0].method).toBe("POST")
            expect(seen[0].url).toBe("https://legacy-share.example.com/api/share")
          }),
        { config: { enterprise: { url: "https://legacy-share.example.com" } } },
      ),
    )
  })

  test("remove deletes the persisted share and calls the delete endpoint", async () => {
    const seen: HttpClientRequest.HttpClientRequest[] = []
    const client = HttpClient.make((req) => {
      seen.push(req)
      if (req.method === "POST") {
        return Effect.succeed(
          json(req, {
            id: "shr_abc",
            url: "https://legacy-share.example.com/share/abc",
            secret: "sec_123",
          }),
        )
      }
      return Effect.succeed(HttpClientResponse.fromWeb(req, new Response(null, { status: 200 })))
    })

    await run(
      client,
      provideTmpdirInstance(
        () =>
          Effect.gen(function* () {
            yield* seed("https://legacy-share.example.com")
            const session = yield* Session.use.create({ title: "test" })

            yield* ShareNext.use.create(session.id)
            yield* ShareNext.use.remove(session.id)

            expect(yield* share(session.id)).toBeUndefined()
            expect(seen.map((req) => [req.method, req.url])).toEqual([
              ["POST", "https://legacy-share.example.com/api/share"],
              ["DELETE", "https://legacy-share.example.com/api/share/shr_abc"],
            ])
          }),
        { config: { enterprise: { url: "https://legacy-share.example.com" } } },
      ),
    )
  })

  test("create fails on a non-ok response and does not persist a share", async () => {
    const client = HttpClient.make((req) => Effect.succeed(json(req, { error: "bad" }, 500)))

    await run(
      client,
      provideTmpdirInstance(
        () =>
          Effect.gen(function* () {
            yield* seed("https://legacy-share.example.com")
            const session = yield* Session.use.create({ title: "test" })

            const exit = yield* ShareNext.Service.use((svc) => Effect.exit(svc.create(session.id)))

            expect(Exit.isFailure(exit)).toBe(true)
            expect(yield* share(session.id)).toBeUndefined()
          }),
        { config: { enterprise: { url: "https://legacy-share.example.com" } } },
      ),
    )
  })

  test("ShareNext coalesces rapid diff events into one delayed sync with latest data", async () => {
    const seen: Array<{ url: string; body: string }> = []
    const syncClient = HttpClient.make((req) => {
      if (req.url.endsWith("/sync") && req.body._tag === "Uint8Array") {
        seen.push({ url: req.url, body: new TextDecoder().decode(req.body.body) })
      }
      return Effect.succeed(json(req, { ok: true }))
    })

    await run(
      syncClient,
      provideTmpdirInstance(
        () =>
          Effect.gen(function* () {
            yield* seed("https://legacy-share.example.com")
            const bus = yield* Bus.Service
            const share = yield* ShareNext.Service
            const session = yield* Session.Service

            const info = yield* session.create({ title: "first" })
            yield* share.init()
            yield* Effect.sleep(50)
            yield* Effect.sync(() =>
              Database.use((db) =>
                db
                  .insert(SessionShareTable)
                  .values({
                    session_id: info.id,
                    id: "shr_abc",
                    url: "https://legacy-share.example.com/share/abc",
                    secret: "sec_123",
                  })
                  .execute(),
              ),
            )

            yield* bus.publish(Session.Event.Diff, {
              sessionID: info.id,
              diff: [
                {
                  file: "a.ts",
                  patch:
                    "Index: a.ts\n===================================================================\n--- a.ts\t\n+++ a.ts\t\n@@ -1,1 +1,1 @@\n-one\n\\ No newline at end of file\n+two\n\\ No newline at end of file\n",
                  additions: 1,
                  deletions: 1,
                  status: "modified",
                },
              ],
            })
            yield* bus.publish(Session.Event.Diff, {
              sessionID: info.id,
              diff: [
                {
                  file: "b.ts",
                  patch:
                    "Index: b.ts\n===================================================================\n--- b.ts\t\n+++ b.ts\t\n@@ -1,1 +1,1 @@\n-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file\n",
                  additions: 2,
                  deletions: 0,
                  status: "modified",
                },
              ],
            })
            yield* Effect.sleep(1_250)

            expect(seen).toHaveLength(1)
            expect(seen[0].url).toBe("https://legacy-share.example.com/api/share/shr_abc/sync")

            const body = JSON.parse(seen[0].body) as {
              secret: string
              data: Array<{
                type: string
                data: Array<{
                  file: string
                  patch: string
                  additions: number
                  deletions: number
                  status?: string
                }>
              }>
            }
            expect(body.secret).toBe("sec_123")
            expect(body.data).toHaveLength(1)
            expect(body.data[0].type).toBe("session_diff")
            expect(body.data[0].data).toEqual([
              {
                file: "b.ts",
                patch:
                  "Index: b.ts\n===================================================================\n--- b.ts\t\n+++ b.ts\t\n@@ -1,1 +1,1 @@\n-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file\n",
                additions: 2,
                deletions: 0,
                status: "modified",
              },
            ])
          }),
        { config: { enterprise: { url: "https://legacy-share.example.com" } } },
      ),
    )
  })
})
