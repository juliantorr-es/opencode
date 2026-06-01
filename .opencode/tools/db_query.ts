import { tool } from "@opencode-ai/plugin"
import { init, absorbArtifact, readArtifact, searchEverything, rebuildSearchIndex } from "./db"

export default tool({
  description: "Run read-only SQL queries OR full-text search against the orchestration database. Use 'query' for SQL, 'search' for Google-like search across all journals/messages/files.",
  args: {
    action: tool.schema.string().describe("'query' for SQL | 'search' for full-text search | 'rebuild_search' to re-index everything"),
    query: tool.schema.string().optional().describe("SQL SELECT query (for 'query') or search terms (for 'search')."),
  },
  async execute(args, context) {
    const db = init(context.worktree)

    if (args.action === "search") {
      if (!args.query) return JSON.stringify({ error: "query required" }, null, 2)
      // Support Google-style syntax: "auth login" becomes "auth AND login"
      const ftsQuery = args.query.split(/\s+/).filter(Boolean).join(" AND ") + "*"
      const results = searchEverything(db, ftsQuery, 30)
      return JSON.stringify({
        action: "search", query: args.query, fts_query: ftsQuery,
        results: results.map((r: any) => ({
          source: r.source,
          snippet: (r.content || "").slice(0, 300),
          rank: r.rank,
        })),
        count: results.length,
        hint: results.length === 0 ? "No matches. Try broader terms or rebuild the index with action='rebuild_search'." : undefined,
      }, null, 2)
    }

    if (args.action === "rebuild_search") {
      const count = rebuildSearchIndex(db)
      return JSON.stringify({ action: "rebuild_search", indexed: count, hint: `Re-indexed ${count} documents for full-text search.` }, null, 2)
    }
    if (args.action === "query") {
      const q = (args.query || "").trim()
      if (!q.toUpperCase().startsWith("SELECT")) {
        return JSON.stringify({ error: "Only SELECT queries allowed." }, null, 2)
      }
      if (/DROP|DELETE|UPDATE|INSERT|ALTER|CREATE/i.test(q)) {
        return JSON.stringify({ error: "Read-only queries only." }, null, 2)
      }
      try {
        const rows = db.query(q + " LIMIT 50").all() as any[]
        return JSON.stringify({ action: "query", query: q.slice(0, 200), rows, count: rows.length, truncated: rows.length >= 50 }, null, 2)
      } catch (e: any) {
        return JSON.stringify({ error: e.message, query: q.slice(0, 200) }, null, 2)
      }
    }
  },
})
