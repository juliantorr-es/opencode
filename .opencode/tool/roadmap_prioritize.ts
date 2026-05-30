import { tool } from "@opencode-ai/plugin"
import { resolve } from "node:path"
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"

function resolvePath(worktree: string, p: string): string { return resolve(worktree, p) }

export default tool({
  description: "Change a roadmap item's priority or move it between phases. Returns recalculated next-up.",
  args: {
    item_id: tool.schema.string().describe("Item ID"),
    priority: tool.schema.number().optional().describe("New priority (lower = higher)"),
    phase: tool.schema.string().optional().describe("Move to different phase"),
    reason: tool.schema.string().describe("Why priority changed"),
    session_ref: tool.schema.string().optional().describe("Session ID"),
  },
  async execute(args, context) {
    const ap = resolvePath(context.worktree, "docs/json/roadmaps/active.v1.json")
    const pp = resolvePath(context.worktree, "docs/json/roadmaps/progress.v1.jsonl")
    if (!existsSync(ap)) return JSON.stringify({ error: "No active roadmap." }, null, 2)

    const active = JSON.parse(readFileSync(ap, "utf8"))
    const items: Record<string, any> = {}
    for (const i of active.items || []) items[i.id] = i

    if (!items[args.item_id]) return JSON.stringify({ error: `Item '${args.item_id}' not found` }, null, 2)

    const item = items[args.item_id]
    const changes: any = {}
    if (args.priority !== undefined) { changes.priority = { from: item.priority, to: args.priority }; item.priority = args.priority }
    if (args.phase) { changes.phase = { from: item.phase, to: args.phase }; item.phase = args.phase }

    writeFileSync(ap, JSON.stringify(active, null, 2), "utf8")
    try { mkdirSync(resolvePath(context.worktree, "docs/json/roadmaps"), { recursive: true }) } catch (_) {}
    appendFileSync(pp, JSON.stringify({
      schema_version: "v1", item_id: args.item_id, status: item.status,
      note: `REPRIORITIZED: ${args.reason} — changes: ${JSON.stringify(changes)}`,
      session_ref: args.session_ref || context.sessionID, recorded_at: new Date().toISOString(),
    }) + "\n", "utf8")

    // Quick next-up
    const completedIds = new Set(Object.entries(items).filter(([, i]) => (i as any).status === "completed" || (i as any).completion_pct >= 100).map(([id]) => id))
    const deprecatedIds = new Set(Object.entries(items).filter(([, i]) => (i as any).status === "deprecated").map(([id]) => id))
    const nextUp = Object.entries(items)
      .filter(([id, i]) => !completedIds.has(id) && !deprecatedIds.has(id) && !(i as any).depends_on?.filter((d: string) => !completedIds.has(d)).length)
      .map(([id, i]) => ({ id, title: (i as any).title?.slice(0, 80), priority: (i as any).priority, status: (i as any).status, phase: (i as any).phase }))
      .sort((a, b) => (a.priority || 999) - (b.priority || 999))
      .slice(0, 5)

    return JSON.stringify({
      status: "reprioritized", item_id: args.item_id, title: item.title,
      changes, reason: args.reason, next_up: nextUp,
    }, null, 2)
  },
})
