import { tool } from "@opencode-ai/plugin"
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from "node:fs"
import { resolve, dirname } from "node:path"
import { spawnSync } from "node:child_process"

function r(worktree: string, p: string): string { return resolve(worktree, p) }

function hb(context: any, tool: string, phase: string, detail: string) {
  try {
    const dir = resolve(context.worktree, "docs/json/opencode/sessions/" + context.sessionID + "/analytics")
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    appendFileSync(dir + "/heartbeat.v1.jsonl",
      JSON.stringify({ at: new Date().toISOString(), session_id: context.sessionID, agent: context.agent, tool, phase, detail: detail.slice(0, 200) }) + "\n", "utf8")
  } catch (_) {}
}

function artifactLog(context: any, event: Record<string, unknown>) {
  try {
    const dir = resolve(context.worktree, `docs/json/opencode/sessions/${context.sessionID}/artifacts`)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    appendFileSync(resolve(dir, `${context.sessionID}.v1.jsonl`),
      JSON.stringify({ at: new Date().toISOString(), ...event }) + "\n", "utf8")
  } catch (_) {}
}

export default tool({
  description: "Create new files or overwrite existing ones. Automatically creates parent directories. Returns the diff if the file already existed. Use smart_edit for targeted in-place edits.",
  args: {
    file_path: tool.schema.string().describe("Path to create (relative to worktree). Parent directories created automatically."),
    content: tool.schema.string().describe("File contents to write"),
    reason: tool.schema.string().optional().describe("Why this file is being created"),
    overwrite: tool.schema.boolean().optional().describe("Allow overwriting existing files (default: false, returns error if file exists)"),
  },
  async execute(args, context) {
    hb(context, "smart_write", "started", args.file_path?.slice(0, 80) || "")
    const fullPath = r(context.worktree, args.file_path)
    const existed = existsSync(fullPath)

    if (existed && !args.overwrite) {
      return JSON.stringify({
        status: "blocked",
        error: `File already exists: ${args.file_path}`,
        hint: "Use overwrite: true to replace the existing file, or use smart_edit to make targeted changes.",
      }, null, 2)
    }

    // Create parent directories
    try { mkdirSync(dirname(fullPath), { recursive: true }) } catch (_) {}

    let oldContent = ""
    if (existed) {
      try { oldContent = readFileSync(fullPath, "utf8") } catch (_) {}
    }

    try { writeFileSync(fullPath, args.content, "utf8") } catch (e: any) {
      return JSON.stringify({ status: "error", error: `Cannot write file: ${e.message}` }, null, 2)
    }

    // Generate diff if overwriting
    let diff = ""
    if (existed) {
      const diffResult = spawnSync("git", ["-C", context.worktree, "diff", "--", args.file_path], {
        encoding: "utf8", maxBuffer: 1024 * 1024, timeout: 5000,
      })
      diff = diffResult.stdout?.trim() || ""
    }

    hb(context, "smart_write", "completed", args.file_path?.slice(0, 80) || "")
    artifactLog(context, { tool: "smart_write", action: existed ? "overwritten" : "created", file: args.file_path, reason: args.reason })

    return JSON.stringify({
      status: "created",
      file: args.file_path,
      action: existed ? "overwritten" : "created",
      reason: args.reason || "",
      size_bytes: Buffer.byteLength(args.content, "utf8"),
      diff: diff.slice(0, 3000) || undefined,
      hint: "File written. Run verification (typecheck, tests) to confirm correctness.",
    }, null, 2)
  },
})
