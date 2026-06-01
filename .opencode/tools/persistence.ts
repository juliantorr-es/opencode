/**
 * Persistence API — the single interface tools use to read/write orchestration state.
 * No tool talks directly to SQLite. All persistence goes through this module.
 *
 * Design contract:
 *   Tools → persistence.ts → db.ts → SQLite + JSONL mirror
 */

import { Database } from "bun:sqlite"
import { init as dbInit, insertAndMirror, forgettingCurve, checkDeadlines, resurrectContext, enableMirror, phoenixRecover, migrateFromFilesystem, rebuildSearchIndex, writeWill } from "./db"

// ═══════════════════════════════════════════════════════════
// Initialization
// ═══════════════════════════════════════════════════════════

export function openDatabase(worktree: string): Database {
  const db = dbInit(worktree)
  enableMirror(worktree)
  return db
}

export function recoverIfNeeded(db: Database, worktree: string): boolean {
  return phoenixRecover(db, worktree)
}

export function migrateLegacyData(db: Database, worktree: string): { migrated: number; errors: number } {
  return migrateFromFilesystem(db, worktree)
}

export function rebuildSearch(db: Database): number {
  return rebuildSearchIndex(db)
}

// ═══════════════════════════════════════════════════════════
// Lane lifecycle
// ═══════════════════════════════════════════════════════════

export interface LaneAgent {
  id: number
  lane_id: string
  agent: string
  status: "pending" | "started" | "completed" | "failed" | "stale" | "resurrected"
  delegated_by: string | null
  delegated_at: string | null
  started_at: string | null
  completed_at: string | null
  task: string | null
  repair: number
  auto_completed: number
  stale_timeout: number
  advanced_by: string | null
  summary: string | null
  files_created: string | null
  files_modified: string | null
  findings: string | null
  blockers: string | null
  next_steps: string | null
  created_at: string
}

export function spawnAgent(
  db: Database,
  laneId: string,
  agent: string,
  delegatedBy: string,
  task?: string,
  staleTimeoutMinutes?: number,
): void {
  insertAndMirror(db, "lane_agents", [
    "lane_id", "agent", "status", "delegated_by", "delegated_at", "task", "stale_timeout",
  ], [
    laneId, agent, "pending", delegatedBy, new Date().toISOString(),
    task?.slice(0, 500) ?? null, staleTimeoutMinutes ?? 0,
  ])
}

export function completeAgent(
  db: Database,
  laneId: string,
  agent: string,
  status: "completed" | "failed" | "partial",
  summary?: string,
  filesCreated?: string[],
  filesModified?: string[],
  findings?: string[],
): void {
  insertAndMirror(db, "lane_agents", [
    "lane_id", "agent", "status", "delegated_by", "delegated_at", "completed_at",
    "auto_completed", "summary", "files_created", "files_modified", "findings",
  ], [
    laneId, agent, status, "plugin", new Date().toISOString(), new Date().toISOString(),
    1, summary?.slice(0, 500) ?? null,
    filesCreated ? JSON.stringify(filesCreated) : null,
    filesModified ? JSON.stringify(filesModified) : null,
    findings ? JSON.stringify(findings) : null,
  ])
}

export function markAgentStale(db: Database, laneId: string, agent: string): void {
  db.run(`UPDATE lane_agents SET status = 'stale', stale_timeout = 1
          WHERE id = (SELECT MAX(id) FROM lane_agents WHERE lane_id = ? AND agent = ?)`,
    laneId, agent)
}

export function markAgentResurrected(db: Database, laneId: string, agent: string, toolCallCount: number): void {
  insertAndMirror(db, "lane_agents", [
    "lane_id", "agent", "status", "delegated_by", "delegated_at", "completed_at", "auto_completed", "summary",
  ], [
    laneId, agent, "resurrected", "ghost", new Date().toISOString(), new Date().toISOString(),
    1, `Resurrected — ${toolCallCount} tool calls replayed`,
  ])
}

export function getLaneAgents(db: Database, laneId: string): LaneAgent[] {
  return db.query(`
    SELECT * FROM lane_agents
    WHERE id IN (SELECT MAX(id) FROM lane_agents GROUP BY lane_id, agent)
      AND lane_id = ?
    ORDER BY delegated_at DESC
  `).all(laneId) as LaneAgent[]
}

export function getLatestAgentStatus(db: Database, laneId: string, agent: string): LaneAgent | null {
  return db.query(`
    SELECT * FROM lane_agents
    WHERE lane_id = ? AND agent = ?
    ORDER BY id DESC LIMIT 1
  `).get(laneId, agent) as LaneAgent | null
}

export function getAllLaneStatuses(db: Database, lanePrefix?: string): LaneAgent[] {
  let query = `
    SELECT * FROM lane_agents
    WHERE id IN (SELECT MAX(id) FROM lane_agents GROUP BY lane_id, agent)
  `
  const params: string[] = []
  if (lanePrefix) {
    query += ` AND lane_id LIKE ?`
    params.push(lanePrefix + "%")
  }
  query += ` ORDER BY delegated_at DESC`
  return db.query(query).all(...params) as LaneAgent[]
}

export function getOverdueAgents(db: Database, laneId: string): LaneAgent[] {
  return checkDeadlines(db, laneId) as LaneAgent[]
}

export function getResurrectedAgents(db: Database, laneId: string): { agent: string }[] {
  return db.query(`
    SELECT DISTINCT agent FROM lane_agents
    WHERE lane_id = ? AND status = 'resurrected'
    ORDER BY id DESC LIMIT 1
  `).all(laneId) as { agent: string }[]
}

/**
 * Get pending agents — used by "the will" on shutdown
 */
export function getPendingAgents(db: Database): { lane_id: string; agent: string }[] {
  return db.query(`
    SELECT lane_id, agent FROM lane_agents
    WHERE id IN (SELECT MAX(id) FROM lane_agents GROUP BY lane_id, agent)
      AND status = 'pending'
  `).all() as { lane_id: string; agent: string }[]
}

// ═══════════════════════════════════════════════════════════
// Event journal
// ═══════════════════════════════════════════════════════════

export interface JournalEntry {
  id: number
  lane_id: string
  agent: string | null
  session_id: string | null
  tool: string | null
  exit_code: number | null
  summary: string | null
  output: string | null
  files_touched: string | null
  created_at: string
}

export function recordEvent(
  db: Database,
  laneId: string,
  agent: string,
  tool: string,
  summary?: string,
  output?: string,
  filesTouched?: string[],
  exitCode?: number,
): void {
  insertAndMirror(db, "journal", [
    "lane_id", "agent", "session_id", "tool", "exit_code", "summary", "output", "files_touched",
  ], [
    laneId, agent, null, tool,
    exitCode ?? null,
    summary?.slice(0, 500) ?? null,
    output?.slice(0, 10000) ?? null,
    filesTouched ? JSON.stringify(filesTouched) : null,
  ])
}

export function getRecentEvents(db: Database, laneId: string, limit = 40): JournalEntry[] {
  return db.query(`
    SELECT * FROM journal WHERE lane_id = ? ORDER BY created_at DESC LIMIT ?
  `).all(laneId, limit) as JournalEntry[]
}

export function getAgentEvents(db: Database, laneId: string, agent: string, limit = 10): JournalEntry[] {
  return db.query(`
    SELECT tool, summary FROM journal WHERE lane_id = ? AND agent = ? ORDER BY created_at DESC LIMIT ?
  `).all(laneId, agent, limit) as JournalEntry[]
}

export function getCrashedAgentJournal(db: Database, laneId: string, agent: string): JournalEntry[] {
  return db.query(`
    SELECT tool, summary, output, exit_code, created_at
    FROM journal WHERE lane_id = ? AND agent = ? ORDER BY created_at ASC
  `).all(laneId, agent) as JournalEntry[]
}

// ═══════════════════════════════════════════════════════════
// Heartbeat / analytics
// ═══════════════════════════════════════════════════════════

export function recordHeartbeat(
  db: Database,
  sessionId: string,
  agent: string,
  tool: string,
  phase: "completed" | "failed" | "loop_detected",
  detail?: string,
): void {
  db.run(
    `INSERT INTO heartbeats (session_id, agent, tool, phase, detail, at) VALUES (?, ?, ?, ?, ?, ?)`,
    sessionId, agent, tool, phase, detail?.slice(0, 200) ?? null, new Date().toISOString(),
  )
}

export function recordToolUsage(
  db: Database,
  sessionId: string,
  agent: string,
  tool: string,
  extra?: { command?: string; elapsedMs?: number; exitCode?: number; cwd?: string },
): void {
  db.run(
    `INSERT INTO tool_usage (session_id, agent, tool, command, elapsed_ms, exit_code, cwd, at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    sessionId, agent, tool,
    extra?.command?.slice(0, 200) ?? null,
    extra?.elapsedMs ?? null,
    extra?.exitCode ?? null,
    extra?.cwd?.slice(0, 200) ?? null,
    new Date().toISOString(),
  )
}

export function getRecentHeartbeats(db: Database, agent: string, minutes: number, phase?: string): number {
  const phaseCond = phase ? `AND phase = ?` : ""
  const params: (string | number)[] = [agent, `-${minutes} minutes`]
  if (phase) params.push(phase)
  return (db.query(
    `SELECT COUNT(*) as cnt FROM heartbeats WHERE agent = ? AND at > datetime('now', ?) ${phaseCond}`
  ).get(...params) as { cnt: number })?.cnt ?? 0
}

// ═══════════════════════════════════════════════════════════
// Claims / artifacts (universal key-value store)
// ═══════════════════════════════════════════════════════════

export function createClaim(db: Database, key: string, data: unknown, source?: string): void {
  db.run(
    `INSERT OR REPLACE INTO artifacts (key, data, source, updated_at) VALUES (?, ?, ?, ?)`,
    key, JSON.stringify(data), source ?? "unknown", new Date().toISOString(),
  )
}

export function readClaim<T = unknown>(db: Database, key: string): T | null {
  const row = db.query(`SELECT data FROM artifacts WHERE key = ?`).get(key) as { data: string } | null
  if (!row) return null
  try { return JSON.parse(row.data) as T } catch { return row.data as T }
}

export function listClaims(db: Database, prefix?: string): string[] {
  const rows = db.query(
    `SELECT key FROM artifacts WHERE key LIKE ? ORDER BY updated_at DESC LIMIT 50`
  ).all((prefix ?? "") + "%") as { key: string }[]
  return rows.map(r => r.key)
}

// ═══════════════════════════════════════════════════════════
// Knowledge graph
// ═══════════════════════════════════════════════════════════

export function indexCodebaseFile(
  db: Database,
  path: string,
  purpose?: string,
  exportsSummary?: string,
  lineCount?: number,
  indexedBy?: string,
): void {
  db.run(
    `INSERT OR REPLACE INTO files (path, purpose, exports_summary, line_count, last_indexed_at, last_modified_by)
     VALUES (?, ?, ?, ?, ?, ?)`,
    path, purpose?.slice(0, 500) ?? null, exportsSummary?.slice(0, 500) ?? null,
    lineCount ?? null, new Date().toISOString(), indexedBy ?? "unknown",
  )
}

export function getFileKnowledge(db: Database, filePath: string): {
  file: { path: string; purpose: string; line_count: number; content_hash: string } | null
  symbols: { name: string; kind: string; line: number; exported: number; signature: string }[]
  importedBy: { from_file: string; imported_symbols: string }[]
  imports: { to_file: string; imported_symbols: string }[]
  hotspot: { type_errors: number; test_failures: number; last_error_message: string } | null
  patterns: { name: string; description: string }[]
} {
  const file = db.query(`SELECT path, purpose, line_count, content_hash FROM files WHERE path = ?`).get(filePath) as any
  const symbols = db.query(`SELECT name, kind, line, exported, signature FROM symbols WHERE file_path = ? LIMIT 20`).all(filePath) as any[]
  const depsIn = db.query(`SELECT from_file, imported_symbols FROM dependencies WHERE to_file = ? LIMIT 10`).all(filePath) as any[]
  const depsOut = db.query(`SELECT to_file, imported_symbols FROM dependencies WHERE from_file = ? LIMIT 10`).all(filePath) as any[]
  const hotspot = db.query(`SELECT type_errors, test_failures, last_error_message FROM error_hotspots WHERE file_path = ?`).get(filePath) as any
  const pats = db.query(`SELECT name, description FROM patterns WHERE file_path = ? LIMIT 5`).all(filePath) as any[]
  return { file, symbols, importedBy: depsIn, imports: depsOut, hotspot, patterns: pats }
}

export function getTopHotspots(db: Database, limit = 10): { file_path: string; type_errors: number; test_failures: number }[] {
  return db.query(`SELECT file_path, type_errors, test_failures FROM error_hotspots ORDER BY (type_errors + test_failures) DESC LIMIT ?`).all(limit) as any[]
}

export function getDiscoveredConventions(db: Database): { category: string; cnt: number }[] {
  return db.query(`SELECT category, COUNT(*) as cnt FROM conventions GROUP BY category ORDER BY cnt DESC`).all() as any[]
}

export function findModifiedFiles(db: Database, worktree: string, limit = 20): { path: string; oldHash: string; newHash: string }[] {
  const { findModifiedFiles: fmf } = require("./db") as typeof import("./db")
  return fmf(db, worktree, limit)
}

// ═══════════════════════════════════════════════════════════
// Search
// ═══════════════════════════════════════════════════════════

export function indexForSearch(db: Database, source: string, content: string): void {
  const { indexForSearch: ifs } = require("./db") as typeof import("./db")
  ifs(db, source, content)
}

export function searchAll(db: Database, query: string, limit = 20): { source: string; content: string; rank: number }[] {
  const { searchEverything } = require("./db") as typeof import("./db")
  return searchEverything(db, query, limit) as any[]
}

// ═══════════════════════════════════════════════════════════
// Maintenance
// ═══════════════════════════════════════════════════════════

export function vacuum(db: Database): { pageCount: number; pageSize: number; sizeBytes: number } {
  db.exec("PRAGMA optimize")
  db.exec("VACUUM")
  const pageCount = (db.query("PRAGMA page_count").get() as { page_count: number })?.page_count ?? 0
  const pageSize = (db.query("PRAGMA page_size").get() as { page_size: number })?.page_size ?? 0
  return { pageCount, pageSize, sizeBytes: pageCount * pageSize }
}

export function pruneOldData(db: Database, retentionDays: number): Record<string, number> {
  const tables: Record<string, string> = {
    heartbeats: `at < datetime('now', '-${retentionDays} days')`,
    tool_usage: `at < datetime('now', '-${retentionDays} days')`,
    bash_usage: `at < datetime('now', '-${retentionDays} days')`,
    journal: `created_at < datetime('now', '-${Math.min(retentionDays * 2, 30)} days')`,
  }
  const result: Record<string, number> = {}
  for (const [table, condition] of Object.entries(tables)) {
    const count = (db.query(`SELECT COUNT(*) as cnt FROM ${table} WHERE ${condition}`).get() as { cnt: number })?.cnt ?? 0
    if (count > 0) db.run(`DELETE FROM ${table} WHERE ${condition}`)
    result[table] = count
  }
  return result
}

export function getDbStats(db: Database): Record<string, number> {
  return {
    heartbeats: (db.query("SELECT COUNT(*) as cnt FROM heartbeats").get() as { cnt: number })?.cnt ?? 0,
    tool_usage: (db.query("SELECT COUNT(*) as cnt FROM tool_usage").get() as { cnt: number })?.cnt ?? 0,
    journal: (db.query("SELECT COUNT(*) as cnt FROM journal").get() as { cnt: number })?.cnt ?? 0,
    lane_agents: (db.query("SELECT COUNT(*) as cnt FROM lane_agents").get() as { cnt: number })?.cnt ?? 0,
    messages: (db.query("SELECT COUNT(*) as cnt FROM messages").get() as { cnt: number })?.cnt ?? 0,
    files: (db.query("SELECT COUNT(*) as cnt FROM files").get() as { cnt: number })?.cnt ?? 0,
  }
}

export function snapshotWill(db: Database, sessionId: string): void {
  writeWill(db, sessionId)
}
