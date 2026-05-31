import { tool } from "@opencode-ai/plugin"
import { resolve } from "node:path"
import { existsSync, mkdirSync, appendFileSync, readFileSync } from "node:fs"

function r(worktree: string, p: string): string { return resolve(worktree, p) }

const LEAF_RULES: Record<string, string[]> = {
  "cartographer": ["surveyor", "diff-historian", "module-grapher", "test-reader"],
  "architect": ["architecture-reviewer", "impact-assessor", "risk-enumerator", "root-cause-analyst", "validation-designer"],
  "critic": ["convergence-checker", "coupling-auditor", "debuggability-forecaster", "error-trace-auditor", "isolation-tester", "reversibility-checker", "surface-area-mapper"],
  "surgeon": ["scalpel", "vitals", "stress-test", "second-opinion", "tourniquet", "monitor"],
  "trial": ["lab-rat", "control-group", "blind-spot", "fire-drill", "stopwatch", "type-guard", "sign-off", "assumption-challenger", "edge-case-enumerator", "state-poisoner", "dependency-saboteur", "security-adversary", "first-responder", "triage", "scope", "quarantine", "autopsy", "discharge", "authority-adversary", "claim-adversary", "evidence-adversary", "stress"],
  "journalist": ["scoop", "editor", "byline", "press", "retort", "headline"],
}

// Teams that MUST be spawned in order (surgeon's team)
const ORDERED_TEAMS: Record<string, string[]> = {
  "surgeon": ["scalpel"], // scalpel first, then vitals+stress-test+second-opinion+monitor in parallel, tourniquet on-demand
  "journalist": ["scoop", "editor", "byline", "press"], // sequential
}

function getPrerequisite(caller: string, agent: string): string | null {
  const order = ORDERED_TEAMS[caller]
  if (!order) return null
  const idx = order.indexOf(agent)
  if (idx <= 0) return null
  return order[idx - 1]!
}

function readLaneLeafHistory(logPath: string, laneId: string): Set<string> {
  const completed = new Set<string>()
  if (!existsSync(logPath)) return completed
  try {
    const lines = readFileSync(logPath, "utf8").split("\n").filter(Boolean).slice(-300)
    for (const line of lines) {
      try {
        const msg = JSON.parse(line)
        const body = typeof msg.body === "string" ? (() => { try { return JSON.parse(msg.body) } catch { return {} } })() : (msg.body || {})
        if (body.lane_id !== laneId) continue
        if (msg.kind === "handoff" && body.status === "completed") {
          completed.add(msg.sender || body.agent || "")
        }
      } catch {}
    }
  } catch (_) {}
  return completed
}

export default tool({
  description: "Spawn a leaf agent. Enforces team membership and ordering where required. Surgeon's team must spawn scalpel first. Journalist's team spawns sequentially. Cartographer/architect/critic/trial teams can spawn in parallel.",
  args: {
    agent: tool.schema.string().describe("Leaf agent to spawn — must be in your team"),
    task: tool.schema.string().describe("What the leaf agent should do"),
    lane_id: tool.schema.string().describe("Lane identifier — required."),
  },
  async execute(args, context) {
    const logPath = r(context.worktree, "docs/json/opencode/coordination/messages.v1.jsonl")
    try { mkdirSync(r(context.worktree, "docs/json/opencode/coordination"), { recursive: true }) } catch (_) {}

    const caller = context.agent
    const allowed = LEAF_RULES[caller]

    if (!allowed) {
      return JSON.stringify({
        status: "blocked",
        error: `'${caller}' is not an orchestrator. Only lifecycle orchestrators spawn leaf agents.`,
        hint: "GM uses lane_spawn. Leaf agents don't spawn anything.",
      }, null, 2)
    }

    if (!allowed.includes(args.agent)) {
      return JSON.stringify({
        status: "blocked",
        error: `'${caller}' cannot spawn '${args.agent}'.`,
        allowed,
        hint: `Your team: ${allowed.join(", ")}.`,
      }, null, 2)
    }

    const task = args.task.trim()
    if (task.length < 10) {
      return JSON.stringify({ status: "blocked", error: "Task too short." }, null, 2)
    }

    const laneId = args.lane_id
    const completed = readLaneLeafHistory(logPath, laneId)

    // Enforce ordering for ordered teams
    const prereq = getPrerequisite(caller, args.agent)
    if (prereq && !completed.has(prereq)) {
      return JSON.stringify({
        status: "blocked",
        error: `${caller}'s team requires '${prereq}' to complete before spawning '${args.agent}'.`,
        lane_id: laneId,
        completed: [...completed],
        hint: `Spawn ${prereq} first, wait for its handoff, then spawn ${args.agent}.`,
      }, null, 2)
    }

    const mid = new Date().toISOString().replace(/[-:T.]/g, "").slice(0, 15)
    const escapedTask = task.replace(/"/g, '\\"')

    const msg = {
      schema_version: "v1", message_id: `${mid}_leaf_spawn`, kind: "delegation",
      session_id: context.sessionID, sender: caller, recipient: args.agent,
      lane_id: laneId,
      subject: task.slice(0, 120),
      body: JSON.stringify({ agent: args.agent, task, lane_id: laneId, background: true, delegated_by: caller, delegated_at: new Date().toISOString() }),
      sent_at: new Date().toISOString(),
    }
    try { appendFileSync(logPath, JSON.stringify(msg) + "\n", "utf8") } catch (_) {}

    const isOrdered = ORDERED_TEAMS[caller]
    const allAllowed = allowed
    const canParallel = !isOrdered || !isOrdered.includes(args.agent)

    return JSON.stringify({
      status: "approved",
      caller,
      agent: args.agent,
      lane_id: laneId,
      task: task.slice(0, 200),
      execute: `task(agent="${args.agent}", description="${args.agent}", prompt="${escapedTask}", background: true)`,
      ordering: canParallel ? "parallel — spawn all remaining team members now" : `sequential — wait for ${args.agent} to complete before spawning the next`,
      hint: "Call the 'execute' command now. Always use background: true.",
      logged_to: "coordination ledger",
    }, null, 2)
  },
})
