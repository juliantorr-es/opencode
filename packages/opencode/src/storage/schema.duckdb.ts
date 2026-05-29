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
//
// Views are created lazily on first analytical query via `initViewsSql()`.

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

// ── View initialization ────────────────────────────────────

/**
 * Create all analytical views in the DuckDB session.
 * Call once after connecting.
 */
export function initViewsSql(): string {
  return ALL_VIEWS.join(";\n")
}
