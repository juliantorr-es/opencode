import { tool } from "@opencode-ai/plugin"
import { resolve } from "node:path"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"

function r(worktree: string, p: string): string { return resolve(worktree, p) }

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
  description: "Fleet dashboard — shows running agents, stale sessions, lane progress, and alerts. Defaults to last 30 minutes. Pure TypeScript, no binary dependency.",
  args: {
    max_age_minutes: tool.schema.number().optional().describe("Only show sessions from the last N minutes (default 30). 0 = all sessions."),
    quick: tool.schema.boolean().optional().describe("Quick mode — only show running/stale agents, skip coordination parsing."),
  },
  async execute(args, context) {
    const sessionsBase = r(context.worktree, "docs/json/opencode/sessions")
    const coordPath = r(context.worktree, "docs/json/opencode/coordination/messages.v1.jsonl")
    const now = Date.now()
    const maxAge = args.max_age_minutes ?? 30
    const quick = args.quick ?? false
    const isGM = context.agent === "general-man-agent" || context.agent === "orchestrator"

    // ── Quick coordination parse (last 100 lines only) ──
    const delegations: Record<string, { parent: string; agent: string }> = {}
    if (!quick && existsSync(coordPath)) {
      try {
        const content = readFileSync(coordPath, "utf8")
        const lines = content.split("\n").filter(Boolean)
        const recent = lines.slice(-200) // Only last 200 lines
        for (const line of recent) {
          try {
            const msg = JSON.parse(line)
            if (msg.kind === "delegation") {
              const body = typeof msg.body === "string" ? (() => { try { return JSON.parse(msg.body) } catch { return {} } })() : (msg.body || {})
              delegations[msg.session_id || body.session_id || "?"] = {
                parent: msg.sender,
                agent: msg.recipient || body.agent || "?",
              }
            }
          } catch {}
        }
      } catch (_) {}
    }

    // ── Read recent sessions only ──
    const fleet: any[] = []
    const alerts: any[] = []
    const waves: Record<string, number> = {}

    if (existsSync(sessionsBase)) {
      let dirs: string[] = []
      try { dirs = readdirSync(sessionsBase) } catch { return JSON.stringify({ error: "Cannot read sessions directory" }, null, 2) }

      for (const sid of dirs) {
        // Quick age check via directory mtime
        const hbPath = r(sessionsBase, sid, "analytics", "heartbeat.v1.jsonl")
        if (!existsSync(hbPath)) continue

        // Check directory modification time for quick filtering
        if (maxAge > 0) {
          try {
            const dirStat = statSync(r(sessionsBase, sid))
            const dirAge = (now - dirStat.mtimeMs) / 60000
            if (dirAge > maxAge * 2) continue // Skip obviously old dirs
          } catch { continue }
        }

        // Read last heartbeat only (fast)
        let lastHb: any = null
        let agent = "?"
        try {
          const content = readFileSync(hbPath, "utf8")
          const lines = content.split("\n").filter(Boolean)
          if (lines.length === 0) continue
          const lastLine = lines[lines.length - 1]!
          try { lastHb = JSON.parse(lastLine); agent = lastHb.agent || agent } catch { continue }
        } catch { continue }

        if (!lastHb) continue

        // Age filter on heartbeat timestamp
        const hbAge = (now - new Date(lastHb.at).getTime()) / 60000
        if (maxAge > 0 && hbAge > maxAge) continue

        const elapsed = lastHb.at ? Math.floor((now - new Date(lastHb.at).getTime()) / 1000) : 0
        const isRunning = lastHb.phase !== "completed" && lastHb.phase !== "failed"
        const stale = isRunning && hbAge > 3 // 3 minutes stale
        const wave = waveFor(agent)

        if (isRunning) waves[wave] = (waves[wave] || 0) + 1

        if (stale && isRunning) {
          alerts.push({ agent, session: sid.slice(0, 12), message: `Stale — no heartbeat for ${Math.floor(hbAge)}m. Last: ${lastHb.tool}:${lastHb.phase}` })
        }

        const parent = Object.entries(delegations).find(([k]) => k.includes(sid))?.[1]?.parent || null

        fleet.push({
          session: sid.slice(0, 12),
          agent,
          wave,
          status: isRunning ? "running" : lastHb.phase === "completed" ? "done" : lastHb.phase,
          current: isRunning ? `${lastHb.tool}:${lastHb.phase}` : "—",
          detail: (lastHb.detail || "").slice(0, 60),
          elapsed_s: elapsed,
          stale,
          parent,
        })
      }
    }

    fleet.sort((a, b) => (a.status === "running" ? -1 : 1) || b.elapsed_s - a.elapsed_s)

    // ── Build response ──
    const running = fleet.filter(f => f.status === "running")
    const done = fleet.filter(f => f.status === "done")
    const failed = fleet.filter(f => f.status === "failed")
    const staleList = fleet.filter(f => f.stale)

    const waveSummary = LIFECYCLE.map(w => {
      const count = waves[w] || 0
      const bar = count > 0 ? "█".repeat(Math.min(count, 12)) : "·"
      const label = w.padEnd(14)
      return `${label} ${bar} ${count}`
    }).join("\n")

    const result: any = {
      summary: `${running.length} running, ${done.length} done, ${failed.length} failed, ${fleet.length} total${staleList.length ? `, ${staleList.length} stale ⚠️` : ""}`,
      wave_summary: waveSummary,
      fleet: fleet.slice(0, 30).map(f => ({
        agent: f.agent.padEnd(16),
        wave: f.wave.padEnd(10),
        status: (f.stale ? "🟡" : f.status === "running" ? "🟢" : f.status === "done" ? "✅" : "❌") + " " + f.status,
        current: f.current,
        detail: f.detail,
        elapsed: `${f.elapsed_s}s`,
        parent: f.parent || "",
      })),
      total: fleet.length,
      shown: Math.min(fleet.length, 30),
    }

    if (alerts.length > 0) result.alerts = alerts.slice(0, 10)

    // Hints
    if (staleList.length > 0) {
      result.hint = `${staleList.length} agent(s) stale. Consider respawning if they're stuck.`
    } else if (running.length === 0 && done.length > 0) {
      result.hint = "All agents done. Review handoffs and move to next wave or close session."
    }

    return JSON.stringify(result, null, 2)
  },
})
