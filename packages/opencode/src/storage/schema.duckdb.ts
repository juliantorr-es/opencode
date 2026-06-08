// ── DuckDB Analytical Schema Definitions ──────────────────
//
// This module defines SQL views and helper functions for analytical
// queries routed through DuckDB. These are READ-ONLY views — DuckDB
// never accepts writes from the application.
//
// Analytical views are created as DuckDB SQL that reads from:
//   - Parquet / CSV exports from the transactional (Postgres) layer
//   - JSON event logs (.rig/reports/reports.jsonl, etc.)
//   - In-memory data passed through the adapter query callback
//   - Pipeline-exported tables (_pipeline_session, _pipeline_part)
//   - Pipeline-exported event data (_pipeline_runtime_event)
//
// Views are created lazily on first analytical query via `initViewsSql()`.

import { Effect } from "effect"
import { DatabaseAdapter } from "./adapter"
import { execDuckDB, execDuckDBStdin } from "./duckdb-exec"

// ── Analytical view helpers ───────────────────────────────

/** SQL to create a session-clustering view for failure analysis. */
export const SESSION_CLUSTERING_VIEW = `
CREATE VIEW IF NOT EXISTS _analytics_session_clustering AS
SELECT
  s.id AS session_id,
  s.project_id,
  s.time_created,
  s.time_updated,
  json_extract_string(s.model, '$.id') AS model_id
FROM _pipeline_session s
WHERE s.time_created > CAST(epoch_ms(CURRENT_TIMESTAMP) AS BIGINT) - CAST(86400000 AS BIGINT) * 30
` as const

/** SQL to create a tool-usage aggregations view. */
export const TOOL_USAGE_VIEW = `
CREATE VIEW IF NOT EXISTS _analytics_tool_usage AS
SELECT
  p.session_id,
  json_extract_string(p.data, '$.tool') AS tool_name,
  count(*) AS invocation_count,
  avg(
    CAST(json_extract(p.data, '$.state.time.end') AS DOUBLE) -
    CAST(json_extract(p.data, '$.state.time.start') AS DOUBLE)
  ) AS avg_duration_ms,
  sum(CASE WHEN json_extract_string(p.data, '$.state.status') = 'error' THEN 1 ELSE 0 END) AS error_count,
  sum(CASE WHEN json_extract_string(p.data, '$.state.status') = 'success' THEN 1 ELSE 0 END) AS success_count
FROM _pipeline_part p
WHERE json_extract_string(p.data, '$.type') = 'tool'
GROUP BY p.session_id, tool_name
` as const

/** All analytical views to create on init. */
export const ALL_VIEWS = [
  SESSION_CLUSTERING_VIEW,
  TOOL_USAGE_VIEW,
] as const

// ── Analytical table definitions ────────────────────────────
//
// Tables back the cross-session analytical pipeline. Unlike views,
// these are created as persistent tables to store structured event
// data written by agents during execution, QA, and diagnostics.
// Materialized by the DuckDB pipeline on init -- see pipeline.ts step 4b.

/** Waves table for stress-test and adversary-wave records. */
export const WAVES_TABLE = `
CREATE TABLE IF NOT EXISTS _analytics_waves (
  session_id TEXT, plan_id TEXT, wave_type TEXT, adversary TEXT,
  attack_surface TEXT, attacks_attempted TEXT, findings TEXT,
  verdict TEXT, recorded_at BIGINT
)` as const

/** Findings table for out-of-scope and cross-session findings. */
export const FINDINGS_TABLE = `
CREATE TABLE IF NOT EXISTS _analytics_findings (
  finding_id TEXT PRIMARY KEY, session_id TEXT, affected_files TEXT,
  language TEXT, why_matters TEXT, best_practice_anchor TEXT,
  recommended_slice TEXT, finding_type TEXT, confidence REAL,
  ttl_seconds BIGINT, expires_at BIGINT, recorded_at BIGINT
)` as const

/** Registry table for cross-session artifact publishing. */
export const REGISTRY_TABLE = `
CREATE TABLE IF NOT EXISTS _analytics_registry (
  dedup_key TEXT PRIMARY KEY, finding_id TEXT, session_id TEXT,
  finding_type TEXT, summary TEXT, source_artifact TEXT,
  relevance_profiles TEXT, confidence REAL, ttl_seconds BIGINT,
  published_at BIGINT, expires_at BIGINT
)` as const

/** QA observations table for test-coverage and boundary-exercise tracking. */
export const QA_TABLE = `
CREATE TABLE IF NOT EXISTS _analytics_qa_observations (
  plan_id TEXT, boundary TEXT, tests_examined TEXT,
  production_paths_exercised TEXT, notes TEXT, recorded_at BIGINT
)` as const

/** Diagnostics table for tool-failure and runtime error tracking. */
export const DIAGNOSTICS_TABLE = `
CREATE TABLE IF NOT EXISTS _analytics_diagnostics (
  session_id TEXT, tool_name TEXT, error_message TEXT,
  args_used TEXT, recovery_attempted INTEGER, recorded_at BIGINT
)` as const

// ── Valkey Coordination Tables ──────────────────────────────
//
// Tables for Valkey-backed coordination fabric metrics. Populated
// by the DuckDB pipeline when optional valkeySnapshot data is provided.

/** Valkey consumer group snapshot — group names, stream keys, pending counts. */
export const VALKEY_CONSUMER_GROUPS_TABLE = `
CREATE OR REPLACE TABLE _pipeline_valkey_consumer_groups (
  group_name TEXT,
  stream_key TEXT,
  pending_count INTEGER,
  last_delivered_id TEXT,
  consumer_count INTEGER,
  snapshot_at_epoch BIGINT
)` as const

/** Valkey heartbeat snapshot — agent presence and generation. */
export const VALKEY_HEARTBEATS_TABLE = `
CREATE OR REPLACE TABLE _pipeline_valkey_heartbeats (
  agent_id TEXT,
  lane_id TEXT,
  last_heartbeat_epoch BIGINT,
  status TEXT,
  generation INTEGER
)` as const

// ── Context Projection Tables ──────────────────────────────
//
// Tables for context-aware working set ranking. Populated by
// buildContextProjections() which pipes runtime events from the
// transactional DB (SQLite/Postgres) and then aggregates into
// relevance scores, co-change patterns, agent heatmaps, and
// error→file associations.

/** File-level event stream — raw events with file_path. */
export const CTX_FILE_EVENTS_TABLE = `
CREATE TABLE IF NOT EXISTS _ctx_file_events (
  session_id TEXT,
  file_path TEXT,
  event_type TEXT,
  actor TEXT,
  tool_name TEXT,
  phase TEXT,
  event_ts TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_ctx_file_events_file ON _ctx_file_events(file_path);
CREATE INDEX IF NOT EXISTS idx_ctx_file_events_session ON _ctx_file_events(session_id);
CREATE INDEX IF NOT EXISTS idx_ctx_file_events_ts ON _ctx_file_events(event_ts);
` as const

/** Ranked file relevance per session — scores for working set ranking. */
export const CTX_FILE_RELEVANCE_TABLE = `
CREATE TABLE IF NOT EXISTS _ctx_file_relevance (
  file_path TEXT,
  session_id TEXT,
  recency_score DOUBLE,
  edit_count INTEGER,
  failure_count INTEGER,
  claim_count INTEGER,
  read_count INTEGER,
  last_ts TIMESTAMP,
  PRIMARY KEY (file_path, session_id)
);
` as const

/** Files that change together — co-occurrence in same session. */
export const CTX_FILE_COCHANGE_TABLE = `
CREATE TABLE IF NOT EXISTS _ctx_file_cochange (
  file_a TEXT,
  file_b TEXT,
  cochange_count INTEGER,
  sessions_shared INTEGER,
  PRIMARY KEY (file_a, file_b)
);
` as const

/** Agent heatmap — which files each agent touches. */
export const CTX_AGENT_HEATMAP_TABLE = `
CREATE TABLE IF NOT EXISTS _ctx_agent_heatmap (
  agent_name TEXT,
  file_path TEXT,
  read_count INTEGER,
  edit_count INTEGER,
  last_access TIMESTAMP,
  PRIMARY KEY (agent_name, file_path)
);
` as const

/** Error→file associations — files linked to error codes. */
export const CTX_ERROR_FILES_TABLE = `
CREATE TABLE IF NOT EXISTS _ctx_error_files (
  error_code TEXT,
  file_path TEXT,
  occurrence_count INTEGER,
  first_seen TIMESTAMP,
  last_seen TIMESTAMP,
  PRIMARY KEY (error_code, file_path)
);
` as const

/** All context projection table DDL statements. */
export const ALL_CTX_TABLES = [
  CTX_FILE_EVENTS_TABLE,
  CTX_FILE_RELEVANCE_TABLE,
  CTX_FILE_COCHANGE_TABLE,
  CTX_AGENT_HEATMAP_TABLE,
  CTX_ERROR_FILES_TABLE,
] as const

// ── Runtime Events ──────────────────────────────────────────
//
// Runtime events capture fine-grained lifecycle events emitted
// by agents, tools, and phases during session execution. Data is
// exported from the SQLite/Postgres event store (if present) or
// from structured JSON logs during the DuckDB pipeline run.

export const RUNTIME_EVENTS_TABLE = `
CREATE TABLE IF NOT EXISTS _pipeline_runtime_event (
  id TEXT PRIMARY KEY,
  session_id TEXT,
  run_id TEXT,
  parent_event_id TEXT,
  correlation_id TEXT,
  ts TIMESTAMP,
  actor TEXT,
  event_type TEXT,
  phase TEXT,
  status TEXT,
  tool_name TEXT,
  file_path TEXT,
  model TEXT,
  duration_ms DOUBLE,
  token_input INTEGER,
  token_output INTEGER,
  error_code TEXT,
  error_message TEXT,
  recoverable BOOLEAN,
  payload_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_runtime_event_ts ON _pipeline_runtime_event(ts);
CREATE INDEX IF NOT EXISTS idx_runtime_event_session ON _pipeline_runtime_event(session_id);
CREATE INDEX IF NOT EXISTS idx_runtime_event_type ON _pipeline_runtime_event(event_type);
CREATE INDEX IF NOT EXISTS idx_runtime_event_status ON _pipeline_runtime_event(status);
CREATE INDEX IF NOT EXISTS idx_runtime_event_tool ON _pipeline_runtime_event(tool_name);
CREATE INDEX IF NOT EXISTS idx_runtime_event_error ON _pipeline_runtime_event(error_code);
` as const

// ── Runtime Event Analytical Views ──────────────────────────

/** Failure Hotspots — "What breaks most often?" */
export const FAILURE_HOTSPOTS_VIEW = `
CREATE OR REPLACE VIEW failure_hotspots AS
SELECT
  error_code,
  tool_name,
  event_type,
  COUNT(*) AS failures,
  AVG(duration_ms) AS avg_duration_ms,
  MAX(duration_ms) AS max_duration_ms
FROM _pipeline_runtime_event
WHERE status = 'failed'
GROUP BY error_code, tool_name, event_type
ORDER BY failures DESC
` as const

/** Slow Tools — "Which tools are slowest?" */
export const SLOW_TOOLS_VIEW = `
CREATE OR REPLACE VIEW slow_tools AS
SELECT
  tool_name,
  COUNT(*) AS calls,
  AVG(duration_ms) AS avg_ms,
  MEDIAN(duration_ms) AS median_ms,
  MAX(duration_ms) AS max_ms,
  SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failures
FROM _pipeline_runtime_event
WHERE event_type LIKE 'tool.%' OR tool_name IS NOT NULL
GROUP BY tool_name
ORDER BY avg_ms DESC
` as const

/** Multi-Agent File Contention — "Which files touched by multiple actors?" */
export const FILE_CONTENTION_VIEW = `
CREATE OR REPLACE VIEW file_contention AS
SELECT
  file_path,
  COUNT(DISTINCT actor) AS actors,
  COUNT(*) AS events,
  COUNT(DISTINCT session_id) AS sessions
FROM _pipeline_runtime_event
WHERE file_path IS NOT NULL
GROUP BY file_path
HAVING COUNT(DISTINCT actor) > 1
ORDER BY events DESC
` as const

/** Phase Gate Denials — "Which phases deny which tools?" */
export const PHASE_GATE_DENIALS_VIEW = `
CREATE OR REPLACE VIEW phase_gate_denials AS
SELECT
  phase,
  tool_name,
  event_type,
  COUNT(*) AS denied_count
FROM _pipeline_runtime_event
WHERE status = 'denied'
GROUP BY phase, tool_name, event_type
ORDER BY denied_count DESC
` as const

/** Error Summary — "Errors by category" */
export const ERROR_SUMMARY_VIEW = `
CREATE OR REPLACE VIEW error_summary AS
SELECT
  error_code,
  actor,
  tool_name,
  COUNT(*) AS occurrences,
  MIN(ts) AS first_seen,
  MAX(ts) AS last_seen
FROM _pipeline_runtime_event
WHERE error_code IS NOT NULL
GROUP BY error_code, actor, tool_name
ORDER BY occurrences DESC
` as const

/** Session Timeline — "Event timeline for a session" */
export const SESSION_TIMELINE_VIEW = `
CREATE OR REPLACE VIEW session_timeline AS
SELECT
  session_id,
  ts,
  event_type,
  actor,
  status,
  tool_name,
  file_path,
  duration_ms,
  error_code,
  correlation_id,
  parent_event_id
FROM _pipeline_runtime_event
ORDER BY session_id, ts
` as const

// ── Product Analytical Queries ───────────────────────────────

/** Packet Propagation Velocity — "Which packet families propagate fastest?" */
export const PACKET_PROPAGATION_VELOCITY_VIEW = `
CREATE OR REPLACE VIEW packet_propagation_velocity AS
WITH packet_data AS (
  SELECT
    COALESCE(
      json_extract_string(model, '$.source_family'),
      json_extract_string(model, '$.packet_type'),
      'unknown'
    ) AS packet_family,
    CAST(json_extract(model, '$.time_to_propagate') AS DOUBLE) AS time_to_propagate,
    id AS session_id
  FROM _pipeline_session
  WHERE json_extract_string(model, '$.source_packet') IS NOT NULL
     OR json_extract_string(model, '$.packet_type') IS NOT NULL
),
event_propagation AS (
  SELECT
    event_type AS packet_family,
    session_id,
    CAST((EXTRACT(epoch FROM MAX(ts)) - EXTRACT(epoch FROM MIN(ts))) * 1000 AS BIGINT) AS propagation_window_ms
  FROM _pipeline_runtime_event
  WHERE event_type IS NOT NULL
  GROUP BY event_type, session_id
)
SELECT
  COALESCE(pd.packet_family, ep.packet_family) AS packet_family,
  COUNT(DISTINCT COALESCE(pd.session_id, ep.session_id)) AS sessions,
  AVG(pd.time_to_propagate) AS avg_time_to_propagate_ms,
  MAX(pd.time_to_propagate) AS max_time_to_propagate_ms,
  AVG(NULLIF(ep.propagation_window_ms, 0)) AS avg_propagation_window_ms,
  CASE WHEN AVG(pd.time_to_propagate) IS NOT NULL THEN 'direct' ELSE 'inferred' END AS source_type
FROM packet_data pd
FULL OUTER JOIN event_propagation ep ON pd.packet_family = ep.packet_family AND pd.session_id = ep.session_id
GROUP BY COALESCE(pd.packet_family, ep.packet_family)
ORDER BY COALESCE(AVG(pd.time_to_propagate), AVG(ep.propagation_window_ms)) ASC NULLS LAST
` as const

/** Framework Failure Frequency — "Which frameworks produce repeated failures?" */
export const FRAMEWORK_FAILURE_FREQUENCY_VIEW = `
CREATE OR REPLACE VIEW framework_failure_frequency AS
SELECT
  COALESCE(split_part(tool_name, ':', 1), 'unknown') AS framework,
  COUNT(*) AS failure_count,
  MAX(ts) AS last_failure,
  COUNT(DISTINCT session_id) AS distinct_sessions,
  COUNT(DISTINCT tool_name) AS distinct_tools
FROM _pipeline_runtime_event
WHERE status = 'failed'
  AND error_code IS NOT NULL
GROUP BY framework
ORDER BY failure_count DESC
` as const

/** Dharma PR Correlation — "Which dharma signals correlate with merged PRs?" */
export const DHARMA_PR_CORRELATION_VIEW = `
CREATE OR REPLACE VIEW dharma_pr_correlation AS
WITH session_signals AS (
  SELECT
    COALESCE(
      json_extract_string(model, '$.dharma'),
      json_extract_string(model, '$.dharma_signal'),
      json_extract_string(model, '$.tags')
    ) AS dharma_signal,
    CAST(
      COALESCE(
        json_extract(model, '$.merged_prs'),
        json_extract(model, '$.merged_pr_count'),
        '0'
      ) AS INTEGER
    ) AS merged_prs,
    id AS session_id
  FROM _pipeline_session
  WHERE json_extract_string(model, '$.dharma') IS NOT NULL
     OR json_extract_string(model, '$.dharma_signal') IS NOT NULL
     OR json_extract_string(model, '$.tags') IS NOT NULL
)
SELECT
  dharma_signal,
  COUNT(*) AS total_sessions,
  SUM(merged_prs) AS merged_prs,
  CASE
    WHEN COUNT(*) > 0 THEN SUM(merged_prs)::DOUBLE / COUNT(*)
    ELSE 0.0
  END AS correlation_score,
  MAX(merged_prs) AS max_prs_in_session
FROM session_signals
WHERE dharma_signal IS NOT NULL
GROUP BY dharma_signal
ORDER BY correlation_score DESC
` as const

/** Codex Staleness — "Which codex entries are going stale?" */
export const CODEX_STALENESS_VIEW = `
CREATE OR REPLACE VIEW codex_staleness AS
SELECT
  file_path,
  MAX(ts) AS last_touched,
  CAST((EXTRACT(epoch FROM CURRENT_TIMESTAMP) - EXTRACT(epoch FROM MAX(ts))) / 86400 AS INTEGER) AS days_since_touch,
  CASE
    WHEN MAX(ts) < CURRENT_TIMESTAMP - INTERVAL '7 days' THEN TRUE
    ELSE FALSE
  END AS is_stale,
  COUNT(*) AS total_events,
  COUNT(DISTINCT session_id) AS sessions_touched,
  COUNT(DISTINCT actor) AS distinct_actors
FROM _pipeline_runtime_event
WHERE file_path IS NOT NULL
GROUP BY file_path
ORDER BY last_touched ASC NULLS LAST
` as const

/** Agent Route Quality — "Which agent routes produce bad matches?" */
export const AGENT_ROUTE_QUALITY_VIEW = `
CREATE OR REPLACE VIEW agent_route_quality AS
SELECT
  COALESCE(actor, 'unknown') AS route,
  COUNT(*) AS total_calls,
  SUM(CASE WHEN status = 'failed' OR status = 'error' THEN 1 ELSE 0 END) AS error_count,
  SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS success_count,
  CASE
    WHEN COUNT(*) > 0
    THEN CAST(SUM(CASE WHEN status = 'failed' OR status = 'error' THEN 1 ELSE 0 END) AS DOUBLE) / COUNT(*) * 100.0
    ELSE 0.0
  END AS error_rate,
  AVG(duration_ms) AS avg_duration_ms
FROM _pipeline_runtime_event
WHERE actor IS NOT NULL
  OR event_type LIKE 'agent.%'
GROUP BY route
ORDER BY error_rate DESC
` as const

// ── Valkey Coordination Views ───────────────────────────────

/** Stale Heartbeats — agents with heartbeat > 60s ago. */
export const STALE_HEARTBEATS_VIEW = `
CREATE OR REPLACE VIEW stale_heartbeats AS
SELECT
  agent_id,
  lane_id,
  last_heartbeat_epoch,
  status,
  generation,
  (CAST(epoch_ms(CURRENT_TIMESTAMP) AS BIGINT) - last_heartbeat_epoch) / 1000 AS stale_seconds
FROM _pipeline_valkey_heartbeats
WHERE last_heartbeat_epoch < CAST(epoch_ms(CURRENT_TIMESTAMP) AS BIGINT) - 60000
ORDER BY stale_seconds DESC
` as const

/** Consumer Lag — consumer groups sorted by pending_count DESC. */
export const CONSUMER_LAG_VIEW = `
CREATE OR REPLACE VIEW consumer_lag AS
SELECT
  group_name,
  stream_key,
  pending_count,
  last_delivered_id,
  consumer_count,
  snapshot_at_epoch
FROM _pipeline_valkey_consumer_groups
ORDER BY pending_count DESC
` as const

/** Coordination Health — summary of total agents, active leases, generation. */
export const COORDINATION_HEALTH_VIEW = `
CREATE OR REPLACE VIEW coordination_health AS
SELECT
  (SELECT COUNT(DISTINCT agent_id) FROM _pipeline_valkey_heartbeats WHERE status = 'active') AS total_agents,
  (SELECT COUNT(*) FROM _pipeline_valkey_heartbeats WHERE status = 'active') AS active_leases,
  GREATEST((SELECT COALESCE(MAX(generation), 0) FROM _pipeline_valkey_heartbeats), 0) AS generation,
  (SELECT COALESCE(SUM(pending_count), 0) FROM _pipeline_valkey_consumer_groups) AS total_pending,
  (SELECT COUNT(*) FROM _pipeline_valkey_consumer_groups) AS consumer_group_count,
  CAST(epoch_ms(CURRENT_TIMESTAMP) AS BIGINT) AS snapshot_at_epoch
` as const

/** All runtime event analytical views. */
export const RUNTIME_EVENT_VIEWS = [
  FAILURE_HOTSPOTS_VIEW,
  SLOW_TOOLS_VIEW,
  FILE_CONTENTION_VIEW,
  PHASE_GATE_DENIALS_VIEW,
  ERROR_SUMMARY_VIEW,
  SESSION_TIMELINE_VIEW,
  STALE_HEARTBEATS_VIEW,
  CONSUMER_LAG_VIEW,
  COORDINATION_HEALTH_VIEW,
  PACKET_PROPAGATION_VELOCITY_VIEW,
  FRAMEWORK_FAILURE_FREQUENCY_VIEW,
  DHARMA_PR_CORRELATION_VIEW,
  CODEX_STALENESS_VIEW,
  AGENT_ROUTE_QUALITY_VIEW,
] as const

/** All analytical tables to create on init (before views). */
export const ALL_TABLES = [
  WAVES_TABLE, FINDINGS_TABLE, REGISTRY_TABLE,
  QA_TABLE, DIAGNOSTICS_TABLE, RUNTIME_EVENTS_TABLE,
  VALKEY_CONSUMER_GROUPS_TABLE, VALKEY_HEARTBEATS_TABLE,
  ...ALL_CTX_TABLES,
] as const

/** All analytical views to create on init (after tables). */
export const ALL_RUNTIME_VIEWS = RUNTIME_EVENT_VIEWS

// ── Context Projection SQL ──────────────────────────────────

/** SQL to insert raw file events from stdin into _ctx_file_events. */
export const CONTEXT_EVENTS_INSERT_SQL = `
DELETE FROM _ctx_file_events;
INSERT INTO _ctx_file_events (session_id, file_path, event_type, actor, tool_name, phase, event_ts)
SELECT session_id, file_path, event_type, actor, tool_name, phase, ts::TIMESTAMP
FROM read_json_auto('/dev/stdin');
` as const

/** SQL to build aggregated context tables from _pipeline_runtime_event. */
export const CONTEXT_AGGREGATION_SQL = `
INSERT OR REPLACE INTO _ctx_file_relevance (file_path, session_id, recency_score, edit_count, failure_count, claim_count, read_count, last_ts)
SELECT
  file_path,
  session_id,
  1.0 / (CAST(epoch_ms(CURRENT_TIMESTAMP) AS BIGINT) - CAST(epoch_ms(MAX(ts)) AS BIGINT) + 1) AS recency_score,
  SUM(CASE WHEN event_type LIKE 'file.%' OR event_type LIKE 'edit.%' THEN 1 ELSE 0 END) AS edit_count,
  SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failure_count,
  SUM(CASE WHEN event_type LIKE 'claim.%' THEN 1 ELSE 0 END) AS claim_count,
  COUNT(*) AS read_count,
  MAX(ts) AS last_ts
FROM _pipeline_runtime_event
WHERE file_path IS NOT NULL
GROUP BY file_path, session_id;

WITH cochange_pairs AS (
  SELECT a.file_path AS file_a, b.file_path AS file_b, a.session_id
  FROM _pipeline_runtime_event a
  JOIN _pipeline_runtime_event b ON a.session_id = b.session_id AND a.file_path < b.file_path
  WHERE a.file_path IS NOT NULL AND b.file_path IS NOT NULL
  GROUP BY a.file_path, b.file_path, a.session_id
)
INSERT OR REPLACE INTO _ctx_file_cochange (file_a, file_b, cochange_count, sessions_shared)
SELECT file_a, file_b, COUNT(*) AS cochange_count, COUNT(DISTINCT session_id) AS sessions_shared
FROM cochange_pairs
GROUP BY file_a, file_b;

INSERT OR REPLACE INTO _ctx_agent_heatmap (agent_name, file_path, read_count, edit_count, last_access)
SELECT
  actor,
  file_path,
  COUNT(*) AS read_count,
  SUM(CASE WHEN event_type LIKE 'file.%' OR event_type LIKE 'edit.%' THEN 1 ELSE 0 END) AS edit_count,
  MAX(ts) AS last_access
FROM _pipeline_runtime_event
WHERE file_path IS NOT NULL
GROUP BY actor, file_path;

INSERT OR REPLACE INTO _ctx_error_files (error_code, file_path, occurrence_count, first_seen, last_seen)
SELECT
  error_code,
  file_path,
  COUNT(*) AS occurrence_count,
  MIN(ts) AS first_seen,
  MAX(ts) AS last_seen
FROM _pipeline_runtime_event
WHERE error_code IS NOT NULL AND file_path IS NOT NULL
GROUP BY error_code, file_path;
` as const

// ── Context Projection Builder ─────────────────────────────
//
// buildContextProjections reads runtime events with file_path from
// SQLite/Postgres via the adapter, pipes them into _ctx_file_events,
// then aggregates into _ctx_file_relevance, _ctx_file_cochange,
// _ctx_agent_heatmap, and _ctx_error_files.

/**
 * Build all context projection tables from runtime event data.
 *
 * Reads events with file_path from the transactional DB (via adapter),
 * pipes them into `_ctx_file_events`, then aggregates into the remaining
 * context tables. The aggregation step reads from `_pipeline_runtime_event`
 * (which the pipeline populates) for richer column access (status, error_code).
 *
 * Safe to call multiple times — tables are truncated before insert.
 */
export function buildContextProjections(
  dbPath: string,
  adapter: DatabaseAdapter.Interface,
  signal?: AbortSignal,
): Effect.Effect<void> {
  if (dbPath === ":memory:") return Effect.void
  return Effect.gen(function* () {
    // 1. Read runtime events with file_path from the transactional DB
    const events: Array<Record<string, unknown>> = yield* adapter.query((db: any) =>
      db.all(
        `SELECT session_id, file_path, event_type, actor, tool_name, phase, ts
         FROM runtime_events
         WHERE file_path IS NOT NULL
         ORDER BY ts DESC LIMIT 10000`,
      ),
    ).pipe(
      Effect.catchTag("DatabaseError", () => Effect.succeed([])),
    )

    if (events.length === 0) {
      yield* Effect.logInfo("No runtime events with file_path found, skipping context projections")
      return
    }

    // 2. Ensure context tables exist, clear old data, pipe fresh events via stdin
    const ddl = ALL_CTX_TABLES.join("\n")
    yield* Effect.promise(() =>
      execDuckDBStdin(dbPath, ddl + "\n" + CONTEXT_EVENTS_INSERT_SQL, JSON.stringify(events), signal),
    )

    // 3. Build aggregated tables from _pipeline_runtime_event
    //    (non-fatal if _pipeline_runtime_event isn't available)
    yield* Effect.promise(() =>
      execDuckDB(dbPath, CONTEXT_AGGREGATION_SQL, signal),
    ).pipe(
      Effect.tapError((err) =>
        Effect.logWarning("Context aggregation skipped (_pipeline_runtime_event unavailable)").pipe(
          Effect.annotateLogs("error", String(err)),
        ),
      ),
      Effect.ignore,
    )

    yield* Effect.logInfo("Context projections built successfully")
  }).pipe(
    Effect.catch((error: unknown) =>
      Effect.logError("Context projections failed (non-fatal)").pipe(
        Effect.annotateLogs("error", String(error)),
      ),
    ),
    Effect.withSpan("ContextProjection.build"),
  )
}

/** Create all analytical tables in the DuckDB session. Call before initViewsSql. */
export function initTablesSql(): string {
  return ALL_TABLES.join(";\n")
}

/** Create all analytical views (existing + runtime) in the DuckDB session. */
export function initViewsSql(): string {
  return [...ALL_VIEWS, ...RUNTIME_EVENT_VIEWS].join(";\n")
}
