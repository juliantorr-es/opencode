import { tool } from "@opencode-ai/plugin"
import { resolve } from "node:path"
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"

function resolvePath(worktree: string, p: string): string {
  return resolve(worktree, p)
}

export default tool({
  description: "Update a roadmap item's status. Appends to progress audit log and recalculates dependents.",
  args: {
    item_id: tool.schema.string().describe("Roadmap item ID (e.g. 'PG-001')"),
    status: tool.schema.string().describe("not_started | in_progress | completed | blocked | frozen"),
    completion_pct: tool.schema.number().optional().describe("0-100"),
    note: tool.schema.string().describe("What changed"),
    session_ref: tool.schema.string().optional().describe("Session ID for audit trail"),
  },
  async execute(args, context) {
    const activePath = resolvePath(context.worktree, "docs/json/roadmaps/active.v1.json")
    const progressPath = resolvePath(context.worktree, "docs/json/roadmaps/progress.v1.jsonl")

    if (!existsSync(activePath)) {
      return JSON.stringify({ error: "No active roadmap. Run roadmap_init first." }, null, 2)
    }

    const active = JSON.parse(readFileSync(activePath, "utf8"))
    const items: Record<string, any> = {}
    for (const item of active.items || []) items[item.id] = item

    if (!items[args.item_id]) {
      return JSON.stringify({ error: `Item '${args.item_id}' not found`, available: Object.keys(items).slice(0, 10) }, null, 2)
    }

    const item = items[args.item_id]
    const oldStatus = item.status
    const oldPct = item.completion_pct || 0

    item.status = args.status
    item.completion_pct = args.completion_pct ?? item.completion_pct ?? 0
    if (!item.sessions) item.sessions = []
    const truncatedNote = args.note.length > 500 ? args.note.slice(0, 497) + "..." : args.note
    item.sessions.push({ ref: args.session_ref || context.sessionID, note: truncatedNote, pct: args.completion_pct ?? 0 })

    writeFileSync(activePath, JSON.stringify(active, null, 2), "utf8")

    // Audit
    try { mkdirSync(resolvePath(context.worktree, "docs/json/roadmaps"), { recursive: true }) } catch (_) {}
    appendFileSync(progressPath, JSON.stringify({
      schema_version: "v1", item_id: args.item_id, status: args.status,
      completion_pct: args.completion_pct ?? item.completion_pct ?? 0, note: truncatedNote,
      session_ref: args.session_ref || context.sessionID,
      recorded_at: new Date().toISOString(),
    }) + "\n", "utf8")

    // Check newly unblocked
    const completedIds = new Set(Object.entries(items).filter(([, i]) => (i as any).status === "completed" || (i as any).completion_pct >= 100).map(([id]) => id))
    const newlyUnblocked: any[] = []
    if ((args.completion_pct ?? 0) >= 100 || args.status === "completed") {
      for (const [id, depItem] of Object.entries(items) as [string, any][]) {
        if (id === args.item_id || depItem.status !== "not_started" || !depItem.depends_on?.length) continue
        if (depItem.depends_on.every((d: string) => completedIds.has(d))) {
          newlyUnblocked.push({ id, title: depItem.title, was_blocked_by: depItem.depends_on.filter((d: string) => d === args.item_id) })
        }
      }
    }

    return JSON.stringify({
      status: "updated", item_id: args.item_id, title: item.title,
      previous_status: oldStatus, new_status: args.status,
      previous_pct: oldPct, new_pct: args.completion_pct ?? 0,
      newly_unblocked: newlyUnblocked,
      hint: "Run roadmap_next to see updated priority queue.",
    }, null, 2)
  },
})
