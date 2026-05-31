import { tool } from "@opencode-ai/plugin"
import { spawnSync } from "node:child_process"
import { resolve } from "node:path"
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"

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
  description: "Replace text in a file with exact matching. Automatically records edit metadata (who, why, what changed). Post-write verification confirms the edit persisted.",
  args: {
    file: tool.schema.string().describe("Path to the file to edit"),
    oldText: tool.schema.string().describe("Exact text to replace — must match uniquely in the file"),
    newText: tool.schema.string().describe("Replacement text"),
    reason: tool.schema.string().describe("Why this edit is being made — one sentence"),
    plan_step: tool.schema.string().optional().describe("Which plan step or repair directive this corresponds to"),
  },
  async execute(args, context) {
    const filePath = resolvePath(context.worktree, args.file)
    const editDir = resolvePath(context.worktree, `docs/json/opencode/sessions/${context.sessionID}/edits`)
    const logPath = resolvePath(context.worktree, `docs/json/opencode/sessions/${context.sessionID}/edits/edit_log.v1.jsonl`)

    if (!existsSync(filePath)) {
      return JSON.stringify({ status: "fail", error: `File not found: ${args.file}` }, null, 2)
    }

    const original = readFileSync(filePath, "utf8")
    const count = original.split(args.oldText).length - 1

    if (count === 0) {
      return JSON.stringify({
        status: "fail",
        error: "oldText not found in file",
        hint: "Check exact whitespace and line endings. Use read_source to see exact file content.",
      }, null, 2)
    }
    if (count > 1) {
      return JSON.stringify({
        status: "fail",
        error: `oldText matches ${count} times — must be unique`,
        hint: "Include more surrounding context to make the match unique.",
      }, null, 2)
    }

    const modified = original.replace(args.oldText, args.newText)
    writeFileSync(filePath, modified, "utf8")

    // Post-write verification
    if (!existsSync(filePath)) {
      return JSON.stringify({
        status: "fail",
        error: `Write verification failed — file does not exist after write: ${args.file}`,
      }, null, 2)
    }
    const verify = readFileSync(filePath, "utf8")
    if (!verify.includes(args.newText)) {
      return JSON.stringify({
        status: "fail",
        error: "Write verification failed — new text not found in file after write. Another process may have modified the file.",
      }, null, 2)
    }

    // Diff summary
    const origLines = original.split("\n")
    const modLines = modified.split("\n")
    let changed = 0
    for (let i = 0; i < Math.max(origLines.length, modLines.length); i++) {
      if (origLines[i] !== modLines[i]) changed++
    }

    // Record metadata
    try { mkdirSync(editDir, { recursive: true }) } catch (_) {}
    const relPath = filePath.startsWith(context.worktree) ? filePath.slice(context.worktree.length + 1) : args.file

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
      change_summary: `${changed} lines changed`,
      plan_step: args.plan_step || null,
      diff_snapshot: diffText.slice(0, 1000) || "(no diff available)",
      edited_at: new Date().toISOString(),
    }
    try {
      appendFileSync(logPath, JSON.stringify(record) + "\n", "utf8")
    } catch (_) {}

    artifactLog(context, { tool: "smart_edit", action: "edited", file: args.file, detail: args.reason?.slice(0, 80) })
    return JSON.stringify({
      status: "applied",
      file: args.file,
      occurrences_matched: 1,
      lines_changed: changed,
      metadata_recorded: true,
      reason: args.reason,
    }, null, 2)
  },
})
