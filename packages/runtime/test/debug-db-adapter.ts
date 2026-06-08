/**
 * Debug script: traces DatabaseAdapter.Service access and layer build order
 * to identify which layer construction triggers the "Service not found" error.
 *
 * Usage: bun run test/debug-db-adapter.ts
 */
import { ConfigProvider, Effect, Layer, Scope, Context } from "effect"
import { HttpApiApp } from "../src/server/routes/instance/httpapi/server"
import { DatabaseAdapter } from "../src/storage/adapter"

// ── Patch DatabaseAdapter.Service to log every access ──────────────────

const originalKey = DatabaseAdapter.Service.key
const patchedService = Object.assign(
  class extends (DatabaseAdapter.Service as any) {},
  {
    key: originalKey,
    pipe(...args: any[]) {
      const stack = new Error().stack?.split("\n").slice(2, 6).join("\n→ ")
      console.log(`[TRACE] DatabaseAdapter.Service accessed from:\n→ ${stack}`)
      return (DatabaseAdapter.Service as any).pipe(...args)
    },
  },
)

// ── Build and trace ───────────────────────────────────────────────────

async function main() {
  const routes = HttpApiApp.createRoutes()

  const scope = Scope.makeUnsafe()
  const memoMap = Layer.makeMemoMapUnsafe()

  console.log("=== Building routes layer ===")
  try {
    const ctx = await Effect.runPromise(
      Layer.buildWithMemoMap(
        routes.pipe(Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv()))),
        memoMap,
        scope,
      ) as any,
    )
    console.log("\n=== SUCCESS ===")
    const keys = [...(ctx as any).mapUnsafe.keys()]
    console.log("Context keys:", keys.length)
    console.log("Has DatabaseAdapter:", (ctx as any).mapUnsafe.has(originalKey))
  } catch (err: any) {
    console.log("\n=== FAILED ===")
    console.log("Error:", err.message || String(err))
    if (err.cause) console.log("Cause:", err.cause)
  }
}

main()
