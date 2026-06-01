import { tool } from "@opencode-ai/plugin"
import { init } from "./db"

export default tool({
  description: "Quick ping/pong between orchestrator and leaf agents. Uses SQLite.",
  args: {
    action: tool.schema.string().describe("'ask' | 'reply' | 'check'"),
    lane_id: tool.schema.string().describe("Lane identifier."),
    agent: tool.schema.string().optional().describe("Target agent (for 'ask')."),
    message: tool.schema.string().optional().describe("Your message."),
    status: tool.schema.string().optional().describe("'working' | 'done' | 'stuck' | 'need_help' (for 'reply')."),
  },
  async execute(args, context) {
    const db = init(context.worktree)
    const now = new Date().toISOString()
    const mid = now.replace(/[-:T.]/g, "").slice(0, 15)

    if (args.action === "ask") {
      const target = args.agent || "all"
      db.run(`INSERT INTO messages (message_id, kind, session_id, sender, recipient, lane_id, subject, body, sent_at)
              VALUES (?, 'ping', ?, ?, ?, ?, ?, ?, ?)`,
        `${mid}_ping_ask`, context.sessionID, context.agent, target, args.lane_id,
        `Ping: ${args.message || "status check"}`.slice(0, 200),
        JSON.stringify({ action: "ask", from: context.agent, to: target, lane_id: args.lane_id, message: args.message || "Status?", sent_at: now }), now)
      return JSON.stringify({ status: "sent", action: "ask", to: target, lane_id: args.lane_id,
        hint: `Ping sent. They'll see it via ping(action='check').` }, null, 2)
    }

    if (args.action === "reply") {
      db.run(`INSERT INTO messages (message_id, kind, session_id, sender, recipient, lane_id, subject, body, sent_at)
              VALUES (?, 'ping', ?, ?, 'orchestrator', ?, ?, ?, ?)`,
        `${mid}_ping_reply`, context.sessionID, context.agent, args.lane_id,
        `Reply: ${args.status || "ack"} — ${args.message || ""}`.slice(0, 200),
        JSON.stringify({ action: "reply", from: context.agent, lane_id: args.lane_id, status: args.status || "working", message: args.message || "", sent_at: now }), now)
      return JSON.stringify({ status: "sent", action: "reply", from: context.agent, reply_status: args.status || "working" }, null, 2)
    }

    if (args.action === "check") {
      const rows = db.query(`SELECT message_id, sender, recipient, subject, body, sent_at FROM messages WHERE kind = 'ping' AND lane_id = ? AND (recipient = ? OR recipient = 'all' OR sender = ?) ORDER BY sent_at DESC LIMIT 20`)
        .all(args.lane_id, context.agent, context.agent) as any[]

      const pings = rows.map((r: any) => {
        let body: any = {}
        try { body = JSON.parse(r.body || "{}") } catch {}
        return {
          message_id: r.message_id,
          direction: r.sender === context.agent ? "→ sent" : "← received",
          from: r.sender, to: r.recipient,
          action: body.action, status: body.status, message: body.message || "",
          sent_at: r.sent_at,
        }
      })

      const unread = pings.filter((p: any) => p.direction === "← received")
      return JSON.stringify({
        action: "check", pings: pings.slice(-10), count: pings.length, unread: unread.length,
        hint: unread.length > 0 ? `${unread.length} unread ping(s).` : "No unread pings.",
      }, null, 2)
    }

    return JSON.stringify({ error: `Unknown action: '${args.action}'. Valid: ask, reply, check.` }, null, 2)
  },
})
