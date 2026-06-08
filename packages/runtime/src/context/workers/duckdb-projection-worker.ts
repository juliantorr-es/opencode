import { Duration, Effect, Layer, Ref, Stream } from "effect"
import * as Log from "@tribunus/core/util/log"
import { ContextInvalidationBus } from "../invalidation-bus"
import * as DuckDB from "../../storage/db.duckdb"

const log = Log.create({ service: "duckdb-projection-worker" })

const CTX_FILE_RELEVANCE_VIEW = `
CREATE OR REPLACE VIEW _ctx_file_relevance_v AS
SELECT
  file_path,
  COUNT(*) AS event_count,
  COUNT(DISTINCT session_id) AS sessions,
  COUNT(DISTINCT actor) AS actors,
  MAX(ts) AS last_touched
FROM _pipeline_runtime_event
WHERE file_path IS NOT NULL AND file_path != ''
GROUP BY file_path
ORDER BY event_count DESC
`

const CTX_FILE_COCHANGE_VIEW = `
CREATE OR REPLACE VIEW _ctx_file_cochange_v AS
SELECT
  a.file_path AS file_a,
  b.file_path AS file_b,
  COUNT(*) AS co_occurrences,
  COUNT(DISTINCT a.session_id) AS sessions
FROM _pipeline_runtime_event a
JOIN _pipeline_runtime_event b
  ON a.session_id = b.session_id
  AND a.id != b.id
  AND a.file_path < b.file_path
WHERE a.file_path IS NOT NULL AND a.file_path != ''
  AND b.file_path IS NOT NULL AND b.file_path != ''
GROUP BY a.file_path, b.file_path
HAVING COUNT(*) > 1
ORDER BY co_occurrences DESC
`

const CTX_SESSION_ACTIVITY_VIEW = `
CREATE OR REPLACE VIEW _ctx_session_activity_v AS
SELECT
  session_id,
  MIN(ts) AS first_event,
  MAX(ts) AS last_event,
  COUNT(*) AS total_events,
  COUNT(DISTINCT actor) AS unique_actors,
  COUNT(DISTINCT tool_name) AS unique_tools,
  COUNT(DISTINCT file_path) AS unique_files,
  SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failure_count
FROM _pipeline_runtime_event
GROUP BY session_id
`

const CTX_AGENT_HEATMAP_VIEW = `
CREATE OR REPLACE VIEW _ctx_agent_heatmap_v AS
SELECT
  actor AS agent_name,
  file_path,
  COUNT(*) AS read_count,
  SUM(CASE WHEN event_type LIKE 'file.%' OR event_type LIKE 'edit.%' THEN 1 ELSE 0 END) AS edit_count,
  MAX(ts) AS last_access
FROM _pipeline_runtime_event
WHERE file_path IS NOT NULL AND file_path != ''
GROUP BY actor, file_path
`

const ALL_PROJECTION_VIEWS = [
  CTX_FILE_RELEVANCE_VIEW,
  CTX_FILE_COCHANGE_VIEW,
  CTX_SESSION_ACTIVITY_VIEW,
  CTX_AGENT_HEATMAP_VIEW,
]

/**
 * Worker 4 — DuckDB Projection Worker
 *
 * Subscribes to `event_projections` invalidation scope. When notified,
 * rebuilds context projection views (_ctx_file_relevance_v, _ctx_file_cochange_v,
 * _ctx_session_activity_v, _ctx_agent_heatmap_v) in DuckDB.
 *
 * Uses the write-capable DuckDB client (DuckDBWrite) for DDL.
 * Previously used the read-only client, which silently rejected DDL via -readonly.
 *
 * Throttled: at most once per 5 seconds to prevent excessive DuckDB calls.
 */
export const layer = Layer.effectDiscard(
  Effect.scoped(
    Effect.gen(function* () {
      const bus = yield* ContextInvalidationBus
      log.info("starting duckdb-projection-worker")

      const lastRun = yield* Ref.make(0)
      const THROTTLE_MS = 5000

      const stream = yield* bus.subscribe("event_projections")

      yield* stream.pipe(
        Stream.debounce(Duration.millis(500)),
        Stream.runForEach(() =>
          Effect.gen(function* () {
            const now = Date.now()
            const last = yield* Ref.get(lastRun)
            if (now - last < THROTTLE_MS) return
            yield* Ref.set(lastRun, now)

            const duckdb = yield* DuckDB.WriteService
            for (const sql of ALL_PROJECTION_VIEWS) {
              yield* Effect.tryPromise(() => duckdb.run(sql)).pipe(
                Effect.tapError((err) =>
                  Effect.logError("Failed to create DuckDB projection view").pipe(
                    Effect.annotateLogs("sql", sql.slice(0, 80)),
                    Effect.annotateLogs("error", String(err)),
                  ),
                ),
              )
            }
            log.debug("DuckDB context projections rebuilt")
          }).pipe(
            Effect.tapError((err) =>
              Effect.logError("DuckDB projection worker iteration failed").pipe(
                Effect.annotateLogs("error", String(err)),
              ),
            ),
          ),
        ),
        Effect.forkScoped,
      )

      log.info("duckdb-projection-worker fiber started")
    }),
  ),
).pipe(Layer.provide(DuckDB.writeLayer))
