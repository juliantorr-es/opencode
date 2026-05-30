import { tool } from "@opencode-ai/plugin"
import { resolve } from "node:path"
import { existsSync, readFileSync } from "node:fs"

function resolvePath(worktree: string, p: string): string {
  return resolve(worktree, p)
}

export default tool({
  description: "Read messages from the coordination ledger. Filters by kind, recipient, sender, or session.",
  args: {
    kind: tool.schema.string().optional().describe("Filter by message kind: directive | blocker | handoff | alert | etc."),
    recipient: tool.schema.string().optional().describe("Filter by recipient agent name or '*'"),
    sender: tool.schema.string().optional().describe("Filter by sender agent name"),
    session_id: tool.schema.string().optional().describe("Filter by session ID"),
    since: tool.schema.string().optional().describe("ISO timestamp — only messages after this time"),
    limit: tool.schema.number().optional().describe("Max messages to return (default 20)"),
  },
  async execute(args, context) {
    const msgPath = resolvePath(context.worktree, "docs/json/opencode/coordination/messages.v1.jsonl")
    
    if (!existsSync(msgPath)) {
      return JSON.stringify({ messages: [], count: 0, note: "No coordination ledger found" }, null, 2)
    }

    let entries: any[] = []
    try {
      entries = readFileSync(msgPath, "utf8").split("\n").filter(Boolean).map(l => {
        try { return JSON.parse(l) } catch { return null }
      }).filter(Boolean)
    } catch {
      return JSON.stringify({ messages: [], count: 0, error: "Failed to parse coordination ledger" }, null, 2)
    }

    // Filter
    const limit = args.limit ?? 20
    let filtered = entries.filter((e: any) => {
      if (args.kind && e.kind !== args.kind) return false
      if (args.recipient && e.recipient !== args.recipient) return false
      if (args.sender && e.sender !== args.sender) return false
      if (args.session_id && e.session_id !== args.session_id) return false
      if (args.since) {
        try {
          if (new Date(e.sent_at).toISOString() <= args.since) return false
        } catch { return false }
      }
      return true
    })

    // Most recent first
    filtered.sort((a: any, b: any) => (b.sent_at || "").localeCompare(a.sent_at || ""))
    filtered = filtered.slice(0, limit)

    // Simplify output
    const messages = filtered.map((e: any) => ({
      message_id: e.message_id,
      kind: e.kind,
      sender: e.sender,
      recipient: e.recipient,
      subject: e.subject,
      body: e.body?.slice(0, 500),
      sent_at: e.sent_at,
    }))

    return JSON.stringify({
      messages,
      count: messages.length,
      total_in_ledger: entries.length,
      filters_applied: [args.kind && "kind", args.recipient && "recipient", args.sender && "sender", args.session_id && "session"].filter(Boolean),
    }, null, 2)
  },
})
