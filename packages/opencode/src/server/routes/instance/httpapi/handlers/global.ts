import { Config } from "@/config/config"
import { GlobalBus, type GlobalEvent as GlobalBusEvent } from "@/bus/global"
import { EffectBridge } from "@/effect/bridge"
import { Bus } from "@/bus"
import { Installation } from "@/installation"
import { disposeAllInstancesAndEmitGlobalDisposed } from "@/server/global-lifecycle"
import { HealthRegistry } from "@/server/health"
import { Service as InstanceHealthStoreService } from "@/project/instance-health"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import * as Log from "@opencode-ai/core/util/log"
import { Effect, Option, Queue, Schema } from "effect"
import * as Stream from "effect/Stream"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import * as Sse from "effect/unstable/encoding/Sse"
import { RootHttpApi } from "../api"
import { GlobalUpgradeInput } from "../groups/global"
import { Database } from "@/storage/db"

const log = Log.create({ service: "server" })

function eventData(data: unknown): Sse.Event {
  return {
    _tag: "Event",
    event: "message",
    id: undefined,
    data: JSON.stringify(data),
  }
}

function parseBody(body: string) {
  try {
    return JSON.parse(body || "{}") as unknown
  } catch {
    return undefined
  }
}

function eventResponse() {
  log.info("global event connected")
  const events = Stream.callback<GlobalBusEvent>((queue) => {
    const handler = (event: GlobalBusEvent) => Queue.offerUnsafe(queue, event)
    return Effect.acquireRelease(
      Effect.sync(() => GlobalBus.on("event", handler)),
      () => Effect.sync(() => GlobalBus.off("event", handler)),
    )
  })
  const heartbeat = Stream.tick("10 seconds").pipe(
    Stream.drop(1),
    Stream.map(() => ({ payload: { id: Bus.createID(), type: "server.heartbeat", properties: {} } })),
  )

  return HttpServerResponse.stream(
    Stream.make({ payload: { id: Bus.createID(), type: "server.connected", properties: {} } }).pipe(
      Stream.concat(events.pipe(Stream.merge(heartbeat, { haltStrategy: "left" }))),
      Stream.map(eventData),
      Stream.pipeThroughChannel(Sse.encode()),
      Stream.encodeText,
      Stream.ensuring(Effect.sync(() => log.info("global event disconnected"))),
    ),
    {
      contentType: "text/event-stream",
      headers: {
        "Cache-Control": "no-cache, no-transform",
        "X-Accel-Buffering": "no",
        "X-Content-Type-Options": "nosniff",
      },
    },
  )
}

export const globalHandlers = HttpApiBuilder.group(RootHttpApi, "global", (handlers) =>
  Effect.gen(function* () {
    const config = yield* Config.Service
    const installation = yield* Installation.Service
    const bridge = yield* EffectBridge.make()

    const health = Effect.fn("GlobalHttpApi.health")(function* () {
      const registry = yield* Effect.serviceOption(HealthRegistry)
      const components = Option.isSome(registry) ? yield* registry.value.getAll() : undefined
      const healthStore = yield* Effect.serviceOption(InstanceHealthStoreService)
      let instance_healthy: boolean | undefined
      if (Option.isSome(healthStore)) {
        const all = yield* healthStore.value.getAll()
        instance_healthy = all.size === 0 ? undefined : [...all.values()].every(h => h.status === "ready")
      }
      return { healthy: true as const, version: InstallationVersion, components, instance_healthy }
    })

    const event = Effect.fn("GlobalHttpApi.event")(function* () {
      return eventResponse()
    })

    const configGet = Effect.fn("GlobalHttpApi.configGet")(function* () {
      return yield* config.getGlobal()
    })

    const configUpdate = Effect.fn("GlobalHttpApi.configUpdate")(function* (ctx) {
      const result = yield* config.updateGlobal(ctx.payload)
      if (result.changed) bridge.fork(disposeAllInstancesAndEmitGlobalDisposed({ swallowErrors: true }))
      return result.info
    })

    const dispose = Effect.fn("GlobalHttpApi.dispose")(function* () {
      yield* disposeAllInstancesAndEmitGlobalDisposed()
      return true
    })

    const upgrade = Effect.fn("GlobalHttpApi.upgrade")(function* (ctx: { payload: typeof GlobalUpgradeInput.Type }) {
      const method = yield* installation.method()
      if (method === "unknown") {
        return {
          status: 400,
          body: { success: false as const, error: "Unknown installation method" },
        }
      }
      const target = ctx.payload.target || (yield* installation.latest(method))
      const result = yield* installation.upgrade(method, target).pipe(
        Effect.as({ status: 200, body: { success: true as const, version: target } }),
        Effect.catch((err) =>
          Effect.succeed({
            status: 500,
            body: {
              success: false as const,
              error: err instanceof Error ? err.message : String(err),
            },
          }),
        ),
      )
      if (!result.body.success) return result
      GlobalBus.emit("event", {
        directory: "global",
        payload: {
          type: Installation.Event.Updated.type,
          properties: { version: target },
        },
      })
      return result
    })

    const upgradeRaw = Effect.fn("GlobalHttpApi.upgradeRaw")(function* (ctx: {
      request: HttpServerRequest.HttpServerRequest
    }) {
      const body = yield* Effect.orDie(ctx.request.text)
      const json = parseBody(body)
      if (json === undefined) {
        return HttpServerResponse.jsonUnsafe({ success: false, error: "Invalid request body" }, { status: 400 })
      }
      const payload = yield* Schema.decodeUnknownEffect(GlobalUpgradeInput)(json).pipe(
        Effect.map((payload) => ({ valid: true as const, payload })),
        Effect.catch(() => Effect.succeed({ valid: false as const })),
      )
      if (!payload.valid) {
        return HttpServerResponse.jsonUnsafe({ success: false, error: "Invalid request body" }, { status: 400 })
      }
      return yield* upgrade({ payload: payload.payload })
    })

    const diagnostics = Effect.fn("GlobalHttpApi.diagnostics")(function* () {
      const healthStore = yield* Effect.serviceOption(InstanceHealthStoreService)
      let instanceCount = 0
      let instanceHealthy = 0
      const instances: { directory: string; status: string }[] = []
      if (Option.isSome(healthStore)) {
        const all = yield* healthStore.value.getAll()
        instanceCount = all.size
        for (const [dir, h] of all) {
          instanceHealthy += h.status === "ready" ? 1 : 0
          instances.push({ directory: dir, status: h.status })
        }
      }
      const config = yield* Config.Service
      return {
        classification: instanceCount === 0 ? "fresh_empty_db" : instanceHealthy === instanceCount ? "all_healthy" : "degraded",
        recommendation: instanceCount === 0 ? "open_project" : instanceHealthy < instanceCount ? "inspect_failing_instances" : null,
        sidecarReady: true,
        instanceCount,
        instanceHealthy,
        instances,
        dataPath: (process.env.TRIBUNUS_STATE_HOME || process.env.OPENCODE_STATE_HOME)
          ? `${process.env.TRIBUNUS_STATE_HOME || process.env.OPENCODE_STATE_HOME}/pglite`
          : "unknown",
        statePath: process.env.TRIBUNUS_STATE_HOME || process.env.OPENCODE_STATE_HOME || "unknown",
        configPath: process.env.TRIBUNUS_CONFIG_HOME || process.env.OPENCODE_CONFIG_HOME || "unknown",
        cachePath: process.env.TRIBUNUS_CACHE_HOME || process.env.OPENCODE_CACHE_HOME || "unknown",
        logPath: process.env.TRIBUNUS_LOG_HOME || process.env.OPENCODE_LOG_HOME || "unknown",
        client: process.env.OPENCODE_CLIENT ?? "unknown",
        warnings: [] as { code: string; message: string }[],
        coordination: {
          backend: "local",
          valkeyReady: false,
          url: null,
          pid: null,
          mode: "ephemeral",
          persistence: "disabled",
          lastError: null,
          featureFlag: process.env.OPENCODE_COORDINATION_BACKEND ?? "local",
        },
      }
    })
    return handlers
      .handle("health", health)
      .handleRaw("event", event)
      .handle("configGet", configGet)
      .handle("configUpdate", configUpdate)
      .handle("dispose", dispose)
      .handleRaw("upgrade", upgradeRaw as any)
      .handle("diagnostics", diagnostics)
  }),
)