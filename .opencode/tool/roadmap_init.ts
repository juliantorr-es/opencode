import { tool } from "@opencode-ai/plugin"
import { resolve } from "node:path"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"

function resolvePath(worktree: string, p: string): string {
  return resolve(worktree, p)
}

function readJson(path: string): any {
  try { return JSON.parse(readFileSync(path, "utf8")) } catch { return null }
}

export default tool({
  description: "Inject the active roadmap into orchestrator context at session start. Returns only actionable items.",
  args: {
    show_all: tool.schema.boolean().optional().describe("Include completed and blocked items too"),
    phase: tool.schema.string().optional().describe("Filter to a specific phase"),
  },
  async execute(args, context) {
    const blueprintPath = resolvePath(context.worktree, "docs/json/roadmaps/opencode-desktop-phase3-roadmap.v1.json")
    const activePath = resolvePath(context.worktree, "docs/json/roadmaps/active.v1.json")
    const progressPath = resolvePath(context.worktree, "docs/json/roadmaps/progress.v1.jsonl")

    let blueprint = readJson(blueprintPath)
    if (!blueprint) {
      blueprint = readJson(activePath)
    }
    if (!blueprint) {
      return JSON.stringify({ error: "No roadmap artifacts found. Run propose_plan or create blueprint first.", blueprint_path: blueprintPath, active_path: activePath }, null, 2)
    }

    const items: Record<string, any> = {}
    for (const item of blueprint.items || []) {
      items[item.id] = { ...item }
    }

    // Replay progress audit over blueprint
    if (existsSync(progressPath)) {
      try {
        const lines = readFileSync(progressPath, "utf8").split("\n").filter(Boolean)
        for (const line of lines) {
          try {
            const entry = JSON.parse(line)
            const id = entry.item_id
            if (id && items[id]) {
              items[id].status = entry.status || items[id].status
              items[id].completion_pct = entry.completion_pct ?? items[id].completion_pct
              if (!items[id].sessions) items[id].sessions = []
              items[id].sessions.push({ ref: entry.session_ref || "", note: entry.note || "", pct: entry.completion_pct || 0 })
            }
          } catch {}
        }
      } catch (_) {}
    }

    // Write active snapshot
    const active = { schema_version: "v1", title: blueprint.title, phases: blueprint.phases || {}, items: Object.values(items) }
    try { mkdirSync(resolvePath(context.worktree, "docs/json/roadmaps"), { recursive: true }) } catch (_) {}
    writeFileSync(activePath, JSON.stringify(active, null, 2), "utf8")

    // Resolve dependencies
    const completedIds = new Set(Object.entries(items).filter(([, i]) => i.status === "completed" || i.completion_pct >= 100).map(([id]) => id))
    const depFail = new Set(Object.entries(items).filter(([, i]) => i.depends_on?.length && !i.depends_on.every((d: string) => completedIds.has(d))).map(([id]) => id))

    const effortOrder: Record<string, number> = { low: 0, moderate: 1, high: 2 }
    const actionable: any[] = []
    const blocked: any[] = []
    const completedList: any[] = []

    for (const [id, item] of Object.entries(items) as [string, any][]) {
      if (args.phase && item.phase !== args.phase) continue
      const entry = {
        id, title: item.title, phase: item.phase, priority: item.priority,
        status: item.status, completion_pct: item.completion_pct || 0,
        depends_on: item.depends_on || [],
        blocked_by: (item.depends_on || []).filter((d: string) => !completedIds.has(d)),
        effort: item.effort, context_summary: (item.context_summary || "").slice(0, 200),
        next_step: item.next_step || "", session_count: (item.sessions || []).length,
      }
      if (item.status === "completed" || item.completion_pct >= 100) completedList.push(entry)
      else if (item.status === "deprecated") continue
      else if (depFail.has(id)) blocked.push(entry)
      else actionable.push(entry)
    }

    actionable.sort((a, b) => (a.priority || 999) - (b.priority || 999) || (effortOrder[a.effort] || 1) - (effortOrder[b.effort] || 1))

    const result: any = args.show_all
      ? { actionable, blocked, completed: completedList, total: Object.keys(items).length }
      : { actionable, blocked_count: blocked.length, completed_count: completedList.length, total: Object.keys(items).length }

    result.summary = `${actionable.length} actionable, ${blocked.length} blocked, ${completedList.length} completed of ${Object.keys(items).length} total`
    result.phases = blueprint.phases || {}
    return JSON.stringify(result, null, 2)
  },
})
