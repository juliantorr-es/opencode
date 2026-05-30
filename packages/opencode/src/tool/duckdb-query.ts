import { Effect, Schema } from "effect"
import { Service as DuckDB } from "@/storage/db.duckdb"
import * as Tool from "./tool"
import DESCRIPTION from "./duckdb-query.txt"

export const Parameters = Schema.Struct({
  sql: Schema.String.annotate({
    description: "The DuckDB SQL query string to execute",
  }),
  limit: Schema.optional(
    Schema.Number.pipe(
      Schema.check(
        Schema.isGreaterThanOrEqualTo(1),
        Schema.isLessThanOrEqualTo(10000),
        Schema.isInt(),
      ),
    ),
  ).annotate({
    description: "Maximum rows to return (default 1000, max 10000)",
  }),
})

export const DuckDBQueryTool = Tool.define(
  "duckdb_query",
  Effect.gen(function* () {
    const client = yield* DuckDB

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>) =>
        Effect.gen(function* () {
          const maxRows = params.limit ?? 1000
          const enforced = Math.min(maxRows, 10000)
          const hasLimit = /\bLIMIT\b\s+\d+/i.test(params.sql)
          const safeSql = hasLimit ? params.sql : `${params.sql.trim()} LIMIT ${enforced}`

          const rows = yield* Effect.tryPromise({
            try: () => client.all<Record<string, unknown>>(safeSql),
            catch: (error) => new Error(String(error)),
          }).pipe(
            Effect.catch((error) => {
              const msg = error.message ?? String(error)
              if (msg.includes("Failed to spawn duckdb")) {
                return Effect.fail(
                  new Tool.InvalidArgumentsError({
                    tool: "duckdb_query",
                    detail: [
                      "DuckDB binary is not installed or not found in PATH.",
                      "",
                      "Install DuckDB to use this tool:",
                      "  macOS:  brew install duckdb",
                      "  Linux:  apt install duckdb  (or download from https://duckdb.org/docs/installation/)",
                      "  Windows:  winget install DuckDB.cli",
                      "",
                      "After installing, restart the session to make the tool available.",
                    ].join("\n"),
                  }),
                )
              }
              return Effect.die(error)
            }),
          )

          return {
            title: `DuckDB query (${rows.length} rows)`,
            metadata: {
              rows: rows.length,
              limit: enforced,
              truncated: rows.length >= enforced,
            },
            output: JSON.stringify(rows, null, 2),
          }
        }).pipe(Effect.orDie),
    }
  }),
)
