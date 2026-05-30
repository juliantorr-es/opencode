import { tool } from "@opencode-ai/plugin"
import { resolve } from "node:path"
import { existsSync, readdirSync, readFileSync } from "node:fs"

function resolvePath(worktree: string, p: string): string { return resolve(worktree, p) }

export default tool({
  description: "Fleet dashboard — running tasks, heartbeat phase timelines, artifact summaries, and alerts. Auto-scoped: secretary sees their subagents, orchestrator sees all lanes.",
  args: {
    scope: tool.schema.string().optional().describe("'lane' (only my session), 'all' (everything), or omit for auto-detect based on caller"),
  },
  async execute(args, context) {
    const sessionsBase = resolvePath(context.worktree, "docs/json/opencode/sessions")
    const coordPath = resolvePath(context.worktree, "docs/json/opencode/coordination/messages.v1.jsonl")
    const now = Date.now()

    // Determine scope: secretary = lane, orchestrator = all
    const maxAge = args.max_age_minutes ?? (context.agent === "secretary" ? 60 : 0)
    const isSecretary = context.agent === "secretary"
    const isOrchestrator = context.agent === "orchestrator"
    const scope = args.scope || (isSecretary ? "lane" : "all")

    // Read heartbeats grouped by session
    const sessions: Record<string, { agent: string; phases: any[]; artifacts: any }> = {}
    
    if (existsSync(sessionsBase)) {
      for (const dir of readdirSync(sessionsBase, { withFileTypes: true }).filter(d => d.isDirectory())) {
        const sid = dir.name
        if (scope === "lane" && sid !== context.sessionID) continue
        
        const hbPath = resolve(sessionsBase, sid, "analytics", "heartbeat.v1.jsonl")
        const artPath = resolve(sessionsBase, sid, "artifacts", `${sid}.v1.json`)

        // Read heartbeats
        const phases: any[] = []
        let agent = "?"
        if (existsSync(hbPath)) {
          try {
            for (const line of readFileSync(hbPath, "utf8").split("\n").filter(Boolean)) {
              try {
                const hb = JSON.parse(line)
                agent = hb.agent || agent
                phases.push({ tool: hb.tool, phase: hb.phase, detail: (hb.detail || "").slice(0, 80), at: hb.at || "" })
              } catch {}
            }
          } catch (_) {}
        }

        // Read artifact summary
        let artifacts: any = null
        if (existsSync(artPath)) {
          try {
            const art = JSON.parse(readFileSync(artPath, "utf8"))
            artifacts = {
              events: art.total_events || 0,
              tools: art.tools_used || {},
              files: (art.files_touched || []).length,
            }
          } catch {}
        }

        // Filter by age if maxAge is set
        let tooOld = false
        if (maxAge > 0 && phases.length > 0) {
          try {
            const firstAt = new Date(phases[0].at).getTime()
            tooOld = (Date.now() - firstAt) > maxAge * 60000
          } catch {}
        }
        if (!tooOld && (phases.length > 0 || artifacts)) {
          sessions[sid] = { agent, phases, artifacts }
        }
        }
      }
    }

    // Build fleet
    const fleet: any[] = []
    const alerts: any[] = []

    for (const [sid, data] of Object.entries(sessions)) {
      const phases = data.phases
      if (!phases.length) continue

      const last = phases[phases.length - 1]
      const firstAt = phases[0]?.at
      const lastAt = last?.at
      const elapsed = firstAt ? Math.floor((now - new Date(firstAt).getTime()) / 1000) : 0
      const isRunning = !["completed", "failed"].includes(last?.phase)
      const lastHbAgo = lastAt ? Math.floor((now - new Date(lastAt).getTime()) / 1000) : 999
      const stale = isRunning && lastHbAgo > 60

      if (stale) alerts.push({ severity: "warning", session: sid.slice(0, 16), agent: data.agent, message: `No heartbeat for ${lastHbAgo}s` })
      if (isRunning && elapsed > 120 && !stale) alerts.push({ severity: "info", session: sid.slice(0, 16), agent: data.agent, message: `Active for ${elapsed}s` })

      fleet.push({
        session: sid.slice(0, 16),
        agent: data.agent,
        status: isRunning ? "running" : last?.phase === "completed" ? "done" : last?.phase,
        current: isRunning ? `${last?.tool}:${last?.phase}` : "—",
        detail: last?.detail || "",
        elapsed_s: elapsed,
        stale,
        tool_calls: new Set(phases.map(p => p.tool)).size,
        artifacts: data.artifacts,
      })
    }

    // Sort: running first, then recent completions
    fleet.sort((a, b) => (a.status === "running" ? -1 : 1) || b.elapsed_s - a.elapsed_s)

    // Read coordination for lane groupings
    const lanes: Record<string, { secretaries: string[]; handoffs: number }> = {}
    if (existsSync(coordPath)) {
      try {
        for (const line of readFileSync(coordPath, "utf8").split("\n").filter(Boolean)) {
          try {
            const msg = JSON.parse(line)
            if (msg.kind === "handoff") {
              const body = typeof msg.body === "string" ? (() => { try { return JSON.parse(msg.body) } catch { return {} } })() : msg.body
              const laneId = body?.lane_id || "unknown"
              if (!lanes[laneId]) lanes[laneId] = { secretaries: [], handoffs: 0 }
              lanes[laneId].handoffs++
            }
            if (msg.kind === "delegation" && msg.agent === "secretary") {
              const body = typeof msg.body === "string" ? (() => { try { return JSON.parse(msg.body) } catch { return {} } })() : msg.body
              const laneId = body?.lane_id || msg.subject?.match(/Lane (\S+)/)?.[1] || "unknown"
              if (!lanes[laneId]) lanes[laneId] = { secretaries: [], handoffs: 0 }
              lanes[laneId].secretaries.push(msg.session_id?.slice(0, 16) || "?")
            }
          } catch {}
        }
      } catch (_) {}
    }

    // Counts
    const running = fleet.filter(f => f.status === "running")
    const done = fleet.filter(f => f.status === "done")
    const failed = fleet.filter(f => f.status === "failed")
    const staleList = fleet.filter(f => f.stale)

    // Build response based on scope
    const result: any = {
      summary: `${running.length} running, ${done.length} done, ${failed.length} failed${staleList.length ? `, ${staleList.length} stale` : ""}`,
      fleet,
      total: fleet.length,
      alerts,
    }

    if (isOrchestrator && Object.keys(lanes).length > 0) {
      result.lanes = Object.entries(lanes).map(([id, l]) => ({
        lane_id: id,
        secretaries: l.secretaries.length,
        handoffs: l.handoffs,
        status: l.handoffs > 0 ? "completed" : "running",
      }))
    }

    if (isSecretary && running.length === 0 && done.length > 0) {
      result.hint = "All your subagents are done. Time to verify and hand off to the orchestrator."
    } else if (isSecretary && staleList.length > 0) {
      result.hint = `${staleList.length} subagent(s) appear stalled. Consider respawning them.`
    } else if (isOrchestrator && staleList.length > 0) {
      result.hint = `${staleList.length} session(s) with no recent heartbeat. Check if secretaries are still alive.`
    }

    return JSON.stringify(result, null, 2)
  },
})
