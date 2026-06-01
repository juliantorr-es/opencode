import { tool } from "@opencode-ai/plugin"
import { init, fileKnowledge } from "./db"

export default tool({
  description: "Generate Mermaid diagrams from the knowledge graph. Dependency graphs, lane timelines, agent flowcharts, architecture maps. Returns raw Mermaid syntax — paste into mermaid.live or any Mermaid renderer.",
  args: {
    action: tool.schema.string().describe("'deps' for dependency graph | 'lanes' for lane timeline | 'agents' for agent flow | 'hotspots' for error heatmap | 'architecture' for system overview"),
    file_path: tool.schema.string().optional().describe("Center file for dependency graph."),
    lane_id: tool.schema.string().optional().describe("Lane ID for timeline."),
    depth: tool.schema.number().optional().describe("Graph depth (default 2)."),
    theme: tool.schema.string().optional().describe("'default' | 'dark' | 'forest' | 'neutral' (default 'dark')."),
  },
  async execute(args, context) {
    const db = init(context.worktree)
    const theme = args.theme ?? "dark"
    let mermaid = ""

    if (args.action === "deps") {
      const center = args.file_path
      if (!center) return JSON.stringify({ error: "file_path required" }, null, 2)
      const maxDepth = args.depth ?? 2
      
      const visited = new Set<string>()
      const edges: { from: string; to: string }[] = []
      const queue: { file: string; depth: number }[] = [{ file: center, depth: 0 }]
      
      while (queue.length > 0) {
        const { file, depth } = queue.shift()!
        if (depth >= maxDepth || visited.has(file)) continue
        visited.add(file)
        
        const deps = db.query(`SELECT to_file FROM dependencies WHERE from_file = ? LIMIT 15`).all(file) as any[]
        for (const d of deps) {
          edges.push({ from: file, to: d.to_file })
          if (!visited.has(d.to_file)) queue.push({ file: d.to_file, depth: depth + 1 })
        }
      }
      
      // Build Mermaid graph
      const nodeIds = new Map<string, string>()
      let id = 0
      const shortName = (p: string) => p.split("/").pop()?.replace(/\.[^.]+$/, "") || p
      
      mermaid = `graph TD\n`
      for (const f of visited) {
        const nid = `N${id++}`
        nodeIds.set(f, nid)
        const label = shortName(f).replace(/-/g, "_")
        // Color by hotspot status
        const hotspot = db.query(`SELECT type_errors, test_failures FROM error_hotspots WHERE file_path = ?`).get(f) as any
        const style = hotspot && (hotspot.type_errors > 0 || hotspot.test_failures > 0)
          ? `:::hot` : ""
        mermaid += `  ${nid}["${label}"]${style}\n`
      }
      for (const e of edges) {
        const from = nodeIds.get(e.from)
        const to = nodeIds.get(e.to)
        if (from && to) mermaid += `  ${from} --> ${to}\n`
      }
      mermaid += `  classDef hot fill:#f96,stroke:#333,stroke-width:2px\n`
    }

    if (args.action === "lanes") {
      const rows = db.query(`SELECT lane_id, agent, status, delegated_at, completed_at FROM lane_agents WHERE id IN (SELECT MAX(id) FROM lane_agents GROUP BY lane_id, agent) ORDER BY delegated_at LIMIT 40`).all() as any[]
      
      mermaid = `gantt\n  title Lane Timeline\n  dateFormat HH:MM:SS\n  axisFormat %H:%M\n`
      const lanes = new Map<string, any[]>()
      for (const r of rows) {
        const l = lanes.get(r.lane_id) || []
        l.push(r)
        lanes.set(r.lane_id, l)
      }
      for (const [lane, agents] of lanes) {
        mermaid += `  section ${lane.slice(0, 12)}\n`
        for (const a of agents) {
          const start = a.delegated_at?.slice(11, 19) || "00:00:00"
          const end = a.completed_at?.slice(11, 19) || start
          const status = a.status === "completed" ? "done" : a.status === "stale" ? "crit" : "active"
          mermaid += `  ${a.agent} :${status}, ${start}, ${end}\n`
        }
      }
    }

    if (args.action === "agents") {
      const rows = db.query(`SELECT lane_id, agent, status FROM lane_agents WHERE id IN (SELECT MAX(id) FROM lane_agents GROUP BY lane_id, agent) ORDER BY lane_id LIMIT 30`).all() as any[]
      
      mermaid = `flowchart LR\n`
      let prevLane = ""
      let prevAgent = ""
      for (const r of rows) {
        if (r.lane_id !== prevLane) {
          mermaid += `  subgraph ${r.lane_id.slice(0, 8)}\n`
          prevLane = r.lane_id
        }
        const nodeId = `${r.lane_id.slice(0,4)}_${r.agent.replace(/-/g,"_")}`
        mermaid += `    ${nodeId}["${r.agent}"]\n`
        if (prevAgent) mermaid += `    ${prevAgent} --> ${nodeId}\n`
        prevAgent = nodeId
      }
      mermaid += `  end\n`
    }

    if (args.action === "hotspots") {
      const hotspots = db.query(`SELECT * FROM error_hotspots ORDER BY (type_errors + test_failures) DESC LIMIT 15`).all() as any[]
      
      mermaid = `pie title Error Hotspots\n`
      for (const h of hotspots) {
        const label = h.file_path.split("/").pop()?.replace(/\.[^.]+$/, "") || h.file_path
        mermaid += `  "${label}" : ${h.type_errors + h.test_failures}\n`
      }
    }

    if (args.action === "architecture") {
      // System overview: plugin → db → tools → agents
      mermaid = `flowchart TB
  subgraph Plugin["⚡ Plugin Hooks"]
    CE["Context Engine"]
    AJ["Auto-Journal"]
    LD["Loop Detection"]
    PR["Phoenix Recovery"]
  end
  subgraph DB["💾 SQLite Database"]
    LA["lane_agents"]
    MSG["messages"]
    JRN["journal"]
    HB["heartbeats"]
    FTS["🔎 FTS5 Search"]
    KG["📊 Knowledge Graph"]
  end
  subgraph Tools["🔧 Tools"]
    AL["announce_lane"]
    ALF["announce_leaf"]
    LH["leaf_handoff"]
    PING["ping"]
    TB["task_board"]
    SJ["session_journal"]
    DA["deep_analyze"]
    DBQ["db_query"]
    LLM["local_llm"]
    DASH["dashboard"]
  end
  subgraph Agents["🤖 Agents"]
    GM["general-man-agent"]
    CG["cartographer"]
    AR["architect"]
    CR["critic"]
    SG["surgeon"]
    TR["trial"]
    JN["journalist"]
  end
  GM --> AL
  GM --> TB
  AL --> CG
  AR --> ALF
  SG --> ALF
  CE --> KG
  AJ --> JRN
  AJ --> HB
  LD --> HB
  PR --> DB
  DA --> KG
  DBQ --> FTS
  LLM --> CE
  DASH --> DB
  LH --> MSG
  PING --> MSG
`
    }

    return JSON.stringify({
      action: args.action,
      mermaid,
      hint: "Copy the mermaid field and paste into mermaid.live or any Mermaid renderer.",
      render_url: `https://mermaid.live/edit#pako:${Buffer.from(mermaid).toString("base64")}`,
    }, null, 2)
  },
})
