import { tool } from "@opencode-ai/plugin"
import { init } from "./db"

const LEAF_RULES: Record<string, string[]> = {
  "cartographer": ["surveyor", "diff-historian", "module-grapher", "test-reader"],
  "architect": ["architecture-reviewer", "impact-assessor", "risk-enumerator", "root-cause-analyst", "validation-designer"],
  "critic": ["convergence-checker", "coupling-auditor", "debuggability-forecaster", "error-trace-auditor", "isolation-tester", "reversibility-checker", "surface-area-mapper"],
  "surgeon": ["scalpel", "vitals", "stress-test", "second-opinion", "tourniquet", "monitor"],
  "trial": ["lab-rat", "control-group", "blind-spot", "fire-drill", "stopwatch", "type-guard", "sign-off", "assumption-challenger", "edge-case-enumerator", "state-poisoner", "dependency-saboteur", "security-adversary", "first-responder", "triage", "scope", "quarantine", "autopsy", "discharge", "authority-adversary", "claim-adversary", "evidence-adversary", "stress"],
  "journalist": ["scoop", "editor", "byline", "press", "retort", "headline"],
}

const ORDERED_TEAMS: Record<string, string[]> = {
  "surgeon": ["scalpel"],
  "journalist": ["scoop", "editor", "byline", "press"],
}

function getPrerequisite(caller: string, agent: string): string | null {
  const order = ORDERED_TEAMS[caller]
  if (!order) return null
  const idx = order.indexOf(agent)
  if (idx <= 0) return null
  return order[idx - 1]!
}

export default tool({
  description: "ANNOUNCE a leaf agent BEFORE using task() to invoke it. Validates team membership. Auto-completes previous leaf agents. Uses SQLite.",
  args: {
    agent: tool.schema.string().describe("Leaf agent to spawn — must be in your team"),
    task: tool.schema.string().describe("What the leaf agent should do"),
    lane_id: tool.schema.string().describe("Lane identifier — required."),
  },
  async execute(args, context) {
    const db = init(context.worktree)
    const now = new Date().toISOString()
    const caller = context.agent
    const allowed = LEAF_RULES[caller]

    if (!allowed) {
      return JSON.stringify({ status: "blocked", error: `'${caller}' is not an orchestrator.` }, null, 2)
    }
    if (!allowed.includes(args.agent)) {
      return JSON.stringify({ status: "blocked", error: `'${caller}' cannot spawn '${args.agent}'.`, allowed }, null, 2)
    }

    const task = args.task.trim()
    if (task.length < 10) {
      return JSON.stringify({ status: "blocked", error: "Task too short." }, null, 2)
    }

    const laneId = args.lane_id

    // ── Auto-complete prerequisite ──
    const prereq = getPrerequisite(caller, args.agent)
    if (prereq) {
      const row = db.query(`SELECT id, status FROM lane_agents WHERE lane_id = ? AND agent = ? ORDER BY id DESC LIMIT 1`)
        .get(laneId, prereq) as any
      if (row && row.status === "pending") {
        db.run(`INSERT INTO lane_agents (lane_id, agent, status, delegated_by, delegated_at, completed_at, auto_completed, advanced_by)
                VALUES (?, ?, 'completed', (SELECT delegated_by FROM lane_agents WHERE id = ?), (SELECT delegated_at FROM lane_agents WHERE id = ?), ?, 1, ?)`,
          laneId, prereq, row.id, row.id, now, args.agent)
      }
    }

    // ── Auto-complete stale agents ──
    db.run(`INSERT INTO lane_agents (lane_id, agent, status, delegated_by, delegated_at, completed_at, auto_completed, stale_timeout, advanced_by)
            SELECT lane_id, agent, 'stale', delegated_by, delegated_at, ?, 1, 1, ?
            FROM lane_agents la WHERE la.id IN (SELECT MAX(id) FROM lane_agents GROUP BY lane_id, agent)
              AND la.lane_id = ? AND la.status = 'pending' AND la.agent != ?
              AND la.delegated_at < datetime('now', '-5 minutes')`,
      now, args.agent, laneId, args.agent)

    // ── Write pending state ──
    db.run(`INSERT INTO lane_agents (lane_id, agent, status, delegated_by, delegated_at, task)
            VALUES (?, ?, 'pending', ?, ?, ?)`,
      laneId, args.agent, caller, now, task.slice(0, 500))

    // ── Write to messages ──
    const mid = now.replace(/[-:T.]/g, "").slice(0, 15)
    const wrappedTask = `START by calling leaf_handoff(action="started", lane_id="${laneId}"). After EVERY significant tool call, call session_journal(action="log", ...). To check for pings: ping(action="check", lane_id="${laneId}"). When COMPLETE, call leaf_handoff(action="handoff", ...). YOUR TASK: ${task}`
    db.run(`INSERT INTO messages (message_id, kind, session_id, sender, recipient, lane_id, subject, body, sent_at)
            VALUES (?, 'delegation', ?, ?, ?, ?, ?, ?, ?)`,
      `${mid}_announce_leaf`, context.sessionID, caller, args.agent, laneId,
      task.slice(0, 120), JSON.stringify({ agent: args.agent, task: wrappedTask, lane_id: laneId, background: true, delegated_by: caller, delegated_at: now }), now)

    const escapedTask = wrappedTask.replace(/"/g, '\\"')
    const isOrdered = ORDERED_TEAMS[caller]
    const canParallel = !isOrdered || !isOrdered.includes(args.agent)

    return JSON.stringify({
      status: "approved", caller, agent: args.agent, lane_id: laneId,
      task: task.slice(0, 200),
      execute: `task(agent="${args.agent}", description="${args.agent}", prompt="${escapedTask}", background: true)`,
      ordering: canParallel ? "parallel — announce + task() ALL remaining team members in this turn" : `sequential — after task() for ${args.agent}, wait for completion before announcing the next`,
      hint: "Call task() with background: true. If parallel, announce ALL remaining team members now.",
    }, null, 2)
  },
})
