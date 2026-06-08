import { spawn } from "child_process"
import { Context, Effect, Layer, Option } from "effect"

import { DatabaseAdapter } from "./adapter"
import { DuckDBConfig } from "./duckdb-config"
import { buildContextProjections, initTablesSql, initViewsSql } from "./schema.duckdb"
import { execDuckDB, execDuckDBStdin } from "./duckdb-exec"

// ── Constants ───────────────────────────────────────────────

const CURRENT_SCHEMA_VERSION = 2

const CREATE_META_TABLE = `
CREATE TABLE IF NOT EXISTS _pipeline_meta (
  schema_version INTEGER NOT NULL PRIMARY KEY,
  created_at_epoch BIGINT NOT NULL
)`

const CHECK_META = "SELECT schema_version FROM _pipeline_meta LIMIT 1"

const WRITE_META = `
INSERT OR REPLACE INTO _pipeline_meta (schema_version, created_at_epoch)
VALUES (${CURRENT_SCHEMA_VERSION}, CAST(epoch_ms(CURRENT_TIMESTAMP) AS BIGINT))`

const CREATE_SESSION_TABLE = `
CREATE OR REPLACE TABLE _pipeline_session AS
SELECT * FROM read_json_auto('/dev/stdin')`

const CREATE_PART_TABLE = `
CREATE OR REPLACE TABLE _pipeline_part AS
SELECT * FROM read_json_auto('/dev/stdin')`

const CREATE_RUNTIME_EVENT_TABLE = `
CREATE OR REPLACE TABLE _pipeline_runtime_event AS
SELECT * FROM read_json_auto('/dev/stdin')`

// ── Service ─────────────────────────────────────────────────

export interface Interface {}

export class Service extends Context.Service<Service, Interface>()("@opencode/DuckDBPipeline") {}

// ── Pipeline helpers ────────────────────────────────────────

export function runPipeline(
  dbPath: string,
  adapter: DatabaseAdapter.Interface,
  signal?: AbortSignal,
  valkeySnapshot?: { generation: number; heartbeats: number; leases: number; queues: number },
): Effect.Effect<void> {
  if (dbPath === ":memory:") { return Effect.void }
  return Effect.gen(function* () {
    // 1. Check meta guard — skip if already populated at this schema version
    const meta = yield* Effect.promise(() => metaCheck(dbPath))
    if (meta !== null && meta >= CURRENT_SCHEMA_VERSION) {
      yield* Effect.logInfo("DuckDB pipeline already populated, skipping")
      return
    }

    // 2. Export session data from Postgres
    const sessions = yield* adapter.query((db: any) =>
      db.all(
        "SELECT id, project_id, time_created, time_updated, CAST(model AS text) AS model FROM session ORDER BY time_created DESC LIMIT 1000",
      ),
    )

    // 3. Export part data from Postgres (tool call data)
    const parts = yield* adapter.query((db: any) =>
      db.all(
        "SELECT id, session_id, CAST(data AS text) AS data FROM part ORDER BY time_created DESC LIMIT 5000",
      ),
    )

    // 3b. Export runtime event data from SQLite/Postgres (if table exists)
    const events: Array<Record<string, unknown>> = yield* adapter.query((db: any) =>
      db.all(
        `SELECT
          id, session_id, run_id, parent_event_id, correlation_id,
          ts, actor, event_type, phase, status, tool_name, file_path, model,
          duration_ms, token_input, token_output,
          error_code, error_message, recoverable,
          CAST(payload_json AS text) AS payload_json
        FROM runtime_events
        ORDER BY ts DESC LIMIT 10000`,
      ),
    ).pipe(
      Effect.catchTag("DatabaseError", (err) =>
        Effect.logInfo("runtime_events table not available, skipping").pipe(
          Effect.annotateLogs("error", String(err)),
          Effect.andThen(Effect.succeed([])),
        ),
      ),
    )

    // 4. Run DuckDB pipeline (spawn process for each step, no -readonly)
    yield* Effect.promise(() => execDuckDB(dbPath, CREATE_META_TABLE, signal))
    yield* Effect.promise(() => execDuckDBStdin(dbPath, CREATE_SESSION_TABLE, JSON.stringify(sessions), signal))
    yield* Effect.promise(() => execDuckDBStdin(dbPath, CREATE_PART_TABLE, JSON.stringify(parts), signal))
    if (events.length > 0) {
      yield* Effect.promise(() => execDuckDBStdin(dbPath, CREATE_RUNTIME_EVENT_TABLE, JSON.stringify(events), signal))
    }

    // 4b. Create analytical tables
    yield* Effect.promise(() => execDuckDB(dbPath, initTablesSql(), signal))

    // 5. Create analytical views
    yield* Effect.promise(() => execDuckDB(dbPath, initViewsSql(), signal))

    // 5b. Build context projection tables from runtime events
    yield* buildContextProjections(dbPath, adapter, signal)

    // 5c. Optionally ingest Valkey snapshot data into coordination tables
    if (valkeySnapshot) {
      const now = Date.now()
      const heartbeatRows = [{
        agent_id: "__aggregate__",
        lane_id: "__aggregate__",
        last_heartbeat_epoch: now,
        status: "active",
        generation: valkeySnapshot.generation,
      }]
      const consumerGroupRows = [{
        group_name: "__pipeline__",
        stream_key: "coordination:queue",
        pending_count: valkeySnapshot.queues,
        last_delivered_id: "0",
        consumer_count: valkeySnapshot.leases,
        snapshot_at_epoch: now,
      }]
      yield* Effect.promise(() =>
        execDuckDBStdin(
          dbPath,
          "INSERT INTO _pipeline_valkey_heartbeats SELECT * FROM read_json_auto('/dev/stdin')",
          JSON.stringify(heartbeatRows),
          signal,
        ),
      )
      yield* Effect.promise(() =>
        execDuckDBStdin(
          dbPath,
          "INSERT INTO _pipeline_valkey_consumer_groups SELECT * FROM read_json_auto('/dev/stdin')",
          JSON.stringify(consumerGroupRows),
          signal,
        ),
      )
      yield* Effect.logInfo("Valkey snapshot ingested into DuckDB coordination tables")
    }

    // 6. Write meta as LAST step — if anything above fails, meta is not written
    yield* Effect.promise(() => execDuckDB(dbPath, WRITE_META, signal))

    yield* Effect.logInfo("DuckDB pipeline completed", dbPath)
  }).pipe(
    Effect.catch((error: unknown) =>
      Effect.logError("DuckDB pipeline failed (non-fatal)").pipe(
        Effect.annotateLogs("error", String(error)),
      ),
    ),
    Effect.withSpan("DuckDBPipeline.run"),
  )
}

/** Spawn duckdb (no -readonly, no firewall — pipeline internal only). */
// NOTE: execDuckDB and execDuckDBStdin moved to duckdb-exec.ts to eliminate duplication

/** Check the _pipeline_meta table for existing schema_version. */
async function metaCheck(dbPath: string): Promise<number | null> {
  if (dbPath === ":memory:") {
    return null
  }
  try {
    const result = await new Promise<any[]>((resolve) => {
      const proc = spawn("duckdb", [dbPath, "-json", "-c", CHECK_META])
      let stdout = ""
      proc.stdout?.on("data", (d: Buffer) => {
        stdout += d.toString()
      })
      proc.stderr?.on("data", () => {}) // drain stderr
      proc.on("close", (code) => {
        if (code !== 0) {
          // Table doesn't exist yet — not an error
          resolve([])
        } else {
          try {
            resolve(JSON.parse(stdout))
          } catch {
            resolve([])
          }
        }
      })
      proc.on("error", () => resolve([]))
    })
    if (result.length === 0) return null
    return (result[0] as any)?.schema_version ?? null
  } catch {
    return null
  }
}

// ── Layer ───────────────────────────────────────────────────

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* DuckDBConfig.Service
    const adapter = yield* DatabaseAdapter.Service
    const dbPath = Option.match(config.dbPath, {
      onNone: () => ":memory:",
      onSome: String,
    })

    // Run pipeline in background fiber — never blocks app startup
    const abortController = new AbortController()
    yield* Effect.addFinalizer(() => Effect.sync(() => abortController.abort()))
    yield* Effect.forkScoped(
      runPipeline(dbPath, adapter, abortController.signal).pipe(
        Effect.catch((error: unknown) =>
          Effect.logError("DuckDB pipeline background fiber failed").pipe(
            Effect.annotateLogs("error", String(error)),
          ),
        ),
      ),
    )

    return Service.of({})
  }),
)

export const defaultLayer: Layer.Layer<Service, never, DuckDBConfig.Service> = 
  layer.pipe(Layer.provide(DatabaseAdapter.defaultLayer))

export * as DuckDBPipeline from "./pipeline"
