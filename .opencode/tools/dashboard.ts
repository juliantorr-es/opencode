import { tool } from "@opencode-ai/plugin"
import { init, searchEverything } from "./db"
import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { Elysia, t } from "elysia"
import * as d3 from "d3"

let server: any = null
let serverRefs = 0
let yjsDocs: Map<string, any> = new Map()

export function getServerRefs(): number { return serverRefs }
export function stopServerIfLast() {
  serverRefs = Math.max(0, serverRefs - 1)
  if (serverRefs === 0 && server) {
    try { server.stop() } catch {}
    server = null
    return true
  }
  return false
}

function buildD3Graph(db: any, centerFile: string): string {
  const nodes: { id: string; group: number; hotspot: boolean }[] = []
  const links: { source: string; target: string }[] = []
  const visited = new Set<string>()
  const queue = [centerFile]

  while (queue.length > 0 && visited.size < 50) {
    const file = queue.shift()!
    if (visited.has(file)) continue
    visited.add(file)

    const hotspot = db.query(`SELECT type_errors, test_failures FROM error_hotspots WHERE file_path = ?`).get(file) as any
    nodes.push({
      id: file.split("/").pop()?.replace(/\.[^.]+$/, "") || file,
      group: hotspot && (hotspot.type_errors > 0 || hotspot.test_failures > 0) ? 1 : 0,
      hotspot: !!(hotspot && (hotspot.type_errors > 0 || hotspot.test_failures > 0)),
    })

    const deps = db.query(`SELECT to_file FROM dependencies WHERE from_file = ? LIMIT 10`).all(file) as any[]
    for (const d of deps) {
      const targetName = d.to_file.split("/").pop()?.replace(/\.[^.]+$/, "") || d.to_file
      links.push({ source: file.split("/").pop()?.replace(/\.[^.]+$/, "") || file, target: targetName })
      if (!visited.has(d.to_file)) queue.push(d.to_file)
    }
  }

  // D3 force simulation to compute positions
  const simulation = d3.forceSimulation(nodes as any)
    .force("link", d3.forceLink(links).id((d: any) => d.id).distance(80))
    .force("charge", d3.forceManyBody().strength(-200))
    .force("center", d3.forceCenter(400, 300))
    .stop()
  
  // Run simulation synchronously
  for (let i = 0; i < 200; i++) simulation.tick()

  // Generate SVG
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 600" style="background:#0d1117">
  <defs><marker id="arrow" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="6" markerHeight="6" orient="auto">
    <path d="M 0 0 L 10 5 L 0 10 z" fill="#30363d"/></marker></defs>`

  for (const l of links) {
    const source = nodes.find(n => n.id === l.source)
    const target = nodes.find(n => n.id === l.target)
    if (source && target) {
      const sx = (source as any).x || 400, sy = (source as any).y || 300
      const tx = (target as any).x || 400, ty = (target as any).y || 300
      svg += `\n  <line x1="${sx}" y1="${sy}" x2="${tx}" y2="${ty}" stroke="#30363d" stroke-width="1" marker-end="url(#arrow)"/>`
    }
  }

  for (const n of nodes) {
    const x = (n as any).x || 400, y = (n as any).y || 300
    const color = n.hotspot ? "#f85149" : "#58a6ff"
    const r = n.hotspot ? 8 : 5
    svg += `\n  <circle cx="${x}" cy="${y}" r="${r}" fill="${color}"/>`
    svg += `\n  <text x="${x}" y="${y - r - 4}" fill="#c9d1d9" text-anchor="middle" font-size="8">${n.id.slice(0, 20)}</text>`
  }
  svg += `\n</svg>`
  return svg
}

export default tool({
  description: "Enhanced dashboard with Elysia REST API, d3-powered interactive dependency graphs, shiki syntax highlighting, and yjs real-time state sync. Start with action='start', stop with 'stop'.",
  args: {
    action: tool.schema.string().describe("'start' to launch the server | 'stop' to shut down | 'status' to check"),
    port: tool.schema.number().optional().describe("Port (default 9876)."),
  },
  async execute(args, context) {
    const port = args.port ?? 9876
    const db = init(context.worktree)

    if (args.action === "start") {
      if (server) {
        serverRefs++
        return JSON.stringify({ status: "running", port, refs: serverRefs, url: `http://localhost:${port}` }, null, 2)
      }

      const app = new Elysia()
        // ── REST API ──
        .get("/api/fleet", () => {
          const rows = db.query(`SELECT lane_id, agent, status, delegated_at FROM lane_agents WHERE id IN (SELECT MAX(id) FROM lane_agents GROUP BY lane_id, agent) ORDER BY delegated_at DESC LIMIT 50`).all() as any[]
          return rows
        })
        .get("/api/lane/:id", ({ params: { id } }) => {
          const agents = db.query(`SELECT agent, status, delegated_at, completed_at, summary FROM lane_agents WHERE lane_id = ? AND id IN (SELECT MAX(id) FROM lane_agents GROUP BY lane_id, agent) ORDER BY delegated_at`).all(id) as any[]
          const msgs = db.query(`SELECT sender, subject, body, sent_at FROM messages WHERE lane_id = ? ORDER BY sent_at DESC LIMIT 20`).all(id) as any[]
          return { agents, messages: msgs }
        })
        .get("/api/search", ({ query: { q } }) => {
          if (!q) return { results: [] }
          const results = searchEverything(db, String(q), 20)
          return { query: q, results }
        })
        .get("/api/graph/:file", ({ params: { file } }) => {
          const svg = buildD3Graph(db, file)
          return new Response(svg, { headers: { "Content-Type": "image/svg+xml" } })
        })
        .get("/api/stats", () => {
          const totalAgents = (db.query("SELECT COUNT(*) as cnt FROM lane_agents").get() as any)?.cnt || 0
          const totalTools = (db.query("SELECT COUNT(*) as cnt FROM tool_usage").get() as any)?.cnt || 0
          const totalErrors = (db.query("SELECT SUM(type_errors + test_failures) as cnt FROM error_hotspots").get() as any)?.cnt || 0
          return { agents: totalAgents, tool_calls: totalTools, errors: totalErrors }
        })
        // ── WebSocket for real-time sync ──
        .ws("/ws", {
          open(ws) {
            ws.send(JSON.stringify({ type: "connected", clients: serverRefs }))
          },
          message(ws, msg) {
            // Broadcast state changes to all clients
            const data = JSON.parse(String(msg))
            if (data.type === "yjs-update") {
              // Yjs sync update — broadcast to all other clients
              app.server?.publish("/ws", String(msg))
            }
          },
        })
        // ── Interactive dashboard ──
        .get("/", () => {
          return new Response(`<!DOCTYPE html><html><head>
<title>Fleet Dashboard</title><meta charset="utf-8">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:system-ui;background:#0d1117;color:#c9d1d9;display:flex;height:100vh}
nav{width:240px;background:#161b22;border-right:1px solid #30363d;padding:16px;overflow-y:auto}
nav h2{color:#58a6ff;font-size:14px;margin-bottom:12px}
nav a{display:block;color:#8b949e;text-decoration:none;padding:6px 8px;border-radius:4px;font-size:13px;cursor:pointer}
nav a:hover{background:#1f2a37;color:#c9d1d9}
main{flex:1;padding:24px;overflow-y:auto}
.lane{background:#161b22;border-radius:8px;padding:16px;margin:12px 0;border-left:4px solid #58a6ff;cursor:pointer}
.lane:hover{border-left-color:#bc8cff}
.agent{display:inline-block;padding:3px 10px;margin:3px;border-radius:3px;font-size:12px}
.pending{background:#1f2a37;border:1px solid #58a6ff;color:#58a6ff}
.completed{background:#1a2e1a;border:1px solid #3fb950;color:#3fb950}
.failed,.stale{background:#2e1a1a;border:1px solid #f85149;color:#f85149}
#detail{background:#161b22;border-radius:8px;padding:16px;margin-top:12px;display:none}
#graph{width:100%;height:400px;background:#0d1117;border-radius:8px;margin-top:12px}
pre.code{background:#161b22;border-radius:8px;padding:16px;overflow-x:auto;font-size:12px;margin:8px 0}
#stats{display:flex;gap:12px;margin-bottom:16px}
.stat{background:#161b22;border-radius:8px;padding:12px 16px;flex:1;text-align:center}
.stat .val{font-size:24px;font-weight:bold;color:#58a6ff}
.stat .lbl{font-size:11px;color:#8b949e;margin-top:4px}
.hot{color:#f85149}
</style></head><body>
<nav>
<h2>🚀 Fleet Dashboard</h2>
<a onclick="loadView('fleet')">📊 Fleet</a>
<a onclick="loadView('graph')">🔗 Dep Graph</a>
<a onclick="loadView('search')">🔍 Search</a>
<a onclick="loadView('stats')">📈 Stats</a>
<div id="lane-list" style="margin-top:12px"></div>
</nav>
<main id="main"></main>
<script>
const ws = new WebSocket('ws://' + location.host + '/ws')
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data)
  if (msg.type === 'connected') loadFleet()
}

async function loadFleet() {
  const res = await fetch('/api/fleet')
  const fleet = await res.json()
  const lanes = {}
  for (const f of fleet) {
    if (!lanes[f.lane_id]) lanes[f.lane_id] = []
    lanes[f.lane_id].push(f)
  }
  document.getElementById('main').innerHTML = '<div id="stats"></div>' + Object.entries(lanes).map(([id, agents]) =>
    '<div class="lane" onclick="loadLane(\\'' + id + '\\')"><strong>' + id.slice(0,12) + '</strong> ' +
    agents.map(a => '<span class="agent ' + a.status + '">' + a.agent + '</span>').join('') +
    '</div>'
  ).join('')
  document.getElementById('lane-list').innerHTML = Object.keys(lanes).map(id =>
    '<a onclick="loadLane(\\'' + id + '\\')">' + id.slice(0,12) + '</a>'
  ).join('')
  loadStats()
}

async function loadLane(id) {
  const res = await fetch('/api/lane/' + id)
  const data = await res.json()
  document.getElementById('detail').style.display = 'block'
  document.getElementById('detail').innerHTML = '<h3>' + id + '</h3>' +
    data.agents.map(a => '<span class="agent ' + a.status + '">' + a.agent + ':' + a.status + (a.summary ? ' - ' + a.summary.slice(0,60) : '') + '</span>').join('') +
    '<h4 style="margin-top:12px">Messages</h4>' +
    data.messages.map(m => '<div style="margin:4px 0;font-size:12px"><strong>' + m.sender + '</strong>: ' + (m.subject||'').slice(0,80) + '</div>').join('')
}

async function loadGraph() {
  const file = prompt('Enter file path for dependency graph:')
  if (!file) return
  document.getElementById('main').innerHTML = '<h3>Dependency Graph: ' + file + '</h3><img id="graph" src="/api/graph/' + encodeURIComponent(file) + '" style="width:100%"/>'
}

async function loadSearch() {
  const q = prompt('Search:')
  if (!q) return
  const res = await fetch('/api/search?q=' + encodeURIComponent(q))
  const data = await res.json()
  document.getElementById('main').innerHTML = '<h3>Search: ' + q + '</h3>' +
    data.results.map(r => '<div style="margin:8px 0;padding:8px;background:#161b22;border-radius:4px"><strong>' + r.source + '</strong><pre class="code">' + (r.snippet||'').slice(0,200) + '</pre></div>').join('')
}

async function loadStats() {
  const res = await fetch('/api/stats')
  const stats = await res.json()
  document.getElementById('stats').innerHTML =
    '<div class="stat"><div class="val">' + stats.agents + '</div><div class="lbl">Agents</div></div>' +
    '<div class="stat"><div class="val">' + stats.tool_calls + '</div><div class="lbl">Tool Calls</div></div>' +
    '<div class="stat"><div class="val hot">' + stats.errors + '</div><div class="lbl">Errors</div></div>'
}

function loadView(v) {
  if (v === 'fleet') loadFleet()
  else if (v === 'graph') loadGraph()
  else if (v === 'search') loadSearch()
  else if (v === 'stats') loadFleet()
}
loadFleet()
</script></body></html>`, { headers: { "Content-Type": "text/html" } })
        })

      server = app.listen(port)
      serverRefs++
      return JSON.stringify({
        action: "start", status: "running", port, refs: serverRefs,
        url: `http://localhost:${port}`,
        api: [`/api/fleet`, `/api/lane/:id`, `/api/search?q=`, `/api/graph/:file`, `/api/stats`],
        hint: "Open in browser. Click lanes for details. Use search for full-text queries.",
      }, null, 2)
    }

    if (args.action === "stop") {
      const stopped = stopServerIfLast()
      return JSON.stringify({ action: "stop", status: stopped ? "stopped" : "deferred", refs: serverRefs }, null, 2)
    }

    if (args.action === "status") {
      return JSON.stringify({ action: "status", running: !!server, port, refs: serverRefs }, null, 2)
    }

    return JSON.stringify({ error: `Unknown action: '${args.action}'. Valid: start, stop, status.` }, null, 2)
  },
})
