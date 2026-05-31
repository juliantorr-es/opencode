import { tool } from "@opencode-ai/plugin"
import { spawnSync } from "node:child_process"
import { resolve, relative } from "node:path"
import { appendFileSync, existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs"

function resolvePath(worktree: string, p: string): string {
  return resolve(worktree, p)
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
  description: "Write content to a file (creates or overwrites). Automatically records edit metadata. Post-write verification confirms the file exists and content matches.",
  args: {
    file: tool.schema.string().describe("Path to the file to write"),
    content: tool.schema.string().describe("Content to write"),
    reason: tool.schema.string().describe("Why this file is being written — one sentence"),
    plan_step: tool.schema.string().optional().describe("Which plan step this corresponds to"),
  },
  async execute(args, context) {
    const filePath = resolvePath(context.worktree, args.file)
    const editDir = resolvePath(context.worktree, `docs/json/opencode/sessions/${context.sessionID}/edits`)
    const logPath = resolvePath(context.worktree, `docs/json/opencode/sessions/${context.sessionID}/edits/edit_log.v1.jsonl`)

    const existed = existsSync(filePath)
    const oldContent = existed ? readFileSync(filePath, "utf8") : ""
    
    // Write
    try {
      mkdirSync(resolve(filePath, ".."), { recursive: true })
    } catch (_) {}
    writeFileSync(filePath, args.content, "utf8")

    // Post-write verification
    if (!existsSync(filePath)) {
      return JSON.stringify({
        status: "fail",
        error: `Write verification failed — file does not exist after write: ${args.file}`,
        hint: "Permissions issue, filesystem error, or cross-lane contention. Check path and retry.",
      }, null, 2)
    }
    const verifyContent = readFileSync(filePath, "utf8")
    if (verifyContent !== args.content) {
      return JSON.stringify({
        status: "fail",
        error: `Write verification failed — content mismatch after write: ${args.file}`,
        expected_bytes: args.content.length,
        actual_bytes: verifyContent.length,
        hint: "Another process may have modified the file simultaneously. Use produce_fragment for shared files.",
      }, null, 2)
    }

    // Record metadata
    try { mkdirSync(editDir, { recursive: true }) } catch (_) {}
    
    const relPath = filePath.startsWith(context.worktree) ? filePath.slice(context.worktree.length + 1) : args.file
    const changeSummary = existed
      ? `rewrote: ${oldContent.split("\n").length} → ${args.content.split("\n").length} lines`
      : "created file"

    // Try git diff
    let diffText = ""
    try {
      const diffResult = spawnSync("git", ["-C", context.worktree, "diff", "--", relPath], {
        encoding: "utf8", timeout: 5000,
      })
      if (diffResult.stdout?.trim()) {
        diffText = diffResult.stdout.trim().split("\n").slice(0, 20).join("\n")
      }
    } catch (_) {}

    const record = {
      schema_version: "v1",
      session_id: context.sessionID,
      agent: context.agent,
      file: args.file,
      reason: args.reason,
      change_summary: changeSummary,
      plan_step: args.plan_step || null,
      diff_snapshot: diffText.slice(0, 1000) || "(no diff available)",
      edited_at: new Date().toISOString(),
    }
    try {
      appendFileSync(logPath, JSON.stringify(record) + "\n", "utf8")
    } catch (_) {}

    artifactLog(context, { tool: "smart_write", action: "wrote", file: args.file, detail: args.reason?.slice(0, 80) })
    return JSON.stringify({
      status: "written",
      file: args.file,
      existed_before: existed,
      size_bytes: args.content.length,
      metadata_recorded: true,
      reason: args.reason,
    }, null, 2)
  },
})
