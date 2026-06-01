import { tool } from "@opencode-ai/plugin"
import { init } from "./db"

export default tool({
  description: "The Janitor — database maintenance agent. Vacuums old data, summarizes stale sessions into knowledge nuggets, prunes heartbeats older than retention period. Run periodically or at session end.",
  args: {
    action: tool.schema.string().describe("'vacuum' to optimize DB | 'prune' to remove old heartbeats/tool_usage | 'summarize' to compress old sessions | 'full_clean' to do all three"),
    retention_days: tool.schema.number().optional().describe("Days to retain raw data (default 7 for heartbeats, 30 for sessions)."),
    dry_run: tool.schema.boolean().optional().describe("If true, report what would be deleted without actually deleting."),
  },
  async execute(args, context) {
    const db = init(context.worktree)
    const retention = args.retention_days ?? 7
    const dryRun = args.dry_run ?? false
    const results: any = { action: args.action, dry_run: dryRun }

    if (args.action === "vacuum" || args.action === "full_clean") {
      if (!dryRun) {
        db.exec("PRAGMA optimize")
        db.exec("VACUUM")
      }
      // Get DB size
      const pageCount = (db.query("PRAGMA page_count").get() as any)?.page_count || 0
      const pageSize = (db.query("PRAGMA page_size").get() as any)?.page_size || 0
      results.vacuum = { status: dryRun ? "would vacuum" : "vacuumed", size_bytes: pageCount * pageSize }
    }

    if (args.action === "prune" || args.action === "full_clean") {
      const tables: Record<string, string> = {
        heartbeats: `at < datetime('now', '-${retention} days')`,
        tool_usage: `at < datetime('now', '-${retention} days')`,
        bash_usage: `at < datetime('now', '-${retention} days')`,
        journal: `created_at < datetime('now', '-${Math.min(retention * 2, 30)} days')`,
      }
      results.prune = {}
      for (const [table, condition] of Object.entries(tables)) {
        const count = (db.query(`SELECT COUNT(*) as cnt FROM ${table} WHERE ${condition}`).get() as any)?.cnt || 0
        if (!dryRun && count > 0) {
          db.run(`DELETE FROM ${table} WHERE ${condition}`)
        }
        results.prune[table] = { would_delete: count, deleted: dryRun ? 0 : count }
      }
    }

    if (args.action === "summarize" || args.action === "full_clean") {
      // Compress old lane_agents entries into summaries
      const oldLanes = db.query(`
        SELECT lane_id, COUNT(*) as cnt, MIN(delegated_at) as first, MAX(completed_at) as last
        FROM lane_agents
        WHERE completed_at < datetime('now', '-14 days') OR stale_timeout = 1
        GROUP BY lane_id
        HAVING cnt > 3
      `).all() as any[]

      let summarized = 0
      for (const lane of oldLanes) {
        const summary = `Lane ${lane.lane_id}: ${lane.cnt} agents, ${lane.first?.slice(0,10)} → ${lane.last?.slice(0,10)}`
        if (!dryRun) {
          // Write summary nugget
          db.run(`INSERT OR REPLACE INTO artifacts (key, data, source, updated_at) VALUES (?, ?, ?, ?)`,
            `lane_summary_${lane.lane_id}`, JSON.stringify(lane), "janitor", new Date().toISOString())
          // Remove raw entries older than retention
          db.run(`DELETE FROM lane_agents WHERE lane_id = ? AND completed_at < datetime('now', '-14 days')`, lane.lane_id)
          summarized++
        }
      }
      results.summarize = { lanes_compressed: oldLanes.length, summarized: dryRun ? 0 : summarized }
    }

    // Total cleanup stats
    const totalHeartbeats = (db.query("SELECT COUNT(*) as cnt FROM heartbeats").get() as any)?.cnt || 0
    const totalToolUsage = (db.query("SELECT COUNT(*) as cnt FROM tool_usage").get() as any)?.cnt || 0
    const totalJournal = (db.query("SELECT COUNT(*) as cnt FROM journal").get() as any)?.cnt || 0
    results.after = { heartbeats: totalHeartbeats, tool_usage: totalToolUsage, journal_entries: totalJournal }

    return JSON.stringify(results, null, 2)
  },
})
