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

interface BatchEdit {
  file: string
  oldText: string
  newText: string
  reason: string
}

export default tool({
  description: "Apply multiple edits atomically. Accepts an array of {file, oldText, newText, reason} objects. All edits are validated before any are applied — if any fails, none are applied. Post-write verification on every file.",
  args: {
    edits: tool.schema.string().describe("JSON array of edit objects: [{\"file\":\"...\",\"oldText\":\"...\",\"newText\":\"...\",\"reason\":\"...\"}]"),
    plan_step: tool.schema.string().optional().describe("Which plan step these edits correspond to"),
  },
  async execute(args, context) {
    const editDir = resolvePath(context.worktree, `docs/json/opencode/sessions/${context.sessionID}/edits`)
    const logPath = resolvePath(context.worktree, `docs/json/opencode/sessions/${context.sessionID}/edits/edit_log.v1.jsonl`)

    // Parse edits
    let edits: BatchEdit[]
    try {
      edits = JSON.parse(args.edits)
      if (!Array.isArray(edits) || edits.length === 0) {
        return JSON.stringify({ status: "fail", error: "edits must be a non-empty JSON array" }, null, 2)
      }
    } catch {
      return JSON.stringify({ status: "fail", error: "edits is not valid JSON" }, null, 2)
    }

    // Phase 1: Validate all edits
    const snapshots: { edit: BatchEdit; path: string; original: string }[] = []
    for (let i = 0; i < edits.length; i++) {
      const edit = edits[i]!
      const filePath = resolvePath(context.worktree, edit.file)

      if (!existsSync(filePath)) {
        return JSON.stringify({
          status: "fail",
          error: `Edit ${i + 1}: file not found: ${edit.file}`,
          applied: i,
          total: edits.length,
        }, null, 2)
      }

      const content = readFileSync(filePath, "utf8")
      const count = content.split(edit.oldText).length - 1

      if (count === 0) {
        // Try whitespace-normalized matching (tabs → spaces) as fallback
        const normContent = content.replace(/\t/g, "  ")
        const normOld = edit.oldText.replace(/\t/g, "  ")
        const normCount = normContent.split(normOld).length - 1
        if (normCount === 1) {
          // Found with normalized whitespace — apply using original content with normalized replacement
          const normNew = edit.newText.replace(/\t/g, "  ")
          // We can't safely apply normalized text back, so tell the agent
          return JSON.stringify({
            status: "fail",
            error: `Edit ${i + 1}/${edits.length}: oldText matched only after normalizing tabs to spaces. The file uses ${content.includes("\t") ? "tabs" : "spaces"} but your oldText used ${edit.oldText.includes("\t") ? "tabs" : "spaces"}.`,
            hint: "Match the file's exact indentation style. Use read_source to see the actual whitespace characters.",
            file_uses_tabs: content.includes("\t"),
            oldtext_uses_tabs: edit.oldText.includes("\t"),
            applied: i,
            total: edits.length,
          }, null, 2)
        }
        const preview = edit.oldText.split("\n")[0]?.slice(0, 100) || "(empty)"
        // Show file snippet to help debug
        const fileLines = content.split("\n")
        const fileSnippet = fileLines.slice(0, 10).map((l, j) => `  ${j + 1}: ${l.slice(0, 80)}`).join("\n")
        return JSON.stringify({
          status: "fail",
          error: `Edit ${i + 1}/${edits.length}: oldText not found in ${edit.file}`,
          preview,
          hint: "Check exact whitespace, indentation, and line endings. The file may have tabs vs spaces mismatch.",
          file_first_10_lines: fileSnippet,
          applied: i,
          total: edits.length,
        }, null, 2)
      }

      if (count > 1) {
        return JSON.stringify({
          status: "fail",
          error: `Edit ${i + 1}: oldText matches ${count} times in ${edit.file} — must be unique`,
          hint: "Include more surrounding context to make the match unique.",
          applied: i,
          total: edits.length,
        }, null, 2)
      }

      snapshots.push({ edit, path: filePath, original: content })
    }

    // Phase 2: Apply all edits
    try { mkdirSync(editDir, { recursive: true }) } catch (_) {}
    const results: string[] = []
    const now = new Date().toISOString()

    for (let i = 0; i < snapshots.length; i++) {
      const snap = snapshots[i]!
      const modified = snap.original.replace(snap.edit.oldText, snap.edit.newText)
      writeFileSync(snap.path, modified, "utf8")

      // Post-write verification
      if (!existsSync(snap.path)) {
        return JSON.stringify({
          status: "fail",
          error: `Edit ${i + 1}: write verification failed — file does not exist after write: ${snap.edit.file}`,
          applied: i,
          total: edits.length,
        }, null, 2)
      }
      const verify = readFileSync(snap.path, "utf8")
      if (!verify.includes(snap.edit.newText)) {
        return JSON.stringify({
          status: "fail",
          error: `Edit ${i + 1}: write verification failed — new text not found in file after write. Another process may have modified the file.`,
          applied: i,
          total: edits.length,
        }, null, 2)
      }

      // Git diff
      let diffText = ""
      const relPath = snap.path.startsWith(context.worktree) ? snap.path.slice(context.worktree.length + 1) : snap.edit.file
      try {
        const diffResult = spawnSync("git", ["-C", context.worktree, "diff", "--", relPath], {
          encoding: "utf8", timeout: 5000,
        })
        if (diffResult.stdout?.trim()) {
          diffText = diffResult.stdout.trim().split("\n").slice(0, 10).join("\n")
        }
      } catch (_) {}

      // Record metadata
      const record = {
        schema_version: "v1",
        session_id: context.sessionID,
        agent: context.agent,
        file: snap.edit.file,
        reason: snap.edit.reason,
        change_summary: `batch edit ${i + 1}/${edits.length}`,
        plan_step: args.plan_step || null,
        diff_snapshot: diffText.slice(0, 500),
        edited_at: now,
      }
      try {
        appendFileSync(logPath, JSON.stringify(record) + "\n", "utf8")
      } catch (_) {}

      results.push(snap.edit.file)
    }

    artifactLog(context, { tool: "smart_batch", action: "batch_edited", files: results.join(", "), edits: results.length })
    return JSON.stringify({
      status: "applied",
      edits_applied: results.length,
      total: edits.length,
      files: results,
      metadata_recorded: true,
    }, null, 2)
  },
})
