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
  "architect": "trial",    // after trial fails → architect (repair)
  "critic": "architect",   // after architect → critic
  "surgeon": "critic",     // after critic → surgeon
  "trial": "surgeon",      // after surgeon → trial (re-test)
}

function readLaneHistory(logPath: string, laneId: string): { completed: Set<string>; spawned: string[]; repairCount: number } {
  const completed = new Set<string>()
  const spawned: string[] = []
  let repairCount = 0
  if (!existsSync(logPath)) return { completed, spawned, repairCount }
  try {
    const lines = readFileSync(logPath, "utf8").split("\n").filter(Boolean).slice(-500)
    for (const line of lines) {
      try {
        const msg = JSON.parse(line)
        const body = typeof msg.body === "string" ? (() => { try { return JSON.parse(msg.body) } catch { return {} } })() : (msg.body || {})
        if (body.lane_id !== laneId) continue
        if (msg.kind === "handoff" && body.status === "completed") {
          completed.add(msg.sender || body.agent || "")
        }
        if (msg.kind === "delegation") {
          const agent = msg.recipient || body.agent || ""
          spawned.push(agent)
          if (body.repair) repairCount++
        }
      } catch {}
    }
  } catch (_) {}
  return { completed, spawned, repairCount }
}

export default tool({
  description: "Spawn a lifecycle agent for a lane. Enforces lane ordering — you can only spawn the next agent in the lifecycle after the previous one completes. Tracks repair loops. Never use task() directly.",
  args: {
    agent: tool.schema.string().describe("Agent to spawn: cartographer, architect, critic, surgeon, trial, journalist, or handy-agent"),
    task: tool.schema.string().describe("What the agent should do"),
    lane_id: tool.schema.string().describe("Lane identifier — required. Every agent in the same lane uses the same lane_id."),
    repair: tool.schema.boolean().optional().describe("Set to true if this is a repair spawn (trial found issues, re-spawning architect)."),
  },
  async execute(args, context) {
    const logPath = r(context.worktree, "docs/json/opencode/coordination/messages.v1.jsonl")
    try { mkdirSync(r(context.worktree, "docs/json/opencode/coordination"), { recursive: true }) } catch (_) {}

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
    const history = readLaneHistory(logPath, laneId)
    const isRepair = args.repair === true

    // ── Enforce lane ordering ──
    // Determine the prerequisite
    let prerequisite: string | null = null
    if (isRepair) {
      // Repair chain: trial → architect → critic → surgeon → trial
      prerequisite = REPAIR_CHAIN[args.agent] || null
      if (prerequisite && !history.completed.has(prerequisite)) {
        return JSON.stringify({
          status: "blocked",
          error: `Cannot spawn ${args.agent} for repair — prerequisite '${prerequisite}' has not completed.`,
          lane_id: laneId,
          completed: [...history.completed],
          hint: `Wait for ${prerequisite} to handoff before spawning ${args.agent}.`,
        }, null, 2)
      }
    } else {
      // Normal lifecycle: cartographer → architect → critic → surgeon → trial → journalist
      prerequisite = LIFECYCLE_CHAIN[args.agent] || null
      if (prerequisite && !history.completed.has(prerequisite)) {
        // Check if this is a re-spawn (previous attempt failed)
        const alreadySpawned = history.spawned.includes(args.agent)
        if (!alreadySpawned) {
          return JSON.stringify({
            status: "blocked",
            error: `Cannot spawn ${args.agent} for lane '${laneId}' — prerequisite '${prerequisite}' has not completed.`,
            lane_id: laneId,
            completed: [...history.completed],
            spawned: history.spawned,
            hint: `Wait for ${prerequisite} to handoff before advancing to ${args.agent}. Lanes advance independently — don't wait for other lanes.`,
          }, null, 2)
        }
        // Re-spawning same agent is allowed (previous attempt may have failed)
      }
    }

    // ── Handy-agent is always allowed (quick fix, no lifecycle position) ──
    if (args.agent === "handy-agent") {
      prerequisite = null // no ordering for handy-agent
    }

    const mid = new Date().toISOString().replace(/[-:T.]/g, "").slice(0, 15)
    const escapedTask = task.replace(/"/g, '\\"')

    const msg = {
      schema_version: "v1", message_id: `${mid}_lane_spawn`, kind: "delegation",
      session_id: context.sessionID, sender: context.agent, recipient: args.agent,
      lane_id: laneId, repair: isRepair || undefined,
      subject: task.slice(0, 120),
      body: JSON.stringify({ agent: args.agent, task, lane_id: laneId, background: true, repair: isRepair || false, delegated_by: context.agent, delegated_at: new Date().toISOString() }),
      sent_at: new Date().toISOString(),
    }
    try { appendFileSync(logPath, JSON.stringify(msg) + "\n", "utf8") } catch (_) {}

    const nextAgent = Object.entries(LIFECYCLE_CHAIN).find(([, prereq]) => prereq === args.agent)?.[0]

    return JSON.stringify({
      status: "approved",
      agent: args.agent,
      lane_id: laneId,
      repair_round: isRepair ? history.repairCount + 1 : undefined,
      task: task.slice(0, 200),
      execute: `task(agent="${args.agent}", description="${args.agent}", prompt="${escapedTask}", background: true)`,
      next: nextAgent ? `After ${args.agent} completes, spawn ${nextAgent} for lane '${laneId}'.` : `This is the final agent for lane '${laneId}'.`,
      hint: "Call the 'execute' command now. Always use background: true.",
      logged_to: "coordination ledger",
    }, null, 2)
  },
})
