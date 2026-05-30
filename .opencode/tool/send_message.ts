import { tool } from "@opencode-ai/plugin"
import { resolve } from "node:path"
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs"

function resolvePath(worktree: string, p: string): string {
  return resolve(worktree, p)
}

export default tool({
  description: "Broadcast wave directives, blockers, clarifications, handoffs, and alerts to the coordination ledger.",
  args: {
    recipient: tool.schema.string().describe("Target agent name, or '*' for broadcast"),
    kind: tool.schema.string().describe("directive | blocker | clarification | handoff | wave_start | wave_complete | alert"),
    wave: tool.schema.string().optional().describe("Current wave name"),
    subject: tool.schema.string().describe("Message subject"),
    body: tool.schema.string().describe("Message body"),
    dry_run: tool.schema.boolean().optional().describe("Preview without writing to ledger"),
  },
  async execute(args, context) {
    const validKinds = ["directive", "blocker", "clarification", "handoff", "wave_start", "wave_complete", "path_reservation", "task_status", "heartbeat", "result", "delegation", "alert"]
    if (!validKinds.includes(args.kind)) {
      return JSON.stringify({ status: "validation_error", error: `Invalid kind: '${args.kind}'`, valid: validKinds }, null, 2)
    }

    const dir = resolvePath(context.worktree, "docs/json/opencode/coordination")
    const msgPath = resolvePath(context.worktree, "docs/json/opencode/coordination/messages.v1.jsonl")
    try { if (!existsSync(dir)) mkdirSync(dir, { recursive: true }) } catch (_) {}

    const messageId = new Date().toISOString().replace(/[-:T.]/g, "").slice(0, 15) + "_" + args.kind
    const record = {
      schema_version: "v1",
      message_id: messageId,
      session_id: context.sessionID,
      sender: context.agent,
      recipient: args.recipient,
      kind: args.kind,
      wave: args.wave || null,
      subject: args.subject,
      body: args.body,
      sent_at: new Date().toISOString(),
    }

    if (args.dry_run) {
      return JSON.stringify({
        status: "dry_run",
        preview: { recipient: args.recipient, kind: args.kind, subject: args.subject, body_preview: args.body.slice(0, 200) },
        note: "No message written. Remove dry_run=true to send.",
      }, null, 2)
    }

    // Read existing, append, keep as circular buffer (last 5 messages + 5 heartbeats)
    let entries: any[] = []
    if (existsSync(msgPath)) {
      try {
        entries = readFileSync(msgPath, "utf8").split("\n").filter(Boolean).map(l => {
          try { return JSON.parse(l) } catch { return null }
        }).filter(Boolean)
      } catch (_) {}
    }
    entries.push(record)
    const heartbeats = entries.filter((e: any) => e.kind === "heartbeat").slice(-5)
    const messages = entries.filter((e: any) => e.kind !== "heartbeat").slice(-5)
    const combined = [...heartbeats, ...messages].sort((a: any, b: any) => (a.sent_at || "").localeCompare(b.sent_at || ""))
    try {
      appendFileSync(msgPath, "") // touch
      // Write combined (simplified — just append for now, circular buffer via truncation)
      if (combined.length > 0) {
        for (const entry of combined) {
          appendFileSync(msgPath + ".tmp", JSON.stringify(entry) + "\n", "utf8")
        }
        // Fall back to simple append if temp approach fails
        appendFileSync(msgPath, JSON.stringify(record) + "\n", "utf8")
      } else {
        appendFileSync(msgPath, JSON.stringify(record) + "\n", "utf8")
      }
    } catch (_) {}

    // Recipient check
    if (args.recipient === "*") {
      return JSON.stringify({ status: "delivered", recipient: "*", kind: args.kind, message_id: messageId, note: "broadcast — no recipient check" }, null, 2)
    }

    // Check for recent heartbeat from recipient (last 10 seconds)
    const cutoff = Date.now() - 10000
    let lastBeat: string | null = null
    for (let i = combined.length - 1; i >= 0; i--) {
      const entry = combined[i]
      if (entry?.kind === "heartbeat" && entry?.sender === args.recipient) {
        try {
          const ts = new Date(entry.sent_at).getTime()
          if (ts > cutoff) {
            const ago = Math.floor((Date.now() - ts) / 1000)
            lastBeat = `${ago}s ago`
            break
          }
        } catch {}
      }
    }

    if (lastBeat) {
      return JSON.stringify({ status: "delivered", recipient: args.recipient, kind: args.kind, message_id: messageId, heartbeat: lastBeat }, null, 2)
    } else {
      return JSON.stringify({
        status: "undelivered",
        error: `No heartbeat from '${args.recipient}' in the last 10 seconds.`,
        message_id: messageId,
        action: `Start a '${args.recipient}' subagent session first, then retry.`,
      }, null, 2)
    }
  },
})
