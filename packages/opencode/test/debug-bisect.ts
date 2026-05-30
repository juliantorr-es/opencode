/**
 * Bisect debug: builds route layers incrementally to isolate which sub-layer
 * triggers the DatabaseAdapter "Service not found" error.
 *
 * Usage: bun run test/debug-bisect.ts
 */
import { ConfigProvider, Effect, Layer, Scope } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { createServer } from "node:http"
import { NodeHttpServer } from "@effect/platform-node"
import { HttpApiApp } from "../src/server/routes/instance/httpapi/server"
import { disposeMiddleware } from "../src/server/routes/instance/httpapi/lifecycle"
import { WebSocketTracker } from "../src/server/routes/instance/httpapi/websocket-tracker"
import { DatabaseAdapter } from "../src/storage/adapter"

type Step = { label: string; build: () => Layer.Layer<any, any, any> }

const steps: Step[] = [
  {
    label: "1. DatabaseAdapter.defaultLayer alone",
    build: () =>
      DatabaseAdapter.defaultLayer.pipe(
        Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv())),
      ) as Layer.Layer<any, any, any>,
  },
  {
    label: "2. createRoutes() alone",
    build: () =>
      HttpApiApp.createRoutes().pipe(
        Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv())),
      ) as Layer.Layer<any, any, any>,
  },
  {
    label: "3. createRoutes() + DatabaseAdapter provided",
    build: () =>
      HttpApiApp.createRoutes().pipe(
        Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv())),
        Layer.provide(DatabaseAdapter.defaultLayer),
      ) as Layer.Layer<any, any, any>,
  },
  {
    label: "4. Full listenerLayer [with DB fix]",
    build: () =>
      HttpRouter.serve(HttpApiApp.createRoutes(), {
        middleware: disposeMiddleware,
        disableLogger: true,
        disableListenLog: true,
      }).pipe(
        Layer.provideMerge(DatabaseAdapter.defaultLayer),
        Layer.provideMerge(WebSocketTracker.layer),
        Layer.provideMerge(
          NodeHttpServer.layer(() => createServer(), {
            port: 0,
            host: "127.0.0.1",
            gracefulShutdownTimeout: "1 second",
          }),
        ),
        Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv())),
      ),
  },
]

async function main() {
  for (const step of steps) {
    console.log(`\n=== ${step.label} ===`)
    const scope = Scope.makeUnsafe()
    const memoMap = Layer.makeMemoMapUnsafe()
    try {
      const ctx = await Effect.runPromise(
        Layer.buildWithMemoMap(step.build(), memoMap, scope) as any,
      )
      const has = (ctx as any).mapUnsafe.has("@opencode/DatabaseAdapter")
      console.log(`  ✅ PASS (keys: ${(ctx as any).mapUnsafe.size}, has DB: ${has})`)
    } catch (err: any) {
      console.log(`  ❌ FAIL: ${err.message || String(err)}`)
    }
  }
}

main()
