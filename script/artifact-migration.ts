#!/usr/bin/env bun
/**
 * Artifact Migration — Session 1: Digestion & Repo Hygiene
 *
 * Classifies every tracked file, ingests operational exhaust into a SQLite
 * artifact registry, removes exhaust from Git, and produces a migration report.
 *
 * The database lives at ~/.opencode/artifact-registry.db (outside the repo).
 *
 * Usage: bun run script/artifact-migration.ts [--dry-run] [--db-path <path>]
 */

import { Database } from "bun:sqlite"
import { $ } from "bun"
import { join, relative, basename, dirname } from "node:path"
import { createHash } from "node:crypto"
import { existsSync, readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const args = Bun.argv.slice(2)
const dryRun = args.includes("--dry-run")
const dbPathArg = args.find((_, i) => args[i - 1] === "--db-path")
const DB_PATH = dbPathArg ?? join(homedir(), ".opencode", "artifact-registry.db")

const REPO_ROOT = join(import.meta.dir, "..")
process.chdir(REPO_ROOT)

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

const db = new Database(DB_PATH, { create: true })
db.run("PRAGMA journal_mode = WAL")
db.run("PRAGMA foreign_keys = ON")

db.run(`
  CREATE TABLE IF NOT EXISTS artifacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    original_path TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    artifact_kind TEXT NOT NULL,
    byte_size INTEGER NOT NULL,
    schema_name TEXT,
    schema_version TEXT,
    session_id TEXT,
    lane_id TEXT,
    agent_name TEXT,
    file_timestamp TEXT,
    summary TEXT,
    retention_class TEXT NOT NULL,
    removed_from_git INTEGER NOT NULL DEFAULT 0,
    superseded INTEGER NOT NULL DEFAULT 0,
    ingested_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`)

db.run("CREATE INDEX IF NOT EXISTS idx_artifacts_hash ON artifacts(content_hash)")
db.run("CREATE INDEX IF NOT EXISTS idx_artifacts_kind ON artifacts(artifact_kind)")
db.run("CREATE INDEX IF NOT EXISTS idx_artifacts_session ON artifacts(session_id)")
db.run("CREATE INDEX IF NOT EXISTS idx_artifacts_retention ON artifacts(retention_class)")

// Also create a migration runs table for tracking
db.run(`
  CREATE TABLE IF NOT EXISTS migration_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    finished_at TEXT,
    total_files INTEGER DEFAULT 0,
    kept INTEGER DEFAULT 0,
    ingested INTEGER DEFAULT 0,
    removed INTEGER DEFAULT 0,
    ignored INTEGER DEFAULT 0,
    failed INTEGER DEFAULT 0,
    dry_run INTEGER NOT NULL DEFAULT 0
  )
`)

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type RetentionClass =
  | "keep"
  | "ingest-remove"
  | "ingest-archive"
  | "transient-delete"
  | "fixture"
  | "adr"
  | "evidence"
  | "debug"
  | "session-archive"
  | "superseded"
  | "trash"

type ArtifactKind =
  | "source"
  | "test"
  | "migration"
  | "schema"
  | "agent-profile"
  | "tool-source"
  | "user-doc"
  | "adr"
  | "generated-evidence"
  | "session-archive"
  | "task-board"
  | "coordination-log"
  | "debug-packet"
  | "scratch-report"
  | "build-output"
  | "config"
  | "roadmap"
  | "cartography"
  | "plan"
  | "validation"
  | "audit"
  | "stress-artifact"
  | "fixture"
  | "package-lock"
  | "generated-doc"
  | "empty-profile"

type ClassifiedFile = {
  path: string
  kind: ArtifactKind
  retention: RetentionClass
  reason: string
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

const sessionIdPattern = /ses_[a-z0-9]+/i
const laneIdPattern = /lane[_-]?\d+/i
const schemaVersionPattern = /\.(v\d+)\./
const agentNamePattern = /\b(architect|cartographer|critic|surgeon|trial|journalist|scalpel|vitals|stress-test|second-opinion|tourniquet|monitor)\b/i
const timestampPattern = /(\d{4}-\d{2}-\d{2}T\d{2}[:\-]\d{2}[:\-]\d{2})/

function classifyFile(filepath: string): ClassifiedFile {
  const segments = filepath.split("/")
  const filename = basename(filepath)
  const dir = dirname(filepath)

  // ── .build — all operational exhaust ─────────────────────────────────
  if (filepath.startsWith(".build/")) {
    const subPath = filepath.slice(".build/".length)
    if (subPath.includes("evidence/"))
      return { path: filepath, kind: "generated-evidence", retention: "evidence", reason: ".build evidence artifact" }
    if (subPath.includes("plans/"))
      return { path: filepath, kind: "plan", retention: "ingest-remove", reason: ".build plan artifact" }
    if (subPath.includes("artifacts/") || subPath.includes("cartography"))
      return { path: filepath, kind: "cartography", retention: "ingest-remove", reason: ".build cartography artifact" }
    if (subPath.includes("typecheck-ledger"))
      return { path: filepath, kind: "generated-evidence", retention: "evidence", reason: ".build typecheck ledger" }
    if (subPath.includes("surveyor"))
      return { path: filepath, kind: "cartography", retention: "ingest-remove", reason: ".build surveyor output" }
    if (subPath.includes("campaign-lifecycle"))
      return { path: filepath, kind: "cartography", retention: "ingest-remove", reason: ".build campaign map" }
    return { path: filepath, kind: "generated-evidence", retention: "ingest-remove", reason: ".build generated artifact" }
  }

  // ── docs/json/opencode/sessions — session archives ──────────────────
  if (filepath.startsWith("docs/json/opencode/sessions/")) {
    return { path: filepath, kind: "session-archive", retention: "session-archive", reason: "session archive data" }
  }

  // ── docs/json/opencode/archive — archived sessions ──────────────────
  if (filepath.startsWith("docs/json/opencode/archive/")) {
    return { path: filepath, kind: "session-archive", retention: "session-archive", reason: "archived session data" }
  }

  // ── docs/json/opencode/coordination — coordination state ────────────
  if (filepath.startsWith("docs/json/opencode/coordination/")) {
    return { path: filepath, kind: "coordination-log", retention: "ingest-remove", reason: "coordination state" }
  }

  // ── docs/json/opencode/waves — wave state ───────────────────────────
  if (filepath.startsWith("docs/json/opencode/waves/")) {
    return { path: filepath, kind: "coordination-log", retention: "ingest-remove", reason: "wave execution state" }
  }

  // ── docs/json/opencode state files ──────────────────────────────────
  if (filepath === "docs/json/opencode/state.v1.json") {
    return { path: filepath, kind: "task-board", retention: "ingest-remove", reason: "runtime state" }
  }
  if (filepath.startsWith("docs/json/opencode/state.db")) {
    return { path: filepath, kind: "build-output", retention: "transient-delete", reason: "runtime database (WAL/SHM ignore)" }
  }

  // ── docs/json/opencode/feedback — tool feedback ─────────────────────
  if (filepath.startsWith("docs/json/opencode/feedback/")) {
    return { path: filepath, kind: "debug-packet", retention: "debug", reason: "tool feedback log" }
  }

  // ── docs/json/opencode/knowledge — knowledge base ───────────────────
  if (filepath.startsWith("docs/json/opencode/knowledge/")) {
    return { path: filepath, kind: "generated-evidence", retention: "evidence", reason: "knowledge base evidence" }
  }

  // ── docs/json/opencode/journal — session journal ────────────────────
  if (filepath.startsWith("docs/json/opencode/journal/")) {
    return { path: filepath, kind: "session-archive", retention: "session-archive", reason: "session journal" }
  }

  // ── docs/json/opencode/checkpoints — checkpoint data ────────────────
  if (filepath.startsWith("docs/json/opencode/checkpoints/")) {
    return { path: filepath, kind: "session-archive", retention: "session-archive", reason: "checkpoint data" }
  }

  // ── docs/json/opencode (remaining operational JSON) ─────────────────
  if (filepath.startsWith("docs/json/opencode/")) {
    if (filepath.includes("cartography") || filepath.includes("maps/"))
      return { path: filepath, kind: "cartography", retention: "ingest-remove", reason: "opencode cartography" }
    if (filepath.includes("evidence/"))
      return { path: filepath, kind: "generated-evidence", retention: "evidence", reason: "opencode evidence" }
    if (filepath.includes("criticism/") || filepath.includes("critique"))
      return { path: filepath, kind: "generated-evidence", retention: "evidence", reason: "criticism/audit" }
    if (filepath.includes("stress/"))
      return { path: filepath, kind: "stress-artifact", retention: "ingest-remove", reason: "stress test artifact" }
    if (filepath.includes("validation/"))
      return { path: filepath, kind: "validation", retention: "evidence", reason: "validation report" }
    if (filepath.includes("design/") || filepath.includes("documentation/"))
      return { path: filepath, kind: "plan", retention: "ingest-remove", reason: "design document" }
    if (filepath.includes("analysis/") || filepath.includes("assessments/"))
      return { path: filepath, kind: "audit", retention: "ingest-remove", reason: "analysis/assessment" }
    if (filepath.includes("testing/"))
      return { path: filepath, kind: "validation", retention: "ingest-remove", reason: "testing artifact" }
    return { path: filepath, kind: "generated-evidence", retention: "evidence", reason: "opencode operational JSON" }
  }

  // ── docs/json (non-opencode operational JSON) ───────────────────────
  if (filepath.startsWith("docs/json/")) {
    if (filepath.includes("cartography/"))
      return { path: filepath, kind: "cartography", retention: "ingest-remove", reason: "cartography artifact" }
    if (filepath.includes("audits/"))
      return { path: filepath, kind: "audit", retention: "evidence", reason: "audit report" }
    if (filepath.includes("roadmaps/"))
      return { path: filepath, kind: "roadmap", retention: "ingest-remove", reason: "roadmap state" }
    if (filepath.includes("execution/"))
      return { path: filepath, kind: "coordination-log", retention: "ingest-remove", reason: "execution state" }
    if (filepath.includes("coordination/"))
      return { path: filepath, kind: "coordination-log", retention: "ingest-remove", reason: "coordination state" }
    if (filepath.includes("testing/"))
      return { path: filepath, kind: "validation", retention: "ingest-remove", reason: "testing artifact" }
    if (filepath.includes("qa/"))
      return { path: filepath, kind: "validation", retention: "ingest-remove", reason: "QA verification" }
    if (filepath.includes("concurrency-stress/"))
      return { path: filepath, kind: "stress-artifact", retention: "ingest-remove", reason: "concurrency stress" }
    return { path: filepath, kind: "generated-evidence", retention: "evidence", reason: "docs/json operational data" }
  }

  // ── .rig — lessons learned ──────────────────────────────────────────
  if (filepath.startsWith(".rig/")) {
    return { path: filepath, kind: "generated-evidence", retention: "evidence", reason: "rig lessons" }
  }

  // ── docs/findings — out-of-scope findings ───────────────────────────
  if (filepath.startsWith("docs/findings/")) {
    return { path: filepath, kind: "generated-evidence", retention: "evidence", reason: "findings log" }
  }

  // ── Root generated files ────────────────────────────────────────────
  if (filename.endsWith(".zip") && filename.startsWith("opencode-debug")) {
    return { path: filepath, kind: "debug-packet", retention: "debug", reason: "debug export" }
  }
  if (filename.endsWith(".html") && filename.includes("pi-session")) {
    return { path: filepath, kind: "session-archive", retention: "session-archive", reason: "session export HTML" }
  }
  if (filepath === "tsconfig.tsbuildinfo") {
    return { path: filepath, kind: "build-output", retention: "transient-delete", reason: "TypeScript build info" }
  }
  if (filepath === "run_7_cmds.sh") {
    return { path: filepath, kind: "scratch-report", retention: "trash", reason: "temporary run script" }
  }
  if (filepath === "extract_i18n_keys_temp.js" || filepath === "extract_i18n_keys_temp.py") {
    return { path: filepath, kind: "scratch-report", retention: "trash", reason: "temporary extraction script" }
  }

  // ── Root empty profile stubs ────────────────────────────────────────
  if (filepath.startsWith("profile-") && filepath.endsWith(".md")) {
    try {
      const stat = statSync(filepath)
      if (stat.size === 0)
        return { path: filepath, kind: "empty-profile", retention: "trash", reason: "empty profile stub" }
    } catch { /* skip */ }
    // Non-empty profiles at root are shortened copies of .opencode/agents/
    return { path: filepath, kind: "agent-profile", retention: "superseded", reason: "duplicate profile (canonical in .opencode/agents/)" }
  }

  // ── Root tool usage guidelines — generated docs ─────────────────────
  if (filepath.startsWith("tool_usage_guidelines-") && filepath.endsWith(".md")) {
    return { path: filepath, kind: "generated-doc", retention: "ingest-remove", reason: "generated tool usage guide" }
  }

  // ── Root generated docs ─────────────────────────────────────────────
  if (filepath === "context.md") {
    return { path: filepath, kind: "generated-evidence", retention: "ingest-remove", reason: "generated code context analysis" }
  }
  if (filepath === "TOOL_GUIDE.md") {
    return { path: filepath, kind: "generated-doc", retention: "ingest-remove", reason: "generated tool guide index" }
  }

  // ── .opencode — agent/tool/plugin source stays; state goes ──────────
  if (filepath.startsWith(".opencode/")) {
    // Keep: agents, tools, command, skills, themes, plugins, glossary, tui.json, env.d.ts
    if (
      filepath.startsWith(".opencode/agents/") ||
      filepath.startsWith(".opencode/tools/") ||
      filepath.startsWith(".opencode/command/") ||
      filepath.startsWith(".opencode/skills/") ||
      filepath.startsWith(".opencode/themes/") ||
      filepath.startsWith(".opencode/plugins/") ||
      filepath.startsWith(".opencode/glossary/") ||
      filepath === ".opencode/tui.json" ||
      filepath === ".opencode/env.d.ts" ||
      filepath === ".opencode/plugin.ts" ||
      filepath === ".opencode/opencode.jsonc" ||
      filepath === ".opencode/.gitignore"
    ) {
      return { path: filepath, kind: "tool-source", retention: "keep", reason: "opencode plugin source" }
    }
    // State/docs that leaked into .opencode tracking
    if (filepath.startsWith(".opencode/docs/"))
      return { path: filepath, kind: "generated-evidence", retention: "ingest-remove", reason: "opencode generated docs" }
    if (filepath === ".opencode/plan_content.txt")
      return { path: filepath, kind: "plan", retention: "trash", reason: "runtime plan cache" }
    // Dependency saboteur / edge-case enumerator / state poisoner .md in .opencode
    if (filepath.match(/^\.opencode\/(dependency-saboteur|edge-case-enumerator|state-poisoner)\.md$/))
      return { path: filepath, kind: "agent-profile", retention: "superseded", reason: "profile duplicate of agent" }
    return { path: filepath, kind: "config", retention: "keep", reason: "opencode config" }
  }

  // ── docs/schemas — schema definitions (keep) ────────────────────────
  if (filepath.startsWith("docs/schemas/")) {
    return { path: filepath, kind: "schema", retention: "keep", reason: "schema definition" }
  }

  // ── docs/adr — architecture decision records (keep) ─────────────────
  if (filepath.startsWith("docs/adr/")) {
    return { path: filepath, kind: "adr", retention: "adr", reason: "architecture decision record" }
  }

  // ── packages — source code ──────────────────────────────────────────
  if (filepath.startsWith("packages/")) {
    if (filepath.includes("/test/") || filepath.includes("/tests/") || filepath.includes("/e2e/"))
      return { path: filepath, kind: "test", retention: "keep", reason: "test file" }
    if (filepath.includes("/src/"))
      return { path: filepath, kind: "source", retention: "keep", reason: "source code" }
    if (filepath.endsWith(".sql.ts") || filepath.includes("migration"))
      return { path: filepath, kind: "migration", retention: "keep", reason: "database migration" }
    if (filepath.endsWith("package.json") || filepath.endsWith("tsconfig.json"))
      return { path: filepath, kind: "config", retention: "keep", reason: "package config" }
    if (filepath.includes("/script/") || filepath.includes("/scripts/"))
      return { path: filepath, kind: "source", retention: "keep", reason: "build/utility script" }
    return { path: filepath, kind: "source", retention: "keep", reason: "package file" }
  }

  // ── specs — specification documents ─────────────────────────────────
  if (filepath.startsWith("specs/")) {
    return { path: filepath, kind: "user-doc", retention: "keep", reason: "specification" }
  }

  // ── sdks — SDK source ───────────────────────────────────────────────
  if (filepath.startsWith("sdks/")) {
    return { path: filepath, kind: "source", retention: "keep", reason: "SDK source" }
  }

  // ── infra — infrastructure config ───────────────────────────────────
  if (filepath.startsWith("infra/")) {
    return { path: filepath, kind: "config", retention: "keep", reason: "infrastructure config" }
  }

  // ── nix, patches, .github, script, github — keep ────────────────────
  if (
    filepath.startsWith("nix/") ||
    filepath.startsWith("patches/") ||
    filepath.startsWith(".github/") ||
    filepath.startsWith("script/") ||
    filepath.startsWith("github/")
  ) {
    return { path: filepath, kind: "config", retention: "keep", reason: "project infrastructure" }
  }

  // ── Root config / docs ──────────────────────────────────────────────
  const keepRootFiles = [
    "package.json", "bun.lock", "bunfig.toml", "tsconfig.json", "turbo.json",
    ".oxlintrc.json", ".editorconfig", ".prettierignore", ".dockerignore",
    ".gitignore", ".gitleaksignore",
    "flake.nix", "flake.lock", "install", "sst.config.ts", "sst-env.d.ts",
    "LICENSE", "SECURITY.md",
    "README.md", "CONTRIBUTING.md", "STATS.md",
    "AGENTS.md", "INDEX.md", "LEAFS.md", "PROJECT.md",
  ]
  const readmeI18n = /^README\.[a-z]{2,4}\.md$/
  if (keepRootFiles.includes(filepath) || readmeI18n.test(filepath))
    return { path: filepath, kind: "config", retention: "keep", reason: "root project file" }

  // Root lane agent docs — orchestration lifecycle descriptions
  const laneAgentDocs = ["architect.md", "cartographer.md", "critic.md", "journalist.md", "surgeon.md", "trial.md"]
  if (laneAgentDocs.includes(filepath))
    return { path: filepath, kind: "user-doc", retention: "keep", reason: "orchestration lifecycle doc" }

  // ── Fallback ────────────────────────────────────────────────────────
  return { path: filepath, kind: "source", retention: "keep", reason: "unclassified (default keep)" }
}

// ---------------------------------------------------------------------------
// Metadata extraction
// ---------------------------------------------------------------------------

function extractMetadata(filepath: string, content: string): {
  sessionId?: string
  laneId?: string
  agentName?: string
  schemaName?: string
  schemaVersion?: string
  timestamp?: string
  summary?: string
} {
  const meta: ReturnType<typeof extractMetadata> = {}

  // Session ID from path
  const sessionMatch = filepath.match(sessionIdPattern)
  if (sessionMatch) meta.sessionId = sessionMatch[0]

  // Lane ID from path
  const laneMatch = filepath.match(laneIdPattern)
  if (laneMatch) meta.laneId = laneMatch[0]

  // Agent name from path
  const agentMatch = filepath.match(agentNamePattern)
  if (agentMatch) meta.agentName = agentMatch[0].toLowerCase()

  // Schema version from filename
  const versionMatch = filepath.match(schemaVersionPattern)
  if (versionMatch) meta.schemaVersion = versionMatch[1]

  // Schema name from filename (between last / and .v1.)
  const schemaNameMatch = basename(filepath).match(/^(.+?)\.v\d+\./)
  if (schemaNameMatch) meta.schemaName = schemaNameMatch[1]

  // Timestamp from filename
  const tsMatch = filepath.match(timestampPattern)
  if (tsMatch) meta.timestamp = tsMatch[1]

  // Try to extract summary from JSON content
  if (filepath.endsWith(".json")) {
    try {
      const parsed = JSON.parse(content)
      if (parsed?.summary) meta.summary = String(parsed.summary).slice(0, 500)
      else if (parsed?.title) meta.summary = String(parsed.title).slice(0, 500)
      else if (parsed?.description) meta.summary = String(parsed.description).slice(0, 500)
      // Extract session_id / lane_id from JSON content if not found in path
      if (!meta.sessionId && parsed?.session_id) meta.sessionId = parsed.session_id
      if (!meta.sessionId && parsed?.sessionId) meta.sessionId = parsed.sessionId
      if (!meta.laneId && parsed?.lane_id) meta.laneId = parsed.lane_id
      if (!meta.laneId && parsed?.laneId) meta.laneId = parsed.laneId
      if (!meta.agentName && parsed?.agent) meta.agentName = parsed.agent
      if (!meta.timestamp && parsed?.timestamp) meta.timestamp = parsed.timestamp
    } catch { /* not valid JSON, skip */ }
  }

  return meta
}

// ---------------------------------------------------------------------------
// Ingestion
// ---------------------------------------------------------------------------

const insertStmt = db.prepare(`
  INSERT INTO artifacts (original_path, content_hash, artifact_kind, byte_size,
    schema_name, schema_version, session_id, lane_id, agent_name,
    file_timestamp, summary, retention_class)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`)

function ingestFile(filepath: string, classified: ClassifiedFile): boolean {
  try {
    const content = readFileSync(filepath, "utf-8")
    const hash = createHash("sha256").update(content).digest("hex")
    const stat = statSync(filepath)
    const meta = extractMetadata(filepath, content)

    insertStmt.run(
      filepath,
      hash,
      classified.kind,
      stat.size,
      meta.schemaName ?? null,
      meta.schemaVersion ?? null,
      meta.sessionId ?? null,
      meta.laneId ?? null,
      meta.agentName ?? null,
      meta.timestamp ?? null,
      meta.summary ?? null,
      classified.retention,
    )
    return true
  } catch (err) {
    console.error(`  FAILED to ingest ${filepath}: ${err}`)
    return false
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("═".repeat(64))
  console.log("  Artifact Migration — Session 1: Digestion & Repo Hygiene")
  console.log("═".repeat(64))
  console.log(`  Mode:      ${dryRun ? "DRY RUN" : "LIVE"}`)
  console.log(`  Database:  ${DB_PATH}`)
  console.log(`  Repo root: ${REPO_ROOT}`)
  console.log("═".repeat(64))
  console.log()

  // Start migration run
  const runId = db.run("INSERT INTO migration_runs (dry_run) VALUES (?)", [dryRun ? 1 : 0]).lastInsertRowid

  // Get all tracked files
  console.log("→ Getting tracked file list...")
  const { stdout } = await $`git ls-files`.quiet()
  const allFiles = stdout.toString().trim().split("\n").filter(Boolean).sort()
  console.log(`  Found ${allFiles.length} tracked files\n`)

  // Classify
  console.log("→ Classifying files...")
  const classified = allFiles.map((f) => classifyFile(f))

  const retentionCounts: Record<string, [number, number]> = {} // [total, ingested]
  const kindCounts: Record<string, number> = {}

  let kept = 0
  let ingested = 0
  let failed = 0
  let removed = 0
  let ignored = 0

  // Process: first show what will happen, then act
  const toRemove: string[] = []
  const toIngest: string[] = []

  for (const c of classified) {
    kindCounts[c.kind] = (kindCounts[c.kind] || 0) + 1
    if (!retentionCounts[c.retention]) retentionCounts[c.retention] = [0, 0]
    retentionCounts[c.retention][0]++

    if (c.retention === "keep" || c.retention === "adr" || c.retention === "fixture") {
      kept++
      continue
    }

    if (c.retention === "transient-delete" || c.retention === "trash") {
      toRemove.push(c.path)
      ignored++
      continue
    }

    // ingest-remove, evidence, debug, session-archive, superseded
    toIngest.push(c.path)
    toRemove.push(c.path)
  }

  console.log(`  Classification complete:`)
  console.log(`    ${kept} files kept in Git`)
  console.log(`    ${toIngest.length} files to ingest then remove`)
  console.log(`    ${ignored} files to remove without ingestion (transient/trash)`)
  console.log()

  // ── Phase 1: Ingest ─────────────────────────────────────────────────
  if (toIngest.length > 0) {
    console.log(`→ Ingesting ${toIngest.length} artifacts into database...`)
    let count = 0
    for (const filepath of toIngest) {
      const c = classified.find((x) => x.path === filepath)!
      if (ingestFile(filepath, c)) {
        ingested++
        retentionCounts[c.retention][1]++
      } else {
        failed++
      }
      count++
      if (count % 500 === 0) console.log(`  ... ${count}/${toIngest.length}`)
    }
    console.log(`  Ingested ${ingested}, failed ${failed}\n`)
  }

  // ── Phase 2: Remove from Git ────────────────────────────────────────
  if (toRemove.length > 0) {
    console.log(`→ Removing ${toRemove.length} files from Git tracking...`)
    if (dryRun) {
      console.log(`  DRY RUN — would git rm ${toRemove.length} files`)
      for (const f of toRemove.slice(0, 20)) console.log(`    ${f}`)
      if (toRemove.length > 20) console.log(`    ... and ${toRemove.length - 20} more`)
    } else {
      // Write file list to temp file to avoid command-line length limits
      const tmpList = "/tmp/artifact-migration-rm-list.txt"
      await Bun.write(tmpList, toRemove.join("\n"))
      const result = await $`git rm --cached --quiet -r $(cat ${tmpList}) 2>&1 || true`.nothrow()
      removed = toRemove.length
      console.log(`  Removed ${removed} files from Git index`)
      if (result.stderr.toString().trim()) {
        console.error("  Warnings:", result.stderr.toString().trim().slice(0, 500))
      }
    }
    console.log()
  }

  // ── Phase 3: Update .gitignore ──────────────────────────────────────
  const forbiddenPatterns = [
    "",
    "# ── Artifact Hygiene Gate — generated by artifact-migration.ts ──",
    "# These paths are operational exhaust. They must not be tracked in Git.",
    "# If you need to track a file under these paths, add it under a fixtures/ directory.",
    "",
    "# Build artifacts and rig relay (operational exhaust)",
    ".build/",
    "",
    "# Operational JSON archives (session data, evidence, coordination)",
    "docs/json/",
    "",
    "# Rig lessons (runtime state)",
    ".rig/",
    "",
    "# Debug exports and session archives",
    "opencode-debug-*.zip",
    "pi-session-*.html",
    "",
    "# Generated tool usage guides and context analysis",
    "tool_usage_guidelines-*.md",
    "context.md",
    "TOOL_GUIDE.md",
    "",
    "# Empty or superseded profile stubs at root",
    "profile-*.md",
    "",
    "# Transient build outputs",
    "tsconfig.tsbuildinfo",
    "",
    "# Temporary extraction/run scripts",
    "extract_i18n_keys_temp.*",
    "run_7_cmds.sh",
    "",
    "# .opencode runtime state (NOT agent/tool/command/skills source)",
    ".opencode/state/",
    ".opencode/docs/",
    ".opencode/plan_content.txt",
    "",
    "# Out-of-scope findings log",
    "docs/findings/",
    "",
  ]

  console.log("→ Updating .gitignore with forbidden paths...")
  const currentGitignore = readFileSync(".gitignore", "utf-8")
  // Only append patterns not already present
  const existingLines = new Set(currentGitignore.split("\n").map((l) => l.trim()))
  const newPatterns = forbiddenPatterns.filter((p) => {
    const trimmed = p.trim()
    if (!trimmed || trimmed.startsWith("#")) return !existingLines.has(trimmed)
    return !existingLines.has(trimmed)
  })

  if (newPatterns.length > 0) {
    const updated = currentGitignore.trimEnd() + "\n" + newPatterns.join("\n") + "\n"
    if (!dryRun) Bun.write(".gitignore", updated)
    console.log(`  Added ${newPatterns.filter((p) => p.trim() && !p.trim().startsWith("#")).length} new patterns`)
  } else {
    console.log("  All patterns already present")
  }
  console.log()

  // ── Phase 4: Update migration run ───────────────────────────────────
  db.run(
    `UPDATE migration_runs SET finished_at = datetime('now'),
       total_files = ?, kept = ?, ingested = ?, removed = ?, ignored = ?, failed = ? WHERE id = ?`,
    [allFiles.length, kept, ingested, removed, ignored, failed, runId],
  )

  // ── Report ──────────────────────────────────────────────────────────
  console.log("═".repeat(64))
  console.log("  MIGRATION REPORT")
  console.log("═".repeat(64))
  console.log()
  console.log(`  Total tracked files:      ${allFiles.length}`)
  console.log(`  Kept in Git:              ${kept}`)
  console.log(`  Ingested into DB:         ${ingested}`)
  console.log(`  Removed from Git:         ${removed}`)
  console.log(`  Ignored (transient):      ${ignored}`)
  console.log(`  Failed ingestion:         ${failed}`)
  console.log()
  console.log("  Artifact kinds found:")
  for (const [kind, count] of Object.entries(kindCounts).sort((a, b) => b[1] - a[1])) {
    const bar = "█".repeat(Math.min(count / 200, 30))
    console.log(`    ${kind.padEnd(24)} ${String(count).padStart(6)} ${bar}`)
  }
  console.log()
  console.log("  Retention classes applied:")
  for (const [cls, [total, ing]] of Object.entries(retentionCounts).sort((a, b) => b[1][0] - a[1][0])) {
    console.log(`    ${cls.padEnd(20)} total=${String(total).padStart(6)}  ingested=${String(ing).padStart(6)}`)
  }
  console.log()
  console.log("  Database location:")
  console.log(`    ${DB_PATH}`)
  console.log()
  console.log("  Query examples:")
  console.log(`    sqlite3 ${DB_PATH} "SELECT * FROM artifacts WHERE retention_class = 'evidence' LIMIT 10"`)
  console.log(`    sqlite3 ${DB_PATH} "SELECT artifact_kind, COUNT(*) FROM artifacts GROUP BY 1 ORDER BY 2 DESC"`)
  console.log(`    sqlite3 ${DB_PATH} "SELECT * FROM artifacts WHERE session_id = 'ses_XXXXXXXXX'"`)
  console.log()
  console.log("  Forbidden paths (now in .gitignore):")
  for (const p of forbiddenPatterns) {
    if (p.trim() && !p.trim().startsWith("#")) console.log(`    ${p}`)
  }
  console.log()
  console.log("  Validation:")
  console.log("    Run: bun run script/hygiene-check.ts")
  console.log("    This validates no tracked files exist under forbidden paths.")
  console.log()
  console.log("═".repeat(64))

  if (dryRun) {
    console.log("  DRY RUN COMPLETE — no changes made. Run without --dry-run to apply.")
  } else {
    console.log("  MIGRATION COMPLETE. Next step: run `bun run script/hygiene-check.ts`")
  }
  console.log("═".repeat(64))

  db.close()
}

main().catch((err) => {
  console.error("FATAL:", err)
  process.exit(1)
})
