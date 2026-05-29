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

/** All analytical tables to create on init (before views). */
export const ALL_TABLES = [
  WAVES_TABLE, FINDINGS_TABLE, REGISTRY_TABLE,
  QA_TABLE, DIAGNOSTICS_TABLE,
] as const

/** Create all analytical tables in the DuckDB session. Call before initViewsSql. */
export function initTablesSql(): string {
  return ALL_TABLES.join(";\n")
}

// ── View initialization ────────────────────────────────────

/**
 * Create all analytical views in the DuckDB session.
 * Call once after connecting.
 */
export function initViewsSql(): string {
  return ALL_VIEWS.join(";\n")
}
