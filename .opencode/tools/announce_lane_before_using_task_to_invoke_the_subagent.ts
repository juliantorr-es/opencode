import { tool } from "@opencode-ai/plugin"
import { resolve } from "node:path"
import { existsSync, mkdirSync, appendFileSync, readFileSync } from "node:fs"

function r(worktree: string, p: string): string { return resolve(worktree, p) }

const GM_SPAWNABLE = ["cartographer", "architect", "critic", "surgeon", "trial", "journalist", "handy-agent"]

// Lifecycle order: which agent must complete before the next can be spawned
const LIFECYCLE_CHAIN: Record<string, string | null> = {
  "cartographer": null,     // first — no prerequisite
  "architect": "cartographer",
  "critic": "architect",
  "surgeon": "critic",
  "trial": "surgeon",
  "journalist": "trial",
}

// Repair loop: which agents can be spawned after trial fails
const REPAIR_CHAIN: Record<string, string | null> = {
  "architect": "trial",
  "critic": "architect",
  "surgeon": "critic",
  "trial": "surgeon",
}

// ── Unified state file (one source of truth) ──
// Format per line: { lane_id, agent, status: "pending"|"completed"|"failed", delegated_by, delegated_at, completed_at }

function statePath(worktree: string): string {
  return r(worktree, "docs/json/opencode/coordination/lane_state.v1.jsonl")
}

function readState(filePath: string): Map<string, { agent: string; status: string; delegated_at: string; completed_at?: string }> {
  const state = new Map<string, { agent: string; status: string; delegated_at: string; completed_at?: string }>()
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
  description: "ANNOUNCE a lane BEFORE using task() to invoke the subagent. Auto-completes the previous lifecycle agent when advancing. Logs to the unified lane state file and coordination ledger. After calling this, you MUST call task() with background: true to actually spawn the agent.",
  args: {
    agent: tool.schema.string().describe("Agent to spawn: cartographer, architect, critic, surgeon, trial, journalist, or handy-agent"),
    task: tool.schema.string().describe("What the agent should do"),
    lane_id: tool.schema.string().describe("Lane identifier — required. Every agent in the same lane uses the same lane_id."),
    repair: tool.schema.boolean().optional().describe("Set to true if this is a repair spawn (trial found issues, re-spawning architect)."),
  },
  async execute(args, context) {
    const sp = statePath(context.worktree)
    const state = readState(sp)

    // ── Validate agent ──
    if (!GM_SPAWNABLE.includes(args.agent)) {
      return JSON.stringify({
        status: "blocked",
        error: `Cannot spawn '${args.agent}'.`,
        allowed: GM_SPAWNABLE,
        hint: `You can ONLY spawn: ${GM_SPAWNABLE.join(", ")}.`,
      }, null, 2)
    }

    const task = args.task.trim()
    if (task.length < 10) {
      return JSON.stringify({ status: "blocked", error: "Task too short. Provide specific instructions." }, null, 2)
    }

    const laneId = args.lane_id
    const isRepair = args.repair === true

    // Count previous repairs for this lane
    let repairCount = 0
    for (const [key, entry] of state) {
      if (key.startsWith(laneId + "::") && entry.repair) repairCount++
    }

    // ── Auto-complete prerequisite — the orchestrator wouldn't advance unless it finished ──
    const prerequisite = isRepair ? REPAIR_CHAIN[args.agent] || null : LIFECYCLE_CHAIN[args.agent] || null
    if (prerequisite) {
      const prereqKey = `${laneId}::${prerequisite}`
      const prereqEntry = state.get(prereqKey)
      if (prereqEntry && prereqEntry.status === "pending") {
        writeState(sp, {
          lane_id: laneId,
          agent: prerequisite,
          status: "completed",
          delegated_by: prereqEntry.delegated_by,
          delegated_at: prereqEntry.delegated_at,
          completed_at: new Date().toISOString(),
          auto_completed: true,
          advanced_by: args.agent,
        })
      }
    }

    // ── Handy-agent is always allowed ──
    if (args.agent === "handy-agent") {
      // no prerequisite
    }

    // ── Write pending state ──
    const now = new Date().toISOString()
    writeState(sp, {
      lane_id: laneId,
      agent: args.agent,
      status: "pending",
      delegated_by: context.agent,
      delegated_at: now,
      repair: isRepair || undefined,
      task: task.slice(0, 200),
    })

    // ── Wrap task with leaf_handoff instructions ──
    const logPath = r(context.worktree, "docs/json/opencode/coordination/messages.v1.jsonl")
    try { mkdirSync(r(context.worktree, "docs/json/opencode/coordination"), { recursive: true }) } catch (_) {}
    const mid = now.replace(/[-:T.]/g, "").slice(0, 15)
    const wrappedTask = `START by calling leaf_handoff(action="started", lane_id="${laneId}"). After EVERY significant tool call (test runs, file reads, writes, searches), call session_journal(action="log", lane_id="${laneId}", tool_name="...", output_summary="...", output_full="...", files_touched="[...]") to record your output. This lets the orchestrator resume if the session crashes. To check for pings: ping(action="check", lane_id="${laneId}"). When COMPLETE, call leaf_handoff(action="handoff", lane_id="${laneId}", status="completed|failed|partial", summary="...", files_created="[...]", files_modified="[...]", findings="[...]", blockers="[...]", next_steps="..."). YOUR TASK: ${task}`
    const escapedTask = wrappedTask.replace(/"/g, '\\"')

    const msg = {
      schema_version: "v1", message_id: `${mid}_announce_lane`, kind: "delegation",
      session_id: context.sessionID, sender: context.agent, recipient: args.agent,
      lane_id: laneId, repair: isRepair || undefined,
      subject: task.slice(0, 120),
      body: JSON.stringify({ agent: args.agent, task: wrappedTask, lane_id: laneId, background: true, repair: isRepair || false, delegated_by: context.agent, delegated_at: now }),
      sent_at: now,
    }
    try { appendFileSync(logPath, JSON.stringify(msg) + "\n", "utf8") } catch (_) {}

    const nextAgent = Object.entries(LIFECYCLE_CHAIN).find(([, prereq]) => prereq === args.agent)?.[0]

    return JSON.stringify({
      status: "approved",
      agent: args.agent,
      lane_id: laneId,
      repair_round: isRepair ? repairCount + 1 : undefined,
      task: task.slice(0, 200),
      execute: `task(agent="${args.agent}", description="${args.agent}", prompt="${escapedTask}", background: true)`,
      next_in_this_lane: nextAgent ? `After ${args.agent} completes, announce ${nextAgent} for lane '${laneId}'.` : `This is the final agent for lane '${laneId}'.`,
      parallel_lanes: "Each lane advances independently. If other lanes need cartographers, announce them ALL now before moving any lane forward. Never serialize independent lanes.",
      hint: "Call task() with background: true for this agent. Then announce cartographers for any remaining lanes.",
      logged_to: "lane_state + coordination ledger",
    }, null, 2)
  },
})
