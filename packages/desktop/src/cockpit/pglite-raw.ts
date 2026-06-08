/**
 * Raw PGlite query utility — direct query execution for polling fallback.
 *
 * Used by projection-stream when the native live extension isn't available,
 * e.g. during Electron renderer boot before live subscriptions are wired.
 */

/** A minimal PGlite client exposing a query() method. */
interface PGliteRawClient {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>
}

let _raw: PGliteRawClient | null = null

/**
 * Register a raw PGlite query client. Called during cockpit
 * initialization. Accepts any object with a query(sql, params?) method.
 */
export function setPGliteRaw(client: { query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> }): void {
  _raw = client
}

/**
 * Resolve the raw client from registration or global.
 */
function resolveRaw(): PGliteRawClient | null {
  if (_raw) return _raw
  try {
    const win = globalThis as { __PGLITE_RAW__?: { query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> } }
    if (win.__PGLITE_RAW__) {
      _raw = win.__PGLITE_RAW__
      return _raw
    }
  } catch {
    // Not available
  }
  return null
}

/**
 * Execute a raw query against PGlite. Returns rows.
 */
export async function rawQuery<R extends object>(
  sql: string,
  params?: unknown[],
): Promise<R[]> {
  const client = resolveRaw()
  if (!client) return []

  const result = await client.query(sql, params ?? [])
  return result.rows as R[]
}
