import { tool } from "@opencode-ai/plugin"
import { resolve } from "node:path"
import { existsSync, mkdirSync, appendFileSync } from "node:fs"

function r(worktree: string, p: string): string { return resolve(worktree, p) }

// Each orchestrator's allowed spawn targets
const SPAWN_RULES: Record<string, string[]> = {
  "general-man-agent": ["cartographer", "architect", "critic", "surgeon", "trial", "journalist", "handy-agent"],
  "cartographer": ["surveyor", "diff-historian", "module-grapher", "test-reader"],
  "architect": ["architecture-reviewer", "impact-assessor", "risk-enumerator", "root-cause-analyst", "validation-designer"],
  "critic": ["convergence-checker", "coupling-auditor", "debuggability-forecaster", "error-trace-auditor", "isolation-tester", "reversibility-checker", "surface-area-mapper"],
  "surgeon": ["scalpel", "vitals", "stress-test", "second-opinion", "tourniquet", "monitor"],
  "trial": ["lab-rat", "control-group", "blind-spot", "fire-drill", "stopwatch", "type-guard", "sign-off", "assumption-challenger", "edge-case-enumerator", "state-poisoner", "dependency-saboteur", "security-adversary", "first-responder", "triage", "scope", "quarantine", "autopsy", "discharge", "authority-adversary", "claim-adversary", "evidence-adversary", "stress"],
  "journalist": ["scoop", "editor", "byline", "press", "retort", "headline"],
}

function spawnable(caller: string, target: string): boolean {
  const allowed = SPAWN_RULES[caller]
  if (!allowed) return true // unknown agent — let OpenCode permissions decide
  return allowed.includes(target)
}

export default tool({
  description: "Delegate work or send coordination messages. For delegation: validates spawn permissions, logs to coordination ledger, and returns the exact task() call to make. For sending: delivers coordination messages to the fleet. Always prefer delegation over sending for assigning work.",
  args: {
    action: tool.schema.string().describe("'send' for coordination messages, 'delegate' to spawn an agent"),
    // delegate args
    agent: tool.schema.string().optional().describe("Target agent to spawn (for delegate)"),
    task: tool.schema.string().optional().describe("Task description — what the agent should do (for delegate)"),
    background: tool.schema.boolean().optional().describe("Run in background (default true). Always use background: true."),
    // send args
    recipient: tool.schema.string().optional().describe("Target agent or '*' (for send)"),
    kind: tool.schema.string().optional().describe("directive | blocker | handoff | alert | overscope (for send)"),
    subject: tool.schema.string().optional().describe("Subject line (for send)"),
    body: tool.schema.string().optional().describe("Message body — JSON string for structured messages (for send)"),
  },
  async execute(args, context) {
    const dir = r(context.worktree, "docs/json/opencode/coordination")
    const path = r(context.worktree, "docs/json/opencode/coordination/messages.v1.jsonl")
    try { if (!existsSync(dir)) mkdirSync(dir, { recursive: true }) } catch (_) {}

    const mid = new Date().toISOString().replace(/[-:T.]/g, "").slice(0, 15)
    const caller = context.agent

    // ── DELEGATE ────────────────────────────────────────────
    if (args.action === "delegate") {
      const target = args.agent
      if (!target) return JSON.stringify({ error: "Missing 'agent' — which agent do you want to spawn?" }, null, 2)

      const mission = args.task
      if (!mission || mission.trim().length === 0) {
        return JSON.stringify({ error: "Missing 'task' — what should the agent do?" }, null, 2)
      }

      // Enforce spawn rules
      if (!spawnable(caller, target)) {
        const allowed = SPAWN_RULES[caller]
        return JSON.stringify({
          status: "blocked",
          error: `'${caller}' cannot spawn '${target}'.`,
          allowed_agents: allowed || ["(unknown caller — no rules defined)"],
          hint: allowed
            ? `You can only spawn: ${allowed.join(", ")}. Use one of these.`
            : "Your spawn rules are not defined. Check SPAWN_RULES in smart_delegate.ts.",
        }, null, 2)
      }

      const bg = args.background ?? true
      if (!bg) {
        return JSON.stringify({
          status: "blocked",
          error: "All delegations must use background: true. Never call task() synchronously.",
        }, null, 2)
      }

      const escapedTask = mission.replace(/"/g, '\\"')

      // Log to coordination ledger
      const msg = {
        schema_version: "v1", message_id: `${mid}_delegation`, kind: "delegation",
        session_id: context.sessionID, sender: caller, recipient: target,
        subject: mission.slice(0, 120),
        body: JSON.stringify({ agent: target, task: mission, background: bg, delegated_by: caller, delegated_at: new Date().toISOString() }),
        sent_at: new Date().toISOString(),
      }
      try { appendFileSync(path, JSON.stringify(msg) + "\n", "utf8") } catch (_) {}

      return JSON.stringify({
        status: "approved",
        caller,
        spawn: target,
        mission: mission.slice(0, 200),
        execute: `task(agent="${target}", task="${escapedTask}", background: ${bg})`,
        hint: "Copy the 'execute' command and call it as your next tool invocation. All delegations must use background: true.",
        logged_to: "coordination ledger",
      }, null, 2)
    }

    // ── SEND ────────────────────────────────────────────────
    if (args.action === "send") {
      const validKinds = ["directive", "blocker", "handoff", "alert", "overscope"]
      if (args.kind && !validKinds.includes(args.kind)) {
        return JSON.stringify({ error: `Invalid kind: '${args.kind}'. Valid: ${validKinds.join(", ")}` }, null, 2)
      }

      const sendMsg = {
        schema_version: "v1", message_id: `${mid}_${args.kind || "handoff"}`,
        session_id: context.sessionID, sender: caller,
        recipient: args.recipient || "*", kind: args.kind || "handoff",
        subject: args.subject || "", body: args.body || "",
        sent_at: new Date().toISOString(),
      }
      try { appendFileSync(path, JSON.stringify(sendMsg) + "\n", "utf8") } catch (_) {}

      const hint = `coordinate(action="send") is for communication only. To spawn work, use smart_delegate(action="delegate", agent="...", task="...") which validates spawn permissions and returns the exact task() call.`
      return JSON.stringify({
        action: "send", status: "delivered", kind: args.kind, recipient: args.recipient,
        hint, logged_to: "coordination ledger",
      }, null, 2)
    }

    return JSON.stringify({ error: `Unknown action: '${args.action}'. Use 'send' or 'delegate'.` }, null, 2)
  },
})
