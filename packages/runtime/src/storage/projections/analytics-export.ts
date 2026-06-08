// Analytics Export — DuckDB Projections
// Exports canonical rows from PGlite into DuckDB for analytical querying.
// DuckDB is read-only after import; never used for authority.

import { Effect, Option } from "effect"
import { Database } from "../db"
import { DuckDBConfig } from "../duckdb-config"
import { DuckDB } from "../db.duckdb"
import { execDuckDBStdin } from "../duckdb-exec"

export interface AnalyticsExport {
  table: string
  exportedAt: number
  rowCount: number
}

// ── PGlite raw query helper ─────────────────────────────────

interface PGliteQueryResult {
  rows: Record<string, unknown>[]
}

interface PGliteClient {
  query(sql: string, params?: unknown[]): Promise<PGliteQueryResult>
}

function getPGlite(): PGliteClient {
  const db = Database.Client() as unknown
  const pg = (db as { $client?: PGliteClient }).$client
  if (!pg) throw new Error("PGlite client unavailable — $client missing from Database.Client()")
  return pg
}

// ── Module ───────────────────────────────────────────────────

export const analyticsExportModule = {
  name: "analytics_export",
  version: 1,

  // Export canonical rows from PGlite into DuckDB for analysis
  exportTable: (table: string): Effect.Effect<AnalyticsExport, never, DuckDBConfig.Service> =>
    Effect.gen(function* () {
      const rows = yield* Effect.tryPromise({
        try: () => getPGlite().query(`SELECT * FROM "${table}"`).then((r) => r.rows),
        catch: () => [] as Record<string, unknown>[],
      }) as Effect.Effect<Record<string, unknown>[], never>
      // Sink into DuckDB via stdin JSON (write-capable, no -readonly)
      if (rows.length > 0) {
        const config = yield* DuckDBConfig.Service
        const dbPath = Option.getOrElse(config.dbPath, () => ":memory:")
        if (dbPath !== ":memory:") {
          yield* Effect.promise(() =>
            execDuckDBStdin(
              dbPath,
              `CREATE OR REPLACE TABLE "analytics_${table}" AS SELECT * FROM read_json_auto('/dev/stdin')`,
              JSON.stringify(rows),
            ),
          ).pipe(
          ).pipe(
            Effect.catchCause((cause) =>
              Effect.logError(
                `DuckDB export failed for ${table}: ${cause}`,
              ),
            ),
          )
        }
      }

      return {
        table,
        exportedAt: Date.now(),
        rowCount: rows.length,
      }
    }),

  // Query analytics results from DuckDB (read-only, through pooled client)
  queryAnalytics: <T>(sql: string): Effect.Effect<T[], never, DuckDB.Service> =>
    Effect.gen(function* () {
      const duckdb = yield* DuckDB.Service
      return yield* Effect.promise(() => duckdb.all<T>(sql)).pipe(
        Effect.catchCause((cause) =>
          Effect.logError(
            `Analytics query failed: ${cause}`,
          ).pipe(Effect.as([] as T[])),
        ),
      )
    }),

  // Rebuild all analytics projections from canonical tables
  rebuildAll: (): Effect.Effect<AnalyticsExport[], never, DuckDBConfig.Service> =>
    Effect.gen(function* () {
      const tables = [
        "coordination_claim",
        "session",
        "event",
        "account",
      ]
      const results: AnalyticsExport[] = []
      for (const table of tables) {
        const result = yield* analyticsExportModule.exportTable(table)
        results.push(result)
      }
      return results
    }),

  // Stale detection: check whether canonical table has any rows
  checkStale: (table: string): Effect.Effect<boolean> =>
    Effect.gen(function* () {
      return yield* Effect.tryPromise({
        try: () =>
          getPGlite()
            .query(`SELECT 1 FROM "${table}" LIMIT 1`)
            .then((r) => r.rows.length > 0),
        catch: () => false,
      }) as Effect.Effect<boolean, never>
    }),
}
