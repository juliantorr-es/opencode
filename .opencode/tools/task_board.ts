import { tool } from "@opencode-ai/plugin"
import { resolve } from "node:path"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { spawnSync } from "node:child_process"

function r(worktree: string, p: string): string { return resolve(worktree, p) }

// jql-powered JSON query — faster than manual parsing for large files
function jqlQuery(worktree: string, filePath: string, query: string): any {
  const fullPath = r(worktree, filePath)
  if (!existsSync(fullPath)) return null
  const binaries = ["jql", "/opt/homebrew/bin/jql", "/usr/local/bin/jql"]
  for (const bin of binaries) {
    const result = spawnSync(bin, [query, fullPath], {
      encoding: "utf8", maxBuffer: 1024 * 1024 * 5, timeout: 15000,
    })
    if (!result.error && result.status === 0 && result.stdout?.trim()) {
      try { return JSON.parse(result.stdout.trim()) } catch { return null }
    }
  }
  return null
}

const LIFECYCLE = ["cartography", "plan", "review", "execution", "validation", "publication"]

function waveFor(agent: string): string {
  if (agent === "cartographer" || agent === "surveyor" || agent === "diff-historian" || agent === "module-grapher" || agent === "test-reader") return "cartography"
  if (agent === "architect" || agent.includes("architecture") || agent.includes("impact") || agent.includes("risk") || agent.includes("root-cause") || agent.includes("validation-designer")) return "plan"
  if (agent === "critic" || agent.includes("convergence") || agent.includes("coupling") || agent.includes("debuggability") || agent.includes("error-trace") || agent.includes("isolation") || agent.includes("reversibility") || agent.includes("surface-area")) return "review"
  if (agent === "surgeon" || agent === "scalpel" || agent === "vitals" || agent === "stress-test" || agent === "second-opinion" || agent === "tourniquet" || agent === "monitor" || agent === "handy-agent") return "execution"
  if (agent === "trial" || agent.includes("lab-rat") || agent.includes("control-group") || agent.includes("blind-spot") || agent.includes("fire-drill") || agent.includes("stopwatch") || agent.includes("type-guard") || agent.includes("sign-off") || agent.includes("adversary") || agent.includes("challenger") || agent.includes("enumerator") || agent.includes("poisoner") || agent.includes("saboteur") || agent.includes("first-responder") || agent === "triage" || agent === "scope" || agent === "quarantine" || agent === "autopsy" || agent === "discharge" || agent === "stress") return "validation"
  if (agent === "journalist" || agent === "scoop" || agent === "editor" || agent === "byline" || agent === "press" || agent === "retort" || agent === "headline") return "publication"
  return "?"
}

function statusEmoji(status: string): string {
  if (status === "running") return "🟢"
  if (status === "done") return "✅"
  if (status === "failed") return "❌"
  if (status === "stale") return "🟡"
  return "⚪"
}

export default tool({
  description: "Fleet dashboard — live view of all lanes, their lifecycle waves, agent status, and alerts. Groups sessions by lane. Shows what each agent is doing right now. Highlights stalled agents and suggests next actions.",
  args: {
    max_age_minutes: tool.schema.number().optional().describe("Only show sessions active within the last N minutes. 0 = show all (default)."),
  },
  async execute(args, context) {
    const sessionsBase = r(context.worktree, "docs/json/opencode/sessions")
    const coordPath = r(context.worktree, "docs/json/opencode/coordination/messages.v1.jsonl")
    const now = Date.now()
    const maxAge = args.max_age_minutes ?? 0
    const isGM = context.agent === "general-man-agent" || context.agent === "orchestrator"

    // ── Parse coordination messages (jql-optimized for large files) ──
    const delegations: Record<string, { parent: string; agent: string; task: string; wave: string }> = {}
    const handoffs: Record<string, { sender: string; body: any }> = {}
    if (existsSync(coordPath)) {
      // Try jql first for speed
      const jqlDelegations = jqlQuery(context.worktree, "docs/json/opencode/coordination/messages.v1.jsonl", "[.[] | select(.kind==\"delegation\")]")
      const jqlHandoffs = jqlQuery(context.worktree, "docs/json/opencode/coordination/messages.v1.jsonl", "[.[] | select(.kind==\"handoff\")]")
      
      if (jqlDelegations && Array.isArray(jqlDelegations)) {
        for (const msg of jqlDelegations) {
          const body = typeof msg.body === "string" ? (() => { try { return JSON.parse(msg.body) } catch { return {} } })() : (msg.body || {})
          const sessionId = msg.session_id || body.session_id || "?"
          delegations[sessionId] = {
            parent: msg.sender, agent: msg.recipient || body.agent || "?",
            task: (msg.subject || body.task || "").slice(0, 60),
            wave: waveFor(msg.recipient || body.agent || "?"),
          }
        }
      }
      if (jqlHandoffs && Array.isArray(jqlHandoffs)) {
        for (const msg of jqlHandoffs) {
          const body = typeof msg.body === "string" ? (() => { try { return JSON.parse(msg.body) } catch { return {} } })() : (msg.body || {})
          handoffs[msg.sender] = { sender: msg.sender, body }
        }
      }
      
      // Fallback: manual parse if jql failed
      if (!jqlDelegations || !jqlHandoffs) {
        try {
          for (const line of readFileSync(coordPath, "utf8").split("\n").filter(Boolean)) {
            try {
              const msg = JSON.parse(line)
              if (msg.kind === "delegation") {
                const body = typeof msg.body === "string" ? (() => { try { return JSON.parse(msg.body) } catch { return {} } })() : (msg.body || {})
                const sessionId = msg.session_id || body.session_id || "?"
                if (!delegations[sessionId]) {
                  delegations[sessionId] = {
                    parent: msg.sender, agent: msg.recipient || body.agent || "?",
                    task: (msg.subject || body.task || "").slice(0, 60),
                    wave: waveFor(msg.recipient || body.agent || "?"),
                  }
                }
              }
              if (msg.kind === "handoff") {
                const body = typeof msg.body === "string" ? (() => { try { return JSON.parse(msg.body) } catch { return {} } })() : (msg.body || {})
                if (!handoffs[msg.sender]) handoffs[msg.sender] = { sender: msg.sender, body }
              }
            } catch {}
          }
        } catch (_) {}
      }
    }

    // ── Read sessions ────────────────────────────────────
    const sessions: Record<string, { id: string; agent: string; phases: any[]; artifacts: any }> = {}
    if (existsSync(sessionsBase)) {
      for (const dir of readdirSync(sessionsBase, { withFileTypes: true }).filter(d => d.isDirectory())) {
        const sid = dir.name
        const hbPath = r(sessionsBase, sid, "analytics", "heartbeat.v1.jsonl")
        const artPath = r(sessionsBase, sid, "artifacts", `${sid}.v1.json`)

        const phases: any[] = []
        let agent = "?"
        if (existsSync(hbPath)) {
          try {
            for (const line of readFileSync(hbPath, "utf8").split("\n").filter(Boolean)) {
              try {
                const hb = JSON.parse(line)
                agent = hb.agent || agent
                phases.push({ tool: hb.tool, phase: hb.phase, detail: (hb.detail || "").slice(0, 100), at: hb.at || "" })
              } catch {}
            }
          } catch (_) {}
        }

        let artifacts: any = null
        if (existsSync(artPath)) {
          try {
            const art = JSON.parse(readFileSync(artPath, "utf8"))
            artifacts = { events: art.total_events || 0, files: (art.files_touched || []).length }
          } catch {}
        }

        const firstAt = phases[0]?.at
        let tooOld = false
        if (maxAge > 0 && firstAt) {
          try { tooOld = (now - new Date(firstAt).getTime()) > maxAge * 60000 } catch {}
        }
        if (!tooOld && (phases.length > 0 || artifacts)) {
          sessions[sid] = { id: sid.slice(0, 16), agent, phases, artifacts }
        }
      }
    }

    // ── Build fleet ──────────────────────────────────────
    const fleet: any[] = []
    const laneMap: Record<string, any[]> = {}
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
      const wave = waveFor(data.agent)

      // Find parent delegation
      const parentSid = Object.entries(delegations).find(([k, v]) => k.includes(sid))?.[0]
      const parent = parentSid ? delegations[parentSid]?.parent : null

      if (stale && isRunning) {
        alerts.push({ severity: "warning", agent: data.agent, session: sid.slice(0, 12), message: `Stale — no heartbeat for ${lastHbAgo}s. Last seen: ${last?.tool}:${last?.phase}` })
      }

      const entry = {
        session: sid.slice(0, 12),
        agent: data.agent,
        wave,
        status: isRunning ? "running" : last?.phase === "completed" ? "done" : last?.phase,
        current: isRunning ? `${last?.tool}:${last?.phase}` : "—",
        detail: last?.detail || "",
        elapsed_s: elapsed,
        stale,
        tool_calls: new Set(phases.map(p => p.tool)).size,
        parent,
        handoff: !!handoffs[data.agent],
        artifacts: data.artifacts,
      }

      fleet.push(entry)

      // Group by lane (parent delegation or standalone)
      const laneKey = parent || data.agent
      if (!laneMap[laneKey]) laneMap[laneKey] = []
      laneMap[laneKey].push(entry)
    }

    fleet.sort((a, b) => (a.status === "running" ? -1 : 1) || b.elapsed_s - a.elapsed_s)

    // ── Build response ───────────────────────────────────
    const running = fleet.filter(f => f.status === "running")
    const done = fleet.filter(f => f.status === "done")
    const failed = fleet.filter(f => f.status === "failed")
    const staleList = fleet.filter(f => f.stale)
    const waves: Record<string, number> = {}
    for (const f of running) { waves[f.wave] = (waves[f.wave] || 0) + 1 }

    // Wave summary
    const waveSummary = LIFECYCLE.map(w => {
      const count = waves[w] || 0
      const bar = count > 0 ? "█".repeat(Math.min(count, 10)) : "·"
      return `${w}: ${bar} ${count}`
    }).join("\n")

    const result: any = {
      summary: `${running.length} running, ${done.length} done, ${failed.length} failed${staleList.length ? `, ${staleList.length} stale` : ""}`,
      wave_summary: waveSummary,
      fleet: fleet.map(f => ({
        agent: f.agent.padEnd(18),
        wave: f.wave.padEnd(10),
        status: statusEmoji(f.status) + " " + f.status,
        current: f.current,
        detail: f.detail.slice(0, 60),
        elapsed: `${f.elapsed_s}s`,
        tools: f.tool_calls,
        stale: f.stale ? "⚠️" : "",
      })),
      total: fleet.length,
      alerts,
    }

    // Lane groups (GM only)
    if (isGM && Object.keys(laneMap).length > 0) {
      result.lanes = Object.entries(laneMap).map(([key, entries]) => {
        const agents = entries.map(e => e.agent).join(", ")
        const wave = entries[0]?.wave || "?"
        const allDone = entries.every(e => e.status === "done")
        const anyStale = entries.some(e => e.stale)
        return {
          lane: key.padEnd(20),
          agents,
          wave,
          status: allDone ? "✅ done" : anyStale ? "🟡 stalled" : "🟢 running",
        }
      })
    }

    // Hints
    if (staleList.length > 0) {
      result.hint = `${staleList.length} agent(s) stale — no heartbeat for >180s. Check if they're stuck in a long tool call or need respawning.`
    } else if (running.length === 0 && done.length > 0) {
      result.hint = "All agents done. Time to review handoffs and move to the next wave or close the session."
    } else if (isGM && running.length > 0) {
      const nextWave = LIFECYCLE.find(w => !waves[w])
      if (nextWave) result.hint = `Wave '${nextWave}' has no running agents. Consider launching the next wave.`
    }

    return JSON.stringify(result, null, 2)
  },
})
