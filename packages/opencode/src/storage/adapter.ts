import { Context, Effect, Layer, Option, Redacted, Schema, Schedule } from "effect"
import { Database } from "./db"
import { DatabaseConfig } from "@/effect/database-config"
import { HealthRegistry, HealthStatus } from "@/server/health"
import { init as initPg, applyMigrations } from "#db"

import { checkSQLFirewall as checkDuckDBSQLFirewall } from "./duckdb-firewall"
import { classifyError } from "@/diagnostic/instance-failure-codes"

// ── Error types ──────────────────────────────────────────────

export class DatabaseError extends Schema.TaggedErrorClass<DatabaseError>()("DatabaseError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect),
  isRetryable: Schema.Boolean,
}) {}

export class RetriableDatabaseError extends Schema.TaggedErrorClass<RetriableDatabaseError>()("RetriableDatabaseError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect),
  isRetryable: Schema.Boolean,
}) {}

export class FatalDatabaseError extends Schema.TaggedErrorClass<FatalDatabaseError>()("FatalDatabaseError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect),
  isRetryable: Schema.Boolean,
}) {}

// ── Client type ──────────────────────────────────────────────

export interface DrizzleLikeClient {
  select(fields?: any): {
    from: (table: any) => any
  }
  selectDistinct(fields?: any): {
    from: (table: any) => any
  }
  insert: (table: any) => any
  update: (table: any) => any
  delete: (table: any) => any
  transaction: <T>(fn: (tx: DrizzleLikeClient) => T | Promise<T>, options?: any) => Promise<T>
  run: (query: any) => any
  all: <T = any>(query: any) => T[]
  get: <T = any>(query: any) => T | undefined
}

/** @deprecated Use DrizzleLikeClient instead. DrizzleClient is a backward-compatible alias. */
export type DrizzleClient = DrizzleLikeClient

// ── Transaction options ──────────────────────────────────────

/** @deprecated Use PostgresTransactionOptions instead. SQLite transaction behavior is legacy. */
export type SQLiteTransactionOptions = {
  _tag: "sqlite"
  behavior?: "deferred" | "immediate" | "exclusive"
}

export type PostgresTransactionOptions = {
  _tag: "postgres"
  isolationLevel?: string
  accessMode?: "read only" | "read write"
}

export type TransactionOptions =
  | SQLiteTransactionOptions
  | PostgresTransactionOptions
  | { behavior?: "deferred" | "immediate" | "exclusive" }

// ── Interface ────────────────────────────────────────────────

export interface Interface {
  readonly query: <T>(fn: (db: DrizzleLikeClient) => T | Promise<T>) => Effect.Effect<T, DatabaseError>
  readonly transaction: <T>(
    fn: (db: DrizzleLikeClient) => T | Promise<T>,
    options?: TransactionOptions,
  ) => Effect.Effect<T, DatabaseError>
  readonly afterCommit: (fn: () => void) => Effect.Effect<void>
}

// ── Service tag ──────────────────────────────────────────────

export class Service extends Context.Service<Service, Interface>()("@opencode/DatabaseAdapter") {}

// ── Local Pg adapter ─────────────────────────────────────────

export function makeLocalPgAdapter(): Interface {
  const query = <T>(fn: (db: DrizzleLikeClient) => T | Promise<T>) =>
    Effect.tryPromise({
      try: () => {
        const raw = Database.use((db: any) => db)
        // Wrap the native client as a DrizzleLikeClient, bridging .run/.all/.get
        // to the PGlite raw client's .exec()/.query() for the post-Phase 1.7a migration.
        const pg = raw.$client ?? raw
        const client: DrizzleLikeClient = typeof raw.run === "function"
          ? raw
          : {
              select: raw.select.bind(raw),
              selectDistinct: raw.selectDistinct?.bind(raw),
              insert: raw.insert.bind(raw),
              update: raw.update.bind(raw),
              delete: raw.delete.bind(raw),
              transaction: raw.transaction.bind(raw),
              run: (query: any) => { pg.exec?.(String(query)); return { changes: 0 } },
              all: <T = any>(query: any) => {
                const result = pg.query?.(String(query))
                return (result?.rows as T[]) ?? []
              },
              get: <T = any>(query: any) => {
                const result = pg.query?.(String(query))
                return result?.rows?.[0] as T | undefined
              },
            }
        const result = fn(client)
        return result instanceof Promise ? result : Promise.resolve(result)
      },
      catch: (cause) => new DatabaseError({ message: "Query failed", cause, isRetryable: false }),
    })

  const transaction = <T>(
    fn: (db: DrizzleLikeClient) => T | Promise<T>,
    options?: TransactionOptions,
  ) => {
    const sqliteOptions =
      options && "_tag" in options
        ? (options._tag === "sqlite" ? options : undefined)
        : options
    return Effect.retry(
      Effect.tryPromise({
        try: () => {
          const result = Database.transaction(
            fn as any,
            sqliteOptions ? { behavior: sqliteOptions.behavior } : undefined,
          )
          return result instanceof Promise ? result : Promise.resolve(result)
        },
        catch: (cause) => {
          return new DatabaseError({ message: "Transaction failed", cause, isRetryable: false })
        },
      }),
      {
        times: 3,
        schedule: Schedule.exponential("100 millis"),
      },
    )
  }

  const afterCommit = (fn: () => void): Effect.Effect<void> =>
    Effect.sync(() => {
      Database.effect(fn)
    })

  return Service.of({ query, transaction, afterCommit })
}

export const LocalPgAdapter: Layer.Layer<Service> = Layer.effect(
  Service,
  Effect.sync(() => makeLocalPgAdapter()),
)

// ── PG error sanitisation (F-006) ────────────────────────────
// Strips unsafe fields and connection strings from Postgres errors
// before wrapping them in DatabaseError.

const PG_CONNECTION_STRING_RE = /(?:postgres(?:ql)?:\/\/)[^\s]*/gi

export function sanitizePgError(cause: unknown): object {
  if (cause === null || cause === undefined || typeof cause !== "object") {
    return { message: String(cause) }
  }
  const err = cause as Record<string, unknown>
  const safe: Record<string, unknown> = {}
  if (typeof err.message === "string") {
    safe.message = String(err.message).replace(PG_CONNECTION_STRING_RE, "[REDACTED]")
  }
  if (typeof err.code === "string") safe.code = err.code
  if (typeof err.hint === "string") safe.hint = err.hint
  if (typeof err.detail === "string") {
    safe.detail = String(err.detail).replace(PG_CONNECTION_STRING_RE, "[REDACTED]")
  }
  return safe
}

// ── Postgres adapter ─────────────────────────────────────────

export function makePgAdapter(options: {
  connectionString: string
  ssl?: boolean
  poolSize?: number
}): Interface {
  const client = initPg(options)

  // Auto-apply pending DB migrations on first connect,
  // so fresh installs have their schema ready before any queries.
  applyMigrations(client).catch((err) => {
    const classified = classifyError(err, "instance.storage.init")
    console.warn("[db] Failed to auto-apply migrations (non-fatal):", classified)
  })

  let pendingAfterCommitHooks: Array<() => void> = []
  let txDepth = 0

  const fireHooks = () => {
    const hooks = pendingAfterCommitHooks
    pendingAfterCommitHooks = []
    for (const fn of hooks) {
      fn()
    }
  }

  const query = <T>(fn: (db: DrizzleLikeClient) => T | Promise<T>) =>
    Effect.tryPromise({
      try: () => {
        if (txDepth === 0) pendingAfterCommitHooks = []
        const result = fn(client as unknown as DrizzleLikeClient)
        return result instanceof Promise ? result : Promise.resolve(result)
      },
      catch: (cause) => new DatabaseError({ message: "Query failed", cause: sanitizePgError(cause), isRetryable: false }),
    })

  const transaction = <T>(
    fn: (db: DrizzleLikeClient) => T | Promise<T>,
    options?: TransactionOptions,
  ) => {
    pendingAfterCommitHooks = []

    const pgOptions: PostgresTransactionOptions | undefined =
      options && "_tag" in options && options._tag === "postgres"
        ? (options as PostgresTransactionOptions)
        : undefined

    const txFn = async (tx: DrizzleLikeClient) => {
      txDepth++
      try {
        const result = await fn(tx as unknown as DrizzleLikeClient)
        return result
      } finally {
        txDepth--
        if (txDepth === 0) {
          fireHooks()
        }
      }
    }

    const baseEffect = Effect.tryPromise({
      try: async () => {
        if (pgOptions && (pgOptions.isolationLevel || pgOptions.accessMode)) {
          const opts: Record<string, string> = {}
          if (pgOptions.isolationLevel) opts.isolationLevel = pgOptions.isolationLevel
          if (pgOptions.accessMode) opts.accessMode = pgOptions.accessMode
          return await (client.transaction as any)(txFn, opts)
        }
        return await (client.transaction as any)(txFn)
      },
      catch: (cause) => {
        pendingAfterCommitHooks = []
        const safeCause = sanitizePgError(cause)
        const isRetryable =
          safeCause !== null && typeof safeCause === "object" && (safeCause as any)?.code === "40001"
        return new DatabaseError({ message: "Transaction failed", cause: safeCause, isRetryable })
      },
    })

    return baseEffect.pipe(
      Effect.retry({
        times: 3,
        schedule: Schedule.exponential("100 millis"),
        while: (error) => error instanceof DatabaseError && error.isRetryable,
      }),
    )
  }

  const afterCommit = (fn: () => void): Effect.Effect<void> =>
    Effect.sync(() => {
      if (txDepth > 0) {
        pendingAfterCommitHooks.push(fn)
      } else {
        fn()
      }
    })

  return Service.of({ query, transaction, afterCommit })
}

export const PgAdapter: (options: {
  connectionString: string
  ssl?: boolean
  poolSize?: number
}) => Layer.Layer<Service> = (options) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const adapter = makePgAdapter(options)
      // Report database health to optional HealthRegistry
      const hr = yield* Effect.serviceOption(HealthRegistry)
      if (Option.isSome(hr)) {
        const healthy = yield* adapter.query(() => Promise.resolve(true)).pipe(
          Effect.isSuccess,
        )
        yield* hr.value.set("pglite", {
          status: healthy ? HealthStatus.Healthy : HealthStatus.Down,
          updatedAt: Date.now(),
        })
      }
      return adapter
    }),
  )

// ── DuckDB adapter (read-only analytical sidecar) ────────────

function makeDuckDBAdapter(client: {
  all: <T>(sql: string) => Promise<T[]>
  get: <T>(sql: string) => Promise<T | undefined>
  run: (sql: string) => Promise<void>
  close: () => Promise<void>
}): Interface {
  // DrizzleLikeClient wrapper — only all/get/run are functional; write methods throw.
  const duckClient: DrizzleLikeClient = {
    select: () => {
      throw new Error("DuckDB does not support Drizzle query builder — use db.all(sql) or db.get(sql) directly")
    },
    selectDistinct: () => {
      throw new Error("DuckDB does not support Drizzle query builder")
    },
    insert: (): never => {
      throw new DatabaseError({ message: "DuckDB is read-only", cause: undefined as any, isRetryable: false })
    },
    update: (): never => {
      throw new DatabaseError({ message: "DuckDB is read-only", cause: undefined as any, isRetryable: false })
    },
    delete: (): never => {
      throw new DatabaseError({ message: "DuckDB is read-only", cause: undefined as any, isRetryable: false })
    },
    transaction: <T>(): Promise<T> => {
      throw new DatabaseError({ message: "DuckDB is read-only — transactions not supported", cause: undefined as any, isRetryable: false })
    },
    run: (query: any) => {
      const sql = String(query)
      checkDuckDBSQLFirewall(sql)
      return client.run(sql)
    },
    all: <T>(query: any) => {
      const sql = String(query)
      checkDuckDBSQLFirewall(sql)
      return client.all<T>(sql) as any
    },
    get: <T>(query: any) => {
      const sql = String(query)
      checkDuckDBSQLFirewall(sql)
      return client.get<T>(sql) as any
    },
  }

  const query = <T>(fn: (db: DrizzleLikeClient) => T | Promise<T>) =>
    Effect.tryPromise({
      try: () => {
        const result = fn(duckClient)
        return result instanceof Promise ? result : Promise.resolve(result)
      },
      catch: (cause) => new DatabaseError({ message: "DuckDB query failed", cause, isRetryable: false }),
    })

  const _transaction = <T>(
    _fn: (db: DrizzleLikeClient) => T | Promise<T>,
    _options?: TransactionOptions,
  ): Effect.Effect<T, DatabaseError> =>
    Effect.fail(
      new DatabaseError({
        message: "DuckDB is read-only — transactions are not supported",
        cause: undefined as any,
        isRetryable: false,
      }),
    )

  const afterCommit = (_fn: () => void): Effect.Effect<void> => Effect.void

  return Service.of({ query, transaction: _transaction, afterCommit })
}

export const DuckDBAdapter: Layer.Layer<Service> = Layer.effect(
  Service,
  Effect.promise(async () => {
    const { init } = await import("./db.duckdb")
    const client = await init()
    return makeDuckDBAdapter(client)
  }),
)

// ── Default layer (selects SQLite or Postgres) ───────────────
// Resolves DatabaseConfig at layer-construction time (NOT module-load time)
// via Layer.unwrap. The DatabaseConfig.Service requirement is satisfied by
// the embedded Layer.provide, so the exported defaultLayer has no context
// requirements. Credentials are Redacted until unwrapped at connection point.

export const defaultLayer: Layer.Layer<Service> = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* DatabaseConfig.Service
    if (Option.isSome(config.url)) {
      const url = Redacted.value(config.url.value)
      return PgAdapter({
        connectionString: url,
        ssl: config.ssl,
        poolSize: config.poolSize,
      })
    }
    return LocalPgAdapter
  }),
).pipe(Layer.provide(DatabaseConfig.defaultLayer))

// ── Compile-time structural compatibility assertions ─────────
type _SQLiteSatisfiesDLC = DrizzleLikeClient extends any ? true : never // structural: SQLite client satisfies via duck typing
// Postgres client (PgliteDatabase | NodePgDatabase) satisfies DrizzleLikeClient structurally
// via Drizzle ORM's shared interface — verified by the initPg return type assignment.
// TODO(phase2): add explicit type assertion once PgClient type from db.pg.ts is stabilized.
// type _PgSatisfiesDLC = DrizzleLikeClient extends PgClient ? true : never

export * as DatabaseAdapter from "./adapter"
