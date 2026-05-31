import { tool } from "@opencode-ai/plugin"
import { resolve } from "node:path"
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs"

function r(worktree: string, p: string): string { return resolve(worktree, p) }

export const modeDescriptions = {
  orchestrator: "Coordinate fleet-wide: fan out delegations, resolve lane conflicts, and publish checkpoints across the session lifecycle.",
  "general-man-agent": "Send structured coordination messages to subagents and receive handoff summaries. Track lanes via the coordination ledger.",
} as const

export default tool({
  description: "Coordinate with the fleet — send messages or announce delegations. Both write to the coordination ledger so task_board shows them immediately.",
  args: {
    action: tool.schema.string().describe("send | delegate"),
    // send
    recipient: tool.schema.string().optional().describe("Target agent or '*' (for send)"),
    kind: tool.schema.string().optional().describe("directive | blocker | handoff | alert (for send)"),
    subject: tool.schema.string().optional().describe("Subject (for send)"),
    body: tool.schema.string().optional().describe("Message body (for send)"),
    // delegate
    agent: tool.schema.string().optional().describe("Target agent (for delegate)"),
    task: tool.schema.string().optional().describe("Task description (for delegate)"),
    lane_id: tool.schema.string().optional().describe("Lane ID (for delegate)"),
    background: tool.schema.boolean().optional().describe("Background mode (default true)"),
  },
  async execute(args, context) {
    const dir = r(context.worktree, "docs/json/opencode/coordination")
    const path = r(context.worktree, "docs/json/opencode/coordination/messages.v1.jsonl")
    try { if (!existsSync(dir)) mkdirSync(dir, { recursive: true }) } catch (_) {}

    const mid = new Date().toISOString().replace(/[-:T.]/g, "").slice(0, 15)

    if (args.action === "send") {
      const validKinds = ["directive", "blocker", "clarification", "handoff", "wave_start", "wave_complete", "alert", "delegation"]
      if (args.kind && !validKinds.includes(args.kind)) return JSON.stringify({ error: `Invalid kind: '${args.kind}'` }, null, 2)

      const msg = {
        schema_version: "v1", message_id: `${mid}_${args.kind}`,
        session_id: context.sessionID, sender: context.agent,
        recipient: args.recipient || "*", kind: args.kind || "handoff",
        subject: args.subject || "", body: args.body || "",
        sent_at: new Date().toISOString(),
      }

      try { appendFileSync(path, JSON.stringify(msg) + "\n", "utf8") } catch (_) {}

      const hint = `REMINDER: coordinate(action="send") is for communication only. To delegate work, use task(agent="...", task="...", background: true). Do NOT use coordinate to assign work — use task() to spawn an agent.`
      return JSON.stringify({ action: "send", status: "delivered", kind: args.kind, recipient: args.recipient, hint }, null, 2)
    }

    if (args.action === "delegate") {
      const bg = args.background ?? true
      const msg = {
        schema_version: "v1", message_id: `${mid}_delegation`, kind: "delegation",
        session_id: context.sessionID, sender: context.agent, recipient: args.agent || "?",
        subject: (args.task || "").slice(0, 120),
        body: JSON.stringify({ agent: args.agent, task: args.task, lane_id: args.lane_id, background: bg, delegated_by: context.agent, delegated_at: new Date().toISOString() }),
        sent_at: new Date().toISOString(),
      }
      try { appendFileSync(path, JSON.stringify(msg) + "\n", "utf8") } catch (_) {}
      return JSON.stringify({
        action: "delegate", status: "delegated", agent: args.agent,
        fleet_visible: true,
        execute: `task(agent="${args.agent}", task="${(args.task || "").replace(/"/g, '\\"')}", background: ${bg})`,
        hint: "Announced to fleet. Copy 'execute' and call task() now.",
      }, null, 2)
    }

    return JSON.stringify({ error: `Unknown action: '${args.action}'` }, null, 2)
  },
})
