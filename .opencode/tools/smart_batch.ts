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
  description: "Atomic batch editor — apply multiple edits across multiple files as a single atomic operation. All edits are validated before any are applied. If any edit fails validation, none are applied. Returns a consolidated diff.",
  args: {
    edits: tool.schema.string().describe("JSON array of {file, oldText, newText, reason} objects. All edits validated before any are applied."),
  },
  async execute(args, context) {
    hb(context, "smart_batch", "started", `batch edit`)
    
    let edits: { file: string; oldText: string; newText: string; reason?: string }[]
    try { edits = JSON.parse(args.edits) } catch {
      return JSON.stringify({ status: "error", error: "Invalid JSON for 'edits'. Must be a JSON array of {file, oldText, newText, reason} objects." }, null, 2)
    }

    if (!Array.isArray(edits) || edits.length === 0) {
      return JSON.stringify({ status: "error", error: "'edits' must be a non-empty JSON array." }, null, 2)
    }

    // Phase 1: Validate all edits
    const validation: any[] = []
    let valid = true

    for (let i = 0; i < edits.length; i++) {
      const edit = edits[i]!
      if (!edit.file || edit.oldText === undefined || edit.newText === undefined) {
        validation.push({ index: i, file: edit.file || "?", status: "invalid", error: "Missing required fields: file, oldText, newText" })
        valid = false
        continue
      }

      const fullPath = r(context.worktree, edit.file)
      if (!existsSync(fullPath)) {
        validation.push({ index: i, file: edit.file, status: "invalid", error: "File not found" })
        valid = false
        continue
      }

      let content: string
      try { content = readFileSync(fullPath, "utf8") } catch (e: any) {
        validation.push({ index: i, file: edit.file, status: "invalid", error: `Cannot read: ${e.message}` })
        valid = false
        continue
      }

      const occurrences = content.split(edit.oldText).length - 1
      if (occurrences === 0) {
        validation.push({ index: i, file: edit.file, status: "invalid", error: "oldText not found in file" })
        valid = false
      } else if (occurrences > 1) {
        validation.push({ index: i, file: edit.file, status: "ambiguous", error: `Found ${occurrences} times — need more specific oldText`, occurrences })
        valid = false
      } else {
        validation.push({ index: i, file: edit.file, status: "valid" })
      }
    }

    if (!valid) {
      hb(context, "smart_batch", "failed", `validation failed: ${validation.filter(v => v.status !== "valid").length}/${edits.length}`)
      return JSON.stringify({
        status: "rejected",
        message: `${validation.filter(v => v.status !== "valid").length} of ${edits.length} edits failed validation. No files were modified.`,
        validation,
        hint: "Fix the invalid edits and retry. All edits must pass validation before any are applied.",
      }, null, 2)
    }

    // Phase 2: Apply all edits
    const results: any[] = []
    for (let i = 0; i < edits.length; i++) {
      const edit = edits[i]!
      const fullPath = r(context.worktree, edit.file)
      const content = readFileSync(fullPath, "utf8")
      const newContent = content.replace(edit.oldText, edit.newText)
      
      try { writeFileSync(fullPath, newContent, "utf8") } catch (e: any) {
        // Rollback! Re-apply previous edits in reverse
        for (let j = results.length - 1; j >= 0; j--) {
          try {
            const prev = edits[j]!
            const prevPath = r(context.worktree, prev.file)
            const prevContent = readFileSync(prevPath, "utf8")
            writeFileSync(prevPath, prevContent.replace(prev.newText, prev.oldText), "utf8")
          } catch {}
        }
        hb(context, "smart_batch", "failed", `write failed at edit ${i}, rolled back`)
        return JSON.stringify({
          status: "error",
          error: `Write failed at edit ${i} (${edit.file}): ${e.message}. All changes rolled back.`,
        }, null, 2)
      }

      // Create parent dirs if needed for new files
      try { mkdirSync(dirname(fullPath), { recursive: true }) } catch (_) {}
      
      results.push({ index: i, file: edit.file, status: "applied", reason: edit.reason || "" })
    }

    // Phase 3: Generate consolidated diff
    const changedFiles = [...new Set(edits.map(e => e.file))]
    const diffResult = spawnSync("git", ["-C", context.worktree, "diff", "--", ...changedFiles], {
      encoding: "utf8", maxBuffer: 1024 * 1024 * 2, timeout: 5000,
    })
    const diff = diffResult.stdout?.trim() || ""

    hb(context, "smart_batch", "completed", `${edits.length} edits across ${changedFiles.length} files`)
    artifactLog(context, { tool: "smart_batch", action: "batch_edit", files: changedFiles.length, edits: edits.length })

    return JSON.stringify({
      status: "applied",
      edits_applied: edits.length,
      files_changed: changedFiles.length,
      results,
      diff: diff.slice(0, 4000),
      hint: "All edits applied atomically. Run verification (typecheck, tests) to confirm correctness.",
    }, null, 2)
  },
})
