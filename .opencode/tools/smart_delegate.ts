import { spawnSync } from "node:child_process"
import { tool } from "@opencode-ai/plugin"
import { resolve } from "node:path"
import { existsSync, mkdirSync, appendFileSync, readFileSync } from "node:fs"

function r(worktree: string, p: string): string { return resolve(worktree, p) }

function jqlQuery(worktree: string, filePath: string, query: string): any {
  const fullPath = r(worktree, filePath)
  if (!existsSync(fullPath)) return null
  const binaries = ["jql", "/opt/homebrew/bin/jql", "/usr/local/bin/jql"]
  for (const bin of binaries) {
    const result = spawnSync(bin, [query, fullPath], {
      encoding: "utf8", maxBuffer: 1024 * 1024 * 5, timeout: 15000,
    })
    if (!result.error && result.status === 0 && result.stdout?.trim()) {
      try { return JSON.parse(result.stdout.trim()) } catch { return null }
    }
  }
  return null
}

// ── Spawn rules: each orchestrator can only spawn its leaf agents ──
const SPAWN_RULES: Record<string, string[]> = {
  "general-man-agent": ["cartographer", "architect", "critic", "surgeon", "trial", "journalist", "handy-agent"],
  "cartographer": ["surveyor", "diff-historian", "module-grapher", "test-reader"],
  "architect": ["architecture-reviewer", "impact-assessor", "risk-enumerator", "root-cause-analyst", "validation-designer"],
  "critic": ["convergence-checker", "coupling-auditor", "debuggability-forecaster", "error-trace-auditor", "isolation-tester", "reversibility-checker", "surface-area-mapper"],
  "surgeon": ["scalpel", "vitals", "stress-test", "second-opinion", "tourniquet", "monitor"],
  "trial": ["lab-rat", "control-group", "blind-spot", "fire-drill", "stopwatch", "type-guard", "sign-off", "assumption-challenger", "edge-case-enumerator", "state-poisoner", "dependency-saboteur", "security-adversary", "first-responder", "triage", "scope", "quarantine", "autopsy", "discharge", "authority-adversary", "claim-adversary", "evidence-adversary", "stress"],
  "journalist": ["scoop", "editor", "byline", "press", "retort", "headline"],
}

// ── Lifecycle order: which wave follows which ──
const LIFECYCLE_ORDER: Record<string, string> = {
  "cartographer": "architect",
  "architect": "critic",
  "critic": "surgeon",
  "surgeon": "trial",
  "trial": "journalist",
  "journalist": "",  // end of lane
}

// ── Wave mapping ──
const AGENT_WAVE: Record<string, string> = {
  "general-man-agent": "orchestration",
  "cartographer": "cartography", "surveyor": "cartography", "diff-historian": "cartography", "module-grapher": "cartography", "test-reader": "cartography",
  "architect": "plan", "architecture-reviewer": "plan", "impact-assessor": "plan", "risk-enumerator": "plan", "root-cause-analyst": "plan", "validation-designer": "plan",
  "critic": "review", "convergence-checker": "review", "coupling-auditor": "review", "debuggability-forecaster": "review", "error-trace-auditor": "review", "isolation-tester": "review", "reversibility-checker": "review", "surface-area-mapper": "review",
  "surgeon": "execution", "scalpel": "execution", "vitals": "execution", "stress-test": "execution", "second-opinion": "execution", "tourniquet": "execution", "monitor": "execution", "handy-agent": "execution",
  "trial": "validation", "lab-rat": "validation", "control-group": "validation", "blind-spot": "validation", "fire-drill": "validation", "stopwatch": "validation", "type-guard": "validation", "sign-off": "validation", "assumption-challenger": "validation", "edge-case-enumerator": "validation", "state-poisoner": "validation", "dependency-saboteur": "validation", "security-adversary": "validation", "first-responder": "validation", "triage": "validation", "scope": "validation", "quarantine": "validation", "autopsy": "validation", "discharge": "validation", "authority-adversary": "validation", "claim-adversary": "validation", "evidence-adversary": "validation", "stress": "validation",
  "journalist": "publication", "scoop": "publication", "editor": "publication", "byline": "publication", "press": "publication", "retort": "publication", "headline": "publication",
}

function spawnable(caller: string, target: string): boolean {
  return (SPAWN_RULES[caller] || []).includes(target)
}

function waveFor(agent: string): string {
  return AGENT_WAVE[agent] || "unknown"
}

// Read coordination history to determine lane state
function readLaneState(coordPath: string, laneId: string): { wave: string; repairRound: number; agents: string[] } {
  const state = { wave: "cartography", repairRound: 0, agents: [] as string[] }
  if (!existsSync(coordPath)) return state
  try {
    const lines = readFileSync(coordPath, "utf8").split("\n").filter(Boolean)
    for (const line of lines) {
      try {
        const msg = JSON.parse(line)
        const body = typeof msg.body === "string" ? (() => { try { return JSON.parse(msg.body) } catch { return {} } })() : (msg.body || {})
        if (body.lane_id !== laneId) continue
        if (msg.kind === "delegation") {
          state.agents.push(msg.recipient || body.agent)
          const w = waveFor(msg.recipient || body.agent)
          if (w !== "unknown" && w !== "orchestration") state.wave = w
          if (body.repair_round) state.repairRound = Math.max(state.repairRound, body.repair_round)
        }
      } catch {}
    }
  } catch (_) {}
  return state
}

export const modeDescriptions = {
  orchestrator: "Delegate work to subagents with lane tracking, lifecycle management, and spawn-permission enforcement.",
  "general-man-agent": "Fan out independent subtasks to specialized subagents in parallel. Track results via the coordination ledger.",
} as const

export default tool({
  description: "Delegate work to agents or send coordination messages. Enforces spawn permissions, tracks lane lifecycle, generates structured task prompts, and logs everything to the coordination ledger. The single tool for all orchestration — never use bare task() or coordinate().",
  args: {
    action: tool.schema.string().describe("'delegate' to spawn an agent, 'send' for coordination messages"),
    // Delegate args
    agent: tool.schema.string().optional().describe("Target agent to spawn (for delegate)"),
    task: tool.schema.string().optional().describe("What the agent should do. Be specific: include file paths, expected output, and constraints."),
    lane_id: tool.schema.string().optional().describe("Lane identifier. Auto-generated if omitted. Use the same lane_id for all agents in the same lane."),
    repair_round: tool.schema.number().optional().describe("Repair round number (1-3). Set when trial found issues and this is a repair delegation."),
    background: tool.schema.boolean().optional().describe("Run in background (default true). Never use false."),
    // Send args
    recipient: tool.schema.string().optional().describe("Target agent name or '*' (for send)"),
    kind: tool.schema.string().optional().describe("directive | blocker | handoff | alert | overscope (for send)"),
    subject: tool.schema.string().optional().describe("One-line summary (for send)"),
    body: tool.schema.string().optional().describe("JSON string with structured message data (for send)"),
  },
  async execute(args, context) {
    const dir = r(context.worktree, "docs/json/opencode/coordination")
    const logPath = r(context.worktree, "docs/json/opencode/coordination/messages.v1.jsonl")
    try { if (!existsSync(dir)) mkdirSync(dir, { recursive: true }) } catch (_) {}

    const mid = new Date().toISOString().replace(/[-:T.]/g, "").slice(0, 15)
    const caller = context.agent
    const laneId = args.lane_id || `${caller}-${mid}`

    // ── DELEGATE ────────────────────────────────────────────
    if (args.action === "delegate") {
      const target = args.agent
      if (!target) return JSON.stringify({ status: "error", error: "Missing 'agent' — which agent do you want to spawn?" }, null, 2)

      const mission = (args.task || "").trim()
      if (mission.length < 10) {
        return JSON.stringify({ status: "error", error: "Task description too short. Provide a detailed task with file paths, expected output, and constraints." }, null, 2)
      }

      // Enforce spawn rules
      if (!spawnable(caller, target)) {
        const allowed = SPAWN_RULES[caller]
        return JSON.stringify({
          status: "blocked",
          error: `'${caller}' cannot spawn '${target}'.`,
          allowed_agents: allowed || [],
          hint: allowed?.length ? `You can spawn: ${allowed.join(", ")}` : "No spawn rules defined for this caller.",
        }, null, 2)
      }

      // Enforce background
      if (args.background === false) {
        return JSON.stringify({ status: "blocked", error: "Synchronous delegation is forbidden. All delegations must use background: true." }, null, 2)
      }

      // Read lane state for context
      const laneState = readLaneState(logPath, laneId)
      const repairRound = args.repair_round || laneState.repairRound
      const targetWave = waveFor(target)

      // Build enriched task with wave context
      let enrichedTask = mission
      if (laneState.agents.length > 0 && targetWave !== "orchestration") {
        enrichedTask = `[Lane ${laneId}] [Wave: ${targetWave}]${repairRound > 0 ? ` [Repair round ${repairRound}/3]` : ""}\n\n${mission}\n\nPrevious agents in this lane: ${laneState.agents.join(" → ")}`
      }

      const escapedTask = enrichedTask.replace(/"/g, '\\"').replace(/\n/g, '\\n')

      // Build the exact task() command
      const taskCmd = `task(agent="${target}", description="${target} ${targetWave}", prompt="${escapedTask}", background: true)`

      // Log to coordination ledger
      const msg = {
        schema_version: "v1", message_id: `${mid}_delegation`, kind: "delegation",
        session_id: context.sessionID, sender: caller, recipient: target,
        lane_id: laneId, wave: targetWave, repair_round: repairRound,
        subject: mission.slice(0, 120),
        body: JSON.stringify({
          agent: target, task: mission, enriched_task: enrichedTask,
          lane_id: laneId, wave: targetWave, repair_round: repairRound,
          background: true, delegated_by: caller, delegated_at: new Date().toISOString(),
        }),
        sent_at: new Date().toISOString(),
      }
      try { appendFileSync(logPath, JSON.stringify(msg) + "\n", "utf8") } catch (_) {}

      // Suggest next wave
      const nextAgent = LIFECYCLE_ORDER[target]
      const nextHint = nextAgent
        ? `After ${target} completes, the next wave is '${nextAgent}'. Delegate to ${nextAgent} next.`
        : `This is the final wave for lane ${laneId}.`

      // Check for repair loop
      const repairWarning = repairRound >= 3
        ? "⚠️  Repair round 3/3 — if trial fails again, escalate to the user."
        : repairRound > 0
          ? `Repair round ${repairRound}/3 — max 3 rounds.`
          : ""

      return JSON.stringify({
        status: "approved",
        caller, target, wave: targetWave, lane_id: laneId,
        repair_round: repairRound || undefined,
        previous_agents: laneState.agents.length > 0 ? laneState.agents : undefined,
        execute: taskCmd,
        enriched_task: enrichedTask.slice(0, 300),
        next: nextHint,
        repair: repairWarning || undefined,
        hint: "Call the 'execute' command as your next tool invocation to spawn the agent.",
        logged_to: "coordination ledger",
      }, null, 2)
    }

    // ── SEND ────────────────────────────────────────────────
    if (args.action === "send") {
      const validKinds: Record<string, string> = {
        "directive": "A command/instruction to another agent",
        "blocker": "Reporting a blocker — needs a decision",
        "handoff": "Lane or wave complete — structured results",
        "alert": "Unexpected finding — awareness, no decision needed",
        "overscope": "Lane too big — propose splitting into N parallel lanes",
      }

      if (args.kind && !validKinds[args.kind]) {
        return JSON.stringify({
          status: "error",
          error: `Invalid kind: '${args.kind}'.`,
          valid_kinds: Object.keys(validKinds),
          descriptions: validKinds,
        }, null, 2)
      }

      const kind = args.kind || "handoff"
      const sendMsg = {
        schema_version: "v1", message_id: `${mid}_${kind}`, kind,
        session_id: context.sessionID, sender: caller,
        recipient: args.recipient || "general-man-agent",
        lane_id: laneId,
        subject: args.subject || "",
        body: args.body || "",
        sent_at: new Date().toISOString(),
      }
      try { appendFileSync(logPath, JSON.stringify(sendMsg) + "\n", "utf8") } catch (_) {}

      // Handoff-specific validation
      let handoffHint = ""
      if (kind === "handoff") {
        handoffHint = "Ensure the body contains a JSON with: lane_id, status (completed|failed|partial), files_created, files_modified, verification (typecheck, tests), blockers, and recommendation."
      }
      if (kind === "blocker") {
        handoffHint = "Ensure the body contains: blocked_at (which wave), finding (what went wrong), options (array of {id, description, effort}), recommended, and attempted."
      }
      if (kind === "overscope") {
        handoffHint = "Ensure the body contains: estimated_total_diff, proposed_lanes (array of {id, mission, target_files, estimated_diff, deps}), and rationale."
      }

      return JSON.stringify({
        action: "send", status: "delivered", kind, recipient: args.recipient, lane_id: laneId,
        hint: handoffHint || "Message delivered to coordination ledger.",
        reminder: "To spawn work, use smart_delegate(action=\"delegate\", agent=\"...\", task=\"...\"). Never use 'send' to assign work.",
        logged_to: "coordination ledger",
      }, null, 2)
    }

    return JSON.stringify({
      status: "error",
      error: `Unknown action: '${args.action}'. Valid actions: 'delegate', 'send'.`,
      examples: {
        delegate: `smart_delegate(action="delegate", agent="cartographer", task="Map the auth module — entry points, dependencies, conventions", lane_id="auth-fix")`,
        send: `smart_delegate(action="send", kind="handoff", subject="Lane auth-fix complete", body='{"lane_id":"auth-fix","status":"completed",...}')`,
      },
    }, null, 2)
  },
})
