import { tool } from "@opencode-ai/plugin"
import { init } from "./db"

const GM_SPAWNABLE = ["cartographer", "architect", "critic", "surgeon", "trial", "journalist", "handy-agent"]

const LIFECYCLE_CHAIN: Record<string, string | null> = {
  "cartographer": null,
  "architect": "cartographer",
  "critic": "architect",
  "surgeon": "critic",
  "trial": "surgeon",
  "journalist": "trial",
}

const REPAIR_CHAIN: Record<string, string | null> = {
  "architect": "trial",
  "critic": "architect",
  "surgeon": "critic",
  "trial": "surgeon",
}

export default tool({
  description: "ANNOUNCE a lane BEFORE using task() to invoke the subagent. Auto-completes the previous lifecycle agent when advancing. Uses SQLite for state.",
  args: {
    agent: tool.schema.string().describe("Agent to spawn: cartographer, architect, critic, surgeon, trial, journalist, or handy-agent"),
    task: tool.schema.string().describe("What the agent should do"),
    lane_id: tool.schema.string().describe("Lane identifier — required."),
    repair: tool.schema.boolean().optional().describe("Set to true if this is a repair spawn."),
  },
  async execute(args, context) {
    const db = init(context.worktree)
    const now = new Date().toISOString()

    if (!GM_SPAWNABLE.includes(args.agent)) {
      return JSON.stringify({ status: "blocked", error: `Cannot spawn '${args.agent}'.`, allowed: GM_SPAWNABLE }, null, 2)
    }

    const task = args.task.trim()
    if (task.length < 10) {
      return JSON.stringify({ status: "blocked", error: "Task too short." }, null, 2)
    }

    const laneId = args.lane_id
    const isRepair = args.repair === true
    const prerequisite = isRepair ? REPAIR_CHAIN[args.agent] || null : LIFECYCLE_CHAIN[args.agent] || null

    // ── Auto-complete prerequisite ──
    if (prerequisite) {
      const prereq = db.query(`SELECT id, status FROM lane_agents WHERE lane_id = ? AND agent = ? ORDER BY id DESC LIMIT 1`)
        .get(laneId, prerequisite) as any
      if (prereq && prereq.status === "pending") {
        db.run(`INSERT INTO lane_agents (lane_id, agent, status, delegated_by, delegated_at, completed_at, auto_completed, advanced_by)
                VALUES (?, ?, 'completed', (SELECT delegated_by FROM lane_agents WHERE id = ?), (SELECT delegated_at FROM lane_agents WHERE id = ?), ?, 1, ?)`,
          laneId, prerequisite, prereq.id, prereq.id, now, args.agent)
      }
    }

    // ── Auto-complete ALL stale agents in this lane (pending >5min) ──
    db.run(`INSERT INTO lane_agents (lane_id, agent, status, delegated_by, delegated_at, completed_at, auto_completed, stale_timeout, advanced_by)
            SELECT lane_id, agent, 'stale', delegated_by, delegated_at, ?, 1, 1, ?
            FROM lane_agents la
            WHERE la.id IN (SELECT MAX(id) FROM lane_agents GROUP BY lane_id, agent)
              AND la.lane_id = ?
              AND la.status = 'pending'
              AND la.agent != ?
              AND la.delegated_at < datetime('now', '-5 minutes')`,
      now, args.agent, laneId, args.agent)

    // ── Count previous repairs ──
    const repairRow = db.query(`SELECT COUNT(*) as cnt FROM lane_agents WHERE lane_id = ? AND repair = 1`).get(laneId) as any
    const repairCount = repairRow?.cnt || 0

    // ── Write pending state ──
    db.run(`INSERT INTO lane_agents (lane_id, agent, status, delegated_by, delegated_at, task, repair)
            VALUES (?, ?, 'pending', ?, ?, ?, ?)`,
      laneId, args.agent, context.agent, now, task.slice(0, 500), isRepair ? 1 : 0)

    // ── Write to messages table ──
    const mid = now.replace(/[-:T.]/g, "").slice(0, 15)
    const wrappedTask = `START by calling leaf_handoff(action="started", lane_id="${laneId}"). After EVERY significant tool call, call session_journal(action="log", ...). To check for pings: ping(action="check", lane_id="${laneId}"). When COMPLETE, call leaf_handoff(action="handoff", ...). YOUR TASK: ${task}`
    db.run(`INSERT INTO messages (message_id, kind, session_id, sender, recipient, lane_id, subject, body, sent_at)
            VALUES (?, 'delegation', ?, ?, ?, ?, ?, ?, ?)`,
      `${mid}_announce_lane`, context.sessionID, context.agent, args.agent, laneId,
      task.slice(0, 120), JSON.stringify({ agent: args.agent, task: wrappedTask, lane_id: laneId, background: true, delegated_by: context.agent, delegated_at: now }),
      now)

    const escapedTask = wrappedTask.replace(/"/g, '\\"')
    const nextAgent = Object.entries(LIFECYCLE_CHAIN).find(([, prereq]) => prereq === args.agent)?.[0]

    return JSON.stringify({
      status: "approved",
      agent: args.agent,
      lane_id: laneId,
      repair_round: isRepair ? repairCount + 1 : undefined,
      task: task.slice(0, 200),
      execute: `task(agent="${args.agent}", description="${args.agent}", prompt="${escapedTask}", background: true)`,
      next_in_this_lane: nextAgent ? `After ${args.agent} completes, announce ${nextAgent} for lane '${laneId}'.` : `This is the final agent for lane '${laneId}'.`,
      parallel_lanes: "Each lane advances independently. If other lanes need cartographers, announce them ALL now.",
      hint: "Call task() with background: true for this agent. Then announce cartographers for any remaining lanes.",
    }, null, 2)
  },
})
