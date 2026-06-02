import type { PluginInput, Hooks } from "@opencode-ai/plugin"
import { Database } from "bun:sqlite"
import {
  init,
  enableMirror,
  writeWill,
  heartbeat,
  logToolUsage,
  checkDeadlines,
  forgettingCurve,
} from "./tools/db"
import { stopServerIfLast } from "./tools/dashboard"

// ═══════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════

let db: Database
let worktree = ""
let currentSessionID = ""
let currentAgent = ""
let currentLaneID = ""

// ═══════════════════════════════════════════════════
// TIMING GUARD — warn when hooks overshoot budget
// ═══════════════════════════════════════════════════

const HOOK_BUDGETS: Record<string, number> = {
  "chat.message": 200,
  "tool.execute.before": 50,
  "tool.execute.after": 100,
  "chat.params": 50,
  "permission.ask": 10,
}

function timed<T>(name: string, fn: () => T): T {
  const start = Date.now()
  const result = fn()
  const elapsed = Date.now() - start
  const budget = HOOK_BUDGETS[name] ?? 100
  if (elapsed > budget) {
    console.warn(`[plugin] ⚠️ ${name} took ${elapsed}ms (budget ${budget}ms)`)
  }
  return result
}

// ═══════════════════════════════════════════════════
// CONTEXT HELPERS — kept inline, bounded queries only
// ═══════════════════════════════════════════════════

function inferPhase(agent: string): "explore" | "execute" {
  try {
    const recent = db.query(
      `SELECT tool FROM journal WHERE agent = ? ORDER BY created_at DESC LIMIT 5`
    ).all(agent) as any[]
    const exploreTools = new Set(["smart_grep", "smart_find", "read_source", "read", "discover"])
    const executeTools = new Set(["smart_edit", "smart_write", "smart_bun", "smart_sd", "smart_batch"])
    let explore = 0, exec = 0
    for (const r of recent) {
      if (exploreTools.has(r.tool)) explore++
      if (executeTools.has(r.tool)) exec++
    }
    if (explore === 0 && exec === 0) return "explore"
    return explore >= exec ? "explore" : "execute"
  } catch {
    return "explore"
  }
}

function hiveMemory(agent: string): string {
  try {
    const files = db.query(
      `SELECT files_touched, created_at FROM journal
       WHERE agent = ? AND files_touched IS NOT NULL
       ORDER BY created_at DESC LIMIT 3`
    ).all(agent) as any[]
    const discoveries = db.query(
      `SELECT summary, created_at FROM journal
       WHERE agent = ? AND summary IS NOT NULL AND summary != ''
       ORDER BY created_at DESC LIMIT 3`
    ).all(agent) as any[]

    let r = ""
    const recentFiles = files.filter((f: any) => {
      const age = f.created_at ? (Date.now() - new Date(f.created_at).getTime()) / 1000 : 99999
      return forgettingCurve(age) > 0.15
    })
    if (recentFiles.length) {
      r += `📁 ${recentFiles.map((f: any) => (f.files_touched || "").slice(0, 60)).join(", ")}. `
    }
    const recentDisc = discoveries.filter((d: any) => {
      const age = d.created_at ? (Date.now() - new Date(d.created_at).getTime()) / 1000 : 99999
      return forgettingCurve(age) > 0.3
    })
    if (recentDisc.length) {
      r += `💡 ${recentDisc.map((d: any) => (d.summary || "").slice(0, 50)).join(" | ")}. `
    }
    return r || "No hive memory yet."
  } catch {
    return ""
  }
}

function peerHealth(laneId: string): string {
  try {
    const peers = db.query(`
      SELECT agent, status, delegated_at,
        CAST((julianday('now') - julianday(delegated_at)) * 86400 AS INTEGER) as age_seconds
      FROM lane_agents
      WHERE id IN (SELECT MAX(id) FROM lane_agents GROUP BY lane_id, agent)
        AND lane_id = ? AND agent != ?
      ORDER BY delegated_at DESC LIMIT 8
    `).all(laneId, currentAgent) as any[]
    if (peers.length === 0) return ""
    let mesh = "\n💓 PEERS:\n"
    for (const p of peers) {
      const icon = p.status === "completed" ? "✅" : p.status === "stale" ? "💀"
        : p.age_seconds > 300 ? "🟡" : "🟢"
      mesh += `  ${icon} ${p.agent}: ${p.status} (${Math.round(p.age_seconds / 60)}m)\n`
    }
    return mesh
  } catch {
    return ""
  }
}

function buildContext(agent: string, laneId: string): string {
  try {
    const entries = db.query(
      `SELECT agent, tool, summary, created_at, files_touched
       FROM journal WHERE lane_id = ? ORDER BY created_at DESC LIMIT 20`
    ).all(laneId) as any[]
    const ranked = entries
      .map((e: any) => {
        let score = 0
        if (e.agent === agent) score += 5
        const age = e.created_at ? (Date.now() - new Date(e.created_at).getTime()) / 1000 : 99999
        if (age < 120) score += 5
        else if (age < 600) score += 3
        if (e.summary && /finding|blocker|error|bug|fail/i.test(e.summary)) score += 3
        return { ...e, _score: score }
      })
      .filter((e: any) => e._score > 3)
      .sort((a: any, b: any) => b._score - a._score)
      .slice(0, 8)

    if (ranked.length === 0) return ""

    let ctx = "\n📊 RECENT:\n"
    for (const e of ranked) {
      const icon = e._score >= 10 ? "🔴" : e._score >= 6 ? "🟡" : "🟢"
      ctx += `  ${icon} [${e.agent}] ${e.tool}: ${(e.summary || "").slice(0, 80)}\n`
    }
    return ctx
  } catch {
    return ""
  }
}

// ═══════════════════════════════════════════════════
// LANE CONTEXT FAST-PATH — read from projection when available
// ═══════════════════════════════════════════════════

function getLaneContext(db: Database, agent: string, laneId: string): {
  phase: "explore" | "execute"
  memory: string
  ctxStr: string
  deadlines: any[]
  peers: string
} {
  // Fast path: read pre-built context from projection
  try {
    const row = db.query(
      `SELECT context FROM lane_context_projection WHERE lane_id = ?`
    ).get(laneId) as { context: string } | undefined
    if (row) {
      const parsed = JSON.parse(row.context)
      return parsed
    }
  } catch { /* fall through to full query chain */ }

  // Fallback: build from scratch (existing query chain)
  const phase = inferPhase(agent)
  const memory = hiveMemory(agent)
  const ctxStr = buildContext(agent, laneId)
  const deadlines = checkDeadlines(db, laneId)
  const peers = peerHealth(laneId)
  return { phase, memory, ctxStr, deadlines, peers }
}

// ═══════════════════════════════════════════════════
// AGENT PROFILES
// ═══════════════════════════════════════════════════

const AGENT_PROFILES: Record<string, { exploreTemp: number; executeTemp: number }> = {
  cartographer:       { exploreTemp: 0.7, executeTemp: 0.3 },
  architect:          { exploreTemp: 0.6, executeTemp: 0.1 },
  critic:             { exploreTemp: 0.4, executeTemp: 0.1 },
  surgeon:            { exploreTemp: 0.3, executeTemp: 0.0 },
  trial:              { exploreTemp: 0.7, executeTemp: 0.1 },
  journalist:         { exploreTemp: 0.5, executeTemp: 0.2 },
  "handy-agent":      { exploreTemp: 0.4, executeTemp: 0.0 },
  "general-man-agent":{ exploreTemp: 0.5, executeTemp: 0.2 },
}

const AUTO_APPROVE = [
  "read", "grep", "glob", "list",
  "smart_grep", "smart_find", "smart_git", "smart_bun",
  "smart_bash", "smart_edit", "smart_write", "smart_sd", "smart_batch",
  "read_source", 'read(action="artifact")', 'read(action="lib")',
  "feedback", "record", "verify", "discover", "gate",
  "leaf_handoff", "ping", "session_journal", "task_board", "task",
  "announce_leaf", "roadmap", "smart_session",
  "doctor", "validator", "config_sync", "system_test",
  "janitor", "db_query", "deep_analyze",
]

const TOOL_HINTS: Record<string, Record<string, string>> = {
  cartographer: { read_source: "Map codebase surface area", smart_grep: "Search for patterns" },
  surgeon:      { read_source: "Read before editing", smart_edit: "Surgical edits — verify with typecheck" },
  trial:        { smart_bun: "Run tests — capture full failure details" },
}

// ═══════════════════════════════════════════════════
// PLUGIN — thin hooks, heavy work behind janitor
// ═══════════════════════════════════════════════════

export default async function plugin(input: PluginInput): Promise<Hooks> {
  const t0 = Date.now()
  worktree = input.worktree

  db = init(input.worktree)
  if (!db) {
    console.error("[plugin] DB init failed — plugin disabled")
    return { dispose: async () => {} }
  }
  enableMirror(input.worktree)
  console.log(`[plugin] ready in ${Date.now() - t0}ms (migration/watcher → janitor tools)`)

  return {
    // ── Temperature adaptation ──
    "chat.params": async (ctx, output) => {
      if (!db) return
      currentAgent = ctx.agent
      currentSessionID = ctx.sessionID
      const p = AGENT_PROFILES[ctx.agent]
      if (!p) return
      timed("chat.params", () => {
        output.temperature = inferPhase(ctx.agent) === "explore"
          ? p.exploreTemp : p.executeTemp
      })
    },

    // ── Auto-approve safe tools ──
    "permission.ask": async (perm, out) => {
      timed("permission.ask", () => {
        if (AUTO_APPROVE.some(a => perm.type === a || perm.type.startsWith(a))) {
          out.status = "allow"
        }
      })
    },

    // ── Tool hints ──
    "tool.definition": async (ctx, out) => {
      const hints = TOOL_HINTS[currentAgent]
      if (hints?.[ctx.toolID]) {
        out.description = `${hints[ctx.toolID]}. ${out.description}`
      }
    },

    // ── Pre-execution: track lane + loop detection ──
    "tool.execute.before": async (ctx, _output) => {
      if (!db) return
      timed("tool.execute.before", () => {
        const lid = (ctx.args as any)?.lane_id || ""
        if (lid) currentLaneID = lid
        try {
          const argsKey = JSON.stringify(ctx.args).slice(0, 80)
          const row = db.query(
            `SELECT COUNT(*) as cnt FROM heartbeats
             WHERE session_id = ? AND tool = ? AND detail LIKE ?
             AND at > datetime('now', '-2 minutes')`
          ).get(ctx.sessionID, ctx.tool, `%${argsKey}%`) as any
          if (row?.cnt >= 3) {
            heartbeat(db, ctx.sessionID, currentAgent, ctx.tool, "loop_detected",
              `Dup #${row.cnt + 1}`)
          }
        } catch {}
      })
    },

    // ── Post-execution: telemetry only, no file I/O ──
    "tool.execute.after": async (ctx, output) => {
      if (!db) return
      timed("tool.execute.after", () => {
        try {
          heartbeat(db, ctx.sessionID, currentAgent, ctx.tool, "completed",
            (output.output || "").slice(0, 200))
        } catch {}
        try { logToolUsage(db, ctx.sessionID, currentAgent, ctx.tool) } catch {}
        const significant = new Set([
          "smart_bun", "smart_bash", "smart_git", "smart_grep",
          "smart_edit", "smart_write", "smart_sd", "smart_batch",
          "read_source", "read", "deep_analyze",
        ])
        if (significant.has(ctx.tool) && currentLaneID) {
          try {
            db.run(
              `INSERT INTO journal (lane_id, agent, session_id, tool, summary, output, files_touched)
               VALUES (?, ?, ?, ?, ?, ?, ?)`,
              currentLaneID, currentAgent, ctx.sessionID, ctx.tool,
              (output.title || ctx.tool).slice(0, 200),
              (output.output || "").slice(0, 2000),
              (ctx.args as any)?.files_touched || null,
            )
          } catch {}
        }
      })
    },

    // ── Context injection: only when a lane is active ──
    "chat.message": async (msg, output) => {
      if (!db || !worktree) return
      if (msg.agent) currentAgent = msg.agent
      if (msg.sessionID) currentSessionID = msg.sessionID
      if (output.message.role !== "system") return
      if (!currentLaneID) return

      const parts = output.parts || []
      if (parts.find((p: any) => p.type === "text")?.text?.includes("🔄 COORDINATION")) return

      timed("chat.message", () => {
        const agent = msg.agent || ""
        const profile = AGENT_PROFILES[agent]
        const ctx = getLaneContext(db, agent, currentLaneID)
        const temp = ctx.phase === "explore" ? profile?.exploreTemp : profile?.executeTemp
        const role = profile ? `You are a ${agent} in ${ctx.phase} phase (temp ${temp}).` : ""
        const overdue = ctx.deadlines.length > 0
          ? "\n⏰ OVERDUE:\n" + ctx.deadlines.map((o: any) =>
              `  • ${o.agent}: ${o.overdue_seconds}s overdue`).join("\n")
          : ""

        const note = [
          "🔄 COORDINATION CONTEXT",
          role,
          "• leaf_handoff(action=\"started\"|\"handoff\", status=\"completed|failed|partial\", ...)",
          "• ping(action=\"check\"|\"reply\", status=\"stuck\", ...)",
          `🧠 HIVE: ${ctx.memory}`,
          ctx.ctxStr,
          overdue,
          ctx.peers,
        ].filter(Boolean).join("\n")

        output.parts = parts.map((p: any) =>
          p.type === "text" ? { ...p, text: p.text + "\n\n" + note } : p
        )
      })
    },

    // ── Compaction ──
    "experimental.session.compacting": async (_ctx, out) => {
      if (currentLaneID && currentAgent) {
        try {
          const rows = db.query(
            `SELECT tool, summary FROM journal
             WHERE lane_id = ? AND agent = ?
             ORDER BY created_at DESC LIMIT 3`
          ).all(currentLaneID, currentAgent) as any[]
          if (rows.length) {
            out.context.push(
              `📋 ${rows.map((r: any) => `${r.tool}: ${(r.summary || "").slice(0, 50)}`).join(" | ")}`
            )
          }
        } catch {}
      }
      out.context.push("🔄 Same lane after compaction. Deliver leaf_handoff when done.")
    },

    "experimental.compaction.autocontinue": async (_ctx, out) => {
      out.enabled = true
    },

    // ── Shutdown ──
    dispose: async () => {
      writeWill(db, currentSessionID)
      stopServerIfLast()
    },
  }
}
