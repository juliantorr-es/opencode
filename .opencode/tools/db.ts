import { Database } from "bun:sqlite"
import { resolve } from "node:path"
import { existsSync, mkdirSync, appendFileSync } from "node:fs"

let _db: Database | null = null
let _dbPath: string | null = null
let _mirrorBase: string | null = null

// ═══════════════════════════════════════════════════════════
// DUAL-WRITE MIRROR: every DB write also goes to JSONL safety net
// ═══════════════════════════════════════════════════════════

export function enableMirror(worktree: string) {
  _mirrorBase = resolve(worktree, "docs/json/opencode/mirror")
  try { mkdirSync(_mirrorBase, { recursive: true }) } catch (_) {}
}

function mirror(table: string, entry: Record<string, unknown>) {
  if (!_mirrorBase) return
  try {
    appendFileSync(resolve(_mirrorBase, `${table}.v1.jsonl`),
      JSON.stringify({ ...entry, mirrored_at: new Date().toISOString() }) + "\n", "utf8")
  } catch (_) {}
}

// ── Mirrored write helpers ──
export function insertAndMirror(db: Database, table: string, columns: string[], values: any[]) {
  const placeholders = columns.map(() => "?").join(",")
  db.run(`INSERT INTO ${table} (${columns.join(",")}) VALUES (${placeholders})`, ...values)
  const entry: Record<string, unknown> = {}
  columns.forEach((c, i) => entry[c] = values[i])
  mirror(table, entry)
}

// ═══════════════════════════════════════════════════════════
// FORGETTING CURVE: time-decayed relevance
// ═══════════════════════════════════════════════════════════

export function forgettingCurve(ageSeconds: number): number {
  // Ebbinghaus-inspired: rapid decay in first hour, then slow
  if (ageSeconds < 300) return 1.0           // <5min: full strength
  if (ageSeconds < 3600) return 0.8          // <1hr: 80%
  if (ageSeconds < 86400) return 0.5         // <1day: 50%
  if (ageSeconds < 604800) return 0.3        // <1week: 30%
  if (ageSeconds < 2592000) return 0.15      // <1month: 15%
  return 0.05                                 // older: barely remembered
}

// ═══════════════════════════════════════════════════════════
// AGENT DEADLINES: auto-stale with configurable timeout
// ═══════════════════════════════════════════════════════════

export function setDeadline(db: Database, laneId: string, agent: string, timeoutMinutes: number) {
  db.run(`UPDATE lane_agents SET deadline_at = datetime('now', '+${timeoutMinutes} minutes')
          WHERE id = (SELECT MAX(id) FROM lane_agents WHERE lane_id = ? AND agent = ?)`,
    laneId, agent)
}

export function checkDeadlines(db: Database, laneId: string): any[] {
  return db.query(`SELECT agent, status, delegated_at, deadline_at,
          CAST((julianday('now') - julianday(deadline_at)) * 86400 AS INTEGER) as overdue_seconds
          FROM lane_agents
          WHERE id IN (SELECT MAX(id) FROM lane_agents GROUP BY lane_id, agent)
            AND lane_id = ? AND status = 'pending'
            AND deadline_at IS NOT NULL AND deadline_at < datetime('now')`)
    .all(laneId) as any[]
}

// ═══════════════════════════════════════════════════════════
// GHOST RESURRECTION: replay crashed agent's journal
// ═══════════════════════════════════════════════════════════

export function resurrectContext(db: Database, laneId: string, agent: string): string {
  const rows = db.query(`SELECT tool, summary, output, exit_code, created_at
          FROM journal WHERE lane_id = ? AND agent = ? ORDER BY created_at ASC`)
    .all(laneId, agent) as any[]
  if (rows.length === 0) return ""
  
  let ctx = `\n👻 GHOST RESURRECTION — you are replacing ${agent} which crashed. Here's everything it did:\n`
  for (const r of rows) {
    ctx += `  [${r.created_at?.slice(11,19)}] ${r.tool}: ${(r.summary||"").slice(0,100)}`
    if (r.exit_code !== null) ctx += ` (exit ${r.exit_code})`
    ctx += "\n"
  }
  ctx += `\n⚠️ Pick up where ${agent} left off. Don't repeat completed work.\n`
  
  // Mark the crashed agent as resurrected
  db.run(`INSERT INTO lane_agents (lane_id, agent, status, delegated_by, delegated_at, completed_at, auto_completed, summary)
          VALUES (?, ?, 'resurrected', 'ghost', datetime('now'), datetime('now'), 1, ?)`,
    laneId, agent, `Resurrected — ${rows.length} tool calls replayed`)
  
  return ctx
}

export function init(worktree: string): Database {
  if (_db) return _db
  const dir = resolve(worktree, "docs/json/opencode")
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  _dbPath = resolve(dir, "state.db")
  _db = new Database(_dbPath, { create: true })
  _db.exec("PRAGMA journal_mode=WAL")
  _db.exec("PRAGMA busy_timeout=5000")
  ensureTables(_db)
  return _db
}

export function getPath(worktree: string): string {
  if (_dbPath) return _dbPath
  return resolve(worktree, "docs/json/opencode", "state.db")
}

function ensureTables(db: Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS lane_agents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lane_id TEXT NOT NULL,
      agent TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      delegated_by TEXT,
      delegated_at TEXT,
      started_at TEXT,
      completed_at TEXT,
      task TEXT,
      repair INTEGER DEFAULT 0,
      auto_completed INTEGER DEFAULT 0,
      stale_timeout INTEGER DEFAULT 0,
      advanced_by TEXT,
      summary TEXT,
      files_created TEXT,
      files_modified TEXT,
      findings TEXT,
      blockers TEXT,
      next_steps TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )

    CREATE INDEX IF NOT EXISTS idx_lane_agents_lane ON lane_agents(lane_id)
    CREATE INDEX IF NOT EXISTS idx_lane_agents_status ON lane_agents(status)
    CREATE INDEX IF NOT EXISTS idx_lane_agents_agent ON lane_agents(agent)

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id TEXT,
      kind TEXT NOT NULL,
      session_id TEXT,
      sender TEXT,
      recipient TEXT,
      lane_id TEXT,
      subject TEXT,
      body TEXT,
      sent_at TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )

    CREATE INDEX IF NOT EXISTS idx_messages_lane ON messages(lane_id)
    CREATE INDEX IF NOT EXISTS idx_messages_kind ON messages(kind)
    CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender)
    CREATE INDEX IF NOT EXISTS idx_messages_recipient ON messages(recipient)

    CREATE TABLE IF NOT EXISTS journal (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lane_id TEXT NOT NULL,
      agent TEXT,
      session_id TEXT,
      tool TEXT,
      exit_code INTEGER,
      summary TEXT,
      output TEXT,
      files_touched TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )

    CREATE INDEX IF NOT EXISTS idx_journal_lane ON journal(lane_id)
    CREATE INDEX IF NOT EXISTS idx_journal_agent ON journal(agent)

    -- Analytics tables
    CREATE TABLE IF NOT EXISTS heartbeats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      agent TEXT NOT NULL,
      tool TEXT NOT NULL,
      phase TEXT NOT NULL,
      detail TEXT,
      at TEXT NOT NULL
    )
    CREATE INDEX IF NOT EXISTS idx_heartbeats_session ON heartbeats(session_id)
    CREATE INDEX IF NOT EXISTS idx_heartbeats_agent ON heartbeats(agent)
    CREATE INDEX IF NOT EXISTS idx_heartbeats_at ON heartbeats(at)

    CREATE TABLE IF NOT EXISTS tool_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      agent TEXT NOT NULL,
      tool TEXT NOT NULL,
      command TEXT,
      elapsed_ms INTEGER,
      exit_code INTEGER,
      cwd TEXT,
      at TEXT NOT NULL
    )
    CREATE INDEX IF NOT EXISTS idx_tool_usage_session ON tool_usage(session_id)

    CREATE TABLE IF NOT EXISTS typecheck_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      agent TEXT NOT NULL,
      exit_code INTEGER,
      error_count INTEGER DEFAULT 0,
      file_count INTEGER DEFAULT 0,
      elapsed_ms INTEGER,
      fallback INTEGER DEFAULT 0,
      at TEXT NOT NULL
    )
    CREATE INDEX IF NOT EXISTS idx_typecheck_session ON typecheck_results(session_id)

    CREATE TABLE IF NOT EXISTS test_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      agent TEXT NOT NULL,
      cwd TEXT,
      elapsed_ms INTEGER,
      pass INTEGER DEFAULT 0,
      fail INTEGER DEFAULT 0,
      total INTEGER DEFAULT 0,
      at TEXT NOT NULL
    )
    CREATE INDEX IF NOT EXISTS idx_test_results_session ON test_results(session_id)

    CREATE TABLE IF NOT EXISTS bash_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      agent TEXT NOT NULL,
      binary TEXT,
      command TEXT,
      reason TEXT,
      elapsed_ms INTEGER,
      exit_code INTEGER,
      at TEXT NOT NULL
    )
    CREATE INDEX IF NOT EXISTS idx_bash_usage_session ON bash_usage(session_id)

    -- ═══════════════════════════════════════════════════════
    -- CODEBASE KNOWLEDGE GRAPH — living map of the codebase
    -- ═══════════════════════════════════════════════════════

    CREATE TABLE IF NOT EXISTS files (
      path TEXT PRIMARY KEY,
      purpose TEXT,
      exports_summary TEXT,
      line_count INTEGER,
      content_hash TEXT,
      last_indexed_at TEXT,
      last_modified_by TEXT,
      test_coverage TEXT
    )

    CREATE TABLE IF NOT EXISTS symbols (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_path TEXT NOT NULL REFERENCES files(path),
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      line INTEGER,
      exported INTEGER DEFAULT 0,
      signature TEXT,
      doc_comment TEXT,
      indexed_at TEXT
    )
    CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(file_path)
    CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name)
    CREATE INDEX IF NOT EXISTS idx_symbols_kind ON symbols(kind)

    CREATE TABLE IF NOT EXISTS dependencies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_file TEXT NOT NULL,
      to_file TEXT NOT NULL,
      import_path TEXT,
      imported_symbols TEXT,
      indexed_at TEXT
    )
    CREATE INDEX IF NOT EXISTS idx_deps_from ON dependencies(from_file)
    CREATE INDEX IF NOT EXISTS idx_deps_to ON dependencies(to_file)

    CREATE TABLE IF NOT EXISTS patterns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      file_path TEXT,
      description TEXT,
      example TEXT,
      found_by TEXT,
      found_at TEXT
    )

    CREATE TABLE IF NOT EXISTS error_hotspots (
      file_path TEXT PRIMARY KEY,
      type_errors INTEGER DEFAULT 0,
      test_failures INTEGER DEFAULT 0,
      last_error_at TEXT,
      last_error_message TEXT
    )

    CREATE TABLE IF NOT EXISTS conventions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category TEXT NOT NULL,
      pattern TEXT NOT NULL,
      example TEXT,
      found_by TEXT,
      found_at TEXT
    )

    CREATE TABLE IF NOT EXISTS artifacts (
      key TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      source TEXT,
      updated_at TEXT
    )

    -- FTS5 full-text search over journal, messages, and file purposes
    CREATE VIRTUAL TABLE IF NOT EXISTS search_idx USING fts5(
      source,
      content,
      tokenize='porter unicode61'
    )
  `)
}

// ── Analytics helpers ──

export function heartbeat(db: Database, sessionID: string, agent: string, tool: string, phase: string, detail: string) {
  db.run(`INSERT INTO heartbeats (session_id, agent, tool, phase, detail, at) VALUES (?, ?, ?, ?, ?, ?)`,
    sessionID, agent, tool, phase, detail.slice(0, 200), new Date().toISOString())
}

export function logToolUsage(db: Database, sessionID: string, agent: string, tool: string, extra: Record<string, unknown>) {
  db.run(`INSERT INTO tool_usage (session_id, agent, tool, command, elapsed_ms, exit_code, cwd, at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    sessionID, agent, tool,
    (extra.command as string)?.slice(0, 200) || null,
    (extra.elapsed_ms as number) || null,
    (extra.exit_code as number) ?? null,
    (extra.cwd as string)?.slice(0, 200) || null,
    new Date().toISOString())
}

export function logTypecheck(db: Database, sessionID: string, agent: string, exitCode: number, errorCount: number, fileCount: number, elapsedMs: number, fallback: boolean) {
  db.run(`INSERT INTO typecheck_results (session_id, agent, exit_code, error_count, file_count, elapsed_ms, fallback, at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    sessionID, agent, exitCode, errorCount, fileCount, elapsedMs, fallback ? 1 : 0, new Date().toISOString())
}

export function logTestResults(db: Database, sessionID: string, agent: string, cwd: string | undefined, elapsedMs: number, pass: number, fail: number, total: number) {
  db.run(`INSERT INTO test_results (session_id, agent, cwd, elapsed_ms, pass, fail, total, at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    sessionID, agent, (cwd || "").slice(0, 200), elapsedMs, pass, fail, total, new Date().toISOString())
}

export function logBashUsage(db: Database, sessionID: string, agent: string, binary: string, command: string, reason: string, elapsedMs: number, exitCode: number) {
  db.run(`INSERT INTO bash_usage (session_id, agent, binary, command, reason, elapsed_ms, exit_code, at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    sessionID, agent, binary, command.slice(0, 200), reason?.slice(0, 200) || null, elapsedMs, exitCode, new Date().toISOString())
}

// ═══════════════════════════════════════════════════════════
// KNOWLEDGE GRAPH API
// ═══════════════════════════════════════════════════════════

export function indexFile(db: Database, path: string, purpose: string, exports: string, lineCount: number, agent: string) {
  db.run(`INSERT OR REPLACE INTO files (path, purpose, exports_summary, line_count, last_indexed_at, last_modified_by)
          VALUES (?, ?, ?, ?, ?, ?)`,
    path, purpose.slice(0, 500), exports.slice(0, 500), lineCount, new Date().toISOString(), agent)
}

// ═══════════════════════════════════════════════════════════
// CONTENT HASHING — detect modifications, invalidate stale knowledge
// ═══════════════════════════════════════════════════════════

export function hashFile(worktree: string, filePath: string): string | null {
  try {
    const { resolve: res } = require("node:path") as typeof import("node:path")
    const { readFileSync: rfs, existsSync: ex } = require("node:fs") as typeof import("node:fs")
    const full = res(worktree, filePath)
    if (!ex(full)) return null
    return Bun.hash(rfs(full)).toString(16)
  } catch { return null }
}

export function recordFileHash(db: Database, filePath: string, hash: string, agent: string) {
  db.run(`UPDATE files SET content_hash = ?, last_indexed_at = ?, last_modified_by = ? WHERE path = ?`,
    hash, new Date().toISOString(), agent, filePath)
}

export function checkStale(db: Database, filePath: string, worktree: string): { stale: boolean; oldHash?: string; newHash?: string } {
  const file = db.query(`SELECT content_hash FROM files WHERE path = ?`).get(filePath) as any
  if (!file?.content_hash) return { stale: false }  // never indexed
  const newHash = hashFile(worktree, filePath)
  if (!newHash) return { stale: false }
  return { stale: file.content_hash !== newHash, oldHash: file.content_hash, newHash }
}

export function findModifiedFiles(db: Database, worktree: string, limit: number = 20): { path: string; oldHash: string; newHash: string }[] {
  const indexed = db.query(`SELECT path, content_hash FROM files WHERE content_hash IS NOT NULL ORDER BY last_indexed_at DESC LIMIT ?`).all(limit) as any[]
  const modified: { path: string; oldHash: string; newHash: string }[] = []
  for (const f of indexed) {
    const newHash = hashFile(worktree, f.path)
    if (newHash && newHash !== f.content_hash) {
      modified.push({ path: f.path, oldHash: f.content_hash, newHash })
    }
  }
  return modified
}

export function touchFileHash(db: Database, filePath: string, agent: string) {
  // Call after editing a file — update the hash so knowledge graph stays fresh
  const { resolve: res } = require("node:path") as typeof import("node:path")
  // We can't compute the hash here without worktree, so just bump the timestamp
  db.run(`UPDATE files SET last_modified_by = ?, last_indexed_at = ? WHERE path = ?`,
    agent, new Date().toISOString(), filePath)
}

export function indexSymbol(db: Database, filePath: string, name: string, kind: string, line: number, exported: boolean, signature: string) {
  db.run(`INSERT INTO symbols (file_path, name, kind, line, exported, signature, indexed_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
    filePath, name, kind, line, exported ? 1 : 0, signature?.slice(0, 300) || null, new Date().toISOString())
}

export function indexDependency(db: Database, fromFile: string, toFile: string, importPath: string, symbols: string) {
  db.run(`INSERT INTO dependencies (from_file, to_file, import_path, imported_symbols, indexed_at)
          VALUES (?, ?, ?, ?, ?)`,
    fromFile, toFile, importPath?.slice(0, 300), symbols?.slice(0, 500) || null, new Date().toISOString())
}

export function recordPattern(db: Database, name: string, filePath: string, description: string, example: string, agent: string) {
  db.run(`INSERT INTO patterns (name, file_path, description, example, found_by, found_at)
          VALUES (?, ?, ?, ?, ?, ?)`,
    name, filePath, description?.slice(0, 500), example?.slice(0, 500), agent, new Date().toISOString())
}

export function bumpErrorHotspot(db: Database, filePath: string, isTypeError: boolean, message: string) {
  const existing = db.query(`SELECT type_errors, test_failures FROM error_hotspots WHERE file_path = ?`).get(filePath) as any
  if (existing) {
    db.run(`UPDATE error_hotspots SET ${isTypeError ? 'type_errors = type_errors + 1' : 'test_failures = test_failures + 1'},
            last_error_at = ?, last_error_message = ? WHERE file_path = ?`,
      new Date().toISOString(), message?.slice(0, 300), filePath)
  } else {
    db.run(`INSERT INTO error_hotspots (file_path, type_errors, test_failures, last_error_at, last_error_message)
            VALUES (?, ?, ?, ?, ?)`,
      filePath, isTypeError ? 1 : 0, isTypeError ? 0 : 1, new Date().toISOString(), message?.slice(0, 300))
  }
}

export function recordConvention(db: Database, category: string, pattern: string, example: string, agent: string) {
  db.run(`INSERT INTO conventions (category, pattern, example, found_by, found_at)
          VALUES (?, ?, ?, ?, ?)`,
    category, pattern?.slice(0, 300), example?.slice(0, 300), agent, new Date().toISOString())
}

// Query: what do we know about this file?
export function fileKnowledge(db: Database, filePath: string): Record<string, any> {
  const file = db.query(`SELECT * FROM files WHERE path = ?`).get(filePath) as any
  const symbols = db.query(`SELECT name, kind, line, exported, signature FROM symbols WHERE file_path = ? LIMIT 20`).all(filePath) as any[]
  const depsIn = db.query(`SELECT from_file, imported_symbols FROM dependencies WHERE to_file = ? LIMIT 10`).all(filePath) as any[]
  const depsOut = db.query(`SELECT to_file, imported_symbols FROM dependencies WHERE from_file = ? LIMIT 10`).all(filePath) as any[]
  const hotspot = db.query(`SELECT * FROM error_hotspots WHERE file_path = ?`).get(filePath) as any
  const patterns = db.query(`SELECT name, description FROM patterns WHERE file_path = ? LIMIT 5`).all(filePath) as any[]
  return { file, symbols, imported_by: depsIn, imports: depsOut, hotspot, patterns }
}

// Query: find all files related to a concept
export function findRelated(db: Database, concept: string): string[] {
  const bySymbol = db.query(`SELECT DISTINCT file_path FROM symbols WHERE name LIKE ? LIMIT 20`).all(`%${concept}%`) as any[]
  const byPattern = db.query(`SELECT DISTINCT file_path FROM patterns WHERE description LIKE ? LIMIT 10`).all(`%${concept}%`) as any[]
  const byDep = db.query(`SELECT DISTINCT to_file FROM dependencies WHERE imported_symbols LIKE ? LIMIT 10`).all(`%${concept}%`) as any[]
  const files = new Set([...bySymbol.map((r: any) => r.file_path), ...byPattern.map((r: any) => r.file_path), ...byDep.map((r: any) => r.to_file)])
  return [...files].slice(0, 30)
}

// Query: what are the error hotspots?
export function topHotspots(db: Database, limit: number = 10): any[] {
  return db.query(`SELECT * FROM error_hotspots ORDER BY (type_errors + test_failures) DESC LIMIT ?`).all(limit) as any[]
}

// Query: what conventions have been discovered?
export function discoveredConventions(db: Database, category?: string): any[] {
  if (category) return db.query(`SELECT * FROM conventions WHERE category = ? ORDER BY found_at DESC`).all(category) as any[]
  return db.query(`SELECT category, COUNT(*) as cnt FROM conventions GROUP BY category ORDER BY cnt DESC`).all() as any[]
}

// ═══════════════════════════════════════════════════════════
// UNIVERSAL ARTIFACT SINK — absorb ALL ad-hoc JSON artifacts
// ═══════════════════════════════════════════════════════════

export function absorbArtifact(db: Database, key: string, data: unknown, source: string) {
  db.run(`INSERT OR REPLACE INTO artifacts (key, data, source, updated_at)
          VALUES (?, ?, ?, ?)`,
    key, JSON.stringify(data), source, new Date().toISOString())
}

export function readArtifact(db: Database, key: string): unknown | null {
  const row = db.query(`SELECT data FROM artifacts WHERE key = ?`).get(key) as any
  if (!row) return null
  try { return JSON.parse(row.data) } catch { return row.data }
}

export function listArtifacts(db: Database, prefix: string): string[] {
  const rows = db.query(`SELECT key FROM artifacts WHERE key LIKE ? ORDER BY updated_at DESC LIMIT 50`).all(prefix + "%") as any[]
  return rows.map((r: any) => r.key)
}

// Migrate all JSONL files from the filesystem into the database
export function migrateFromFilesystem(db: Database, worktree: string): { migrated: number; errors: number } {
  const { resolve } = require("node:path") as typeof import("node:path")
  const { existsSync, readFileSync, readdirSync, renameSync, statSync } = require("node:fs") as typeof import("node:fs")
  
  let migrated = 0
  let errors = 0
  const base = resolve(worktree, "docs/json/opencode")
  if (!existsSync(base)) return { migrated, errors }

  // Mapping: filename pattern → table + transform
  const mappings: { pattern: RegExp; table: string; columns: string[]; transform: (entry: any) => any[] }[] = [
    {
      pattern: /lane_state\.v1\.jsonl$/,
      table: "lane_agents",
      columns: ["lane_id","agent","status","delegated_by","delegated_at","completed_at","auto_completed","stale_timeout","advanced_by","task","summary","files_created","files_modified","findings","blockers","next_steps","repair"],
      transform: (e: any) => [e.lane_id,e.agent,e.status||"pending",e.delegated_by,e.delegated_at,e.completed_at,e.auto_completed?1:0,e.stale_timeout?1:0,e.advanced_by,e.task?.slice(0,500),e.summary,e.files_created,e.files_modified,e.findings,e.blockers,e.next_steps,e.repair?1:0],
    },
    {
      pattern: /messages\.v1\.jsonl$/,
      table: "messages",
      columns: ["message_id","kind","session_id","sender","recipient","lane_id","subject","body","sent_at"],
      transform: (e: any) => [e.message_id,e.kind,e.session_id,e.sender,e.recipient,e.lane_id,e.subject,(typeof e.body==="string"?e.body:JSON.stringify(e.body)),e.sent_at],
    },
    {
      pattern: /session_journal\.v1\.jsonl$/,
      table: "journal",
      columns: ["lane_id","agent","session_id","tool","exit_code","summary","output","files_touched"],
      transform: (e: any) => [e.lane_id,e.agent,e.session_id,e.tool,e.exit_code,e.summary?.slice(0,500),e.output?.slice(0,10000),e.files_touched],
    },
    {
      pattern: /heartbeat\.v1\.jsonl$/,
      table: "heartbeats",
      columns: ["session_id","agent","tool","phase","detail","at"],
      transform: (e: any) => [e.session_id||"",e.agent||"?",e.tool||"?",e.phase||"?",e.detail?.slice(0,200),e.at||new Date().toISOString()],
    },
    {
      pattern: /smart_tool_usage\.v1\.jsonl$/,
      table: "tool_usage",
      columns: ["session_id","agent","tool","command","elapsed_ms","exit_code","cwd","at"],
      transform: (e: any) => [e.session_id||"",e.agent||"?",e.tool||"?",e.command?.slice(0,200),e.elapsed_ms,e.exit_code,e.cwd?.slice(0,200),e.at||new Date().toISOString()],
    },
    {
      pattern: /typecheck_results\.v1\.jsonl$/,
      table: "typecheck_results",
      columns: ["session_id","agent","exit_code","error_count","file_count","elapsed_ms","at"],
      transform: (e: any) => [e.session_id||"",e.agent||"?",e.exit_code,e.error_count||0,e.file_count||0,e.elapsed_ms,e.at||new Date().toISOString()],
    },
    {
      pattern: /test_results\.v1\.jsonl$/,
      table: "test_results",
      columns: ["session_id","agent","cwd","elapsed_ms","pass","fail","total","at"],
      transform: (e: any) => [e.session_id||"",e.agent||"?",e.cwd?.slice(0,200),e.elapsed_ms,e.pass||0,e.fail||0,e.total||0,e.at||new Date().toISOString()],
    },
    {
      pattern: /bash_usage\.v1\.jsonl$/,
      table: "bash_usage",
      columns: ["session_id","agent","binary","command","reason","elapsed_ms","exit_code","at"],
      transform: (e: any) => [e.session_id||"",e.agent||"?",e.binary,e.command?.slice(0,200),e.reason?.slice(0,200),e.elapsed_ms,e.exit_code,e.at||new Date().toISOString()],
    },
  ]

  function walk(dir: string) {
    let entries: string[]
    try { entries = readdirSync(dir) } catch { return }
    for (const name of entries) {
      const full = resolve(dir, name)
      try {
        const st = statSync(full)
        if (st.isDirectory()) { walk(full); continue }
        if (!name.endsWith(".jsonl")) continue

        for (const mapping of mappings) {
          if (!mapping.pattern.test(name)) continue
          try {
            const content = readFileSync(full, "utf8")
            const lines = content.split("\n").filter(Boolean)
            const placeholders = mapping.columns.map(() => "?").join(",")
            const stmt = db.prepare(`INSERT OR IGNORE INTO ${mapping.table} (${mapping.columns.join(",")}) VALUES (${placeholders})`)
            let count = 0
            for (const line of lines) {
              try {
                const entry = JSON.parse(line)
                stmt.run(...mapping.transform(entry))
                count++
              } catch { errors++ }
            }
            if (count > 0) {
              // Rename to .migrated so we don't re-process
              try { renameSync(full, full + ".migrated") } catch {}
              migrated += count
            }
          } catch { errors++ }
          break
        }
      } catch {}
    }
  }

  walk(base)
  return { migrated, errors }
}

// ═══════════════════════════════════════════════════════════
// 🐦‍🔥 PHOENIX RECOVERY: rebuild DB from mirror if corrupted
// ═══════════════════════════════════════════════════════════

export function phoenixRecover(db: Database, worktree: string): boolean {
  const { resolve } = require("node:path") as typeof import("node:path")
  const { existsSync: ex, readFileSync: rfs, readdirSync: rds } = require("node:fs") as typeof import("node:fs")
  
  const mirrorDir = resolve(worktree, "docs/json/opencode/mirror")
  if (!ex(mirrorDir)) return false
  
  const agentCount = (db.query("SELECT COUNT(*) as cnt FROM lane_agents").get() as any)?.cnt || 0
  const msgCount = (db.query("SELECT COUNT(*) as cnt FROM messages").get() as any)?.cnt || 0
  if (agentCount > 0 || msgCount > 0) return false
  
  let recovered = 0
  try {
    const files = rds(mirrorDir).filter((f: string) => f.endsWith(".jsonl"))
    for (const file of files) {
      const table = file.replace(".v1.jsonl", "")
      const content = rfs(resolve(mirrorDir, file), "utf8")
      for (const line of content.split("\n").filter(Boolean)) {
        try {
          const entry = JSON.parse(line)
          const cols = Object.keys(entry).filter(k => k !== "mirrored_at")
          const vals = cols.map(k => entry[k])
          db.run(`INSERT OR IGNORE INTO ${table} (${cols.join(",")}) VALUES (${cols.map(()=>"?").join(",")})`, ...vals)
          recovered++
        } catch {}
      }
    }
  } catch {}
  return recovered > 0
}

// ═══════════════════════════════════════════════════════════
// 📜 THE WILL: final state snapshot on shutdown
// ═══════════════════════════════════════════════════════════

export function writeWill(db: Database, sessionID: string) {
  try {
    const agents = db.query("SELECT lane_id, agent, status FROM lane_agents WHERE id IN (SELECT MAX(id) FROM lane_agents GROUP BY lane_id, agent) AND status = 'pending'").all() as any[]
    const toolCount = (db.query("SELECT COUNT(*) as cnt FROM tool_usage WHERE session_id = ?").get(sessionID) as any)?.cnt || 0
    const will = {
      session_id: sessionID, written_at: new Date().toISOString(),
      pending_agents: agents.map((a: any) => ({ lane: a.lane_id, agent: a.agent })),
      total_tool_calls: toolCount,
      message: agents.length > 0
        ? `${agents.length} agents pending. Resume with session_journal(action='resume').`
        : "All agents completed.",
    }
    db.run(`INSERT OR REPLACE INTO artifacts (key, data, source, updated_at) VALUES (?,?,?,?)`,
      `will_${sessionID}`, JSON.stringify(will), "dispose", new Date().toISOString())
  } catch {}
}

// ═══════════════════════════════════════════════════════════
// 🔎 FTS5 FULL-TEXT SEARCH — google for your codebase
// ═══════════════════════════════════════════════════════════

export function indexForSearch(db: Database, source: string, content: string) {
  try {
    db.run(`INSERT INTO search_idx (source, content) VALUES (?, ?)`, source, content.slice(0, 5000))
  } catch {}
}

export function searchEverything(db: Database, query: string, limit: number = 20): any[] {
  // FTS5 query syntax: "auth*" for prefix, "auth OR login" for boolean
  try {
    return db.query(`SELECT source, content, rank FROM search_idx WHERE search_idx MATCH ? ORDER BY rank LIMIT ?`)
      .all(query, limit) as any[]
  } catch {
    // Fall back to LIKE if FTS query syntax fails
    return db.query(`SELECT source, content FROM search_idx WHERE content LIKE ? LIMIT ?`)
      .all(`%${query}%`, limit) as any[]
  }
}

export function rebuildSearchIndex(db: Database): number {
  try {
    db.exec(`DELETE FROM search_idx`)
    let count = 0
    // Index journal entries
    const journal = db.query(`SELECT lane_id, agent, summary, output FROM journal ORDER BY created_at DESC LIMIT 500`).all() as any[]
    for (const j of journal) {
      indexForSearch(db, `journal:${j.lane_id}:${j.agent}`, `${j.summary||""} ${j.output||""}`)
      count++
    }
    // Index messages
    const msgs = db.query(`SELECT sender, subject, body FROM messages ORDER BY sent_at DESC LIMIT 500`).all() as any[]
    for (const m of msgs) {
      indexForSearch(db, `message:${m.sender}`, `${m.subject||""} ${(m.body||"").slice(0, 1000)}`)
      count++
    }
    // Index file purposes
    const files = db.query(`SELECT path, purpose FROM files WHERE purpose IS NOT NULL`).all() as any[]
    for (const f of files) {
      indexForSearch(db, `file:${f.path}`, f.purpose || "")
      count++
    }
    return count
  } catch { return 0 }
}
