import { tool } from "@opencode-ai/plugin"
import { init } from "./db"

const LIFECYCLE = ["cartography", "plan", "review", "execution", "validation", "publication"]

function waveFor(agent: string): string {
  if (agent === "cartographer" || agent === "surveyor" || agent === "diff-historian" || agent === "module-grapher" || agent === "test-reader") return "cartography"
  if (agent === "architect" || agent.includes("architecture") || agent.includes("impact") || agent.includes("risk") || agent.includes("root-cause") || agent.includes("validation-designer")) return "plan"
  if (agent === "critic" || agent.includes("convergence") || agent.includes("coupling") || agent.includes("debuggability") || agent.includes("error-trace") || agent.includes("isolation") || agent.includes("reversibility") || agent.includes("surface-area")) return "review"
  if (agent === "surgeon" || agent === "scalpel" || agent === "vitals" || agent === "stress-test" || agent === "second-opinion" || agent === "tourniquet" || agent === "monitor" || agent === "handy-agent") return "execution"
  if (agent === "trial" || agent.includes("lab-rat") || agent.includes("control-group") || agent.includes("blind-spot") || agent.includes("fire-drill") || agent.includes("stopwatch") || agent.includes("type-guard") || agent.includes("sign-off") || agent.includes("adversary") || agent.includes("challenger") || agent.includes("enumerator") || agent.includes("poisoner") || agent.includes("saboteur") || agent.includes("first-responder") || agent === "triage" || agent === "scope" || agent === "quarantine" || agent === "autopsy" || agent === "discharge" || agent === "stress") return "validation"
  if (agent === "journalist" || agent === "scoop" || agent === "editor" || agent === "byline" || agent === "press" || agent === "retort" || agent === "headline") return "publication"
  return "other"
}

export default tool({
  description: "Fleet dashboard — SQL-powered. Shows all agents: pending, completed, failed, stale. Use lane_prefix or session_id to filter.",
  args: {
    quick: tool.schema.boolean().optional().describe("Quick mode — compact output."),
    lane_prefix: tool.schema.string().optional().describe("Only show lanes starting with this prefix."),
    hide_stale: tool.schema.boolean().optional().describe("Hide stale agents (>5min pending)."),
  },
  async execute(args, context) {
    const db = init(context.worktree)
    const now = Date.now()


    // ── Fast path: read from projection ──
    let fromProjection: any[] | undefined
    try {
      fromProjection = db.query(
        "SELECT * FROM task_board_projection WHERE instance_id = ?"
      ).all("default") as any[]
    } catch {
      fromProjection = undefined
    }

    if (fromProjection && fromProjection.length > 0) {
      const nowMs = Date.now()
      const fleet: any[] = []
      const waves: Record<string, number> = {}

      for (const r of fromProjection) {
        const wave = waveFor(r.assigned_agent || "")
        const startedAt = r.started_at ? Number(r.started_at) : 0
        const elapsed = startedAt ? Math.floor((nowMs - startedAt) / 1000) : 0
        const status = r.task_status || "unknown"
        const isPending = status === "pending"
        const stale = isPending && elapsed > 180

        if (args.hide_stale && (stale || status === "stale")) continue
        if (isPending) waves[wave] = (waves[wave] || 0) + 1

        fleet.push({
          agent: r.assigned_agent || r.task_id || "",
          lane: String(r.lane_id || "").slice(0, 12),
          wave,
          status,
          delegated_by: "",
          elapsed_s: elapsed,
          stale: isPending && stale,
          auto_completed: false,
        })
      }

      fleet.sort((a: any, b: any) => (a.status === "pending" ? -1 : 1) || b.elapsed_s - a.elapsed_s)

      const pending = fleet.filter((f: any) => f.status === "pending")
      const done = fleet.filter((f: any) => f.status === "completed")
      const failed = fleet.filter((f: any) => f.status === "failed" || f.status === "stale")
      const staleList = fleet.filter((f: any) => f.stale)

      const waveSummary = LIFECYCLE.map(w => {
        const count = waves[w] || 0
        const bar = count > 0 ? "█".repeat(Math.min(count, 12)) : "·"
        return `${w.padEnd(14)} ${bar} ${count}`
      }).join("\n")

      const quick = args.quick ?? false

      const result: any = {
        summary: `${pending.length} pending, ${done.length} done, ${failed.length} failed${staleList.length ? `, ${staleList.length} stale ⚠️` : ""}`,
        wave_summary: waveSummary,
        fleet: fleet.slice(0, 40).map((f: any) => ({
          agent: f.agent.padEnd(20),
          lane: f.lane.padEnd(12),
          wave: f.wave.padEnd(10),
          status: (f.status === "stale" ? "💀" : f.stale ? "🟡" : f.status === "pending" ? "🔵" : f.status === "completed" ? "✅" : "❌") + " " + f.status + (f.auto_completed ? " (auto)" : ""),
          by: f.delegated_by.padEnd(16),
          elapsed: `${f.elapsed_s}s`,
        })),
        total: fleet.length,
        shown: Math.min(fleet.length, 40),
      }

      if (!quick) {
        const laneGroups = new Map<string, any[]>()
        for (const f of fleet) {
          const existing = laneGroups.get(f.lane) || []
          existing.push(f)
          laneGroups.set(f.lane, existing)
        }
        if (laneGroups.size > 0) {
          result.lanes = [...laneGroups.entries()].slice(0, 20).map(([lane, agents]) => ({
            lane: lane.padEnd(12),
            agents: agents.map((a: any) => `${a.agent}(${a.status})`).join(" → "),
          }))
        }
      }

      if (staleList.length > 0) result.hint = `${staleList.length} agent(s) stale. Advance the lane to auto-complete them.`
      else if (pending.length === 0 && done.length > 0) result.hint = "All agents done. Advance lanes."
      else if (pending.length > 0) result.hint = `${pending.length} agent(s) running.`

      return JSON.stringify(result, null, 2)
    }
    // ── Fallback: full subquery dedup logic ──
    // ── Get latest status per lane+agent (deduplicated) ──
    let query = `
      SELECT lane_id, agent, status, delegated_by, delegated_at, completed_at,
             auto_completed, stale_timeout, advanced_by, task
      FROM lane_agents
      WHERE id IN (SELECT MAX(id) FROM lane_agents GROUP BY lane_id, agent)
    `
    const params: any[] = []
    if (args.lane_prefix) {
      query += ` AND lane_id LIKE ?`
      params.push(args.lane_prefix + "%")
    }
    query += ` ORDER BY delegated_at DESC`

    const rows = db.query(query).all(...params) as any[]

    if (rows.length === 0) {
      return JSON.stringify({
        summary: "0 agents in database. Announce agents first.",
        fleet: [],
        total: 0,
      }, null, 2)
    }

    // ── Build fleet ──
    const fleet: any[] = []
    const waves: Record<string, number> = {}
    const nowMs = Date.now()

    for (const r of rows) {
      const wave = waveFor(r.agent)
      const delegatedAt = r.delegated_at ? new Date(r.delegated_at).getTime() : 0
      const elapsed = delegatedAt ? Math.floor((nowMs - delegatedAt) / 1000) : 0
      const isPending = r.status === "pending"
      const isStaleStatus = r.status === "stale"
      const stale = isPending && elapsed > 180

      if (args.hide_stale && (stale || isStaleStatus)) continue
      if (isPending) waves[wave] = (waves[wave] || 0) + 1

      fleet.push({
        agent: r.agent,
        lane: String(r.lane_id || "").slice(0, 12),
        wave,
        status: r.status,
        delegated_by: r.delegated_by || "",
        elapsed_s: elapsed,
        stale: isPending && stale,
        auto_completed: !!r.auto_completed,
      })
    }

    fleet.sort((a, b) => (a.status === "pending" ? -1 : 1) || b.elapsed_s - a.elapsed_s)

    const pending = fleet.filter(f => f.status === "pending")
    const done = fleet.filter(f => f.status === "completed")
    const failed = fleet.filter(f => f.status === "failed" || f.status === "stale")
    const staleList = fleet.filter(f => f.stale)

    const waveSummary = LIFECYCLE.map(w => {
      const count = waves[w] || 0
      const bar = count > 0 ? "█".repeat(Math.min(count, 12)) : "·"
      return `${w.padEnd(14)} ${bar} ${count}`
    }).join("\n")

    const quick = args.quick ?? false

    const result: any = {
      summary: `${pending.length} pending, ${done.length} done, ${failed.length} failed${staleList.length ? `, ${staleList.length} stale ⚠️` : ""}`,
      wave_summary: waveSummary,
      fleet: fleet.slice(0, 40).map(f => ({
        agent: f.agent.padEnd(20),
        lane: f.lane.padEnd(12),
        wave: f.wave.padEnd(10),
        status: (f.status === "stale" ? "💀" : f.stale ? "🟡" : f.status === "pending" ? "🔵" : f.status === "completed" ? "✅" : "❌") + " " + f.status + (f.auto_completed ? " (auto)" : ""),
        by: f.delegated_by.padEnd(16),
        elapsed: `${f.elapsed_s}s`,
      })),
      total: fleet.length,
      shown: Math.min(fleet.length, 40),
    }

    if (!quick) {
      const laneGroups = new Map<string, any[]>()
      for (const f of fleet) {
        const existing = laneGroups.get(f.lane) || []
        existing.push(f)
        laneGroups.set(f.lane, existing)
      }
      if (laneGroups.size > 0) {
        result.lanes = [...laneGroups.entries()].slice(0, 20).map(([lane, agents]) => ({
          lane: lane.padEnd(12),
          agents: agents.map(a => `${a.agent}(${a.status})`).join(" → "),
        }))
      }
    }

    if (staleList.length > 0) result.hint = `${staleList.length} agent(s) stale. Advance the lane to auto-complete them.`
    else if (pending.length === 0 && done.length > 0) result.hint = "All agents done. Advance lanes."
    else if (pending.length > 0) result.hint = `${pending.length} agent(s) running.`

    return JSON.stringify(result, null, 2)
  },
})
