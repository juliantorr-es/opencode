import { tool } from "@opencode-ai/plugin"
import { resolve } from "node:path"
import { existsSync, readdirSync, readFileSync } from "node:fs"

function resolvePath(worktree: string, p: string): string { return resolve(worktree, p) }

export default tool({
  description: "Fleet dashboard — running tasks, heartbeat phase timelines, artifact summaries, and alerts. Auto-scoped: lifecycle agents see their own lane, GM sees all lanes.",
  args: {
    scope: tool.schema.string().optional().describe("'lane' (only my session), 'all' (everything), or omit for auto-detect based on caller"),
    max_age_minutes: tool.schema.number().optional().describe("Only show sessions active within the last N minutes. 0 = show all (default)."),
  },
  async execute(args, context) {
    const sessionsBase = resolvePath(context.worktree, "docs/json/opencode/sessions")
    const coordPath = resolvePath(context.worktree, "docs/json/opencode/coordination/messages.v1.jsonl")
    const now = Date.now()

    // Determine scope: GM sees all, lifecycle agents see their own session
    const isGM = context.agent === "general-man-agent" || context.agent === "orchestrator"
    const scope = args.scope || (isGM ? "all" : "lane")
    const maxAge = args.max_age_minutes ?? 0

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
      const stale = isRunning && lastHbAgo > 180

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
              if (!lanes[laneId]) lanes[laneId] = { agents: [], handoffs: 0 }
              lanes[laneId].handoffs++
            }
            if (msg.kind === "delegation") {
              const body = typeof msg.body === "string" ? (() => { try { return JSON.parse(msg.body) } catch { return {} } })() : msg.body
              const laneId = body?.lane_id || msg.subject?.match(/Lane (\S+)/)?.[1] || "unknown"
              if (!lanes[laneId]) lanes[laneId] = { agents: [], handoffs: 0 }
              lanes[laneId].agents.push({ agent: msg.recipient, session: msg.session_id?.slice(0, 16) || "?" })
            }
          } catch {}
        }
      } catch (_) {}
    }

    // Auto-expire delegated entries that never got a heartbeat
    // BUT: if heartbeats exist, the agent IS running — upgrade to deployed regardless of coordination
    const deadDelegations: string[] = []
    for (const [sid, data] of Object.entries(sessions)) {
      if (data.phases.length === 0 && data.agent !== "?") {
        // No heartbeats — check if this was a delegation that was never acted on
        try {
          const coordLines = existsSync(coordPath) ? readFileSync(coordPath, "utf8").split("\n").filter(Boolean).slice(-200) : []
          for (const line of coordLines) {
            try {
              const msg = JSON.parse(line)
              if (msg.kind === "delegation" && msg.session_id === sid) {
                const age = (now - new Date(msg.sent_at).getTime()) / 1000
                if (age > 60) deadDelegations.push(sid)
                break
              }
            } catch {}
          }
        } catch {}
      }
      // Heartbeats exist → agent is running. Coordination status is irrelevant.
    }

    // Counts
    const running = fleet.filter(f => f.status === "running")
    const done = fleet.filter(f => f.status === "done")
    const failed = fleet.filter(f => f.status === "failed")
    const staleList = fleet.filter(f => f.stale)
    const abandoned = fleet.filter(f => deadDelegations.includes(f.session))

    // Remove abandoned from active fleet
    const activeFleet = fleet.filter(f => !deadDelegations.includes(f.session))

    // Build response based on scope
    const result: any = {
      summary: `${running.length} running, ${done.length} done, ${failed.length} failed${staleList.length ? `, ${staleList.length} stale` : ""}${abandoned.length ? `, ${abandoned.length} abandoned` : ""}`,
      fleet: activeFleet,
      total: activeFleet.length,
      alerts,
    }

    // Alert for dead delegations
    for (const sid of deadDelegations) {
      alerts.push({ severity: "info", session: sid.slice(0, 16), message: "Delegation abandoned — task() was never called." })
    }

    if (isGM && Object.keys(lanes).length > 0) {
      result.lanes = Object.entries(lanes).map(([id, l]) => ({
        lane_id: id,
        agents: l.agents.length,
        handoffs: l.handoffs,
        status: l.handoffs > 0 ? "completed" : "running",
      }))
    }

    if (staleList.length > 0) {
      result.hint = `${staleList.length} session(s) with no recent heartbeat. Check if agents are still alive. Consider respawning.`
    }

    return JSON.stringify(result, null, 2)
  },
})
