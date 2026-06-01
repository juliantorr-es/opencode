import { tool } from "@opencode-ai/plugin"
import { init } from "./db"

export default tool({
  description: "Leaf agent handoff — signal that you started working, then deliver a structured completion handoff. Uses SQLite.",
  args: {
    action: tool.schema.string().describe("'started' | 'handoff'"),
    lane_id: tool.schema.string().describe("The lane_id your orchestrator assigned you."),
    status: tool.schema.string().optional().describe("'completed' | 'failed' | 'partial' (for handoff)"),
    summary: tool.schema.string().optional().describe("One-sentence summary (for handoff)"),
    files_created: tool.schema.string().optional().describe("JSON array of file paths (for handoff)"),
    files_modified: tool.schema.string().optional().describe("JSON array of file paths (for handoff)"),
    findings: tool.schema.string().optional().describe("JSON array of findings (for handoff)"),
    blockers: tool.schema.string().optional().describe("JSON array of blockers (for handoff)"),
    next_steps: tool.schema.string().optional().describe("What next (for handoff)"),
  },
  async execute(args, context) {
    const db = init(context.worktree)
    const now = new Date().toISOString()
    const mid = now.replace(/[-:T.]/g, "").slice(0, 15)
    const agent = context.agent
    const laneId = args.lane_id

    if (args.action === "started") {
      db.run(`INSERT INTO lane_agents (lane_id, agent, status, delegated_by, delegated_at, started_at)
              VALUES (?, ?, 'started', 'orchestrator', ?, ?)`,
        laneId, agent, now, now)
      db.run(`INSERT INTO messages (message_id, kind, session_id, sender, recipient, lane_id, subject, body, sent_at)
              VALUES (?, 'handoff', ?, ?, 'orchestrator', ?, ?, ?, ?)`,
        `${mid}_leaf_started`, context.sessionID, agent, laneId,
        `${agent} started on lane ${laneId}`,
        JSON.stringify({ agent, lane_id: laneId, action: "started", status: "started" }), now)
      return JSON.stringify({ status: "acknowledged", action: "started", agent, lane_id: laneId,
        hint: "Begin work. When done, call leaf_handoff(action='handoff', ...)." }, null, 2)
    }

    if (args.action === "handoff") {
      const handoffStatus = args.status || "completed"
      let filesCreated = "[]", filesModified = "[]", findings = "[]", blockers = "[]"
      try { if (args.files_created) { JSON.parse(args.files_created); filesCreated = args.files_created } } catch {}
      try { if (args.files_modified) { JSON.parse(args.files_modified); filesModified = args.files_modified } } catch {}
      try { if (args.findings) { JSON.parse(args.findings); findings = args.findings } } catch {}
      try { if (args.blockers) { JSON.parse(args.blockers); blockers = args.blockers } } catch {}

      db.run(`INSERT INTO lane_agents (lane_id, agent, status, delegated_by, delegated_at, started_at, completed_at, summary, files_created, files_modified, findings, blockers, next_steps)
              VALUES (?, ?, ?, 'orchestrator', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        laneId, agent, handoffStatus, now, now, now, args.summary || "", filesCreated, filesModified, findings, blockers, args.next_steps || "")

      db.run(`INSERT INTO messages (message_id, kind, session_id, sender, recipient, lane_id, subject, body, sent_at)
              VALUES (?, 'handoff', ?, ?, 'orchestrator', ?, ?, ?, ?)`,
        `${mid}_leaf_handoff`, context.sessionID, agent, laneId,
        `${agent} ${handoffStatus} — ${args.summary || "no summary"}`.slice(0, 200),
        JSON.stringify({ agent, lane_id: laneId, action: "handoff", status: handoffStatus, summary: args.summary, files_created: args.files_created, files_modified: args.files_modified, findings: args.findings, blockers: args.blockers, next_steps: args.next_steps }), now)

      return JSON.stringify({ status: "delivered", action: "handoff", agent, lane_id: laneId,
        handoff_status: handoffStatus, summary: args.summary || "",
        hint: "Handoff recorded. Orchestrator reads it via read(action='messages')." }, null, 2)
    }

    return JSON.stringify({ error: `Unknown action: '${args.action}'. Valid: started, handoff.` }, null, 2)
  },
})
