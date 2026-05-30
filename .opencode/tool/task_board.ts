import { tool } from "@opencode-ai/plugin"
import { resolve } from "node:path"
import { existsSync, readdirSync, readFileSync } from "node:fs"

function resolvePath(worktree: string, p: string): string { return resolve(worktree, p) }

export default tool({
  description: "Show the task operations dashboard: fleet status with heartbeat phase timelines, running tasks, completed tasks, blocked tasks, and alerts.",
  args: {
    wave: tool.schema.string().optional().describe("Filter by wave name"),
    status: tool.schema.string().optional().describe("Filter by status: running | completed | failed | blocked"),
    session_id: tool.schema.string().optional().describe("Filter by session ID"),
  },
  async execute(args, context) {
    const coordPath = resolvePath(context.worktree, "docs/json/opencode/coordination/messages.v1.jsonl")
    const knowledgeBase = resolvePath(context.worktree, "docs/json/opencode/knowledge/sessions")
    const sessionsBase = resolvePath(context.worktree, "docs/json/opencode/sessions")

    // Read coordination messages
    const messages: any[] = []
    if (existsSync(coordPath)) {
      try {
        readFileSync(coordPath, "utf8").split("\n").filter(Boolean).forEach(l => {
          try { const m = JSON.parse(l); if (m.kind === "task_status" || m.kind === "handoff" || m.kind === "heartbeat") messages.push(m) } catch {}
        })
      } catch (_) {}
    }

    // Build tasks from coordination
    const tasks: Record<string, any> = {}
    for (const msg of messages) {
      if (args.wave && msg.wave !== args.wave) continue
      if (args.session_id && msg.session_id !== args.session_id) continue

      const id = msg.task_id || msg.message_id || `msg_${Math.random().toString(36).slice(2, 8)}`
      if (!tasks[id]) tasks[id] = { task_id: id, source: "coordination", agent: msg.subagent_type || msg.sender || "?", description: msg.subject || "", wave: msg.wave, events: [] }
      tasks[id].events.push({ status: msg.task_status || msg.status || msg.kind || "unknown", at: msg.sent_at, detail: msg.body?.slice(0, 120) || "" })
    }

    // Read heartbeats for fleet status
    const heartbeats: Record<string, any> = {}
    if (existsSync(sessionsBase)) {
      try {
        for (const dir of readdirSync(sessionsBase, { withFileTypes: true }).filter(d => d.isDirectory())) {
          const hbPath = resolve(sessionsBase, dir.name, "analytics", "heartbeat.v1.jsonl")
          if (!existsSync(hbPath)) continue
          if (args.session_id && dir.name !== args.session_id) continue

          try {
            readFileSync(hbPath, "utf8").split("\n").filter(Boolean).forEach(l => {
              try {
                const hb = JSON.parse(l)
                const key = `${hb.session_id?.slice(0, 8) || "?"}|${hb.agent || "?"}`
                if (!heartbeats[key]) heartbeats[key] = { session_id: hb.session_id, agent: hb.agent, phases: [] as any[] }
                heartbeats[key].phases.push({ tool: hb.tool, phase: hb.phase, detail: (hb.detail || "").slice(0, 100), at: hb.at || "" })
              } catch {}
            })
          } catch (_) {}
        }
      } catch (_) {}
    }

    // Build fleet from heartbeats
    const fleet: any[] = []
    const alerts: any[] = []
    const now = Date.now()
    for (const [, hb] of Object.entries(heartbeats) as [string, any][]) {
      const phases = hb.phases
      if (!phases.length) continue
      const last = phases[phases.length - 1]
      const firstAt = phases[0]?.at
      const lastAt = last?.at
      const elapsed = firstAt ? Math.floor((now - new Date(firstAt).getTime()) / 1000) : 0
      const isRunning = !["completed", "failed"].includes(last?.phase)
      const lastHbAgo = lastAt ? Math.floor((now - new Date(lastAt).getTime()) / 1000) : 999
      const stale = isRunning && lastHbAgo > 60

      if (stale) alerts.push({ severity: "warning", session: hb.session_id?.slice(0, 16), agent: hb.agent, message: `No heartbeat for ${lastHbAgo}s` })
      if (isRunning && elapsed > 120) alerts.push({ severity: "info", session: hb.session_id?.slice(0, 16), agent: hb.agent, message: `Running for ${elapsed}s` })

      fleet.push({
        session: hb.session_id?.slice(0, 16),
        agent: hb.agent,
        status: isRunning ? "running" : last?.phase,
        current: `${last?.tool}:${last?.phase}`,
        detail: last?.detail || "",
        elapsed_s: elapsed,
        stale,
        tool_count: new Set(phases.map((p: any) => p.tool)).size,
      })
    }
    fleet.sort((a, b) => (a.status === "running" ? -1 : 1) || b.elapsed_s - a.elapsed_s)

    // Build dashboard from tasks
    const dashboard: any[] = []
    for (const [, task] of Object.entries(tasks) as [string, any][]) {
      const events = task.events || []
      const latest = events.length ? events[events.length - 1].status : "unknown"
      if (args.status && latest !== args.status) continue

      let elapsed = 0
      let stale = false
      if (events.length) {
        try {
          const first = new Date(events[0].at).getTime()
          const last = new Date(events[events.length - 1].at).getTime()
          elapsed = Math.floor((now - first) / 1000)
          if (latest === "running" && (now - last) > 30000) stale = true
        } catch {}
      }

      dashboard.push({
        task_id: task.task_id?.slice(0, 16),
        source: task.source, agent: task.agent,
        description: task.description, wave: task.wave,
        status: latest, stale, elapsed_seconds: elapsed,
        event_count: events.length,
        timeline: events.slice(-10).map((e: any) => ({ status: e.status, at: (e.at || "").slice(0, 19), detail: (e.detail || "").slice(0, 80) })),
      })
    }
    dashboard.sort((a, b) => ({ running: 0, blocked: 1, completed: 2, failed: 3 }[a.status] ?? 4) - ({ running: 0, blocked: 1, completed: 2, failed: 3 }[b.status] ?? 4))

    const counts: Record<string, number> = {}
    for (const t of dashboard) counts[t.status] = (counts[t.status] || 0) + 1
    const summary = Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(" | ") || "no tasks"

    return JSON.stringify({
      dashboard, total: dashboard.length,
      fleet, fleet_total: fleet.length,
      alerts,
      summary,
      hint: "Use wave=<name>, status=<running|completed|failed|blocked>, or session_id=<id> to filter.",
    }, null, 2)
  },
})
