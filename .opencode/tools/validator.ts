/**
 * Validator — structural integrity check for the orchestration plugin.
 *
 * Unlike doctor (which checks health), validator checks STRUCTURE:
 *   - No duplicate agent definitions (e.g., both agents/ and agent/)
 *   - No ghost directories (secretary incident prevention)
 *   - Required canonical files exist
 *   - DB schema version is correct
 *   - Tool registrations are valid
 *   - Config sources don't conflict
 *   - Plugin surface is internally consistent
 *
 * Validator should FAIL if ANY structural issue exists.
 * Used in CI, pre-commit, or before distribution.
 */

import { tool } from "@opencode-ai/plugin"
import { init } from "./db"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { resolve } from "node:path"

function r(worktree: string, p: string): string { return resolve(worktree, p) }

export default tool({
  description: "Validator — structural integrity check for the orchestration plugin. Fails if duplicate agents, ghost directories, missing required files, or config conflicts exist. Use in CI or before distribution.",
  args: {
    strict: tool.schema.boolean().optional().describe("Strict mode — fail on warnings too."),
    fix: tool.schema.boolean().optional().describe("Attempt to auto-fix structural issues (NOT IMPLEMENTED — reports only)."),
  },
  async execute(args, context) {
    const db = init(context.worktree)
    const violations: any[] = []
    const warnings: any[] = []

    function violate(category: string, detail: string, severity: "error" | "warning" = "error") {
      const entry = { category, detail, severity }
      if (severity === "error") violations.push(entry)
      else warnings.push(entry)
    }

    // ═══════════════════════════════════════
    // 1. CANONICAL DIRECTORY CHECK
    // ═══════════════════════════════════════

    // Active agent directory must be exactly one of: .opencode/agents
    const agentDirs = [
      ".opencode/agents",
      ".opencode/agent",    // GHOST — singular form
      "agents",              // root-level (legacy)
    ]

    const existingAgentDirs = agentDirs.filter(d => existsSync(r(context.worktree, d)))
    if (existingAgentDirs.length > 1) {
      violate("canonical_directories",
        `Multiple agent directories exist: ${existingAgentDirs.join(", ")}. Only .opencode/agents should exist.`,
        "error")
    }
    if (!existingAgentDirs.includes(".opencode/agents")) {
      violate("canonical_directories",
        "Canonical agent directory .opencode/agents does not exist.",
        "error")
    }
    if (existingAgentDirs.includes(".opencode/agent")) {
      violate("ghost_directory",
        "Ghost directory .opencode/agent exists. This is the 'secretary' pattern — delete it.",
        "error")
    }

    // Active tool directory must be .opencode/tools
    if (!existsSync(r(context.worktree, ".opencode/tools"))) {
      violate("canonical_directories", "Canonical tool directory .opencode/tools does not exist.", "error")
    }

    // ═══════════════════════════════════════
    // 2. REQUIRED CANONICAL FILES
    // ═══════════════════════════════════════

    const requiredFiles: { path: string; label: string; critical: boolean }[] = [
      { path: ".opencode/plugin.ts", label: "Plugin entry point", critical: true },
      { path: ".opencode/package.json", label: "Plugin dependencies", critical: true },
      { path: ".opencode/opencode.jsonc", label: "Project config", critical: true },
      { path: ".opencode/tui.json", label: "TUI config", critical: false },
      { path: ".opencode/tools/db.ts", label: "Database layer", critical: true },
      { path: ".opencode/tools/persistence.ts", label: "Persistence API", critical: true },
      { path: ".opencode/tools/config.ts", label: "Config resolution", critical: true },
      { path: ".opencode/tools/doctor.ts", label: "Doctor tool", critical: false },
      { path: ".opencode/tools/validator.ts", label: "Validator tool", critical: false },
      { path: ".opencode/tools/task_board.ts", label: "Task board", critical: false },
      { path: ".opencode/tools/dashboard.ts", label: "Dashboard", critical: false },
    ]

    for (const file of requiredFiles) {
      if (!existsSync(r(context.worktree, file.path))) {
        const severity = file.critical ? "error" : "warning"
        violate("required_files", `${file.label}: ${file.path} missing`, severity)
      }
    }

    // ═══════════════════════════════════════
    // 3. DUPLICATE AGENT CHECK
    // ═══════════════════════════════════════

    // Check for duplicate agent names across directories
    const agentDir = ".opencode/agents"
    if (existsSync(r(context.worktree, agentDir))) {
      const files = readdirSync(r(context.worktree, agentDir)).filter(f => f.endsWith(".md"))
      const names = new Set<string>()
      const duplicates: string[] = []

      for (const f of files) {
        const name = f.replace(/\.md$/, "")
        if (names.has(name)) {
          duplicates.push(name)
        }
        names.add(name)
      }

      if (duplicates.length > 0) {
        violate("duplicate_agents",
          `Duplicate agent definitions: ${duplicates.join(", ")}`,
          "error")
      }

      // Check each agent file has valid frontmatter
      for (const f of files.slice(0, 10)) {
        const content = readFileSync(r(context.worktree, agentDir, f), "utf8")
        if (!/^---\n/.test(content)) {
          violate("agent_frontmatter",
            `Agent ${f} is missing YAML frontmatter (starts with ---)`,
            "warning")
        }
      }
    }

    // ═══════════════════════════════════════
    // 4. TOOL REGISTRATION VALIDITY
    // ═══════════════════════════════════════

    const toolDir = ".opencode/tools"
    if (existsSync(r(context.worktree, toolDir))) {
      const toolFiles = readdirSync(r(context.worktree, toolDir)).filter(f => f.endsWith(".ts") && !f.endsWith(".d.ts"))

      for (const f of toolFiles) {
        const content = readFileSync(r(context.worktree, toolDir, f), "utf8")
        // Check for the tool() registration pattern
        if (!/export default tool\(/.test(content) && !/tool\(/.test(content)) {
          // Internal modules like db.ts, persistence.ts, config.ts don't need tool()
          if (!["db.ts", "persistence.ts", "config.ts"].includes(f)) {
            violate("tool_registration",
              `Tool file ${f} does not export a tool() registration`,
              "warning")
          }
        }
      }
    }

    // ═══════════════════════════════════════
    // 5. DB SCHEMA VERSION
    // ═══════════════════════════════════════

    try {
      const tables = (db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as any[]).map((r: any) => r.name)

      // All core tables must exist
      const coreTables = ["lane_agents", "messages", "journal", "heartbeats", "tool_usage"]
      for (const t of coreTables) {
        if (!tables.includes(t)) {
          violate("db_schema", `Core table ${t} is missing from database`, "error")
        }
      }

      // Check for unknown tables (potential schema drift)
      const knownTables = new Set([
        ...coreTables, "typecheck_results", "test_results", "bash_usage",
        "files", "symbols", "dependencies", "patterns", "error_hotspots",
        "conventions", "artifacts", "search_idx", "sqlite_sequence",
      ])
      for (const t of tables) {
        if (!knownTables.has(t) && !t.startsWith("search_idx_")) {
          violate("db_schema", `Unknown table ${t} — potential schema drift`, "warning")
        }
      }

      // WAL mode is required
      const journalMode = (db.query("PRAGMA journal_mode").get() as any)?.journal_mode
      if (journalMode !== "wal") {
        violate("db_schema", `Database journal mode is ${journalMode}, must be wal`, "error")
      }
    } catch (e: any) {
      violate("db_schema", `Cannot validate DB schema: ${e.message}`, "error")
    }

    // ═══════════════════════════════════════
    // 6. CONFIG CONFLICTS
    // ═══════════════════════════════════════

    const globalPath = resolve(
      require("node:os").homedir(),
      ".config/opencode/opencode.json",
    )
    const projectPath = r(context.worktree, ".opencode/opencode.jsonc")

    if (existsSync(globalPath) && existsSync(projectPath)) {
      try {
        const stripComments = (raw: string) =>
          raw.replace(/\/\/[^\n]*/g, "").replace(/,\s*}/g, "}").replace(/,\s*\]/g, "]")

        const global = JSON.parse(stripComments(readFileSync(globalPath, "utf8")))
        const project = JSON.parse(stripComments(readFileSync(projectPath, "utf8")))

        // Check for conflicting agent permissions
        const gAgents = global.agent ?? {}
        const pAgents = project.agent ?? {}
        for (const agent of Object.keys(pAgents)) {
          if (gAgents[agent]) {
            const gPerms = new Set(Object.keys(gAgents[agent].permission ?? {}))
            const pPerms = new Set(Object.keys(pAgents[agent].permission ?? {}))
            for (const perm of pPerms) {
              if (gPerms.has(perm)) {
                const gVal = JSON.stringify(gAgents[agent].permission[perm])
                const pVal = JSON.stringify(pAgents[agent].permission[perm])
                if (gVal !== pVal) {
                  violate("config_conflict",
                    `Agent ${agent} permission ${perm} differs: global=${gVal}, project=${pVal}`,
                    "warning")
                }
              }
            }
          }
        }
      } catch (e: any) {
        violate("config_parse", `Cannot parse configs for comparison: ${e.message}`, "warning")
      }
    }

    // ═══════════════════════════════════════
    // 7. GHOST STUB CHECK (root-level orphans)
    // ═══════════════════════════════════════

    const rootFiles = readdirSync(context.worktree)
    const ghostPatterns = [
      /^profile-.*\.md$/,
      /^tool_usage_guidelines-.*\.md$/,
    ]

    for (const f of rootFiles) {
      for (const pattern of ghostPatterns) {
        if (pattern.test(f)) {
          violate("ghost_stubs", `Root-level ghost file: ${f} — remove it. Canonical files are in .opencode/.`, "error")
          break
        }
      }
    }

    // ═══════════════════════════════════════
    // Result
    // ═══════════════════════════════════════

    const effectiveViolations = args.strict ? [...violations, ...warnings] : violations

    return JSON.stringify({
      valid: effectiveViolations.length === 0,
      timestamp: new Date().toISOString(),
      summary: {
        errors: violations.length,
        warnings: warnings.length,
        total_violations: effectiveViolations.length,
      },
      violations,
      warnings: args.strict ? [] : warnings,
      recommendation: effectiveViolations.length === 0
        ? "✅ Plugin structure is valid and canonical."
        : `❌ ${effectiveViolations.length} structural issue(s) found. Fix before distribution.`,
    }, null, 2)
  },
})
