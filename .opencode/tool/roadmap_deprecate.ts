import { tool } from "@opencode-ai/plugin"
import { resolve } from "node:path"
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"

function resolvePath(worktree: string, p: string): string { return resolve(worktree, p) }

export default tool({
  description: "Mark a roadmap item as deprecated — no longer needed. Cascades to dependents.",
  args: {
    item_id: tool.schema.string().describe("Item ID to deprecate"),
    reason: tool.schema.string().describe("Why deprecated"),
    replacement: tool.schema.string().optional().describe("Replacement item ID"),
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
    const exp = new Date(Date.now() + 30 * 86400000).toISOString()
    item.status = "deprecated"
    item.deprecation_reason = args.reason
    item.deprecation_replacement = args.replacement || null
    item.deprecation_session = args.session_ref || context.sessionID
    item.deprecation_expires = exp

    writeFileSync(ap, JSON.stringify(active, null, 2), "utf8")
    try { mkdirSync(resolvePath(context.worktree, "docs/json/roadmaps"), { recursive: true }) } catch (_) {}
    appendFileSync(pp, JSON.stringify({
      schema_version: "v1", item_id: args.item_id, status: "deprecated",
      note: `DEPRECATED: ${args.reason}` + (args.replacement ? ` → replacement: ${args.replacement}` : ""),
      session_ref: args.session_ref || context.sessionID, recorded_at: new Date().toISOString(),
    }) + "\n", "utf8")

    const orphaned = Object.entries(items)
      .filter(([id, i]) => id !== args.item_id && (i as any).depends_on?.includes(args.item_id))
      .map(([id, i]) => ({ id, title: (i as any).title, blocked_by: args.item_id }))

    return JSON.stringify({
      status: "deprecated", item_id: args.item_id, title: item.title,
      reason: args.reason, replacement: args.replacement || null,
      expires_in_30_days: true, orphaned_dependents: orphaned,
    }, null, 2)
  },
})
