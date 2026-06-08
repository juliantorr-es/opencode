import type * as SDK from "@opencode-ai/sdk/v2"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { Effect, Exit, Layer, Option, Schema, Scope, Context, Stream } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { Account } from "@/account/account"
import { Bus } from "@/bus"
import { InstanceState } from "@/effect/instance-state"
import { Provider } from "@/provider/provider"
import { ModelID, ProviderID } from "@/provider/schema"
import { Session } from "@/session/session"
import { MessageV2 } from "@/session/message-v2"
import type { SessionID } from "@/session/schema"
import { Database } from "@/storage/db"
import { one } from "@/storage/adapter"
import { eq } from "drizzle-orm"
import { Config } from "@/config/config"
import * as Log from "@opencode-ai/core/util/log"
import { SessionShareTable } from "@/storage/schema"
import {
  enforceCapabilityGovernance,
  shareCreateMetadata,
  getRecoveryState,
  CapabilityContext,
  PrivilegeBoundary,
  CapabilityRefusalError,
  type ApprovalLevel,
} from "@/capability/metadata"
import { evaluateCapabilityAuthority } from "@/capability/authority"
import { persistAuthorityReceipt } from "@/capability/receipts"

const log = Log.create({ service: "share-next" })
function isDisabled() {
  return process.env["OPENCODE_DISABLE_SHARE"] === "true" || process.env["OPENCODE_DISABLE_SHARE"] === "1"
}

export type Api = {
  create: string
  sync: (shareID: string) => string
  remove: (shareID: string) => string
  data: (shareID: string) => string
}

export type Req = {
  headers: Record<string, string>
  api: Api
  baseUrl: string
}

const ShareSchema = Schema.Struct({
  id: Schema.String,
  url: Schema.String,
  secret: Schema.String,
})
export type Share = typeof ShareSchema.Type

type State = {
  queue: Map<SessionID, Map<string, Data>>
  scope: Scope.Closeable
  shared: Map<SessionID, Share | null>
}

type Data =
  | {
      type: "session"
      data: SDK.Session
    }
  | {
      type: "message"
      data: SDK.Message
    }
  | {
      type: "part"
      data: SDK.Part
    }
  | {
      type: "session_diff"
      data: SDK.SnapshotFileDiff[]
    }
  | {
      type: "model"
      data: SDK.Model[]
    }

export interface Interface {
  readonly init: () => Effect.Effect<void, unknown>
  readonly url: () => Effect.Effect<string, unknown>
  readonly request: () => Effect.Effect<Req, unknown>
  readonly create: (sessionID: SessionID) => Effect.Effect<Share, unknown>
  readonly remove: (sessionID: SessionID) => Effect.Effect<void, unknown>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ShareNext") {}

export const use = serviceUse(Service)

const db = <T>(fn: (d: Parameters<typeof Database.use>[0] extends (trx: infer D) => any ? D : never) => T | Promise<T>) =>
  Effect.promise(() => {
    const r = Database.use(fn)
    return r instanceof Promise ? r : Promise.resolve(r)
  })

function api(resource: string): Api {
  return {
    create: `/api/${resource}`,
    sync: (shareID) => `/api/${resource}/${shareID}/sync`,
    remove: (shareID) => `/api/${resource}/${shareID}`,
    data: (shareID) => `/api/${resource}/${shareID}/data`,
  }
}

const legacyApi = api("share")
const consoleApi = api("shares")

function key(item: Data) {
  switch (item.type) {
    case "session":
      return "session"
    case "message":
      return `message/${item.data.id}`
    case "part":
      return `part/${item.data.messageID}/${item.data.id}`
    case "session_diff":
      return "session_diff"
    case "model":
      return "model"
  }
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const account = yield* Account.Service
    const bus = yield* Bus.Service
    const cfg = yield* Config.Service
    const http = yield* HttpClient.HttpClient
    const httpOk = HttpClient.filterStatusOk(http)
    const provider = yield* Provider.Service
    const session = yield* Session.Service

    function sync(sessionID: SessionID, data: Data[]): Effect.Effect<void> {
      return Effect.gen(function* () {
        if (isDisabled()) return
        const share = yield* getCached(sessionID)
        if (!share) return

        const s = yield* InstanceState.get(state)
        const existing = s.queue.get(sessionID)
        if (existing) {
          for (const item of data) {
            existing.set(key(item), item)
          }
          return
        }

        const next = new Map(data.map((item) => [key(item), item]))
        s.queue.set(sessionID, next)
        yield* flush(sessionID).pipe(
          Effect.delay(1000),
          Effect.catchCause((cause) =>
            Effect.sync(() => {
              log.error("share flush failed", { sessionID, cause })
            }),
          ),
          Effect.forkIn(s.scope),
        )
      })
    }

    const state: InstanceState.InstanceState<State> = yield* InstanceState.make<State>(
      Effect.fn("ShareNext.state")(function* (_ctx) {
        const cache: State = { queue: new Map(), scope: yield* Scope.make(), shared: new Map() }

        yield* Effect.addFinalizer(() =>
          Scope.close(cache.scope, Exit.void).pipe(
            Effect.andThen(
              Effect.sync(() => {
                cache.queue.clear()
                cache.shared.clear()
              }),
            ),
          ),
        )

        if (isDisabled()) return cache

        const watch = <D extends { type: string }>(
          def: D,
          fn: (evt: { properties: any }) => Effect.Effect<void, unknown>,
        ) =>
          bus.subscribe(def as never).pipe(
            Effect.flatMap((stream) =>
              stream.pipe(
                Stream.runForEach((evt) =>
                  fn(evt).pipe(
                    Effect.catchCause((cause) =>
                      Effect.sync(() => {
                        log.error("share subscriber failed", { type: def.type, cause })
                      }),
                    ),
                  ),
                ),
                Effect.forkScoped,
              ),
            ),
          )

        yield* watch(Session.Event.Updated, (evt) =>
          Effect.gen(function* () {
            const info = evt.properties.info
            yield* sync(info.id, [{ type: "session", data: info }])
          }),
        )
        yield* watch(MessageV2.Event.Updated, (evt) =>
          Effect.gen(function* () {
            const info = evt.properties.info
            yield* sync(info.sessionID, [{ type: "message", data: info }])
            if (info.role !== "user") return
            const model = yield* provider.getModel(info.model.providerID, info.model.modelID)
            yield* sync(info.sessionID, [{ type: "model", data: [model] }])
          }),
        )
        yield* watch(MessageV2.Event.PartUpdated, (evt) =>
          sync(evt.properties.part.sessionID, [{ type: "part", data: evt.properties.part }]),
        )
        yield* watch(Session.Event.Diff, (evt) =>
          sync(evt.properties.sessionID, [{ type: "session_diff", data: evt.properties.diff }]),
        )
        yield* watch(Session.Event.Deleted, (evt) => remove(evt.properties.sessionID))

        return cache
      }),
    )

    const request = Effect.fn("ShareNext.request")(function* () {
      const headers: Record<string, string> = {}
      const active = yield* account.active()
      if (Option.isNone(active) || !active.value.active_org_id) {
        const baseUrl = (yield* cfg.get()).enterprise?.url ?? "https://opncd.ai"
        return { headers, api: legacyApi, baseUrl } satisfies Req
      }

      const token = yield* account.token(active.value.id)
      if (Option.isNone(token)) {
        throw new Error("No active account token available for sharing")
      }

      headers.authorization = `Bearer ${token.value}`
      headers["x-org-id"] = active.value.active_org_id
      return { headers, api: consoleApi, baseUrl: active.value.url } satisfies Req
    })

    const get = Effect.fnUntraced(function* (sessionID: SessionID) {
      const row = yield* db((db) =>
        one(db.select().from(SessionShareTable).where(eq(SessionShareTable.session_id, sessionID))),
      )
      if (!row) return
      return { id: row.id, secret: row.secret, url: row.url } satisfies Share
    })

    const getCached = Effect.fnUntraced(function* (sessionID: SessionID) {
      const s = yield* InstanceState.get(state)
      if (s.shared.has(sessionID)) {
        const cached = s.shared.get(sessionID)
        return cached === null ? undefined : cached
      }

      const share = yield* get(sessionID)
      s.shared.set(sessionID, share ?? null)
      return share
    })

    const flush = Effect.fn("ShareNext.flush")(function* (sessionID: SessionID) {
      if (isDisabled()) return
      const s = yield* InstanceState.get(state)
      const queued = s.queue.get(sessionID)
      if (!queued) return

      s.queue.delete(sessionID)

      const share = yield* getCached(sessionID)
      if (!share) return

      const req = yield* request()
      const res = yield* HttpClientRequest.post(`${req.baseUrl}${req.api.sync(share.id)}`).pipe(
        HttpClientRequest.setHeaders(req.headers),
        HttpClientRequest.bodyJson({ secret: share.secret, data: Array.from(queued.values()) }),
        Effect.flatMap((r) => http.execute(r)),
      )

      if (res.status >= 400) {
        log.warn("failed to sync share", { sessionID, shareID: share.id, status: res.status })
      }
    })

    const full = Effect.fn("ShareNext.full")(function* (sessionID: SessionID) {
      log.info("full sync", { sessionID })
      const info = yield* session.get(sessionID)
      const diffs = yield* session.diff(sessionID)
      const messages = yield* session.messages({ sessionID })
      const models = yield* Effect.forEach(
        Array.from(
          new Map(
            messages
              .filter((msg) => msg.info.role === "user")
              .map((msg) => (msg.info as SDK.UserMessage).model)
              .map((item) => [`${item.providerID}/${item.modelID}`, item] as const),
          ).values(),
        ),
        (item) => provider.getModel(ProviderID.make(item.providerID), ModelID.make(item.modelID)),
        { concurrency: 8 },
      )

      yield* sync(sessionID, [
        { type: "session", data: info },
        ...messages.map((item) => ({ type: "message" as const, data: item.info })),
        ...messages.flatMap((item) => item.parts.map((part) => ({ type: "part" as const, data: part }))),
        { type: "session_diff", data: diffs },
        { type: "model", data: models },
      ])
    })

    const init = Effect.fn("ShareNext.init")(function* () {
      if (isDisabled()) return
      yield* InstanceState.get(state)
    })

    const url = Effect.fn("ShareNext.url")(function* () {
      return (yield* request()).baseUrl
    })

    const create = Effect.fn("ShareNext.create")(function* (sessionID: SessionID) {
      if (isDisabled()) return { id: "", url: "", secret: "" }

      let projectID: string | undefined = undefined
      try {
        const sess = yield* session.get(sessionID)
        projectID = sess.projectID
      } catch (e) {
        // Nullable projectID fallback
      }

      // Enforce capability governance for share.create
      const recoveryState = yield* getRecoveryState(sessionID, "side-effect")
      const capCtx = yield* Effect.serviceOption(CapabilityContext)
      const grantedBoundaries = Option.isSome(capCtx)
        ? capCtx.value.grantedBoundaries
        : (["none", "filesystem", "network", "secrets", "shell"] as readonly PrivilegeBoundary[])
      const approvalLevelGranted = Option.isSome(capCtx)
        ? capCtx.value.approvalLevelGranted
        : ("auto" as ApprovalLevel)
      const authorityGrants = Option.isSome(capCtx)
        ? capCtx.value.authorityGrants
        : undefined

      const capResult = evaluateCapabilityAuthority({
        metadata: shareCreateMetadata,
        recoveryState,
        grantedBoundaries,
        approvalLevelGranted,
        availableAuthorityGrants: authorityGrants,
      })

      yield* persistAuthorityReceipt({
        capabilityId: shareCreateMetadata.id,
        actionName: "share.create",
        sessionId: sessionID,
        projectId: projectID,
        authorityOutcome: capResult.available ? "allowed" : "refused",
        refusalReasons: capResult.reasons,
        authorityChain: capResult.authorityChain,
        missingAuthority: capResult.missingAuthority,
        recoveryState,
        approvalLevel: shareCreateMetadata.approvalLevel,
        privilegeBoundaries: [...shareCreateMetadata.privilegeBoundaries],
        consentClass: capResult.consentClass,
      })

      if (!capResult.available) {
        const reason = capResult.reasons[0] as any
        return yield* Effect.fail(
          new CapabilityRefusalError({
            reason: reason || "coordination_state_blocks_side_effect",
            message: capResult.message || "Capability share.create refused",
          })
        )
      }

      log.info("creating share", { sessionID })
      const req = yield* request()
      const result = yield* HttpClientRequest.post(`${req.baseUrl}${req.api.create}`).pipe(
        HttpClientRequest.setHeaders(req.headers),
        HttpClientRequest.bodyJson({ sessionID }),
        Effect.flatMap((r) => httpOk.execute(r)),
        Effect.flatMap(HttpClientResponse.schemaBodyJson(ShareSchema)),
      )
      yield* db((db) =>
        db
          .insert(SessionShareTable)
          .values({ session_id: sessionID, id: result.id, secret: result.secret, url: result.url })
          .onConflictDoUpdate({
            target: SessionShareTable.session_id,
            set: { id: result.id, secret: result.secret, url: result.url },
          })
          .execute(),
      )
      const s = yield* InstanceState.get(state)
      s.shared.set(sessionID, result)
      yield* full(sessionID).pipe(
        Effect.catchCause((cause) =>
          Effect.sync(() => {
            log.error("share full sync failed", { sessionID, cause })
          }),
        ),
        Effect.forkIn(s.scope),
      )
      return result
    })

    const remove = Effect.fn("ShareNext.remove")(function* (sessionID: SessionID) {
      if (isDisabled()) return
      log.info("removing share", { sessionID })
      const s = yield* InstanceState.get(state)
      const share = yield* getCached(sessionID)
      if (!share) {
        s.shared.delete(sessionID)
        s.queue.delete(sessionID)
        return
      }

      const req = yield* request()
      yield* HttpClientRequest.delete(`${req.baseUrl}${req.api.remove(share.id)}`).pipe(
        HttpClientRequest.setHeaders(req.headers),
        HttpClientRequest.bodyJson({ secret: share.secret }),
        Effect.flatMap((r) => httpOk.execute(r)),
      )

      yield* db((db) => db.delete(SessionShareTable).where(eq(SessionShareTable.session_id, sessionID)).execute())
      s.shared.delete(sessionID)
      s.queue.delete(sessionID)
    })

    return Service.of({ init, url, request, create, remove })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(Bus.layer),
  Layer.provide(Account.defaultLayer),
  Layer.provide(Config.defaultLayer),
  Layer.provide(FetchHttpClient.layer),
  Layer.provide(Provider.defaultLayer),
  Layer.provide(Session.defaultLayer),
)

export * as ShareNext from "./share-next"
