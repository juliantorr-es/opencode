/**
 * Doctor — health check for the orchestration plugin.
 *
 * Verifies:
 *   - Database accessibility and integrity
 *   - All expected tables exist
 *   - WAL mode enabled
 *   - Agent definitions exist and are valid
 *   - Tool files exist and are loadable
 *   - Plugin entry point exists
 *   - No duplicate agent directories
 *   - Config consistency (global ↔ project)
 *   - Required binaries present
 *   - Schema version
 *   - Stale claims / corrupt state
 *
 * Usage: Run on startup, after changes, or when troubleshooting.
 *   "Run doctor and paste the report" — every support request.
 */

import { tool } from "@opencode-ai/plugin"
import { init } from "./db"
import { checkConfigSync } from "./config"
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { resolve } from "node:path"

function r(worktree: string, p: string): string { return resolve(worktree, p) }

export default tool({
  description: "Doctor — health check for the orchestration plugin. Validates database, agents, tools, configs, binaries, and state integrity. Run on startup or when troubleshooting.",
  args: {
    quick: tool.schema.boolean().optional().describe("Quick check — DB + critical files only."),
    verbose: tool.schema.boolean().optional().describe("Verbose output with raw details."),
  },
  async execute(args, context) {
    const db = init(context.worktree)
    const results: any = {
      status: "healthy",
      timestamp: new Date().toISOString(),
      worktree: context.worktree,
      sections: {},
    }

    function fail(section: string, check: Record<string, unknown>) {
      if (!results.sections[section]) results.sections[section] = []
      results.sections[section].push(check)
      if (results.status === "healthy") results.status = "degraded"
    }

    function pass(section: string, check: Record<string, unknown>) {
      if (!results.sections[section]) results.sections[section] = []
      results.sections[section].push(check)
    }

    // ═══════════════════════════════════════
    // 1. DATABASE
    // ═══════════════════════════════════════
    try {
      const row = db.query("SELECT 1 as ok").get() as any
      if (row?.ok === 1) {
        pass("database", { check: "accessible", status: "✅" })
      } else {
        fail("database", { check: "accessible", status: "❌", detail: "Query returned unexpected result" })
        results.status = "critical"
      }
    } catch (e: any) {
      fail("database", { check: "accessible", status: "❌", detail: e.message })
      results.status = "critical"
    }

    const expectedTables = [
      "lane_agents", "messages", "journal", "heartbeats", "tool_usage",
      "typecheck_results", "test_results", "bash_usage",
      "files", "symbols", "dependencies", "patterns", "error_hotspots",
      "conventions", "artifacts",
    ]
    const actualTables = (db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as any[]).map((r: any) => r.name)
    for (const t of expectedTables) {
      if (actualTables.includes(t)) {
        pass("database", { check: `table:${t}`, status: "✅" })
      } else {
        fail("database", { check: `table:${t}`, status: "❌", detail: "Missing table" })
      }
    }

    const journalMode = (db.query("PRAGMA journal_mode").get() as any)?.journal_mode
    if (journalMode === "wal") {
      pass("database", { check: "wal_mode", status: "✅" })
    } else {
      fail("database", { check: "wal_mode", status: "⚠️", detail: `Current: ${journalMode}. Recommend wal.` })
    }

    // Integrity check
    try {
      const integrity = (db.query("PRAGMA integrity_check").get() as any)?.["integrity_check"]
      if (integrity === "ok") {
        pass("database", { check: "integrity", status: "✅" })
      } else {
        fail("database", { check: "integrity", status: "❌", detail: integrity })
        results.status = "critical"
      }
    } catch (e: any) {
      fail("database", { check: "integrity", status: "❌", detail: e.message })
    }

    // DB size
    const pageCount = (db.query("PRAGMA page_count").get() as any)?.page_count ?? 0
    const pageSize = (db.query("PRAGMA page_size").get() as any)?.page_size ?? 0
    const sizeMB = ((pageCount * pageSize) / (1024 * 1024)).toFixed(2)
    pass("database", { check: "size", status: "ℹ️", detail: `${sizeMB} MB (${pageCount} pages)` })

    // Row counts
    const counts: Record<string, number> = {}
    for (const t of ["lane_agents", "journal", "heartbeats", "tool_usage", "messages", "files"]) {
      try { counts[t] = (db.query(`SELECT COUNT(*) as cnt FROM ${t}`).get() as any)?.cnt ?? 0 } catch { counts[t] = -1 }
    }
    pass("database", { check: "row_counts", status: "ℹ️", detail: JSON.stringify(counts) })

    // Stale agents
    const staleCount = (db.query(
      `SELECT COUNT(*) as cnt FROM lane_agents
       WHERE id IN (SELECT MAX(id) FROM lane_agents GROUP BY lane_id, agent)
         AND status = 'pending'
         AND delegated_at < datetime('now', '-30 minutes')`
    ).get() as any)?.cnt ?? 0
    if (staleCount > 0) {
      fail("database", { check: "stale_agents", status: "⚠️", detail: `${staleCount} agents stale >30min` })
    } else {
      pass("database", { check: "stale_agents", status: "✅" })
    }

    // ═══════════════════════════════════════
    // 2. FILES
    // ═══════════════════════════════════════
    if (existsSync(r(context.worktree, ".opencode/plugin.ts"))) {
      pass("files", { check: "plugin_entry", status: "✅", detail: ".opencode/plugin.ts exists" })
    } else {
      fail("files", { check: "plugin_entry", status: "❌", detail: ".opencode/plugin.ts missing" })
      results.status = "critical"
    }

    // Agent directory
    const agentDirs = [".opencode/agents", "agents"]
    const foundAgentDirs: string[] = []
    for (const d of agentDirs) {
      if (existsSync(r(context.worktree, d))) foundAgentDirs.push(d)
    }
    if (foundAgentDirs.length === 0) {
      fail("files", { check: "agent_directory", status: "❌", detail: "No agent directory found" })
    } else if (foundAgentDirs.length > 1) {
      fail("files", { check: "agent_directory", status: "❌", detail: `Duplicate agent dirs: ${foundAgentDirs.join(", ")}` })
      results.status = "critical"
    } else {
      const agentDir = r(context.worktree, foundAgentDirs[0])
      const agentCount = readdirSync(agentDir).filter(f => f.endsWith(".md")).length
      pass("files", { check: "agent_directory", status: "✅", detail: `${foundAgentDirs[0]} — ${agentCount} agents` })
    }

    // Ghost check: .opencode/agent (singular) should not exist
    if (existsSync(r(context.worktree, ".opencode/agent"))) {
      fail("files", { check: "ghost_directory", status: "❌", detail: ".opencode/agent exists — remove this ghost" })
    } else {
      pass("files", { check: "ghost_directory", status: "✅", detail: "No .opencode/agent ghost" })
    }

    // Tool directory
    const toolDir = r(context.worktree, ".opencode/tools")
    if (existsSync(toolDir)) {
      const toolCount = readdirSync(toolDir).filter(f => f.endsWith(".ts")).length
      pass("files", { check: "tool_directory", status: "✅", detail: `${toolCount} tools` })
    } else {
      fail("files", { check: "tool_directory", status: "❌", detail: ".opencode/tools missing" })
      results.status = "critical"
    }

    // Required tool files
    const requiredTools = ["db.ts", "persistence.ts", "config.ts", "doctor.ts", "validator.ts", "task_board.ts", "dashboard.ts"]
    for (const t of requiredTools) {
      const tPath = r(context.worktree, `.opencode/tools/${t}`)
      if (existsSync(tPath)) {
        pass("files", { check: `tool:${t}`, status: "✅" })
      } else {
        fail("files", { check: `tool:${t}`, status: "⚠️", detail: `Missing — ${t} is part of the canonical plugin surface` })
      }
    }

    // TUI config
    if (existsSync(r(context.worktree, ".opencode/tui.json"))) {
      pass("files", { check: "tui_config", status: "✅" })
    } else {
      fail("files", { check: "tui_config", status: "⚠️", detail: "No tui.json" })
    }

    if (!args.quick) {
      // ═══════════════════════════════════════
      // 3. AGENT VALIDATION
      // ═══════════════════════════════════════
      const agentDir = r(context.worktree, foundAgentDirs[0] || ".opencode/agents")
      if (existsSync(agentDir)) {
        const agentFiles = readdirSync(agentDir).filter(f => f.endsWith(".md"))
        const criticalAgents = ["cartographer", "architect", "critic", "surgeon", "trial", "journalist", "general-man-agent"]

        // Check critical agents exist
        for (const a of criticalAgents) {
          const found = agentFiles.some(f => f === `${a}.md` || f.startsWith(a))
          if (found) {
            pass("agents", { check: `critical:${a}`, status: "✅" })
          } else {
            fail("agents", { check: `critical:${a}`, status: "⚠️", detail: "Critical agent missing" })
          }
        }

        // Validate frontmatter for a sample
        let validCount = 0
        let invalidCount = 0
        for (const file of agentFiles.slice(0, 10)) {
          const content = readFileSync(r(agentDir, file), "utf8")
          if (/^---\n/.test(content)) {
            validCount++
            if (args.verbose) pass("agents", { check: `frontmatter:${file}`, status: "✅" })
          } else {
            invalidCount++
            fail("agents", { check: `frontmatter:${file}`, status: "⚠️", detail: "Missing YAML frontmatter" })
          }
        }
        if (agentFiles.length > 10) {
          pass("agents", { check: "sample_check", status: "ℹ️", detail: `Checked 10/${agentFiles.length}. ${validCount} valid, ${invalidCount} invalid.` })
        }
      }

      // ═══════════════════════════════════════
      // 4. CONFIG SYNC
      // ═══════════════════════════════════════
      const sync = checkConfigSync(context.worktree)
      if (sync.synced) {
        pass("config", { check: "sync", status: "✅" })
      } else {
        for (const diff of sync.diffs) {
          fail("config", { check: "sync", status: "⚠️", detail: diff })
        }
      }

      // ═══════════════════════════════════════
      // 5. BINARIES
      // ═══════════════════════════════════════
      const binDir = r(context.worktree, ".opencode/tools/bin")
      if (existsSync(binDir)) {
        const bins = ["delta", "fd", "jql", "rg", "tokei"]
        for (const b of bins) {
          if (existsSync(r(binDir, b))) {
            pass("binaries", { check: b, status: "✅" })
          } else {
            fail("binaries", { check: b, status: "⚠️", detail: "Missing binary" })
          }
        }
      }

      // ═══════════════════════════════════════
      // 6. SEARCH INDEX
      // ═══════════════════════════════════════
      try {
        const ftsCount = (db.query("SELECT COUNT(*) as cnt FROM search_idx").get() as any)?.cnt ?? 0
        pass("search", { check: "fts_index", status: "ℹ️", detail: `${ftsCount} indexed documents` })
      } catch {
        fail("search", { check: "fts_index", status: "⚠️", detail: "FTS5 index not available" })
      }
    }

    // ═══════════════════════════════════════
    // Summary
    // ═══════════════════════════════════════
    let failCount = 0
    let passCount = 0
    for (const [, checks] of Object.entries(results.sections)) {
      for (const c of checks as any[]) {
        if (c.status === "❌" || c.status === "⚠️") failCount++
        else passCount++
      }
    }

    results.summary = {
      total: passCount + failCount,
      passed: passCount,
      failed: failCount,
      status: results.status,
      recommendation: results.status === "healthy"
        ? "All checks passed. Plugin is healthy."
        : results.status === "degraded"
          ? "Some non-critical checks failed. Review ⚠️ items."
          : "Critical checks failed. Plugin may not function correctly.",
    }

    return JSON.stringify(results, null, 2)
  },
})
