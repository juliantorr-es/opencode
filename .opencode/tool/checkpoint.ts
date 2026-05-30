import { tool } from "@opencode-ai/plugin"
import { resolve } from "node:path"
import { existsSync, mkdirSync, appendFileSync, readFileSync, writeFileSync } from "node:fs"

function r(worktree: string, p: string): string { return resolve(worktree, p) }

export default tool({
  description: "Checkpoint management — prepare or report.",
  args: {
    action: tool.schema.string().describe("prepare | report"),
    checkpoint_id: tool.schema.string().optional().describe("Checkpoint ID"),
    description: tool.schema.string().optional().describe("What this checkpoint captures"),
    files_snapshot: tool.schema.string().optional().describe("JSON array of file paths"),
  },
  async execute(args, context) {
    if (args.action === "prepare") {
      const dir = r(context.worktree, `docs/json/opencode/sessions/${context.sessionID}/checkpoints`)
      const path = r(context.worktree, `docs/json/opencode/sessions/${context.sessionID}/checkpoints/checkpoints.v1.jsonl`)
      try { if (!existsSync(dir)) mkdirSync(dir, { recursive: true }) } catch (_) {}
      let files: string[] = []
      try { if (args.files_snapshot) files = JSON.parse(args.files_snapshot) } catch {}
      try { appendFileSync(path, JSON.stringify({ schema_version: "v1", checkpoint_id: args.checkpoint_id, description: args.description, session_id: context.sessionID, files, created_at: new Date().toISOString() }) + "\n", "utf8") } catch (_) {}
      return JSON.stringify({ action: "prepare", checkpoint_id: args.checkpoint_id }, null, 2)
    }

    if (args.action === "report") {
      const cp = r(context.worktree, `docs/json/opencode/sessions/${context.sessionID}/checkpoints/checkpoints.v1.jsonl`)
      let entries: any[] = []
      if (existsSync(cp)) { try { entries = readFileSync(cp, "utf8").split("\n").filter(Boolean).map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean) } catch {} }
      const out = r(context.worktree, `docs/json/opencode/sessions/${context.sessionID}/checkpoint_report.v1.json`)
      writeFileSync(out, JSON.stringify({ schema_version: "v1", generated_at: new Date().toISOString(), session_id: context.sessionID, checkpoints: entries, total: entries.length }, null, 2), "utf8")
      return JSON.stringify({ action: "report", checkpoints: entries.length }, null, 2)
    }

    return JSON.stringify({ error: `Unknown action: '${args.action}'` }, null, 2)
  },
})
