import { tool } from "@opencode-ai/plugin"
import { resolve } from "node:path"
import { existsSync, readFileSync } from "node:fs"

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
  description: "Fleet dashboard — reads the unified lane state file. Shows all agents: pending, completed, failed. Pure TypeScript, no binary dependency.",
  args: {
    quick: tool.schema.boolean().optional().describe("Quick mode — compact output."),
  },
  async execute(args, context) {
    const statePath = r(context.worktree, "docs/json/opencode/coordination/lane_state.v1.jsonl")
    const now = Date.now()

    if (!existsSync(statePath)) {
      return JSON.stringify({
        summary: "0 running, 0 done — no lane state yet. Announce agents via announce_lane or announce_leaf first.",
        fleet: [],
        total: 0,
      }, null, 2)
    }

    // ── Read unified state file ──
    const entries: any[] = []
    try {
      const content = readFileSync(statePath, "utf8")
      const lines = content.split("\n").filter(Boolean)
      for (const line of lines) {
        try { entries.push(JSON.parse(line)) } catch {}
      }
    } catch {
      return JSON.stringify({ error: "Cannot read lane state" }, null, 2)
    }

    if (entries.length === 0) {
      return JSON.stringify({
        summary: "0 entries in lane state.",
        fleet: [],
        total: 0,
      }, null, 2)
    }

    // ── Deduplicate: keep latest status per lane+agent ──
    const latest = new Map<string, any>()
    for (const e of entries) {
      const key = `${e.lane_id}::${e.agent}`
      latest.set(key, e) // last write wins
    }

    // ── Build fleet ──
    const fleet: any[] = []
    const waves: Record<string, number> = {}

    for (const [key, e] of latest) {
      const wave = waveFor(e.agent)
      const delegatedAt = e.delegated_at ? new Date(e.delegated_at).getTime() : 0
      const completedAt = e.completed_at ? new Date(e.completed_at).getTime() : 0
      const elapsed = delegatedAt ? Math.floor((now - delegatedAt) / 1000) : 0
      const isRunning = e.status === "pending"
      const stale = isRunning && elapsed > 180 // 3 minutes stale

      if (isRunning) waves[wave] = (waves[wave] || 0) + 1

      fleet.push({
        agent: e.agent,
        lane: String(e.lane_id || "").slice(0, 12),
        wave,
        status: e.status,
        delegated_by: e.delegated_by || "",
        elapsed_s: elapsed,
        stale: isRunning && stale,
        auto_completed: e.auto_completed || false,
      })
    }

    fleet.sort((a, b) => (a.status === "pending" ? -1 : 1) || b.elapsed_s - a.elapsed_s)

    const pending = fleet.filter(f => f.status === "pending")
    const done = fleet.filter(f => f.status === "completed")
    const failed = fleet.filter(f => f.status === "failed")
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
        status: (f.stale ? "🟡" : f.status === "pending" ? "🔵" : f.status === "completed" ? "✅" : "❌") + " " + f.status + (f.auto_completed ? " (auto)" : ""),
        by: f.delegated_by.padEnd(16),
        elapsed: `${f.elapsed_s}s`,
      })),
      total: fleet.length,
      shown: Math.min(fleet.length, 40),
    }

    if (!quick) {
      // Group by lane
      const laneGroups = new Map<string, any[]>()
      for (const f of fleet) {
        const existing = laneGroups.get(f.lane) || []
        existing.push(f)
        laneGroups.set(f.lane, existing)
      }
      if (laneGroups.size > 0) {
        result.lanes = [...laneGroups.entries()].map(([lane, agents]) => ({
          lane: lane.padEnd(12),
          agents: agents.map(a => `${a.agent}(${a.status})`).join(" → "),
        }))
      }
    }

    if (staleList.length > 0) {
      result.hint = `${staleList.length} agent(s) stale (>3min pending). Consider respawning if stuck.`
    } else if (pending.length === 0 && done.length > 0) {
      result.hint = "All agents done. Review handoffs and advance lanes."
    } else if (pending.length > 0) {
      result.hint = `${pending.length} agent(s) running. Check messages for handoffs before advancing.`
    }

    return JSON.stringify(result, null, 2)
  },
})
