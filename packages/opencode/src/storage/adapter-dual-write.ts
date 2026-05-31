/**
 * PG-001: Dual-write adapter.
 *
 * Wraps SQLite (primary) and Postgres (shadow) adapters with best-effort
 * asynchronous shadow writes to PG. PG failures are logged, not fatal.
 *
 * @experimental — no transaction coordination; use only during migration.
 */
import { Effect, Layer, Option, Redacted } from "effect"
import { DatabaseConfig } from "@/effect/database-config"
import * as Log from "@opencode-ai/core/util/log"
import {
  DatabaseError,
  type DrizzleLikeClient,
  type Interface as AdapterInterface,
  type TransactionOptions,
  Service,
  makeLocalPgAdapter,
  makePgAdapter,
} from "./adapter"

const log = Log.create({ service: "dual-write-adapter" })

/**
 * Create a dual-write adapter. SQLite is primary; PG is an async shadow.
 */
export function makeDualWriteAdapter(
  sqliteAdapter: AdapterInterface,
  pgAdapter: AdapterInterface,
): AdapterInterface {
  const shadowQuery = <T>(fn: (db: DrizzleLikeClient) => T | Promise<T>): void => {
    Effect.runPromise(
      Effect.tryPromise({
        try: () => Effect.runPromise(pgAdapter.query(fn)) as any,
        catch: (cause) => {
          log.warn("dual-write: PG shadow query failed", { error: String(cause) })
        },
      }),
    )
  }

  const shadowTransaction = <T>(
    fn: (db: DrizzleLikeClient) => T | Promise<T>,
    options?: TransactionOptions,
  ): void => {
    Effect.runPromise(
      Effect.tryPromise({
        try: () => Effect.runPromise(pgAdapter.transaction(fn, options)) as any,
        catch: (cause) => {
          log.warn("dual-write: PG shadow transaction failed", { error: String(cause) })
        },
      }),
    )
  }

  const query = <T>(fn: (db: DrizzleLikeClient) => T | Promise<T>): Effect.Effect<T, DatabaseError> =>
    sqliteAdapter.query((sqliteDb) => {
      const result = fn(sqliteDb)
      if (result instanceof Promise) {
        return result.then((resolved) => {
          shadowQuery(fn)
          return resolved
        })
      }
      shadowQuery(fn)
      return result
    })

  const transaction = <T>(
    fn: (db: DrizzleLikeClient) => T | Promise<T>,
    options?: TransactionOptions,
  ): Effect.Effect<T, DatabaseError> =>
    sqliteAdapter.transaction((sqliteTx) => {
      const result = fn(sqliteTx)
      if (result instanceof Promise) {
        return result.then((resolved) => {
          shadowTransaction(fn, options)
          return resolved
        })
      }
      shadowTransaction(fn, options)
      return result
    })

  const afterCommit = (fn: () => void): Effect.Effect<void> => sqliteAdapter.afterCommit(fn)

  return Service.of({ query, transaction, afterCommit })
}

/**
 * Dual-write adapter layer — enabled when a PG URL is configured.
 * Uses Layer.unwrap to select between SQLite-only and dual-write at
 * layer-construction time (not module-load time), with DatabaseConfig
 * provided by the embedded Layer.provide.
 */
export const dualWriteAdapterLayer: Layer.Layer<typeof Service> = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* DatabaseConfig.Service

    if (Option.isSome(config.url)) {
      const url = Redacted.value(config.url.value)
      log.info("dual-write adapter enabled — all writes shadowed to PG", {
        pgUrl: url.replace(/\/\/.*@/, "//****@"),
      })
      return Layer.effect(
        Service,
        Effect.sync(() => makeDualWriteAdapter(makeLocalPgAdapter(), makePgAdapter({
          connectionString: url,
          ssl: config.ssl,
          poolSize: config.poolSize,
        }))),
      ) as Layer.Layer<typeof Service>
    }

    log.info("dual-write adapter: no PG URL configured — using SQLite only")
    return Layer.effect(
      Service,
      Effect.sync(() => makeLocalPgAdapter()),
    ) as Layer.Layer<typeof Service>
  }),
).pipe(Layer.provide(DatabaseConfig.defaultLayer))
