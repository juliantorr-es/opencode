import { tool } from "@opencode-ai/plugin"
import { resolve } from "node:path"
import { existsSync, readFileSync } from "node:fs"

function resolvePath(worktree: string, p: string): string {
  return resolve(worktree, p)
}

export default tool({
  description: "Return the top-N actionable roadmap items whose dependencies are all met. The 'what do I work on next?' query.",
  args: {
    limit: tool.schema.number().optional().describe("Max items (default 5)"),
    phase: tool.schema.string().optional().describe("Filter to phase"),
    show_blocked: tool.schema.boolean().optional().describe("Include blocked items in results with their blockers"),
  },
  async execute(args, context) {
    const activePath = resolvePath(context.worktree, "docs/json/roadmaps/active.v1.json")
    if (!existsSync(activePath)) {
      return JSON.stringify({ error: "No active roadmap. Run roadmap_init first." }, null, 2)
    }

    const active = JSON.parse(readFileSync(activePath, "utf8"))
    const items: Record<string, any> = {}
    for (const item of active.items || []) items[item.id] = item

    const completedIds = new Set(Object.entries(items).filter(([, i]) => (i as any).status === "completed" || (i as any).completion_pct >= 100).map(([id]) => id))
    const deprecatedIds = new Set(Object.entries(items).filter(([, i]) => (i as any).status === "deprecated").map(([id]) => id))

    const effortOrder: Record<string, number> = { low: 0, moderate: 1, high: 2 }
    const ready: any[] = []
    const inProgress: any[] = []
    const blocked: any[] = []
    let blockedCount = 0

    for (const [id, item] of Object.entries(items) as [string, any][]) {
      if (completedIds.has(id) || deprecatedIds.has(id)) continue
      if (args.phase && item.phase !== args.phase) continue

      const deps: string[] = item.depends_on || []
      const unmet = deps.filter((d: string) => !completedIds.has(d))
      const entry = {
        id, title: item.title, phase: item.phase,
        phase_name: (active.phases || {})[item.phase] || "",
        priority: item.priority, status: item.status,
        completion_pct: item.completion_pct || 0,
        effort: item.effort,
        context_summary: (item.context_summary || "").slice(0, 300),
        next_step: item.next_step || "",
        depends_on: deps, unmet_dependencies: unmet,
        session_count: (item.sessions || []).length,
      }

      if (item.status === "in_progress") inProgress.push(entry)
      else if (unmet.length) {
        blockedCount++
        if (args.show_blocked) blocked.push(entry)
      }
      else ready.push(entry)
    }

    ready.sort((a, b) => (a.priority || 999) - (b.priority || 999) || effortOrder[a.effort || "moderate"] - effortOrder[b.effort || "moderate"])
    inProgress.sort((a, b) => (a.priority || 999) - (b.priority || 999))

    const nextUp = [...inProgress, ...ready].slice(0, args.limit ?? 5)
    const recommendation = inProgress[0]
      ? `Continue: ${inProgress[0].id} — ${inProgress[0].title.slice(0, 80)} (${inProgress[0].completion_pct}% done)`
      : ready[0] ? `Start: ${ready[0].id} — ${ready[0].title.slice(0, 80)}` : null

    const result: any = {
      next: nextUp, total_ready: ready.length, total_in_progress: inProgress.length,
      total_blocked: blockedCount, total_completed: completedIds.size,
      recommendation,
      hint: "Use roadmap_init(show_all=true) to see full picture.",
    }
    if (args.show_blocked) result.blocked = blocked

    return JSON.stringify(result, null, 2)
  },
})
