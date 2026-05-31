import { tool } from "@opencode-ai/plugin"
import { resolve } from "node:path"
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs"

function r(worktree: string, p: string): string { return resolve(worktree, p) }

export default tool({
  description: "Roadmap lifecycle — init, next, progress, deprecate, prioritize. One tool for the cross-session control plane.",
  args: {
    action: tool.schema.string().describe("init | next | progress | deprecate | prioritize"),
    item_id: tool.schema.string().optional().describe("Item ID (for progress/deprecate/prioritize)"),
    status: tool.schema.string().optional().describe("Status (for progress)"),
    completion_pct: tool.schema.number().optional().describe("0-100 (for progress)"),
    priority: tool.schema.number().optional().describe("New priority (for prioritize)"),
    phase: tool.schema.string().optional().describe("Phase filter or new phase"),
    note: tool.schema.string().optional().describe("Note (for progress/deprecate)"),
    reason: tool.schema.string().optional().describe("Reason (for deprecate/prioritize)"),
    replacement: tool.schema.string().optional().describe("Replacement item (for deprecate)"),
    show_all: tool.schema.boolean().optional().describe("Show all items (for init)"),
    limit: tool.schema.number().optional().describe("Max items (for next)"),
  },
  async execute(args, context) {
    const bp = r(context.worktree, "docs/json/roadmaps/opencode-desktop-phase3-roadmap.v1.json")
    const ap = r(context.worktree, "docs/json/roadmaps/active.v1.json")
    const pp = r(context.worktree, "docs/json/roadmaps/progress.v1.jsonl")

    function loadItems(): Record<string, any> {
      if (!existsSync(ap)) {
        if (!existsSync(bp)) return {}
        const blue = JSON.parse(readFileSync(bp, "utf8"))
        const items: Record<string, any> = {}
        for (const i of blue.items || []) items[i.id] = { ...i }
        // Replay progress
        if (existsSync(pp)) {
          for (const line of readFileSync(pp, "utf8").split("\n").filter(Boolean)) {
            try {
              const e = JSON.parse(line)
              if (items[e.item_id]) { items[e.item_id].status = e.status || items[e.item_id].status; items[e.item_id].completion_pct = e.completion_pct ?? items[e.item_id].completion_pct }
            } catch {}
          }
        }
        try { mkdirSync(r(context.worktree, "docs/json/roadmaps"), { recursive: true }) } catch (_) {}
        writeFileSync(ap, JSON.stringify({ items: Object.values(items) }, null, 2), "utf8")
      }
      const active = JSON.parse(readFileSync(ap, "utf8"))
      const map: Record<string, any> = {}
      for (const i of active.items || []) map[i.id] = i
      return map
    }

    const items = loadItems()
    if (!Object.keys(items).length && args.action !== "init") return JSON.stringify({ error: "No roadmap. Run roadmap(action='init') first." }, null, 2)

    // ── INIT ──
    if (args.action === "init") {
      const completed = new Set(Object.entries(items).filter(([, i]) => i.status === "completed" || i.completion_pct >= 100).map(([id]) => id))
      const depFail = new Set(Object.entries(items).filter(([, i]) => (i.depends_on || []).some((d: string) => !completed.has(d))).map(([id]) => id))
      const eff = { low: 0, moderate: 1, high: 2 }
      const actionable: any[] = [], blocked: any[] = [], done: any[] = []
      for (const [id, item] of Object.entries(items) as [string, any][]) {
        if (args.phase && item.phase !== args.phase) continue
        const e = { id, title: item.title, phase: item.phase, priority: item.priority, status: item.status, completion_pct: item.completion_pct || 0, depends_on: item.depends_on || [], blocked_by: (item.depends_on || []).filter((d: string) => !completed.has(d)), effort: item.effort, context: (item.context_summary || "").slice(0, 200), next_step: item.next_step }
        if (item.status === "completed" || item.completion_pct >= 100) done.push(e)
        else if (item.status === "deprecated") continue
        else if (depFail.has(id)) blocked.push(e)
        else actionable.push(e)
      }
      actionable.sort((a, b) => (a.priority || 99) - (b.priority || 99) || (eff[a.effort] || 1) - (eff[b.effort] || 1))
      return JSON.stringify({ action: "init", actionable: args.show_all ? undefined : actionable, blocked: args.show_all ? blocked : undefined, completed: args.show_all ? done : undefined, summary: `${actionable.length} ready, ${blocked.length} blocked, ${done.length} done` }, null, 2)
    }

    // ── NEXT ──
    if (args.action === "next") {
      const completed = new Set(Object.entries(items).filter(([, i]) => i.status === "completed" || i.completion_pct >= 100).map(([id]) => id))
      const ready: any[] = [], inProg: any[] = []
      for (const [id, item] of Object.entries(items) as [string, any][]) {
        if (completed.has(id) || item.status === "deprecated") continue
        if (args.phase && item.phase !== args.phase) continue
        const unmet = (item.depends_on || []).filter((d: string) => !completed.has(d))
        if (unmet.length) continue
        const e = { id, title: item.title, phase: item.phase, priority: item.priority, status: item.status, completion_pct: item.completion_pct || 0, context: (item.context_summary || "").slice(0, 200), next_step: item.next_step }
        if (item.status === "in_progress") inProg.push(e); else ready.push(e)
      }
      const next = [...inProg, ...ready].slice(0, args.limit ?? 5)
      return JSON.stringify({ action: "next", next, recommendation: next[0] ? `${next[0].id}: ${next[0].title}` : "Nothing ready" }, null, 2)
    }

    // ── PROGRESS ──
    if (args.action === "progress") {
      if (!items[args.item_id!]) return JSON.stringify({ error: `Item '${args.item_id}' not found` }, null, 2)
      const item = items[args.item_id!]
      const old = { status: item.status, pct: item.completion_pct || 0 }
      item.status = args.status || item.status
      item.completion_pct = args.completion_pct ?? item.completion_pct
      writeFileSync(ap, JSON.stringify({ items: Object.values(items) }, null, 2), "utf8")
      appendFileSync(pp, JSON.stringify({ schema_version: "v1", item_id: args.item_id, status: args.status, completion_pct: args.completion_pct, note: args.note, session_ref: context.sessionID, recorded_at: new Date().toISOString() }) + "\n", "utf8")
      return JSON.stringify({ action: "progress", item_id: args.item_id, previous: old, new: { status: item.status, pct: item.completion_pct } }, null, 2)
    }

    // ── DEPRECATE ──
    if (args.action === "deprecate") {
      if (!items[args.item_id!]) return JSON.stringify({ error: `Item '${args.item_id}' not found` }, null, 2)
      const item = items[args.item_id!]
      item.status = "deprecated"; item.deprecation_reason = args.reason; item.deprecation_replacement = args.replacement
      item.deprecation_expires = new Date(Date.now() + 30 * 86400000).toISOString()
      writeFileSync(ap, JSON.stringify({ items: Object.values(items) }, null, 2), "utf8")
      appendFileSync(pp, JSON.stringify({ schema_version: "v1", item_id: args.item_id, status: "deprecated", note: `DEPRECATED: ${args.reason}`, session_ref: context.sessionID, recorded_at: new Date().toISOString() }) + "\n", "utf8")
      const orphans = Object.entries(items).filter(([id, i]) => id !== args.item_id && (i as any).depends_on?.includes(args.item_id)).map(([id]) => id)
      return JSON.stringify({ action: "deprecate", item_id: args.item_id, reason: args.reason, orphaned: orphans }, null, 2)
    }

    // ── PRIORITIZE ──
    if (args.action === "prioritize") {
      if (!items[args.item_id!]) return JSON.stringify({ error: `Item '${args.item_id}' not found` }, null, 2)
      const item = items[args.item_id!]
      const changes: any = {}
      if (args.priority !== undefined) { changes.priority = { from: item.priority, to: args.priority }; item.priority = args.priority }
      if (args.phase) { changes.phase = { from: item.phase, to: args.phase }; item.phase = args.phase }
      writeFileSync(ap, JSON.stringify({ items: Object.values(items) }, null, 2), "utf8")
      appendFileSync(pp, JSON.stringify({ schema_version: "v1", item_id: args.item_id, status: item.status, note: `REPRIORITIZED: ${args.reason}`, session_ref: context.sessionID, recorded_at: new Date().toISOString() }) + "\n", "utf8")
      return JSON.stringify({ action: "prioritize", item_id: args.item_id, changes }, null, 2)
    }

    return JSON.stringify({ error: `Unknown action: '${args.action}'` }, null, 2)
  },
})
