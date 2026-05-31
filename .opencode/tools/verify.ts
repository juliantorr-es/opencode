import { tool } from "@opencode-ai/plugin"
import { resolve } from "node:path"
import { existsSync } from "node:fs"

function r(worktree: string, p: string): string { return resolve(worktree, p) }

const REQUIRED = ["status", "files_created", "files_modified", "verification", "blockers", "deferred"]
const VALID = ["completed", "failed", "partial", "blocked", "frozen", "cancelled"]

export default tool({
  description: "Verify handoff JSON or file existence. One tool for all verification.",
  args: {
    action: tool.schema.string().describe("handoff | files | preflight"),
    handoff_json: tool.schema.string().optional().describe("Handoff JSON (for handoff)"),
    files_json: tool.schema.string().optional().describe("JSON array of file paths to verify existence (for files)"),
  },
  async execute(args, context) {
    if (args.action === "handoff") {
      let h: any
      try { h = JSON.parse(args.handoff_json || "{}") } catch { return JSON.stringify({ action: "handoff", status: "fail", errors: ["Invalid JSON"] }, null, 2) }
      const errors: string[] = []
      for (const f of REQUIRED) { if (!(f in h)) errors.push(`Missing: ${f}`) }
      if (h.status && !VALID.includes(h.status)) errors.push(`Invalid status: ${h.status}`)
      return JSON.stringify({ action: "handoff", status: errors.length ? "fail" : "pass", errors, present: REQUIRED.filter(f => f in h), missing: REQUIRED.filter(f => !(f in h)) }, null, 2)
    }

    if (args.action === "files") {
      let files: string[] = []
      try { files = JSON.parse(args.files_json || "[]") } catch { return JSON.stringify({ error: "files_json must be a JSON array" }, null, 2) }
      const missing: string[] = [], present: string[] = []
      for (const f of files) { (existsSync(r(context.worktree, f)) ? present : missing).push(f) }
      return JSON.stringify({ action: "files", status: missing.length ? "fail" : "pass", claimed: files.length, present: present.length, missing, hint: missing.length ? "Files don't exist. Subagent fabricated claims." : "All verified." }, null, 2)
    }

    if (args.action === "preflight") {
      const fp = r(context.worktree, args.handoff_json || ".");
      const exists = existsSync(fp);
      return JSON.stringify({ action: "preflight", file: args.handoff_json, verdict: exists ? "allowed" : "new_file", exists }, null, 2);
    }
    return JSON.stringify({ error: `Unknown action: '${args.action}'` }, null, 2)
  },
})
