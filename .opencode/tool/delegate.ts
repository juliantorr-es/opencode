import { tool } from "@opencode-ai/plugin"
import { resolve } from "node:path"
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"

function resolvePath(worktree: string, p: string): string { return resolve(worktree, p) }

export default tool({
  description: "Announce a delegation to the fleet. Writes to the coordination ledger so task_board shows it immediately. Returns the exact task() call to execute.",
  args: {
    agent: tool.schema.string().describe("Target agent name"),
    task: tool.schema.string().describe("Task description — what, which files, what success looks like"),
    wave: tool.schema.string().optional().describe("Wave name"),
    background: tool.schema.boolean().optional().describe("Background mode (default true)"),
    lane_id: tool.schema.string().optional().describe("Lane identifier for cross-lane tracking"),
  },
  async execute(args, context) {
    const coordDir = resolvePath(context.worktree, "docs/json/opencode/coordination")
    const coordPath = resolvePath(context.worktree, "docs/json/opencode/coordination/messages.v1.jsonl")
    try { if (!existsSync(coordDir)) mkdirSync(coordDir, { recursive: true }) } catch (_) {}

    const bg = args.background ?? true
    const messageId = new Date().toISOString().replace(/[-:T.]/g, "").slice(0, 15) + "_delegation"

    // Write to coordination ledger — task_board reads this immediately
    const msg = {
      schema_version: "v1",
      message_id: messageId,
      kind: "delegation",
      session_id: context.sessionID,
      sender: context.agent,
      recipient: args.agent,
      wave: args.wave || null,
      subject: args.task.slice(0, 120),
      body: JSON.stringify({
        agent: args.agent,
        task: args.task,
        lane_id: args.lane_id || null,
        background: bg,
        delegated_by: context.agent,
        delegated_at: new Date().toISOString(),
      }),
      sent_at: new Date().toISOString(),
    }

    try {
      // Append to circular buffer (keep last 20 messages)
      let entries: any[] = []
      if (existsSync(coordPath)) {
        try {
          entries = readFileSync(coordPath, "utf8").split("\n").filter(Boolean)
            .map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
        } catch {}
      }
      entries.push(msg)
      appendFileSync(coordPath, JSON.stringify(msg) + "\n", "utf8")
    } catch (_) {}

    // Also write to delegations log for audit
    const delPath = resolvePath(context.worktree, "docs/json/opencode/coordination/delegations.v1.jsonl")
    try {
      appendFileSync(delPath, JSON.stringify({
        schema_version: "v1", agent: args.agent, task: args.task,
        wave: args.wave || null, background: bg,
        session_id: context.sessionID, delegated_by: context.agent,
        delegated_at: new Date().toISOString(),
      }) + "\n", "utf8")
    } catch (_) {}

    return JSON.stringify({
      status: "delegated",
      agent: args.agent,
      task_summary: args.task.slice(0, 100),
      background: bg,
      lane_id: args.lane_id || null,
      // Visible on task_board immediately
      fleet_visible: true,
      // Tool usage heartbeats will auto-confirm deployment even if task() is missed
      auto_confirm: "Heartbeats from tool usage automatically upgrade status to running.",
      execute: `task(agent="${args.agent}", task="${args.task.replace(/"/g, '\\"')}", background: ${bg})`,
      hint: "Delegation announced to fleet. Copy 'execute' and call task() now.",
    }, null, 2)
  },
})
