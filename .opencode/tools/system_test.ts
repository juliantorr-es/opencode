import { tool } from "@opencode-ai/plugin"
import { init } from "./db"
import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"

function r(worktree: string, p: string): string { return resolve(worktree, p) }

export default tool({
  description: "Self-test the orchestration system. Validates that the database, tools, agents, and configs are all properly wired. Run on startup or after making changes.",
  args: {
    action: tool.schema.string().describe("'smoke' for quick checks | 'full' for comprehensive validation | 'agents' to check all agent definitions | 'tools' to verify tool files"),
  },
  async execute(args, context) {
    const db = init(context.worktree)
    const results: any = { action: args.action, passed: 0, failed: 0, checks: [] }
    
    function check(name: string, condition: boolean, detail?: string) {
      results.checks.push({ name, status: condition ? "✅" : "❌", detail })
      if (condition) results.passed++; else results.failed++
    }

    // ── Database checks ──
    if (args.action === "smoke" || args.action === "full") {
      // DB is accessible
      try {
        const row = db.query("SELECT 1 as ok").get() as any
        check("Database accessible", row?.ok === 1)
      } catch { check("Database accessible", false, "Cannot query DB") }

      // All expected tables exist
      const expectedTables = ["lane_agents","messages","journal","heartbeats","tool_usage","typecheck_results","test_results","bash_usage","files","symbols","dependencies","patterns","error_hotspots","conventions","artifacts"]
      const actualTables = (db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as any[]).map((r: any) => r.name)
      for (const t of expectedTables) {
        check(`Table: ${t}`, actualTables.includes(t))
      }

      // WAL mode
      const journalMode = (db.query("PRAGMA journal_mode").get() as any)?.journal_mode
      check("WAL mode enabled", journalMode === "wal", `Current: ${journalMode}`)

      // Plugin file exists
      check("Plugin file exists", existsSync(r(context.worktree, "plugin.ts")))
    }

    // ── Agent checks ──
    if (args.action === "agents" || args.action === "full") {
      const agentsDir = r(context.worktree, "agents")
      if (existsSync(agentsDir)) {
        const { readdirSync } = require("node:fs") as typeof import("node:fs")
        const files = readdirSync(agentsDir).filter((f: string) => f.endsWith(".md"))
        check("Agent definitions found", files.length > 0, `${files.length} agents`)

        for (const file of files.slice(0, 10)) {  // check first 10
          const content = readFileSync(r(agentsDir, file), "utf8")
          const hasFrontmatter = /^---\n/.test(content)
          const hasPermission = /permission:/.test(content)
          const hasLeafHandoff = /leaf_handoff/.test(content)
          check(`Agent ${file}: frontmatter`, hasFrontmatter)
          check(`Agent ${file}: permissions`, hasPermission)
          check(`Agent ${file}: leaf_handoff`, hasLeafHandoff, "Missing coordination tool")
        }
      } else {
        check("Agents directory", false, "agents/ not found")
      }
    }

    // ── Tool checks ──
    if (args.action === "tools" || args.action === "full") {
      const toolsDir = r(context.worktree, "tools")
      if (existsSync(toolsDir)) {
        const { readdirSync } = require("node:fs") as typeof import("node:fs")
        const files = readdirSync(toolsDir).filter((f: string) => f.endsWith(".ts"))
        check("Tool files found", files.length > 0, `${files.length} tools`)

        // Check critical tools exist
        const critical = ["announce_lane_before_using_task_to_invoke_the_subagent.ts", "task_board.ts", "leaf_handoff.ts", "ping.ts", "db.ts", "read.ts"]
        for (const c of critical) {
          check(`Critical tool: ${c}`, files.includes(c))
        }

        // Check db.ts exports
        const dbContent = readFileSync(r(toolsDir, "db.ts"), "utf8")
        check("db.ts: init export", /export function init/.test(dbContent))
        check("db.ts: heartbeat export", /export function heartbeat/.test(dbContent))
        check("db.ts: fileKnowledge export", /export function fileKnowledge/.test(dbContent))
        check("db.ts: phoenixRecover export", /export function phoenixRecover/.test(dbContent))
        check("db.ts: writeWill export", /export function writeWill/.test(dbContent))
      } else {
        check("Tools directory", false, "tools/ not found")
      }
    }

    // ── Config checks ──
    if (args.action === "smoke" || args.action === "full") {
      const configPath = r(context.worktree, "opencode.jsonc")
      check("Config file exists", existsSync(configPath))
      if (existsSync(configPath)) {
        const raw = readFileSync(configPath, "utf8")
        const clean = raw.replace(/\/\/[^\n]*/g, "")
        try {
          const cfg = JSON.parse(clean)
          check("Config is valid JSON", true)
          check("Config has plugin", Array.isArray(cfg.plugin) && cfg.plugin.length > 0)
          check("Config has agents", Object.keys(cfg.agent || {}).length > 0)
          check("Config has permissions", !!cfg.permission)
        } catch {
          check("Config is valid JSON", false, "Parse error")
        }
      }

      // Global config
      const { homedir } = require("node:os") as typeof import("node:os")
      const globalPath = resolve(homedir(), ".config/opencode/opencode.json")
      check("Global config exists", existsSync(globalPath))
    }

    return JSON.stringify({
      ...results,
      summary: `${results.passed} passed, ${results.failed} failed`,
      hint: results.failed > 0 ? "Run config_sync(action='sync') to fix config gaps. Check agent frontmatters for missing permissions." : "All systems nominal. 🚀",
    }, null, 2)
  },
})
