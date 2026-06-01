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

// ── Unified state file ──
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
  description: "ANNOUNCE a leaf agent BEFORE using task() to invoke it. Validates team membership. Auto-completes the previous leaf agent when advancing in ordered teams. Logs to the unified lane state file and coordination ledger. After calling this, you MUST call task() with background: true to actually spawn the leaf agent.",
  args: {
    agent: tool.schema.string().describe("Leaf agent to spawn — must be in your team"),
    task: tool.schema.string().describe("What the leaf agent should do"),
    lane_id: tool.schema.string().describe("Lane identifier — required."),
  },
  async execute(args, context) {
    const sp = statePath(context.worktree)
    const state = readState(sp)
    const caller = context.agent
    const allowed = LEAF_RULES[caller]

    if (!allowed) {
      return JSON.stringify({
        status: "blocked",
        error: `'${caller}' is not an orchestrator. Only lifecycle orchestrators spawn leaf agents.`,
        hint: "GM uses announce_lane_before_using_task_to_invoke_the_subagent. Leaf agents don't spawn anything.",
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

    // ── Auto-complete prerequisite when advancing ──
    const prereq = getPrerequisite(caller, args.agent)
    if (prereq) {
      const prereqKey = `${laneId}::${prereq}`
      const prereqEntry = state.get(prereqKey)
      if (prereqEntry && prereqEntry.status === "pending") {
        writeState(sp, {
          lane_id: laneId,
          agent: prereq,
          status: "completed",
          delegated_by: prereqEntry.delegated_by,
          delegated_at: prereqEntry.delegated_at,
          completed_at: new Date().toISOString(),
          auto_completed: true,
          advanced_by: args.agent,
        })
      }
    }

    // ── Write pending state ──
    const now = new Date().toISOString()
    writeState(sp, {
      lane_id: laneId,
      agent: args.agent,
      status: "pending",
      delegated_by: caller,
      delegated_at: now,
      task: task.slice(0, 200),
    })

    // ── Wrap task with leaf_handoff instructions and write to coordination ledger ──
    const logPath = r(context.worktree, "docs/json/opencode/coordination/messages.v1.jsonl")
    try { mkdirSync(r(context.worktree, "docs/json/opencode/coordination"), { recursive: true }) } catch (_) {}
    const mid = now.replace(/[-:T.]/g, "").slice(0, 15)
    const wrappedTask = `START by calling leaf_handoff(action="started", lane_id="${laneId}"). After EVERY significant tool call (test runs, file reads, writes, searches), call session_journal(action="log", lane_id="${laneId}", tool_name="...", output_summary="...", output_full="...", files_touched="[...]") to record your output. This lets the orchestrator resume if the session crashes. To check for pings: ping(action="check", lane_id="${laneId}"). When COMPLETE, call leaf_handoff(action="handoff", lane_id="${laneId}", status="completed|failed|partial", summary="...", files_created="[...]", files_modified="[...]", findings="[...]", blockers="[...]", next_steps="..."). YOUR TASK: ${task}`
    const escapedTask = wrappedTask.replace(/"/g, '\\"')
    const msg = {
      schema_version: "v1", message_id: `${mid}_announce_leaf`, kind: "delegation",
      session_id: context.sessionID, sender: caller, recipient: args.agent,
      lane_id: laneId,
      subject: task.slice(0, 120),
      body: JSON.stringify({ agent: args.agent, task: wrappedTask, lane_id: laneId, background: true, delegated_by: caller, delegated_at: now }),
      sent_at: now,
    }
    try { appendFileSync(logPath, JSON.stringify(msg) + "\n", "utf8") } catch (_) {}

    const isOrdered = ORDERED_TEAMS[caller]
    const canParallel = !isOrdered || !isOrdered.includes(args.agent)

    return JSON.stringify({
      status: "approved",
      caller,
      agent: args.agent,
      lane_id: laneId,
      task: task.slice(0, 200),
      execute: `task(agent="${args.agent}", description="${args.agent}", prompt="${escapedTask}", background: true)`,
      ordering: canParallel ? "parallel — announce + task() ALL remaining team members in this turn" : `sequential — after task() for ${args.agent}, wait for completion before announcing the next`,
      hint: "Call task() with background: true for this agent. If parallel, announce ALL remaining team members now.",
      logged_to: "lane_state + coordination ledger",
    }, null, 2)
  },
})
