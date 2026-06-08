// ── Runtime Event DuckDB Query Helpers ─────────────────────
//
// Typed query functions that read from the DuckDB analytical
// views defined in schema.duckdb.ts. Each function accepts a
// DuckDBRawClient and returns structured records.
//
// All views are read-only — these queries never write.

import type { DuckDBRawClient } from "../storage/db.duckdb"

// ── Row types ──────────────────────────────────────────────

export interface FailureHotspot {
  error_code: string | null
  tool_name: string | null
  event_type: string | null
  failures: number
  avg_duration_ms: number | null
  max_duration_ms: number | null
}

export interface SlowTool {
  tool_name: string | null
  calls: number
  avg_ms: number | null
  median_ms: number | null
  max_ms: number | null
  failures: number
}

export interface FileContention {
  file_path: string
  actors: number
  events: number
  sessions: number
}

export interface PhaseGateDenial {
  phase: string | null
  tool_name: string | null
  event_type: string | null
  denied_count: number
}

export interface ErrorSummary {
  error_code: string
  actor: string | null
  tool_name: string | null
  occurrences: number
  first_seen: string | null
  last_seen: string | null
}

export interface SessionEvent {
  session_id: string | null
  ts: string | null
  event_type: string | null
  actor: string | null
  status: string | null
  tool_name: string | null
  file_path: string | null
  duration_ms: number | null
  error_code: string | null
  correlation_id: string | null
  parent_event_id: string | null
}

// ── Query functions ────────────────────────────────────────

/**
 * Query failure hotspots — events that fail most often,
 * grouped by error_code, tool_name, and event_type.
 * @param db DuckDB client
 * @param limit Optional max rows to return (default 50)
 */
export function queryFailureHotspots(db: DuckDBRawClient, limit: number = 50): Promise<FailureHotspot[]> {
  return db.all<FailureHotspot>(
    `SELECT * FROM failure_hotspots ORDER BY failures DESC LIMIT ${limit}`,
  )
}

/**
 * Query slow tools — average, median, and max duration per tool.
 * @param db DuckDB client
 * @param minCalls Optional minimum call count to include (default 1)
 */
export function querySlowTools(db: DuckDBRawClient, minCalls: number = 1): Promise<SlowTool[]> {
  return db.all<SlowTool>(
    `SELECT * FROM slow_tools WHERE calls >= ${minCalls} ORDER BY avg_ms DESC`,
  )
}

/**
 * Query file contention — files touched by multiple actors.
 * @param db DuckDB client
 */
export function queryFileContention(db: DuckDBRawClient): Promise<FileContention[]> {
  return db.all<FileContention>(
    "SELECT * FROM file_contention ORDER BY events DESC",
  )
}

/**
 * Query phase gate denials — which phases deny which tools.
 * @param db DuckDB client
 */
export function queryPhaseGateDenials(db: DuckDBRawClient): Promise<PhaseGateDenial[]> {
  return db.all<PhaseGateDenial>(
    "SELECT * FROM phase_gate_denials ORDER BY denied_count DESC",
  )
}

/**
 * Query error summary — errors by category, grouped by error_code, actor, tool_name.
 * @param db DuckDB client
 */
export function queryErrorSummary(db: DuckDBRawClient): Promise<ErrorSummary[]> {
  return db.all<ErrorSummary>(
    "SELECT * FROM error_summary ORDER BY occurrences DESC",
  )
}

/**
 * Query session timeline — chronological event list for a specific session.
 * @param db DuckDB client
 * @param sessionId Session identifier to filter on
 */
export function querySessionTimeline(db: DuckDBRawClient, sessionId: string): Promise<SessionEvent[]> {
  return db.all<SessionEvent>(
    `SELECT * FROM session_timeline WHERE session_id = '${sessionId.replace(/'/g, "''")}' ORDER BY ts`,
  )
}
