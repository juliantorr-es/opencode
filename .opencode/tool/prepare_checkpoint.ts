import { tool } from "@opencode-ai/plugin"
import { resolve } from "node:path"
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"

function resolvePath(worktree: string, p: string): string { return resolve(worktree, p) }

export default tool({
  description: "Prepare a checkpoint artifact for the current session state.",
  args: {
    checkpoint_id: tool.schema.string().describe("Checkpoint identifier"),
    description: tool.schema.string().describe("What this checkpoint captures"),
    files_snapshot: tool.schema.string().optional().describe("JSON array of file paths in this checkpoint"),
  },
  async execute(args, context) {
    const dir = resolvePath(context.worktree, `docs/json/opencode/sessions/${context.sessionID}/checkpoints`)
    const path = resolvePath(context.worktree, `docs/json/opencode/sessions/${context.sessionID}/checkpoints/checkpoints.v1.jsonl`)
    try { if (!existsSync(dir)) mkdirSync(dir, { recursive: true }) } catch (_) {}

    const record = {
      schema_version: "v1", checkpoint_id: args.checkpoint_id,
      description: args.description, session_id: context.sessionID,
      files: args.files_snapshot ? (() => { try { return JSON.parse(args.files_snapshot) } catch { return [] } })() : [],
      created_at: new Date().toISOString(),
    }
    try { appendFileSync(path, JSON.stringify(record) + "\n", "utf8") } catch (_) {}
    return JSON.stringify({ status: "created", checkpoint_id: args.checkpoint_id }, null, 2)
  },
})
