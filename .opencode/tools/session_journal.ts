import { tool } from "@opencode-ai/plugin"
import { resolve } from "node:path"
import { existsSync, mkdirSync, appendFileSync, readFileSync, unlinkSync, readdirSync } from "node:fs"

function r(worktree: string, p: string): string { return resolve(worktree, p) }

function journalPath(worktree: string): string {
  return r(worktree, "docs/json/opencode/journal/session_journal.v1.jsonl")
}

export default tool({
  description: "Persistent cross-session journal. Leaf agents log their tool outputs here so the GM/orchestrator can read them — even after a crash and restart. At session end, call cleanup to remove the journal file. Use 'log' to record work, 'read' to inspect, 'resume' to pick up where a lane left off, 'cleanup' to garbage collect.",
  args: {
    action: tool.schema.string().describe("'log' to record tool output | 'read' to inspect journal | 'resume' to check what a lane last did | 'cleanup' to delete the journal file"),
    lane_id: tool.schema.string().describe("Lane identifier."),
    agent: tool.schema.string().optional().describe("Filter by agent name (for 'read'/'resume')."),
    tool_name: tool.schema.string().optional().describe("Tool name (for 'log')."),
    output_summary: tool.schema.string().optional().describe("Brief summary of what the tool produced (for 'log', max 500 chars)."),
    output_full: tool.schema.string().optional().describe("Full tool output — can be large (for 'log')."),
    exit_code: tool.schema.number().optional().describe("Tool exit code (for 'log')."),
    files_touched: tool.schema.string().optional().describe("JSON array of files read/modified/created (for 'log')."),
    session_id: tool.schema.string().optional().describe("Session ID to filter by (for 'read'). Defaults to current session."),
    max_entries: tool.schema.number().optional().describe("Max entries to return (for 'read', default 50)."),
  },
  async execute(args, context) {
    const jp = journalPath(context.worktree)
    try { mkdirSync(r(context.worktree, "docs/json/opencode/journal"), { recursive: true }) } catch (_) {}
    const now = new Date().toISOString()

    // ── LOG: record tool output ──
    if (args.action === "log") {
      let filesTouched: string[] = []
      if (args.files_touched) {
        try { filesTouched = JSON.parse(args.files_touched) } catch {}
      }

      const entry = {
        at: now,
        lane_id: args.lane_id,
        agent: context.agent,
        session_id: context.sessionID,
        tool: args.tool_name || "unknown",
        exit_code: args.exit_code,
        summary: (args.output_summary || "").slice(0, 500),
        output: (args.output_full || "").slice(0, 10000),
        files_touched: filesTouched.slice(0, 50),
      }
      try { appendFileSync(jp, JSON.stringify(entry) + "\n", "utf8") } catch (_) {}

      return JSON.stringify({
        status: "logged",
        action: "log",
        tool: args.tool_name,
        lane_id: args.lane_id,
        hint: "Output recorded. The orchestrator can read it via session_journal(action='read').",
      }, null, 2)
    }

    // ── READ: inspect journal ──
    if (args.action === "read") {
      if (!existsSync(jp)) {
        return JSON.stringify({ action: "read", entries: [], count: 0, hint: "Journal is empty — no work logged yet." }, null, 2)
      }

      const entries: any[] = []
      try {
        const lines = readFileSync(jp, "utf8").split("\n").filter(Boolean)
        for (const line of lines) {
          try {
            const e = JSON.parse(line)
            // Filter by lane, agent, session
            if (args.lane_id && e.lane_id !== args.lane_id) continue
            if (args.agent && e.agent !== args.agent) continue
            if (args.session_id && e.session_id !== args.session_id) continue
            entries.push({
              at: e.at,
              lane_id: e.lane_id,
              agent: e.agent,
              tool: e.tool,
              exit_code: e.exit_code,
              summary: (e.summary || "").slice(0, 200),
              output_preview: (e.output || "").slice(0, 500),
              files_touched: e.files_touched?.slice(0, 10),
            })
          } catch {}
        }
      } catch {
        return JSON.stringify({ action: "read", error: "Cannot read journal" }, null, 2)
      }

      const max = args.max_entries ?? 50
      const recent = entries.slice(-max)

      return JSON.stringify({
        action: "read",
        entries: recent,
        count: recent.length,
        total: entries.length,
        hint: recent.length === 0 ? "No entries match your filters." : undefined,
      }, null, 2)
    }

    // ── RESUME: check what a lane last did ──
    if (args.action === "resume") {
      if (!existsSync(jp)) {
        return JSON.stringify({ action: "resume", lane_id: args.lane_id, status: "fresh", hint: "No journal entries for this lane. Start from scratch." }, null, 2)
      }

      const entries: any[] = []
      try {
        const lines = readFileSync(jp, "utf8").split("\n").filter(Boolean)
        for (const line of lines) {
          try {
            const e = JSON.parse(line)
            if (e.lane_id !== args.lane_id) continue
            if (args.agent && e.agent !== args.agent) continue
            entries.push(e)
          } catch {}
        }
      } catch {
        return JSON.stringify({ action: "resume", error: "Cannot read journal" }, null, 2)
      }

      if (entries.length === 0) {
        return JSON.stringify({ action: "resume", lane_id: args.lane_id, status: "fresh", hint: "No prior work for this lane." }, null, 2)
      }

      // Group by agent
      const byAgent: Record<string, any[]> = {}
      for (const e of entries) {
        const a = e.agent || "unknown"
        if (!byAgent[a]) byAgent[a] = []
        byAgent[a].push(e)
      }

      // Last entry per agent
      const lastPerAgent: any[] = []
      for (const [agent, agentEntries] of Object.entries(byAgent)) {
        const last = agentEntries[agentEntries.length - 1]
        lastPerAgent.push({
          agent,
          tool_count: agentEntries.length,
          last_tool: last.tool,
          last_summary: (last.summary || "").slice(0, 200),
          last_at: last.at,
          files_touched: last.files_touched?.slice(0, 20) || [],
        })
      }

      return JSON.stringify({
        action: "resume",
        lane_id: args.lane_id,
        total_entries: entries.length,
        agents: lastPerAgent,
        hint: "Use session_journal(action='read') for detailed entries. To resume: deploy agents only for work not yet done.",
      }, null, 2)
    }

    // ── CLEANUP: garbage collect the journal ──
    if (args.action === "cleanup") {
      if (!existsSync(jp)) {
        return JSON.stringify({ action: "cleanup", status: "already_clean", hint: "Journal does not exist." }, null, 2)
      }
      try { unlinkSync(jp) } catch (e: any) {
        return JSON.stringify({ action: "cleanup", status: "error", error: e.message }, null, 2)
      }
      return JSON.stringify({ action: "cleanup", status: "deleted", hint: "Journal file removed. Session complete." }, null, 2)
    }

    return JSON.stringify({ error: `Unknown action: '${args.action}'. Valid: log, read, resume, cleanup.` }, null, 2)
  },
})
