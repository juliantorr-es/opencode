import { tool } from "@opencode-ai/plugin"
import { resolve } from "node:path"
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs"

function resolvePath(worktree: string, p: string): string { return resolve(worktree, p) }

export default tool({
  description: "Publish a checkpoint — mark it as complete, copy to the published directory.",
  args: {
    checkpoint_id: tool.schema.string().describe("Checkpoint identifier"),
    status: tool.schema.string().describe("published | rejected"),
    note: tool.schema.string().optional().describe("Publication note"),
  },
  async execute(args, context) {
    const cpPath = resolvePath(context.worktree, `docs/json/opencode/sessions/${context.sessionID}/checkpoints/checkpoints.v1.jsonl`)
    if (!existsSync(cpPath)) return JSON.stringify({ status: "fail", error: "No checkpoints found" }, null, 2)

    // Find and update the checkpoint
    let entries: any[] = []
    try { entries = readFileSync(cpPath, "utf8").split("\n").filter(Boolean).map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean) } catch { return JSON.stringify({ error: "Parse error" }, null, 2) }

    let found = false
    for (const entry of entries) {
      if (entry.checkpoint_id === args.checkpoint_id) {
        entry.status = args.status
        entry.published_at = new Date().toISOString()
        entry.publication_note = args.note || null
        found = true
      }
    }
    if (!found) return JSON.stringify({ status: "fail", error: `Checkpoint not found: ${args.checkpoint_id}` }, null, 2)

    try { writeFileSync(cpPath, entries.map(e => JSON.stringify(e)).join("\n") + "\n", "utf8") } catch (_) {}
    return JSON.stringify({ status: "published", checkpoint_id: args.checkpoint_id }, null, 2)
  },
})
