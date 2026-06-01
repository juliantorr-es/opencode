import type { PluginInput, Hooks } from "@opencode-ai/plugin"
import { Database } from "bun:sqlite"
import { init, fileKnowledge, topHotspots, discoveredConventions, migrateFromFilesystem, enableMirror, forgettingCurve, checkDeadlines, resurrectContext, phoenixRecover, writeWill, checkStale, findModifiedFiles, hashFile, recordFileHash, indexFile, indexForSearch, rebuildSearchIndex } from "./tools/db"
import { stopServerIfLast } from "./tools/dashboard"
import PQueue from "p-queue"
import { watch } from "chokidar"

let db: Database
let currentSessionID = ""
let currentAgent = ""
let currentLaneID = ""
let worktree = ""

// ═══════════════════════════════════════════════════════════
// 🔍 SESSION LENS: auto-scope DB queries per session
// ═══════════════════════════════════════════════════════════
function sessionLens(table: string, defaultSession: string): string {
  // Leaf agents only see their own session's data unless they're the GM
  if (currentAgent === "general-man-agent") return ""
  const sessionScoped = ["heartbeats", "tool_usage", "journal", "messages"]
  if (sessionScoped.includes(table) && defaultSession) {
    return ` AND session_id = '${defaultSession.replace(/'/g, "''")}'`
  }
  return ""
}

// ═══════════════════════════════════════════════════════════
// 📋 CONTEXT DIFFING: track what was already shown to agents
// ═══════════════════════════════════════════════════════════
const contextCache = new Map<string, string>()
function diffContext(agent: string, laneId: string, newCtx: string): string {
  const key = `${agent}::${laneId}`
  const prev = contextCache.get(key) || ""
  if (newCtx === prev) return ""  // nothing new
  // Only show new parts (simple line diff)
  const prevLines = new Set(prev.split("\n"))
  const newLines = newCtx.split("\n").filter(l => !prevLines.has(l) && l.trim())
  contextCache.set(key, newCtx)
  if (newLines.length === 0) return ""
  return "\n🆕 NEW CONTEXT:\n" + newLines.slice(0, 15).join("\n")
}

// ═══════════════════════════════════════════════════════════
// 💓 HEARTBEAT MESH: peer health scores
// ═══════════════════════════════════════════════════════════
function peerHealth(laneId: string): string {
  try {
    const peers = db.query(`
      SELECT agent, status, delegated_at,
        CAST((julianday('now') - julianday(delegated_at)) * 86400 AS INTEGER) as age_seconds
      FROM lane_agents
      WHERE id IN (SELECT MAX(id) FROM lane_agents GROUP BY lane_id, agent)
        AND lane_id = ? AND agent != ?
      ORDER BY delegated_at DESC LIMIT 10
    `).all(laneId, currentAgent) as any[]
    
    if (peers.length === 0) return ""
    let mesh = "\n💓 PEER HEALTH:\n"
    for (const p of peers) {
      const icon = p.status === "completed" ? "✅" : p.status === "stale" ? "💀" : p.age_seconds > 300 ? "🟡" : "🟢"
      mesh += `  ${icon} ${p.agent}: ${p.status} (${Math.round(p.age_seconds/60)}m ago)\n`
    }
    return mesh
  } catch { return "" }
}

// ═══════════════════════════════════════
// CONTEXT ENGINE CONFIG
// ═══════════════════════════════════════

const CONTEXT_BUDGET: Record<string, { system: number; history: number; artifacts: number }> = {
  cartographer:     { system: 2000, history: 4000, artifacts: 6000 },
  architect:        { system: 1500, history: 3000, artifacts: 4000 },
  critic:           { system: 1500, history: 3000, artifacts: 3000 },
  surgeon:          { system: 1000, history: 2000, artifacts: 8000 },
  trial:            { system: 1000, history: 2000, artifacts: 5000 },
  journalist:       { system: 1500, history: 5000, artifacts: 2000 },
  "handy-agent":    { system: 1000, history: 1500, artifacts: 4000 },
  "general-man-agent": { system: 2000, history: 6000, artifacts: 3000 },
}

// Dynamic temperature: creative when exploring, precise when executing
const AGENT_PROFILES: Record<string, { exploreTemp: number; executeTemp: number }> = {
  cartographer:   { exploreTemp: 0.7, executeTemp: 0.3 },  // needs creativity to find patterns
  architect:      { exploreTemp: 0.6, executeTemp: 0.1 },  // creative designs, precise specs
  critic:         { exploreTemp: 0.4, executeTemp: 0.1 },  // creative critique, precise judgment
  surgeon:        { exploreTemp: 0.3, executeTemp: 0.0 },  // precise edits only
  trial:          { exploreTemp: 0.7, executeTemp: 0.1 },  // creative edge cases, precise tests
  journalist:     { exploreTemp: 0.5, executeTemp: 0.2 },  // creative prose, precise commits
  "handy-agent":    { exploreTemp: 0.4, executeTemp: 0.0 },
  "general-man-agent": { exploreTemp: 0.5, executeTemp: 0.2 },
}

// ⚡ Circuit breaker: prevent cascading hook failures
const breaker = new Map<string, number>()
function guard(name: string, fn: () => void) {
  const fails = breaker.get(name) || 0
  if (fails >= 3) return
  try { fn(); breaker.set(name, 0) }
  catch { breaker.set(name, fails + 1) }
}

// ═══════════════════════════════════════════════════════════
// 🎯 PRIORITY QUEUE: critical lanes get DB/tool access first
// ═══════════════════════════════════════════════════════════
const priorityQueue = new PQueue({ concurrency: 1 })
const CRITICAL_LANES = new Set<string>()  // lanes marked as critical get priority

export function markLaneCritical(laneId: string) {
  CRITICAL_LANES.add(laneId)
}

function getPriority(laneId: string): number {
  if (CRITICAL_LANES.has(laneId)) return 10
  // Lanes with blockers get higher priority
  try {
    const hasBlockers = db.query(`SELECT COUNT(*) as cnt FROM lane_agents WHERE lane_id = ? AND status = 'failed'`).get(laneId) as any
    if (hasBlockers?.cnt > 0) return 7
  } catch {}
  return 5  // default priority
}

// Infer the agent's current phase from recent tool calls
function inferPhase(agent: string): "explore" | "execute" {
  try {
    const recent = db.query(`SELECT tool FROM journal WHERE agent = ? ORDER BY created_at DESC LIMIT 5`).all(agent) as any[]
    const tools = recent.map((r: any) => r.tool)
    // Exploration tools → explore phase
    const exploreTools = ["smart_grep", "smart_find", "read_source", "read", "discover"]
    // Execution tools → execute phase
    const executeTools = ["smart_edit", "smart_write", "smart_bun", "smart_sd", "smart_batch"]
    
    let exploreScore = 0, executeScore = 0
    for (const t of tools) {
      if (exploreTools.includes(t)) exploreScore++
      if (executeTools.includes(t)) executeScore++
    }
    // No history → default to explore (fresh agent)
    if (exploreScore === 0 && executeScore === 0) return "explore"
    return exploreScore >= executeScore ? "explore" : "execute"
  } catch { return "explore" }
}

const AUTO_APPROVE = ["read","grep","glob","list","smart_grep","smart_find","smart_git","smart_bun","smart_bash","smart_edit","smart_write","smart_sd","smart_batch","read_source","read(action=\"artifact\")","read(action=\"lib\")","feedback","record","verify","discover","gate","leaf_handoff","ping","session_journal","task_board","task","announce_leaf","roadmap","smart_session","doctor","validator","config_sync","system_test","janitor","db_query"]

const TOOL_CONTEXT: Record<string, Record<string, string>> = {
  cartographer: { read_source: "Map codebase surface area", smart_grep: "Search for patterns" },
  surgeon: { read_source: "Read before editing", smart_edit: "Surgical edits — verify with typecheck" },
  trial: { smart_bun: "Run tests — capture full failure details" },
}

const TOOL_EMOJIS: Record<string, string> = {
  smart_bun:"🧪",smart_bash:"💻",smart_git:"📦",smart_grep:"🔍",smart_find:"📂",
  smart_edit:"✏️",smart_write:"📝",read_source:"📖",read:"👁️",leaf_handoff:"📬",ping:"📡",task_board:"📊",
}

// ═══════════════════════════════════════
// KNOWLEDGE GRAPH CONTEXT BUILDER
// ═══════════════════════════════════════

function scoreRelevance(agent: string, e: any): number {
  let s = 0
  if (e.agent === agent) s += 10
  const tool = e.tool || ""
  if (tool === "smart_bun" && agent === "trial") s += 8
  if ((tool === "smart_edit" || tool === "smart_write") && (agent === "surgeon" || agent === "journalist")) s += 8
  if ((tool === "smart_grep" || tool === "smart_find") && agent === "cartographer") s += 7
  const age = e.created_at ? (Date.now() - new Date(e.created_at).getTime()) / 1000 : 99999
  if (age < 120) s += 5; else if (age < 600) s += 3; else if (age < 3600) s += 1
  if (e.summary && /finding|blocker|error|bug|fail/i.test(e.summary)) s += 4
  return s
}

function buildContext(agent: string, laneId: string): string {
  try {
    const entries = db.query("SELECT * FROM journal WHERE lane_id = ? ORDER BY created_at DESC LIMIT 40").all(laneId) as any[]
    const ranked = entries.map(e => ({...e, _score: scoreRelevance(agent, e)})).filter(e => e._score > 3).sort((a,b) => b._score - a._score)
    if (!ranked.length) return ""

    const critical = ranked.filter(e => e._score >= 12).slice(0, 5)
    const important = ranked.filter(e => e._score >= 8 && e._score < 12).slice(0, 8)
    let ctx = ""

    // 📊 KNOWLEDGE GRAPH: file knowledge for surgeons/architects/trial
    if (agent === "surgeon" || agent === "architect" || agent === "trial") {
      const touched = [...new Set(entries.filter(e => e.agent === agent).flatMap(e => { try { return JSON.parse(e.files_touched||"[]") } catch { return [] } }))].slice(0, 5)
      if (touched.length) {
        ctx += "\n📊 KNOWLEDGE GRAPH — files in play:\n"
        for (const f of touched) {
          const k = fileKnowledge(db, f)
          const stale = checkStale(db, f, worktree)
          if (k.file) {
            const staleMark = stale.stale ? " ⚠️ STALE (file modified since indexing)" : ""
            ctx += `  📄 ${f} — ${k.file.purpose||"?"} | ${k.symbols?.filter((s:any)=>s.exported).length||0} exports${staleMark}\n`
            if (k.imported_by?.length) ctx += `     Used by: ${k.imported_by.slice(0,3).map((d:any)=>d.from_file).join(", ")}\n`
            if (k.hotspot?.type_errors > 0 || k.hotspot?.test_failures > 0) ctx += `     ⚠️ ${k.hotspot.type_errors} type errs, ${k.hotspot.test_failures} test fails\n`
          }
        }
      }
      const hotspots = topHotspots(db, 3)
      if (hotspots.length) ctx += "\n🔥 ERROR HOTSPOTS:\n" + hotspots.map((h:any) => `  • ${h.file_path}: ${h.type_errors}T ${h.test_failures}F`).join("\n")
    }

    // 📐 CONVENTIONS for cartographers/architects
    if (agent === "cartographer" || agent === "architect") {
      const conv = discoveredConventions(db)
      if (conv.length) ctx += "\n📐 CONVENTIONS:\n" + conv.slice(0,5).map((c:any) => `  • ${c.category}: ${c.cnt} patterns`).join("\n")
    }

    if (critical.length) ctx += "\n\n🔴 CRITICAL:\n" + critical.map(e => {
      const age = e.created_at ? (Date.now() - new Date(e.created_at).getTime()) / 1000 : 999
      const icon = age < 120 ? "🟢" : age < 600 ? "🟡" : "🟠"
      return `  ${icon} [${e.agent}] ${e.tool}: ${(e.summary||"").slice(0,100)}`
    }).join("\n")
    if (important.length) ctx += "\n🟡 IMPORTANT:\n" + important.map(e => {
      const age = e.created_at ? (Date.now() - new Date(e.created_at).getTime()) / 1000 : 999
      const icon = age < 120 ? "🟢" : age < 600 ? "🟡" : "🟠"
      return `  ${icon} [${e.agent}] ${e.tool}: ${(e.summary||"").slice(0,100)}`
    }).join("\n")

    // File collisions
    const myFiles = new Set(entries.filter(e => e.agent === agent).flatMap(e => { try { return JSON.parse(e.files_touched||"[]") } catch { return [] } }))
    const theirFiles = new Set(entries.filter(e => e.agent !== agent).flatMap(e => { try { return JSON.parse(e.files_touched||"[]") } catch { return [] } }))
    const collisions = [...myFiles].filter(f => theirFiles.has(f))
    if (collisions.length) ctx += "\n\n⚠️ FILE COLLISIONS:\n" + collisions.slice(0,5).map(f => `  • ${f}`).join("\n") + "\n  Coordinate to avoid merge conflicts."

    return ctx
  } catch { return "" }
}

function hiveMemory(agent: string): string {
  try {
    const files = db.query("SELECT files_touched, created_at FROM journal WHERE agent = ? AND files_touched IS NOT NULL ORDER BY created_at DESC LIMIT 5").all(agent) as any[]
    const discoveries = db.query("SELECT summary, created_at FROM journal WHERE agent = ? AND summary IS NOT NULL AND summary != '' ORDER BY created_at DESC LIMIT 5").all(agent) as any[]
    const failures = db.query("SELECT tool, COUNT(*) as cnt FROM heartbeats WHERE agent = ? AND phase = 'failed' AND at > datetime('now', '-7 days') GROUP BY tool ORDER BY cnt DESC LIMIT 3").all(agent) as any[]
    let r = ""
    
    // Apply forgetting curve to files
    const recentFiles = files.filter((f: any) => {
      const age = f.created_at ? (Date.now() - new Date(f.created_at).getTime()) / 1000 : 99999
      return forgettingCurve(age) > 0.15  // only show if >15% remembered
    })
    if (recentFiles.length) r += `📁 Past (decayed): ${recentFiles.map((f: any) => (f.files_touched||"").slice(0,80)).join(", ")}. `
    
    const recentDiscoveries = discoveries.filter((d: any) => {
      const age = d.created_at ? (Date.now() - new Date(d.created_at).getTime()) / 1000 : 99999
      return forgettingCurve(age) > 0.3
    })
    if (recentDiscoveries.length) r += `💡 ${recentDiscoveries.map((d: any) => (d.summary||"").slice(0,60)).join(" | ")}. `
    
    if (failures.length) r += `⚠️ Watch: ${failures.map((f: any) => `${f.tool}(${f.cnt}x)`).join(", ")}.`
    return r || "No hive memory yet."
  } catch { return "" }
}

function graveyard(laneId: string, text: string): string {
  try {
    const files = text.match(/[\w\/-]+\.(ts|tsx|js|jsx|json|md)/g) || []
    let r = ""
    for (const f of files.slice(0, 3)) {
      const graves = db.query("SELECT agent, summary FROM lane_agents WHERE lane_id = ? AND (status='failed' OR status='stale') AND (files_modified LIKE ? OR files_created LIKE ?) ORDER BY created_at DESC LIMIT 3").all(laneId, `%${f}%`, `%${f}%`) as any[]
      if (graves.length) r += `\n🪦 ${f}: ${graves.map(g=>`${g.agent} failed`).join(", ")}. Try different approach.`
    }
    return r
  } catch { return "" }
}

// ═══════════════════════════════════════
// PLUGIN
// ═══════════════════════════════════════

export default async function plugin(input: PluginInput): Promise<Hooks> {
  worktree = input.worktree
  db = init(input.worktree)
  if (!db) { console.error('[plugin] Failed to initialize database'); return {} }
  enableMirror(input.worktree)
  
  // 🐦‍🔥 Phoenix: rebuild DB from mirror if it was lost
  const recovered = phoenixRecover(db, input.worktree)
  
  // Migrate any existing JSONL artifacts into the database
  const migration = migrateFromFilesystem(db, input.worktree)
  if (migration.migrated > 0 || recovered) {
    console.log(`[plugin] ${recovered ? '🐦‍🔥 Phoenix recovered +' : 'Mirrored +'} migrated ${migration.migrated} entries (${migration.errors} errors)`)
  }

  // 🔎 Rebuild full-text search index on startup
  const ftsCount = rebuildSearchIndex(db)
  if (ftsCount > 0) console.log(`[plugin] 🔎 FTS5 index rebuilt: ${ftsCount} documents`)

  // 👁️ Live file watcher: auto-reindex on every save
  const watcher = watch(input.worktree, {
    ignored: /(node_modules|\.git|docs\/json\/opencode|dist|\.db)/,
    persistent: true,
    ignoreInitial: true,
  })
  watcher.on("change", (filePath: string) => {
    const rel = filePath.replace(input.worktree + "/", "")
    const hash = hashFile(input.worktree, rel)
    if (hash) {
      recordFileHash(db, rel, hash, "watcher")
      try {
        const { readFileSync: rfs, existsSync: ex } = require("node:fs") as typeof import("node:fs")
        const full = filePath
        if (ex(full)) {
          const lines = rfs(full, "utf8").split("\n").length
          indexFile(db, rel, `Auto-indexed via file watcher (${lines} lines)`, "", lines, "watcher")
        }
      } catch {}
    }
  })
  watcher.on("add", (filePath: string) => {
    const rel = filePath.replace(input.worktree + "/", "")
    if (/\.(ts|tsx|js|jsx)$/.test(rel)) {
      const hash = hashFile(input.worktree, rel)
      if (hash) recordFileHash(db, rel, hash, "watcher")
    }
  })

  return {
    // ── CONTEXT ENGINE ──
    "chat.message": async (msg, output) => guard("chat.message", () => {
      if (!db || !worktree) return  // safety: bail if plugin not initialized
      if (msg.agent) currentAgent = msg.agent
      if (msg.sessionID) currentSessionID = msg.sessionID
      if (output.message.role !== "system") {
        // ── Intent classifier for auto-handoff (multi-signal, not just regex) ──
        if (output.message.role === "assistant" && currentLaneID) {
          const text = output.parts?.find((p:any) => p.type==="text")?.text || ""
          const signals = 0
            + (/handoff|leaf_handoff/i.test(text) ? 3 : 0)
            + (/completed|done|finished|ready for review|PR ready/i.test(text.slice(0,500)) ? 1 : 0)
            + (/files_created|files_modified|findings/i.test(text) ? 2 : 0)
            + (/summary|conclusion|in summary/i.test(text.slice(-500)) ? 1 : 0)
          if (signals >= 4) {  // high confidence only
            try { db.run("INSERT INTO lane_agents (lane_id,agent,status,delegated_by,delegated_at,completed_at,auto_completed,summary) VALUES (?,?,'completed','plugin',datetime('now'),datetime('now'),1,?)", currentLaneID, currentAgent, text.slice(0,200)) } catch {}
          }
        }
        return
      }

      const parts = output.parts || []
      const existing = parts.find((p:any) => p.type==="text")?.text || ""
      if (msg.agent === "general-man-agent" || existing.includes("🔄 COORDINATION")) return

      const profile = AGENT_PROFILES[msg.agent||""]
      const budget = CONTEXT_BUDGET[msg.agent||""] || CONTEXT_BUDGET["handy-agent"]!
      const phase = inferPhase(msg.agent||"")
      const temp = phase === "explore" ? profile?.exploreTemp : profile?.executeTemp
      const roleHint = profile ? `You are a ${msg.agent} in ${phase} phase (temp ${temp}).` : ""
      const memory = hiveMemory(msg.agent||"")
      const kg = currentLaneID ? buildContext(msg.agent||"", currentLaneID) : ""
      const graves = currentLaneID ? graveyard(currentLaneID, existing) : ""
      
      // 👻 Ghost resurrection: if an agent in this lane crashed, inject its journal
      let ghostCtx = ""
      if (currentLaneID) {
        const crashed = db.query(`SELECT DISTINCT agent FROM lane_agents WHERE lane_id=? AND status='resurrected' ORDER BY id DESC LIMIT 1`).all(currentLaneID) as any[]
        if (crashed.length > 0 && crashed[0].agent !== msg.agent) {
          ghostCtx = resurrectContext(db, currentLaneID, crashed[0].agent)
        }
      }
      
      // ⏰ Deadline alerts
      let deadlineCtx = ""
      if (currentLaneID) {
        const overdue = checkDeadlines(db, currentLaneID)
        if (overdue.length > 0) {
          deadlineCtx = "\n⏰ OVERDUE AGENTS:\n" + overdue.map((o: any) =>
            `  • ${o.agent}: overdue by ${o.overdue_seconds}s — consider advancing past it`).join("\n")
        }
      }

      // 💓 Peer health + 📋 Context diffing
      let peerCtx = ""
      let diffCtx = ""
      let prioCtx = ""
      if (currentLaneID) {
        peerCtx = peerHealth(currentLaneID)
        diffCtx = diffContext(msg.agent||"", currentLaneID, kg)
        const priority = getPriority(currentLaneID)
        if (priority >= 10) prioCtx = "\n🎯 CRITICAL PRIORITY — this lane has top priority for all resources."
        else if (priority >= 7) prioCtx = "\n⚠️ ELEVATED PRIORITY — this lane has blockers that need attention."
      }

      const note = `
🔄 COORDINATION CONTEXT
${roleHint}
• Start: leaf_handoff(action="started",...), ping(action="check",...)
• Complete: leaf_handoff(action="handoff",status="completed|failed|partial",summary="...",files_created="[...]",files_modified="[...]",findings="[...]")
• Stuck: ping(action="reply",status="stuck",message="...")
🧠 HIVE: ${memory}${graves}${diffCtx || kg}${ghostCtx}${deadlineCtx}${peerCtx}${prioCtx}
`.trim()

      output.parts = parts.map((p:any) => p.type==="text" ? {...p, text: p.text + "\n\n" + note} : p)
    }),

    // ── AUTO-JOURNAL + ANALYTICS ──
    "tool.execute.after": async (ctx, output) => {
      if (!db) return
      // Heartbeat + usage (always)
      try { db.run("INSERT INTO heartbeats (session_id,agent,tool,phase,detail,at) VALUES (?,?,?,'completed',?,?)", ctx.sessionID, currentAgent, ctx.tool, (output.output||"").slice(0,200), new Date().toISOString()) } catch {}
      try { db.run("INSERT INTO tool_usage (session_id,agent,tool,at) VALUES (?,?,?,?)", ctx.sessionID, currentAgent, ctx.tool, new Date().toISOString()) } catch {}

      // Journal significant tools
      const sig = new Set(["smart_bun","smart_bash","smart_git","smart_grep","smart_edit","smart_write","smart_sd","smart_batch","read_source","read","deep_analyze"])
      if (sig.has(ctx.tool) && currentLaneID) {
        try { db.run("INSERT INTO journal (lane_id,agent,session_id,tool,summary,output) VALUES (?,?,?,?,?,?)", currentLaneID, currentAgent, ctx.sessionID, ctx.tool, (output.title||ctx.tool).slice(0,200), (output.output||"").slice(0,2000)) } catch {}
        // Auto-index into FTS5 search
        try { indexForSearch(db, `journal:${currentLaneID}:${currentAgent}`, `${output.title||ctx.tool} ${(output.output||"").slice(0,1000)}`) } catch {}
      }

      // 🔑 AUTO-INDEX: hash + index every file touched by file-aware tools
      try {
        const args = ctx.args as any
        const fileFields = ["file_path", "file", "path", "from_file", "to_file"]
        for (const field of fileFields) {
          const fp = args?.[field]
          if (fp && typeof fp === "string" && /\.[a-z]+$/i.test(fp)) {
            const hash = hashFile(worktree, fp)
            if (hash) {
              recordFileHash(db, fp, hash, currentAgent)
              // Lightweight index: at minimum record the file exists
              const { existsSync, readFileSync } = require("node:fs") as typeof import("node:fs")
              const { resolve } = require("node:path") as typeof import("node:path")
              const full = resolve(worktree, fp)
              if (existsSync(full)) {
                const lines = readFileSync(full, "utf8").split("\n").length
                indexFile(db, fp, `Auto-indexed via ${ctx.tool}`, "", lines, currentAgent)
              }
            }
          }
        }
        // Multi-file tools: smart_batch, smart_find results
        if (ctx.tool === "smart_batch") {
          try { JSON.parse(args?.edits || "[]").forEach((e: any) => {
            if (e.file) { const h = hashFile(worktree, e.file); if (h) recordFileHash(db, e.file, h, currentAgent) }
          })} catch {}
        }
      } catch {}

      const emoji = TOOL_EMOJIS[ctx.tool]
      if (emoji && output.title && !output.title.startsWith(emoji)) output.title = `${emoji} ${output.title}`
    },

    // ── LOOP DETECTION ──
    "tool.execute.before": async (ctx, output) => {
      const lid = (ctx.args as any)?.lane_id || ""
      if (lid) currentLaneID = lid
      try {
        const argsKey = JSON.stringify(ctx.args).slice(0,200)
        const row = db.query("SELECT COUNT(*) as cnt FROM heartbeats WHERE session_id=? AND tool=? AND detail LIKE ? AND at > datetime('now','-2 minutes')").get(ctx.sessionID, ctx.tool, `%${argsKey.slice(0,80)}%`) as any
        if (row?.cnt >= 3) db.run("INSERT INTO heartbeats (session_id,agent,tool,phase,detail,at) VALUES (?,?,?,'loop_detected',?,?)", ctx.sessionID, currentAgent, ctx.tool, `Dup #${row.cnt+1}`, new Date().toISOString())
      } catch {}
    },

    // ── CROSS-SESSION MEMORY ──
    "experimental.chat.messages.transform": async (ctx, output) => {
      if (!currentLaneID || !currentAgent) return
      try {
        const rows = db.query("SELECT tool,summary FROM journal WHERE lane_id=? AND agent=? ORDER BY created_at DESC LIMIT 10").all(currentLaneID, currentAgent) as any[]
        if (rows.length) {
          output.messages.unshift({
            info: { id:"mem",role:"system",sessionID:currentSessionID,agent:currentAgent,synthetic:true } as any,
            parts: [{ type:"text", text:`📋 ALREADY DONE:\n${rows.map(r=>`  • ${r.tool}: ${(r.summary||"").slice(0,80)}`).join("\n")}\n\n⚠️ Do NOT repeat.`, synthetic:true }],
          })
        }
      } catch {}
    },

    // ── ADAPTIVE PARAMS ──
    "chat.params": async (ctx, output) => {
      if (!db) return
      currentAgent = ctx.agent; currentSessionID = ctx.sessionID
      const p = AGENT_PROFILES[ctx.agent]
      if (p) {
        try {
          const phase = inferPhase(ctx.agent)
          const baseTemp = phase === "explore" ? p.exploreTemp : p.executeTemp
          
          const fails = db.query("SELECT COUNT(*) as cnt FROM heartbeats WHERE agent=? AND phase='failed' AND at > datetime('now','-10 minutes')").get(ctx.agent) as any
          const loops = db.query("SELECT COUNT(*) as cnt FROM heartbeats WHERE agent=? AND phase='loop_detected' AND at > datetime('now','-5 minutes')").get(ctx.agent) as any
          
          // Stuck agents: cool down to break loops. Otherwise use phase temp.
          output.temperature = (fails?.cnt>3||loops?.cnt>0) ? Math.max(0, baseTemp - 0.3) : baseTemp
        } catch { output.temperature = p.exploreTemp }
      }
    },

    "permission.ask": async (perm, out) => {
      if (AUTO_APPROVE.some(a => perm.type===a||perm.type.startsWith(a))) out.status = "allow"
    },

    "experimental.session.compacting": async (ctx, out) => {
      if (currentLaneID && currentAgent) {
        try {
          const rows = db.query("SELECT tool,summary FROM journal WHERE lane_id=? AND agent=? ORDER BY created_at DESC LIMIT 5").all(currentLaneID,currentAgent) as any[]
          if (rows.length) out.context.push(`📋 Recent: ${rows.map(r=>`${r.tool}: ${(r.summary||"").slice(0,60)}`).join(" | ")}`)
        } catch {}
      }
      out.context.push("🔄 Same lane after compaction. Deliver leaf_handoff when done.")
    },

    "experimental.compaction.autocontinue": async (ctx, out) => { out.enabled = true },

    "tool.definition": async (ctx, out) => {
      const hints = TOOL_CONTEXT[currentAgent]
      if (hints?.[ctx.toolID]) out.description = `${hints[ctx.toolID]}. ${out.description}`
    },

    "experimental.chat.system.transform": async (ctx, out) => {
      out.system.push("You are an agent in the OpenCode orchestration system.")
    },

    // ═══════════════════════════════════════════════════════════
    // AUTO-SYNC: keep global and local configs aligned on startup
    // ═══════════════════════════════════════════════════════════
    config: async (cfg) => {
      // Read both configs and merge missing entries from local → global
      const { readFileSync, writeFileSync, existsSync } = await import("node:fs")
      const { resolve } = await import("node:path")
      const { homedir } = await import("node:os")
      
      const globalPath = resolve(homedir(), ".config/opencode/opencode.json")
      if (!existsSync(globalPath)) return
      
      try {
        const globalRaw = readFileSync(globalPath, "utf8")
        const global = JSON.parse(globalRaw)
        const local = cfg as any
        let changed = false

        // Sync permissions
        if (!global.permission) { global.permission = {}; changed = true }
        for (const [key, val] of Object.entries(local.permission || {})) {
          if (!(key in global.permission)) { global.permission[key] = val; changed = true }
        }

        // Sync agents and their permissions
        if (!global.agent) { global.agent = {}; changed = true }
        for (const [agent, ac] of Object.entries(local.agent || {})) {
          if (!global.agent[agent]) { global.agent[agent] = JSON.parse(JSON.stringify(ac)); changed = true; continue }
          const agentConfig = ac as any
          const gc = global.agent[agent]
          if (!gc.permission) { gc.permission = {}; changed = true }
          for (const [key, val] of Object.entries(agentConfig.permission || {})) {
            if (!(key in gc.permission)) { gc.permission[key] = val; changed = true }
          }
        }

        if (changed) {
          writeFileSync(globalPath, JSON.stringify(global, null, 2) + "\n", "utf8")
          console.log("[plugin] Synced config: global ← local")
        }
      } catch { /* silent — config sync is best-effort */ }
    },

    dispose: async () => {
      // 📜 The Will: snapshot pending state before shutdown
      const will = writeWill(db, currentSessionID)
      // 🖥️ Dashboard: only stop if this was the last session
      stopServerIfLast()
      try { console.log(`[plugin] 📜 ${currentSessionID} disposed — ${will?.pending_agents?.length || 0} agents pending`) } catch {}
    },
  }
}
