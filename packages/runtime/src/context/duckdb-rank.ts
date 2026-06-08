// ── DuckDB Context Ranking ─────────────────────────────────
//
// Typed query functions for context-aware working set ranking.
// Reads from DuckDB context projection tables populated by
// buildContextProjections() in schema.duckdb.ts.
//
// These are read-only queries — they never write to DuckDB.

import { Effect } from "effect"
import type { DuckDBRawClient } from "../storage/db.duckdb"

// ── Row types ──────────────────────────────────────────────

/** A ranked file within a session's working set. */
export interface RankedFile {
  filePath: string
  sessionId: string
  score: number
  recencyScore: number
  editCount: number
  failureCount: number
  claimCount: number
  lastAccess: string | null
}

/** A co-change relationship between two files. */
export interface FileCochange {
  fileA: string
  fileB: string
  cochangeCount: number
  sessionsShared: number
}

/** Agent access summary for a file. */
export interface AgentHeatmapEntry {
  agentName: string
  filePath: string
  readCount: number
  editCount: number
  lastAccess: string | null
}

/** Error-to-file association. */
export interface ErrorFileEntry {
  errorCode: string
  filePath: string
  occurrenceCount: number
  firstSeen: string | null
  lastSeen: string | null
}

// ── Query functions ────────────────────────────────────────

/**
 * Return the top-N files for a given session, ranked by a weighted
 * combination of recency, edit count, failure count, and claim count.
 *
 * Weights: recency=0.4, edit=0.3, failure=0.2, claim=0.1
 *
 * @param db DuckDB read-only client
 * @param sessionId Session to rank files for
 * @param limit Max files to return (default 20)
 */
export function rankWorkingSet(
  db: DuckDBRawClient,
  sessionId: string,
  limit: number = 20,
): Effect.Effect<string[]> {
  return Effect.tryPromise(() =>
    db.all<{ file_path: string }>(
      `SELECT file_path
       FROM _ctx_file_relevance
       WHERE session_id = '${sessionId.replace(/'/g, "''")}'
       ORDER BY (
         recency_score * 0.4 +
         CAST(edit_count AS DOUBLE) * 0.3 +
         CAST(failure_count AS DOUBLE) * 0.2 +
         CAST(claim_count AS DOUBLE) * 0.1
       ) DESC
       LIMIT ${limit}`,
    ).then((rows) => rows.map((r) => r.file_path)),
  )
}

/**
 * Return the top-N files with full scoring details for analysis.
 *
 * @param db DuckDB read-only client
 * @param sessionId Session to rank files for
 * @param limit Max files to return (default 20)
 */
export function rankWorkingSetFull(
  db: DuckDBRawClient,
  sessionId: string,
  limit: number = 20,
): Effect.Effect<RankedFile[]> {
  return Effect.tryPromise(() =>
    db.all<{
      file_path: string
      session_id: string
      recency_score: number
      edit_count: number
      failure_count: number
      claim_count: number
      last_ts: string | null
    }>(
      `SELECT file_path, session_id, recency_score, edit_count, failure_count, claim_count, last_ts
       FROM _ctx_file_relevance
       WHERE session_id = '${sessionId.replace(/'/g, "''")}'
       ORDER BY (
         recency_score * 0.4 +
         CAST(edit_count AS DOUBLE) * 0.3 +
         CAST(failure_count AS DOUBLE) * 0.2 +
         CAST(claim_count AS DOUBLE) * 0.1
       ) DESC
       LIMIT ${limit}`,
    ).then((rows) =>
      rows.map((r) => ({
        filePath: r.file_path,
        sessionId: r.session_id,
        score:
          r.recency_score * 0.4 +
          (r.edit_count ?? 0) * 0.3 +
          (r.failure_count ?? 0) * 0.2 +
          (r.claim_count ?? 0) * 0.1,
        recencyScore: r.recency_score,
        editCount: r.edit_count,
        failureCount: r.failure_count,
        claimCount: r.claim_count,
        lastAccess: r.last_ts ?? null,
      })),
    ),
  )
}

/**
 * Query co-change relationships for a given file.
 *
 * @param db DuckDB read-only client
 * @param filePath File to find co-change partners for
 */
export function queryCochange(
  db: DuckDBRawClient,
  filePath: string,
): Effect.Effect<FileCochange[]> {
  const safe = filePath.replace(/'/g, "''")
  return Effect.tryPromise(() =>
    db.all<{
      file_a: string
      file_b: string
      cochange_count: number
      sessions_shared: number
    }>(
      `SELECT file_a, file_b, cochange_count, sessions_shared
       FROM _ctx_file_cochange
       WHERE file_a = '${safe}' OR file_b = '${safe}'
       ORDER BY cochange_count DESC`,
    ).then((rows) =>
      rows.map((r) => ({
        fileA: r.file_a,
        fileB: r.file_b,
        cochangeCount: r.cochange_count,
        sessionsShared: r.sessions_shared,
      })),
    ),
  )
}

/**
 * Query agent heatmap entries for a given file.
 *
 * Tries the table first (`_ctx_agent_heatmap` — populated in persistent mode),
 * then falls back to the view (`_ctx_agent_heatmap_v` — populated in :memory:
 * mode by the projection worker).
 *
 * @param db DuckDB read-only client
 * @param filePath File to get agent access data for
 */
export function queryAgentHeatmap(
  db: DuckDBRawClient,
  filePath: string,
): Effect.Effect<AgentHeatmapEntry[]> {
  const safe = filePath.replace(/'/g, "''")
  const queryFor = (source: string) =>
    db.all<{
      agent_name: string
      file_path: string
      read_count: number
      edit_count: number
      last_access: string | null
    }>(
      `SELECT agent_name, file_path, read_count, edit_count, last_access
       FROM ${source}
       WHERE file_path = '${safe}'
       ORDER BY last_access DESC`,
    ).then((rows) =>
      rows.map((r) => ({
        agentName: r.agent_name,
        filePath: r.file_path,
        readCount: r.read_count,
        editCount: r.edit_count,
        lastAccess: r.last_access ?? null,
      })),
    )

  const table = "_ctx_agent_heatmap"
  const view = "_ctx_agent_heatmap_v"

  return Effect.tryPromise(() =>
    queryFor(table).then((rows) => {
      if (rows.length > 0) return rows
      return queryFor(view)
    }),
  ).pipe(
    Effect.catch(() => Effect.tryPromise(() => queryFor(view))),
  )
}

/**
 * Query error-to-file associations for error analysis.
 *
 * @param db DuckDB read-only client
 * @param limit Max results (default 50)
 */
export function queryErrorFiles(
  db: DuckDBRawClient,
  limit: number = 50,
): Effect.Effect<ErrorFileEntry[]> {
  return Effect.tryPromise(() =>
    db.all<{
      error_code: string
      file_path: string
      occurrence_count: number
      first_seen: string | null
      last_seen: string | null
    }>(
      `SELECT error_code, file_path, occurrence_count, first_seen, last_seen
       FROM _ctx_error_files
       ORDER BY occurrence_count DESC
       LIMIT $1`,
      [limit],
    ).then((rows) =>
      rows.map((r) => ({
        errorCode: r.error_code,
        filePath: r.file_path,
        occurrenceCount: r.occurrence_count,
        firstSeen: r.first_seen ?? null,
        lastSeen: r.last_seen ?? null,
      })),
    ),
  )
}
