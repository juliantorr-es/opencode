import { tool } from "@opencode-ai/plugin"
import { resolve } from "node:path"
import { existsSync, mkdirSync, appendFileSync, readFileSync } from "node:fs"

function r(worktree: string, p: string): string { return resolve(worktree, p) }

export default tool({
  description: "Quick ping/pong between orchestrator and leaf agents. Use 'ask' to check on an agent, 'reply' to respond, 'check' to see your inbox. All messages route through the coordination ledger.",
  args: {
    action: tool.schema.string().describe("'ask' to ping an agent | 'reply' to respond | 'check' to read your inbox"),
    lane_id: tool.schema.string().describe("Lane identifier."),
    agent: tool.schema.string().optional().describe("Target agent name (for 'ask'). Defaults to all agents in this lane."),
    message: tool.schema.string().optional().describe("Your message (for 'ask' and 'reply')."),
    status: tool.schema.string().optional().describe("'working' | 'done' | 'stuck' | 'need_help' (for 'reply')."),
  },
  async execute(args, context) {
    const logPath = r(context.worktree, "docs/json/opencode/coordination/messages.v1.jsonl")
    try { mkdirSync(r(context.worktree, "docs/json/opencode/coordination"), { recursive: true }) } catch (_) {}
    const now = new Date().toISOString()
    const mid = now.replace(/[-:T.]/g, "").slice(0, 15)

    // ── ASK: orchestrator pings a leaf agent ──
    if (args.action === "ask") {
      const target = args.agent || "all"
      const msg = {
        schema_version: "v1",
        message_id: `${mid}_ping_ask`,
        kind: "ping",
        session_id: context.sessionID,
        sender: context.agent,
        recipient: target,
        lane_id: args.lane_id,
        subject: `Ping: ${args.message || "status check"}`.slice(0, 200),
        body: JSON.stringify({
          action: "ask",
          from: context.agent,
          to: target,
          lane_id: args.lane_id,
          message: args.message || "Status?",
          sent_at: now,
        }),
        sent_at: now,
      }
      try { appendFileSync(logPath, JSON.stringify(msg) + "\n", "utf8") } catch (_) {}
      return JSON.stringify({
        status: "sent",
        action: "ask",
        to: target,
        lane_id: args.lane_id,
        hint: `Ping sent to ${target}. They'll see it when they call ping(action='check').`,
      }, null, 2)
    }

    // ── REPLY: leaf agent responds ──
    if (args.action === "reply") {
      const msg = {
        schema_version: "v1",
        message_id: `${mid}_ping_reply`,
        kind: "ping",
        session_id: context.sessionID,
        sender: context.agent,
        recipient: "orchestrator",
        lane_id: args.lane_id,
        subject: `Reply: ${args.status || "ack"} — ${args.message || ""}`.slice(0, 200),
        body: JSON.stringify({
          action: "reply",
          from: context.agent,
          lane_id: args.lane_id,
          status: args.status || "working",
          message: args.message || "",
          sent_at: now,
        }),
        sent_at: now,
      }
      try { appendFileSync(logPath, JSON.stringify(msg) + "\n", "utf8") } catch (_) {}
      return JSON.stringify({
        status: "sent",
        action: "reply",
        from: context.agent,
        reply_status: args.status || "working",
        hint: "Reply sent. Orchestrator will see it via ping(action='check') or read(action='messages').",
      }, null, 2)
    }

    // ── CHECK: read your inbox ──
    if (args.action === "check") {
      if (!existsSync(logPath)) {
        return JSON.stringify({ action: "check", pings: [], count: 0, hint: "No messages yet." }, null, 2)
      }

      const pings: any[] = []
      try {
        const lines = readFileSync(logPath, "utf8").split("\n").filter(Boolean).slice(-200)
        for (const line of lines) {
          try {
            const msg = JSON.parse(line)
            if (msg.kind !== "ping") continue
            const body = typeof msg.body === "string" ? JSON.parse(msg.body) : (msg.body || {})
            // Show pings TO me (I'm the recipient) or FROM me (replies I sent)
            const isForMe = msg.recipient === context.agent || msg.recipient === "all"
            const isFromMe = msg.sender === context.agent
            const isForMyLane = body.lane_id === args.lane_id
            if ((isForMe || isFromMe) && isForMyLane) {
              pings.push({
                message_id: msg.message_id,
                direction: isFromMe ? "→ sent" : "← received",
                from: msg.sender,
                to: msg.recipient,
                action: body.action,
                status: body.status,
                message: body.message || "",
                sent_at: msg.sent_at,
              })
            }
          } catch {}
        }
      } catch {
        return JSON.stringify({ action: "check", error: "Cannot read messages" }, null, 2)
      }

      const unread = pings.filter(p => p.direction === "← received")
      return JSON.stringify({
        action: "check",
        pings: pings.slice(-10),
        count: pings.length,
        unread: unread.length,
        hint: unread.length > 0
          ? `${unread.length} unread ping(s). Reply with ping(action='reply', ...).`
          : "No unread pings. Keep working.",
      }, null, 2)
    }

    return JSON.stringify({ error: `Unknown action: '${args.action}'. Valid: ask, reply, check.` }, null, 2)
  },
})
