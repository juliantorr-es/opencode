/**
 * Projection Stream — PGlite live query binding for cockpit panel components.
 *
 * Wraps PGlite's live query extension as a simple subscription API suitable
 * for LitElement lifecycle (connectedCallback / disconnectedCallback).
 *
 * Pattern:
 *   this._unsub = liveQuery<RowType>("SELECT ...", (rows) => { this._data = rows })
 *
 * Polling fallback when the native live extension is unavailable (e.g. in
 * the Electron renderer without direct PGlite access).
 */

/** Shape received from PGlite live.query() callbacks. */
interface LiveQueryResult {
  rows: Record<string, unknown>[]
}

/** Subscription handle returned by pg.live.query(). */
interface LiveQueryHandle {
  unsubscribe: () => void
}

/** The live namespace on a PGlite instance. */
interface PGliteLive {
  query: (sql: string, params: unknown[], cb: (result: LiveQueryResult) => void) => LiveQueryHandle
}

interface PGliteClientWithLive {
  live: PGliteLive
}

/* ── Internal PGlite instance (set during desktop boot) ─── */

let _pg: PGliteClientWithLive | null = null
let _pollFallbackMs = 2000

/**
 * Register a PGlite instance for live queries. Called once during cockpit
 * initialization. Accepts the raw PGlite client (with live extension loaded).
 */
export function setPGliteInstance(client: unknown): void {
  const pg = client as PGliteClientWithLive
  if (typeof pg?.live?.query === "function") {
    _pg = pg
  }
}

/**
 * Override the polling fallback interval. Default 2000ms.
 */
export function setPollInterval(ms: number): void {
  _pollFallbackMs = ms
}

/**
 * Try to resolve a PGlite client from the environment.
 * Checks window.__PGLITE__ first, then the injected instance.
 */
function resolveClient(): PGliteClientWithLive | null {
  if (_pg) return _pg
  try {
    const win = globalThis as Record<string, unknown> & { __PGLITE__?: unknown }
    if (win.__PGLITE__) {
      const c = win.__PGLITE__ as PGliteClientWithLive
      if (typeof c?.live?.query === "function") {
        _pg = c
        return c
      }
    }
  } catch {
    // Not available
  }
  return null
}

/* ── Live query subscription ────────────────────────────── */

/**
 * Subscribe to a live query. Calls `onData` with the latest rows on every
 * change. Returns an unsubscribe function. Uses PGlite native live extension
 * when available, falls back to polling.
 *
 * Use in connectedCallback:
 *   override connectedCallback() {
 *     super.connectedCallback()
 *     this._unsub = liveQuery("SELECT ...", (r) => this._data = r)
 *   }
 *   override disconnectedCallback() {
 *     super.disconnectedCallback()
 *     this._unsub?.()
 *   }
 */
export function liveQuery<R extends object>(
  sql: string,
  onData: (rows: R[]) => void,
  params?: unknown[],
): () => void {
  const client = resolveClient()

  if (client) {
    try {
      const handle = client.live.query(sql, params ?? [], (result: LiveQueryResult) => {
        onData(result.rows as R[])
      })
      return () => handle.unsubscribe()
    } catch {
      // Fall through to polling
    }
  }

  // Polling fallback: fire once immediately then poll
  let active = true
  const poll = async (): Promise<void> => {
    if (!active) return
    try {
      const { rawQuery } = await import("./pglite-raw")
      const rows = await rawQuery<R>(sql, params)
      if (active) onData(rows)
    } catch {
      // Silently skip errors during polling
    }
  }

  void poll()
  const interval = setInterval(poll, _pollFallbackMs)
  return () => {
    active = false
    clearInterval(interval)
  }
}

/**
 * Subscribe to a single-value live query (first row only, or null).
 */
export function liveQueryOne<R extends object>(
  sql: string,
  onData: (row: R | null) => void,
  params?: unknown[],
): () => void {
  return liveQuery<R>(
    sql,
    (rows) => onData(rows.length > 0 ? rows[0] : null),
    params,
  )
}
