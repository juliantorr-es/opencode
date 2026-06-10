/**
 * PGlite live query subscription service.
 *
 * Uses the PGlite `live` extension (v0.2.16+) when available for native live query
 * subscriptions that fire on every data change. Falls back to polling via the
 * DatabaseAdapter when the extension isn't loaded or the backend isn't PGlite.
 */

import { Context, Effect, Layer, Queue, Stream } from "effect"
import { DatabaseAdapter } from "./adapter"
import { Database } from "./db"

// ── PGlite live extension types ────────────────────────────

/** Result shape from `pg.live.query()` callbacks. */
interface LiveQueryResult {
  rows: Record<string, unknown>[]
  offset?: number
  limit?: number
  totalCount?: number
}

/** Subscription handle returned by `pg.live.query()`. */
interface LiveQueryHandle {
  unsubscribe: () => void
}

/** The `live` namespace on a PGlite instance. */
interface PGliteLive {
  query(
    sql: string,
    params: unknown[],
    callback: (result: LiveQueryResult) => void,
  ): LiveQueryHandle
}

/** A raw PGlite client that has the `live` extension loaded. */
interface PGliteClientWithLive {
  live: PGliteLive
}

// ── Runtime type guards ────────────────────────────────────

function isPGliteClient(obj: unknown): obj is { $client: unknown } {
  if (obj === null || typeof obj !== "object") return false
  return "$client" in obj
}

function hasLiveExtension(obj: unknown): obj is PGliteClientWithLive {
  if (obj === null || typeof obj !== "object") return false
  const dict = obj as Record<string, unknown>
  if (typeof dict.live !== "object" || dict.live === null) return false
  return "query" in dict.live && typeof (dict.live as Record<string, unknown>).query === "function"
}

// ── Emit callback shape (we only need single) ──────────────

interface EmitSingle<R> {
  single(value: R): void
}

// ── Service tag ────────────────────────────────────────────

export class PGliteLiveQuery extends Context.Service<PGliteLiveQuery>()(
  "@opencode/PGliteLiveQuery", {} as any
) {
  constructor(private readonly adapter: DatabaseAdapter.Service & {}) {

    // @ts-expect-error Context.Service constructor type inference
    super(undefined as any)
  }

  /**
   * Subscribe to query results.
   * Emits an array of result rows on each data change.
   *
   * Tries a PGlite native live subscription first (via the `live` extension).
   * Falls back to polling via the DatabaseAdapter at `pollIntervalMs` (default 1000ms).
   */
  subscribe<R extends Record<string, unknown>>(
    sql: string,
    params?: unknown[],
    pollIntervalMs?: number,
  ): Stream.Stream<R[], never> {
    const interval = pollIntervalMs ?? 1000

    return Stream.callback<R[], never>((queue) => {
      // Create a compat emit wrapper using Queue.offerUnsafe
      const emit: EmitSingle<R[]> = {
        single(rows) {
          Queue.offerUnsafe(queue, rows)
        },
      }

      // Attempt native PGlite live query first
      const liveSub = this.tryLiveSubscription<R>(sql, params ?? [], emit)

      if (liveSub) {
        return Effect.acquireRelease(
          Effect.void,
          () => Effect.sync(() => liveSub.unsubscribe()),
        )
      }

      // Fallback: polling via DatabaseAdapter
      const timerId = setInterval(() => {
        Effect.runPromise(
          (this.adapter as any).query<any[]>((db: any) => db.all(sql) as R[]),
        ).then(
          (rows: R[]) => {
            emit.single(rows as R[])
          },
          () => {
            // Polling errors are swallowed — the stream stays alive and retries
            // on the next tick.
          },
        )
      }, interval)

      return Effect.acquireRelease(
        Effect.void,
        () => Effect.sync(() => clearInterval(timerId)),
      )
    })
  }

  /**
   * Subscribe to a single-value query.
   * Emits the first row or null on each data change.
   */
  subscribeOne<R extends Record<string, unknown>>(
    sql: string,
    params?: unknown[],
    pollIntervalMs?: number,
  ): Stream.Stream<R | null, never> {
    return this.subscribe<R>(sql, params, pollIntervalMs).pipe(
      Stream.map((rows) => (rows.length > 0 ? rows[0] : null)),
    )
  }

  // ── Internals ──────────────────────────────────────────

  /**
   * Try to set up a PGlite native live subscription.
   * Returns the subscription handle if successful, or `null` if the
   * live extension is not available.
   */
  private tryLiveSubscription<R extends Record<string, unknown>>(
    sql: string,
    params: unknown[],
    emit: EmitSingle<R[]>,
  ): LiveQueryHandle | null {
    try {
      const raw = Database.use((db: unknown) => db)
      const pglite = isPGliteClient(raw) ? (raw.$client as unknown) : raw

      if (!hasLiveExtension(pglite)) return null

      const handle = pglite.live.query(sql, params, (result) => {
        // The live extension returns rows typed as Record<string, unknown>[];
        // the caller supplies the concrete R via the generic parameter.
        emit.single(result.rows as unknown as R[])
      })

      return handle
    } catch {
      return null
    }
  }
}

// ── Layer ──────────────────────────────────────────────────

export const PGliteLiveQueryLive = Layer.effect(
  PGliteLiveQuery,
  Effect.gen(function* () {
    const adapter = yield* DatabaseAdapter.Service
    return new PGliteLiveQuery(adapter as any)
  }),
)
