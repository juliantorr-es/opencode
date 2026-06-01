import { tool } from "@opencode-ai/plugin"
import { resolve } from "node:path"
import { existsSync, mkdirSync, appendFileSync, readFileSync } from "node:fs"

function r(worktree: string, p: string): string { return resolve(worktree, p) }

// ── Unified state helpers ──
function statePath(worktree: string): string {
  return r(worktree, "docs/json/opencode/coordination/lane_state.v1.jsonl")
}

function readState(filePath: string): Map<string, any> {
  const state = new Map<string, any>()
  if (!existsSync(filePath)) return state
  try {
    const lines = readFileSync(filePath, "utf8").split("\n").filter(Boolean).slice(-1000)
    for (const line of lines) {
      try {
        const entry = JSON.parse(line)
        const key = `${entry.lane_id}::${entry.agent}`
        state.set(key, entry)
      } catch {}
    }
  } catch (_) {}
  return state
}

function writeState(filePath: string, entry: Record<string, unknown>) {
  try { mkdirSync(r(filePath, ".."), { recursive: true }) } catch (_) {}
  try { appendFileSync(filePath, JSON.stringify(entry) + "\n", "utf8") } catch (_) {}
}

export default tool({
  description: "Leaf agent handoff — signal that you started working, then deliver a structured completion handoff. Use this at the START of your turn (action='started') and at the END (action='handoff'). Your orchestrator reads these from the coordination ledger via read(action='messages').",
  args: {
    action: tool.schema.string().describe("'started' to signal you began working | 'handoff' to deliver your completed results"),
    lane_id: tool.schema.string().describe("The lane_id your orchestrator assigned you."),
    status: tool.schema.string().optional().describe("'completed' | 'failed' | 'partial' (for handoff action)"),
    summary: tool.schema.string().optional().describe("One-sentence summary of what you did (for handoff)"),
    files_created: tool.schema.string().optional().describe("JSON array of file paths created (for handoff)"),
    files_modified: tool.schema.string().optional().describe("JSON array of file paths modified (for handoff)"),
    findings: tool.schema.string().optional().describe("JSON array of key findings/discoveries (for handoff)"),
    blockers: tool.schema.string().optional().describe("JSON array of blockers encountered (for handoff)"),
    next_steps: tool.schema.string().optional().describe("What the orchestrator should do next (for handoff)"),
  },
  async execute(args, context) {
    const sp = statePath(context.worktree)
    const state = readState(sp)
    const now = new Date().toISOString()
    const mid = now.replace(/[-:T.]/g, "").slice(0, 15)

    const laneId = args.lane_id
    const agent = context.agent

    // ── Find our state entry ──
    const ourKey = `${laneId}::${agent}`
    const ourEntry = state.get(ourKey)

    if (!ourEntry || ourEntry.status !== "pending") {
      // We don't have a pending entry — the orchestrator may not have announced us.
      // Write one anyway so the state file stays consistent.
      writeState(sp, {
        lane_id: laneId,
        agent,
        status: args.action === "started" ? "started" : args.status || "completed",
        delegated_by: ourEntry?.delegated_by || "unknown",
        delegated_at: ourEntry?.delegated_at || now,
        started_at: args.action === "started" ? now : undefined,
        completed_at: args.action === "handoff" ? now : undefined,
      })
    } else if (args.action === "started") {
      writeState(sp, {
        lane_id: laneId,
        agent,
        status: "started",
        delegated_by: ourEntry.delegated_by,
        delegated_at: ourEntry.delegated_at,
        started_at: now,
      })
    } else if (args.action === "handoff") {
      const handoffStatus = args.status || "completed"
      // Parse JSON arrays safely
      let filesCreated: string[] = []
      let filesModified: string[] = []
      let findings: string[] = []
      let blockers: string[] = []
      try { if (args.files_created) filesCreated = JSON.parse(args.files_created) } catch {}
      try { if (args.files_modified) filesModified = JSON.parse(args.files_modified) } catch {}
      try { if (args.findings) findings = JSON.parse(args.findings) } catch {}
      try { if (args.blockers) blockers = JSON.parse(args.blockers) } catch {}

      // Update state
      writeState(sp, {
        lane_id: laneId,
        agent,
        status: handoffStatus,
        delegated_by: ourEntry.delegated_by,
        delegated_at: ourEntry.delegated_at,
        started_at: ourEntry.started_at || now,
        completed_at: now,
        summary: args.summary || "",
        files_created: filesCreated,
        files_modified: filesModified,
        findings,
        blockers,
        next_steps: args.next_steps || "",
      })
    }

    // ── Write to coordination ledger so orchestrator can read it ──
    const logPath = r(context.worktree, "docs/json/opencode/coordination/messages.v1.jsonl")
    try { mkdirSync(r(context.worktree, "docs/json/opencode/coordination"), { recursive: true }) } catch (_) {}

    const messageKind = args.action === "started" ? "handoff" : "handoff"
    const body: Record<string, unknown> = {
      agent,
      lane_id: laneId,
      action: args.action,
      status: args.action === "started" ? "started" : args.status || "completed",
      session_id: context.sessionID,
    }

    if (args.action === "handoff") {
      body.summary = args.summary
      body.files_created = args.files_created
      body.files_modified = args.files_modified
      body.findings = args.findings
      body.blockers = args.blockers
      body.next_steps = args.next_steps
    }

    const msg = {
      schema_version: "v1",
      message_id: `${mid}_leaf_${args.action}`,
      kind: messageKind,
      session_id: context.sessionID,
      sender: agent,
      recipient: ourEntry?.delegated_by || "orchestrator",
      lane_id: laneId,
      subject: args.action === "started"
        ? `${agent} started on lane ${laneId}`
        : `${agent} ${args.status || "completed"} — ${args.summary || "no summary"}`.slice(0, 200),
      body: JSON.stringify(body),
      sent_at: now,
    }
    try { appendFileSync(logPath, JSON.stringify(msg) + "\n", "utf8") } catch (_) {}

    if (args.action === "started") {
      return JSON.stringify({
        status: "acknowledged",
        action: "started",
        agent,
        lane_id: laneId,
        hint: "Begin your work. When done, call leaf_handoff(action='handoff', ...) to deliver your results.",
      }, null, 2)
    }

    return JSON.stringify({
      status: "delivered",
      action: "handoff",
      agent,
      lane_id: laneId,
      handoff_status: args.status || "completed",
      summary: args.summary || "",
      logged_to: "lane_state + coordination ledger",
      hint: "Your handoff has been recorded. The orchestrator will read it via read(action='messages').",
    }, null, 2)
  },
})
