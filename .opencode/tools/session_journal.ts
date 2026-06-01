import { tool } from "@opencode-ai/plugin"
import { init } from "./db"
import { existsSync, unlinkSync } from "node:fs"
import { resolve } from "node:path"
import { getPath } from "./db"

export default tool({
  description: "Persistent cross-session journal using SQLite. Log, read, resume, cleanup.",
  args: {
    action: tool.schema.string().describe("'log' | 'read' | 'resume' | 'cleanup'"),
    lane_id: tool.schema.string().describe("Lane identifier."),
    agent: tool.schema.string().optional().describe("Filter by agent (for 'read'/'resume')."),
    tool_name: tool.schema.string().optional().describe("Tool name (for 'log')."),
    output_summary: tool.schema.string().optional().describe("Brief summary (for 'log')."),
    output_full: tool.schema.string().optional().describe("Full tool output (for 'log')."),
    exit_code: tool.schema.number().optional().describe("Exit code (for 'log')."),
    files_touched: tool.schema.string().optional().describe("JSON array of files (for 'log')."),
    session_id: tool.schema.string().optional().describe("Filter by session (for 'read')."),
    max_entries: tool.schema.number().optional().describe("Max entries (for 'read', default 50)."),
  },
  async execute(args, context) {
    const db = init(context.worktree)
    const now = new Date().toISOString()

    if (args.action === "log") {
      db.run(`INSERT INTO journal (lane_id, agent, session_id, tool, exit_code, summary, output, files_touched)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        args.lane_id, context.agent, context.sessionID, args.tool_name || "unknown",
        args.exit_code ?? null, (args.output_summary || "").slice(0, 500),
        (args.output_full || "").slice(0, 10000), args.files_touched || "[]")
      return JSON.stringify({ status: "logged", action: "log", tool: args.tool_name, lane_id: args.lane_id }, null, 2)
    }

    if (args.action === "read") {
      let query = `SELECT * FROM journal WHERE 1=1`
      const params: any[] = []
      if (args.lane_id) { query += ` AND lane_id = ?`; params.push(args.lane_id) }
      if (args.agent) { query += ` AND agent = ?`; params.push(args.agent) }
      if (args.session_id) { query += ` AND session_id = ?`; params.push(args.session_id) }
      query += ` ORDER BY created_at DESC LIMIT ?`
      params.push(args.max_entries ?? 50)

      const rows = db.query(query).all(...params) as any[]
      return JSON.stringify({
        action: "read",
        entries: rows.map((r: any) => ({
          at: r.created_at, lane_id: r.lane_id, agent: r.agent, tool: r.tool,
          exit_code: r.exit_code, summary: (r.summary || "").slice(0, 200),
          output_preview: (r.output || "").slice(0, 500),
        })),
        count: rows.length,
        hint: rows.length === 0 ? "No entries match your filters." : undefined,
      }, null, 2)
    }

    if (args.action === "resume") {
      let query = `SELECT lane_id, agent, COUNT(*) as tool_count, tool as last_tool, summary as last_summary, MAX(created_at) as last_at
                   FROM journal WHERE lane_id = ?`
      const params: any[] = [args.lane_id]
      if (args.agent) { query += ` AND agent = ?`; params.push(args.agent) }
      query += ` GROUP BY lane_id, agent`

      const rows = db.query(query).all(...params) as any[]
      if (rows.length === 0) {
        return JSON.stringify({ action: "resume", lane_id: args.lane_id, status: "fresh",
          hint: "No prior work for this lane." }, null, 2)
      }
      return JSON.stringify({
        action: "resume", lane_id: args.lane_id, agents: rows.map((r: any) => ({
          agent: r.agent, tool_count: r.tool_count, last_tool: r.last_tool,
          last_summary: (r.last_summary || "").slice(0, 200), last_at: r.last_at,
        })),
        hint: "Don't redeploy agents that already completed their work.",
      }, null, 2)
    }

    if (args.action === "cleanup") {
      const dbPath = getPath(context.worktree)
      // Close doesn't delete — we just truncate journal
      db.run(`DELETE FROM journal`)
      return JSON.stringify({ action: "cleanup", status: "truncated",
        hint: "Journal entries deleted. Database file remains for lane state." }, null, 2)
    }

    return JSON.stringify({ error: `Unknown action: '${args.action}'.` }, null, 2)
  },
})
