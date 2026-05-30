import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { InstanceState } from "@/effect/instance-state"
import path from "path"
import { execFile } from "child_process"
import { promisify } from "util"
import DESCRIPTION from "./rig-jsonl-query.txt"

const execFileAsync = promisify(execFile)

const Parameters = Schema.Struct({
  artifact: Schema.String.annotate({ description: "Path to the JSON or JSONL artifact" }),
  query: Schema.String.annotate({ description: "SQL query to execute against the artifact view" }),
  table: Schema.optional(Schema.String).annotate({
    description: "Optional SQL view name, default evidence",
  }),
})

export const RigJsonlQueryTool = Tool.define(
  "rig_jsonl_query",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      cacheable: true,
      execute: (params: Schema.Schema.Type<typeof Parameters>, _ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const artifactPath = path.isAbsolute(params.artifact)
            ? params.artifact
            : path.resolve(instance.directory, params.artifact)
          const tableName = params.table ?? "evidence"

          // Validate table name to prevent injection
          if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(tableName)) {
            return {
              title: "rig_jsonl_query",
              metadata: { status: "fail" },
              output: JSON.stringify(
                { status: "fail", error: `Invalid table name: ${tableName}` },
                null,
                2,
              ),
            }
          }

          // Escape artifact path for SQL string literal
          const escapedArtifact = artifactPath.replace(/'/g, "''")

          // Build the DuckDB SQL
          const duckdbSql = `CREATE OR REPLACE TEMP VIEW ${tableName} AS SELECT * FROM read_json_auto('${escapedArtifact}'); ${params.query}`

          const result = yield* Effect.promise<{ stdout: string; stderr: string }>(async () => {
            try {
              const { stdout, stderr } = await execFileAsync("duckdb", [
                "-json",
                "-c",
                duckdbSql,
              ], {
                maxBuffer: 10 * 1024 * 1024,
                timeout: 30_000,
              })
              return { stdout, stderr }
            } catch (err: unknown) {
              const error = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string }
              return {
                stdout: error.stdout?.toString() ?? "",
                stderr: error.stderr?.toString() ?? error.message ?? String(error),
              }
            }
          })

          if (result.stderr && !result.stdout) {
            return {
              title: "rig_jsonl_query",
              metadata: { status: "fail" },
              output: JSON.stringify(
                {
                  status: "fail",
                  artifact: artifactPath,
                  query: params.query,
                  error: result.stderr,
                },
                null,
                2,
              ),
            }
          }

          // Parse the JSON output from DuckDB
          const trimmed = result.stdout.trim()
          let parsed: unknown
          try {
            // DuckDB -json outputs a JSON array of rows directly
            const rows = JSON.parse(trimmed) as Record<string, unknown>[]
            parsed = {
              artifact: artifactPath,
              table: tableName,
              query: params.query,
              row_count: rows.length,
              rows,
            }
          } catch {
            // If parsing fails, return raw output
            parsed = {
              artifact: artifactPath,
              table: tableName,
              query: params.query,
              row_count: 0,
              rows: [],
              raw_output: trimmed,
              parse_error: "Could not parse DuckDB JSON output",
            }
          }

          return {
            title: `rig_jsonl_query: ${path.basename(artifactPath)}`,
            metadata: {
              artifact: artifactPath,
              row_count: (parsed as Record<string, unknown>).row_count as number,
            },
            output: JSON.stringify(parsed, null, 2),
          }
        }).pipe(Effect.orDie),
    }
  }),
)

export * as RigJsonlQuery from "./rig-jsonl-query"
